package dev.findmyperson.locationcapture.store

import android.content.Context
import android.database.sqlite.SQLiteException
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import dev.findmyperson.locationcapture.core.PurgeCounts
import dev.findmyperson.locationcapture.core.SampleStore
import dev.findmyperson.locationcapture.core.StoreUnusableException
import dev.findmyperson.locationcapture.core.StoredSample
import net.zetetic.database.DatabaseErrorHandler
import net.zetetic.database.sqlcipher.SQLiteConnection
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/*
 * STAND-IN, see StoreRules.kt: to be replaced by the store of plan task C2.3.
 * This file is the Android half: the Keystore-wrapped key and the SQLCipher connection.
 * It builds, and nothing in it has run on a device (README.md, "Not verified").
 */

/**
 * The 32-byte store key, wrapped by an AES-GCM key held in the Android Keystore
 * (plan 4.4; m0/store-proof's KeystoreKeyProvider).
 *
 * The Keystore key deliberately sets neither setUnlockedDeviceRequired nor
 * setUserAuthenticationRequired: background capture must read the key while the phone is
 * locked. The wrapped blob is a file in `noBackupFilesDir`, which Android never backs up, so a
 * restore on another phone cannot bring a blob whose Keystore key did not come with it.
 */
class KeystoreStoreKey(context: Context) {
    private val blob = File(StoreLocation.directory(context), "store-key.wrapped")

    @Synchronized
    fun getOrCreateKeyHex(): String {
        if (blob.exists()) {
            // If the Keystore key is gone but the blob remains, fail loudly: silently minting a
            // new key would orphan every row already in the store.
            return decrypt(blob.readText(Charsets.US_ASCII))
        }
        val keyHex = StoreKeys.randomKeyHex()
        blob.parentFile?.mkdirs()
        val temp = File(blob.parentFile, blob.name + ".tmp")
        temp.writeText(encrypt(keyHex), Charsets.US_ASCII)
        check(temp.renameTo(blob)) { "could not persist the wrapped store key" }
        return keyHex
    }

    private fun wrapKey(): SecretKey {
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keystore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private fun encrypt(keyHex: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, wrapKey()) }
        val ciphertext = cipher.doFinal(keyHex.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ciphertext, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val (iv, ciphertext) = stored.trim().split(":").map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance(TRANSFORM).apply {
            init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, iv))
        }
        return StoreKeys.requireKeyHex(String(cipher.doFinal(ciphertext), Charsets.US_ASCII))
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "fmp_store_wrap_v1"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}

/** Where the store lives: `getStoreDirectory` of the spec. */
object StoreLocation {
    /** App-private and excluded from backup by the platform itself, whatever the manifest says. */
    fun directory(context: Context): File = File(context.applicationContext.noBackupFilesDir, "fmp-store")

    fun file(context: Context): File = File(directory(context), StoreContract.STORE_FILE_NAME)
}

/**
 * [SampleStore] on the SQLCipher file TypeScript migrates and reads through op-sqlite.
 *
 * A connection is opened for one check or one insert and closed again. Capture writes about
 * four rows an hour, and a short-lived connection means a background process holds no file
 * open between wakes.
 */
class SqlCipherSampleStore(context: Context, private val key: KeystoreStoreKey) : SampleStore {
    private val appContext = context.applicationContext

    override fun check(): String? = try {
        open().close()
        null
    } catch (e: StoreOpenException) {
        e.message
    } catch (e: Exception) {
        "${e.javaClass.simpleName}: ${e.message}"
    }

    override fun insert(sample: StoredSample) {
        try {
            open().use { StoreRules.insert(it, sample) }
        } catch (e: StoreOpenException) {
            throw StoreUnusableException(e.message ?: e.step, e)
        } catch (e: Exception) {
            // The message of a driver error names the statement, never the bound values.
            throw StoreUnusableException("${e.javaClass.simpleName}: ${e.message}", e)
        }
    }

    override fun purgeExpired(nowTsUtc: Long): PurgeCounts = try {
        open().use { StorePurge.run(it, nowTsUtc) }
    } catch (e: StoreOpenException) {
        throw StoreUnusableException(e.message ?: e.step, e)
    } catch (e: Exception) {
        throw StoreUnusableException("${e.javaClass.simpleName}: ${e.message}", e)
    }

    /** Opens the existing store with the pinned parameters and verifies them before returning. */
    private fun open(): SqlDatabase {
        loadLibrary()
        val file = StoreLocation.file(appContext)
        if (!file.exists()) {
            // The native side never creates the store: TypeScript creates and migrates it.
            throw StoreOpenException("NOT_CREATED", "the store file does not exist yet")
        }
        val keyHex = try {
            key.getOrCreateKeyHex()
        } catch (e: Exception) {
            throw StoreOpenException("KEY_UNAVAILABLE", "the store key could not be read (${e.javaClass.simpleName})", e)
        }
        val hook = object : SQLiteDatabaseHook {
            override fun preKey(connection: SQLiteConnection) {}

            // After the key is set and before the first read: when cipher_* pragmas must be applied.
            override fun postKey(connection: SQLiteConnection) {
                for (pragma in CipherPragmas.APPLY) {
                    connection.execute(pragma, null, null)
                }
            }
        }
        val database = try {
            SQLiteDatabase.openDatabase(
                file.path,
                StoreKeys.keyLiteral(keyHex).toByteArray(Charsets.US_ASCII),
                null,
                // Without the WAL flag this wrapper sets its own default journal mode on open,
                // which would take the store out of WAL under the TypeScript reader.
                SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING,
                KEEP_THE_FILE,
                hook,
            )
        } catch (e: Exception) {
            // A wrong key or a page-size / HMAC / KDF mismatch surfaces here as "file is not a database".
            throw StoreOpenException("BAD_KEY_OR_PARAMS", "store did not decrypt with the pinned parameters", e)
        }
        val connection = Connection(database)
        try {
            StoreRules.verify(connection)
        } catch (e: Exception) {
            connection.close()
            throw e
        }
        return connection
    }

    private class Connection(private val database: SQLiteDatabase) : SqlDatabase {
        override fun scalar(sql: String): String? =
            database.rawQuery(sql, null as Array<String>?).use { if (it.moveToFirst()) it.getString(0) else null }

        override fun execute(sql: String, args: Array<Any?>) {
            database.execSQL(sql, args)
        }

        override fun update(sql: String, args: LongArray): Int {
            val statement = database.compileStatement(sql)
            try {
                args.forEachIndexed { index, value -> statement.bindLong(index + 1, value) }
                return statement.executeUpdateDelete()
            } finally {
                statement.close()
            }
        }

        // Takes the write lock at the start, so TypeScript's connection cannot write between
        // two statements of the purge.
        override fun <T> transaction(block: () -> T): T {
            database.beginTransaction()
            try {
                val result = block()
                database.setTransactionSuccessful()
                return result
            } finally {
                database.endTransaction()
            }
        }

        override fun close() {
            database.close()
        }
    }

    private companion object {
        /**
         * What to do when SQLite reports corruption: nothing. A wrong key looks like corruption,
         * and a handler that deletes the file would turn a key problem into the loss of thirty
         * days of history. The failure reaches the status as `store_unusable` instead.
         */
        val KEEP_THE_FILE = DatabaseErrorHandler { _: SQLiteDatabase, _: SQLiteException -> }

        @Volatile
        private var loaded = false

        /** Zetetic's sqlcipher-android ships libsqlcipher.so; it must be loaded before first use. */
        fun loadLibrary() {
            if (!loaded) {
                System.loadLibrary("sqlcipher")
                loaded = true
            }
        }
    }
}
