package dev.findmyperson.encryptedstore

import android.content.Context
import java.io.File

/** One fix, as the capture module hands it over. The two cells are computed by the caller. */
data class LocationSampleRow(
    /** Time of the fix, Unix seconds. */
    val tsUtc: Long,
    val lat: Double,
    val lon: Double,
    val accuracyM: Double,
    /** One of [StoreContract.SAMPLE_SOURCES]. */
    val source: String,
    /** Res-7 H3 cell of (lat, lon). */
    val h3R7: String,
    /** Res-5 PARENT of [h3R7], not the res-5 cell containing the point. */
    val h3R5: String,
)

/**
 * THE NATIVE STORE INTERFACE ON ANDROID. One instance per process, from [get].
 *
 * The capture module writes every fix through [insertLocationSample]. It does so with no
 * JavaScript running: when Android starts the process for a WorkManager job or a boot receiver
 * there is no React instance, so the native side has to find the key, open the encrypted file
 * and commit by itself (plan 5.5, rule 1). Coordinates therefore never cross the bridge.
 *
 * What this class guarantees to its callers:
 *   - the file is under the no-backup directory and the app's manifest forbids backup, or
 *     nothing is opened (BACKUP_NOT_EXCLUDED);
 *   - the connection is SQLCipher 4 with every pinned parameter in effect and WAL;
 *   - the schema is the version this build writes, or nothing is written (SCHEMA_MISMATCH):
 *     TypeScript owns migrations, native code never creates or alters a table;
 *   - only the statements of packages/shared/contracts/native-writer.json are run as writes.
 *
 * Every method is safe to call from any thread and blocks while it works, so call it off the
 * main thread. A failed open is not remembered: the next call tries again, which is how the
 * store comes back after TypeScript has migrated it or after "delete all data".
 */
class EncryptedStore internal constructor(
    private val paths: StorePaths,
    private val vault: StoreKeyVault,
    private val opener: StoreDatabaseOpener,
    private val applicationFlags: () -> Int,
) {
    private val lock = Any()
    private var database: StoreDatabase? = null

    /** The store key as 64 hex characters, made on first call. For `getOrCreateStoreKeyHex`. */
    fun keyHex(): String = synchronized(lock) {
        directory()
        vault.getOrCreateKeyHex()
    }

    /** The backup-excluded directory of the store, created if absent. For `getStoreDirectory`. */
    fun directory(): File = synchronized(lock) {
        StorePaths.requireBackupDisabled(applicationFlags())
        if (!paths.directory.isDirectory && !paths.directory.mkdirs()) {
            throw StoreException(StoreException.OPEN_FAILED, "could not create the store directory")
        }
        paths.directory
    }

    /**
     * Opens the store if it is not open and checks it is usable. For `initStore`, and for the
     * check the capture module repeats on every background wake. Throws [StoreException]; the
     * capture module reports that as `store_unusable`.
     */
    fun check() {
        synchronized(lock) { open() }
    }

    /** Stores one fix and returns its row id. Throws [StoreException] if the store is unusable. */
    fun insertLocationSample(sample: LocationSampleRow): Long = synchronized(lock) {
        write {
            it.insert(
                StoreContract.INSERT_LOCATION_SAMPLE_SQL,
                listOf(sample.tsUtc, sample.lat, sample.lon, sample.accuracyM, sample.source, sample.h3R7, sample.h3R5),
            )
        }
    }

    /**
     * A read for the capture module's own status (newest sample time, samples in the last day).
     * SELECT only; first column of the first row as text, or null.
     */
    fun readScalar(sql: String, args: List<Any> = emptyList()): String? = synchronized(lock) {
        require(sql.trimStart().startsWith("SELECT", ignoreCase = true)) { "readScalar runs SELECT statements only" }
        open().scalar(sql, args)
    }

    /**
     * "Delete all my data" (plan 4.7), the native half: closes the connection, deletes the
     * database with its -wal and -shm files, deletes the wrapped key and the Keystore key that
     * wrapped it. The next [keyHex] makes a new key. Works when the store or the key is
     * already unusable. TypeScript recreates the schema straight afterwards; until it has,
     * [insertLocationSample] refuses with SCHEMA_MISMATCH.
     */
    fun deleteAllData() {
        synchronized(lock) {
            close()
            val survivors = paths.databaseFiles.filter { it.exists() && !it.delete() }
            if (survivors.isNotEmpty()) {
                throw StoreException(StoreException.DELETE_FAILED, "could not delete ${survivors.joinToString { it.name }}")
            }
            vault.destroy()
        }
    }

    /** Closes the connection. The next call that needs it opens it again. */
    fun close() {
        synchronized(lock) {
            val open = database
            database = null
            open?.close()
        }
    }

    private fun open(): StoreDatabase {
        database?.let { return it }
        directory()
        val key = vault.getOrCreateKeyHex()
        val opened = opener.open(paths.database, key)
        try {
            StoreVerifier.verifyCipher(opened)
            StoreVerifier.requireSchemaVersion(opened)
        } catch (e: Exception) {
            opened.close()
            throw e
        }
        database = opened
        return opened
    }

    private fun <T> write(statement: (StoreDatabase) -> T): T {
        val db = open()
        return try {
            statement(db)
        } catch (e: StoreException) {
            throw e
        } catch (e: Exception) {
            // Drop the connection so the next write starts from a fresh, re-verified open.
            close()
            throw StoreException(StoreException.OPEN_FAILED, "write failed: ${e.message}", e)
        }
    }

    companion object {
        @Volatile
        private var instance: EncryptedStore? = null

        /** The process-wide store. Pass any context; the application context is used. */
        fun get(context: Context): EncryptedStore =
            instance ?: synchronized(this) {
                instance ?: run {
                    val app = context.applicationContext
                    val paths = StorePaths.of(app)
                    EncryptedStore(
                        paths = paths,
                        vault = StoreKeyVault(paths.keyFile, KeystoreKeyWrapper()),
                        opener = SqlcipherDatabase,
                        applicationFlags = { app.applicationInfo.flags },
                    ).also { instance = it }
                }
            }
    }
}
