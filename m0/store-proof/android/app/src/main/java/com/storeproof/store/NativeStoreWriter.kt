package com.storeproof.store

import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook
import net.zetetic.database.sqlcipher.SQLiteConnection
import java.io.File

/**
 * Opens the store natively and writes one row.
 *
 * Why this writes the database itself instead of handing the sample to JS (architecture plan
 * section 5.5, rule 1): when Android starts the process for a background wake (a WorkManager
 * job, a boot receiver) there is no React instance and no JS thread, so nothing could receive
 * the data. The native side must be able to open the encrypted file and commit on its own.
 * It also keeps coordinates off the JS bridge, where a crash report or a stray console.log
 * could capture them. This proof writes a timestamp and a label, not a location.
 */
object NativeStoreWriter {
    init {
        // Zetetic's sqlcipher-android ships libsqlcipher.so; it must be loaded before first use.
        System.loadLibrary("sqlcipher")
    }

    /** Opens (creating if absent) with the pinned parameters and verifies them before returning. */
    fun open(dbPath: String, keyHex: String): SQLiteDatabase {
        File(dbPath).parentFile?.mkdirs()
        val hook = object : SQLiteDatabaseHook {
            override fun preKey(connection: SQLiteConnection) {}
            // Runs after the key is set and before the first read, which is when cipher_* pragmas must be applied.
            override fun postKey(connection: SQLiteConnection) {
                for (pragma in CipherParams.APPLY_PRAGMAS) {
                    connection.execute(pragma, null, null)
                }
            }
        }
        val db = try {
            SQLiteDatabase.openOrCreateDatabase(
                File(dbPath),
                StoreKeys.keyLiteral(keyHex).toByteArray(Charsets.US_ASCII),
                null,
                null,
                hook,
            )
        } catch (e: IllegalArgumentException) {
            throw e
        } catch (e: Exception) {
            // A wrong key or a page-size / HMAC / KDF-algorithm mismatch surfaces here as "file is not a database".
            throw StoreOpenException("BAD_KEY_OR_PARAMS", "store did not decrypt with the pinned parameters: ${e.message}", e)
        }
        try {
            verify(db)
        } catch (e: Exception) {
            db.close()
            throw e
        }
        return db
    }

    private fun scalar(db: SQLiteDatabase, sql: String): String? =
        db.rawQuery(sql, null).use { if (it.moveToFirst()) it.getString(0) else null }

    private fun verify(db: SQLiteDatabase) {
        ParamCheck.requireSqlcipherMajor(scalar(db, "PRAGMA cipher_version"))
        ParamCheck.requireMatch { scalar(db, "PRAGMA $it") }
        db.enableWriteAheadLogging()
        val mode = scalar(db, "PRAGMA journal_mode")
        if (mode?.lowercase() != CipherParams.JOURNAL_MODE) {
            throw StoreOpenException("PARAM_MISMATCH", "journal_mode is ${mode ?: "unreadable"}, pinned ${CipherParams.JOURNAL_MODE}")
        }
        db.execSQL(CipherParams.CREATE_TABLE_SQL)
    }

    /** Opens, inserts one row stamped with the current time, closes. Returns the epoch seconds written. */
    fun writeProbeRow(dbPath: String, keyHex: String, label: String): Long {
        val ts = System.currentTimeMillis() / 1000
        val db = open(dbPath, keyHex)
        try {
            db.execSQL(CipherParams.INSERT_SQL, arrayOf<Any>(ts, label))
        } finally {
            db.close()
        }
        return ts
    }
}
