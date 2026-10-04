package dev.findmyperson.encryptedstore

import java.io.File

/**
 * [StoreDatabase] over [SqlcipherConnection]: the SQLCipher that op-sqlite compiles into the
 * app, which is the engine and the version the TypeScript side uses. There is no SQLCipher
 * dependency to keep in step with op-sqlite any more, and one copy of SQLite in the process.
 *
 * Run on a JVM against SQLCipher built from op-sqlite's source by SqlcipherHostTest; on a
 * phone it has not run (README.md, "Not verified").
 */
class SqlcipherDatabase private constructor(private val connection: SqlcipherConnection) : StoreDatabase {

    override fun scalar(sql: String, args: List<Any>): String? = connection.scalar(sql, args)

    override fun insert(sql: String, args: List<Any>): Long = connection.insert(sql, args)

    override fun update(sql: String, args: List<Any>): Int = connection.update(sql, args)

    override fun close() = connection.close()

    companion object : StoreDatabaseOpener {
        override fun open(file: File, keyHex: String): StoreDatabase {
            val literal = StoreKeys.keyLiteral(keyHex)
            val connection = try {
                SqlcipherConnection.open(file, literal, create = true)
            } catch (e: SqlcipherException) {
                throw StoreException(StoreException.OPEN_FAILED, e.message ?: "could not open the store file", e)
            }
            try {
                try {
                    // After the key is set and before the first read: where cipher pragmas must go.
                    for (pragma in StoreContract.APPLY_PRAGMAS) {
                        connection.scalar(pragma)
                    }
                    connection.busyTimeout(StoreContract.BUSY_TIMEOUT_MS)
                } catch (e: SqlcipherException) {
                    throw StoreException(StoreException.OPEN_FAILED, "could not configure the connection: ${e.message}", e)
                }
                try {
                    // The first real read. A wrong key or a page-size, HMAC or KDF-algorithm
                    // mismatch surfaces here as "file is not a database".
                    connection.scalar("SELECT count(*) FROM sqlite_master")
                } catch (e: SqlcipherException) {
                    throw StoreException(
                        StoreException.BAD_KEY_OR_PARAMS,
                        "the store did not decrypt with the stored key and the pinned parameters: ${e.message}",
                        e,
                    )
                }
                try {
                    connection.scalar("PRAGMA journal_mode = ${StoreContract.JOURNAL_MODE}")
                } catch (e: SqlcipherException) {
                    throw StoreException(StoreException.OPEN_FAILED, "could not set the journal mode: ${e.message}", e)
                }
            } catch (e: Exception) {
                connection.close()
                throw e
            }
            return SqlcipherDatabase(connection)
        }
    }
}
