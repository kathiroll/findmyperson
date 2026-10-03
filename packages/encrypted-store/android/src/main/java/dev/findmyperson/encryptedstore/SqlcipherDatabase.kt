package dev.findmyperson.encryptedstore

import net.zetetic.database.sqlcipher.SQLiteConnection
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook
import net.zetetic.database.sqlcipher.SQLiteStatement
import java.io.File

/**
 * [StoreDatabase] over Zetetic's SQLCipher for Android.
 *
 * The version of that library must be the SQLCipher release op-sqlite compiles into the app,
 * so the Kotlin writer and the TypeScript reader agree on the file format; build.gradle pins
 * it and a TypeScript test compares the two. Android then has two copies of SQLCipher in one
 * process (op-sqlite's, inside libop-sqlite.so, and this one, libsqlcipher.so). m0/store-proof
 * built that combination into an APK; that the two coexist on a device is a device check.
 */
class SqlcipherDatabase private constructor(private val db: SQLiteDatabase) : StoreDatabase {

    override fun scalar(sql: String, args: List<Any>): String? =
        db.rawQuery(sql, args.toTypedArray()).use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null
        }

    override fun insert(sql: String, args: List<Any>): Long =
        db.compileStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeInsert()
        }

    override fun update(sql: String, args: List<Any>): Int =
        db.compileStatement(sql).use { statement ->
            bind(statement, args)
            statement.executeUpdateDelete()
        }

    override fun close() = db.close()

    private fun bind(statement: SQLiteStatement, args: List<Any>) {
        args.forEachIndexed { index, value ->
            when (value) {
                is Long -> statement.bindLong(index + 1, value)
                is Int -> statement.bindLong(index + 1, value.toLong())
                is Double -> statement.bindDouble(index + 1, value)
                is String -> statement.bindString(index + 1, value)
                else -> throw IllegalArgumentException("unsupported bind type ${value::class.java.simpleName}")
            }
        }
    }

    companion object : StoreDatabaseOpener {
        private val loaded by lazy { System.loadLibrary("sqlcipher") }

        override fun open(file: File, keyHex: String): StoreDatabase {
            loaded
            val literal = StoreKeys.keyLiteral(keyHex)
            val hook = object : SQLiteDatabaseHook {
                override fun preKey(connection: SQLiteConnection) {}

                // After the key is set and before the first read: where cipher pragmas must go.
                override fun postKey(connection: SQLiteConnection) {
                    for (pragma in StoreContract.APPLY_PRAGMAS) {
                        connection.execute(pragma, null, null)
                    }
                }
            }
            val db = try {
                SQLiteDatabase.openOrCreateDatabase(file, literal.toByteArray(Charsets.US_ASCII), null, null, hook)
            } catch (e: Exception) {
                // A wrong key or a page-size, HMAC or KDF-algorithm mismatch surfaces here as
                // "file is not a database".
                throw StoreException(
                    StoreException.BAD_KEY_OR_PARAMS,
                    "the store did not decrypt with the stored key and the pinned parameters: ${e.message}",
                    e,
                )
            }
            try {
                db.enableWriteAheadLogging()
                db.rawQuery("PRAGMA busy_timeout = ${StoreContract.BUSY_TIMEOUT_MS}", null).use { it.moveToFirst() }
            } catch (e: Exception) {
                db.close()
                throw StoreException(StoreException.OPEN_FAILED, "could not configure the connection: ${e.message}", e)
            }
            return SqlcipherDatabase(db)
        }
    }
}
