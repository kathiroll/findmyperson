package dev.findmyperson.encryptedstore

import java.io.Closeable
import java.io.File

/** A failure of the SQLCipher connection. [resultCode] is SQLite's, when SQLite was the one to fail. */
class SqlcipherException(message: String, val resultCode: Int? = null, cause: Throwable? = null) :
    Exception(message, cause)

/**
 * ONE SQLCIPHER CONNECTION ON ANDROID, through the SQLCipher inside op-sqlite's library.
 *
 * This is the only way native code on Android reaches SQLite. The store and the capture module
 * both open their connection here, so the Kotlin writers and the JavaScript side (op-sqlite)
 * run one copy of SQLite in the process and exclude each other as SQLite intends. A second copy
 * would not see this one's file locks (README.md, "One SQLite library in the Android process").
 *
 * [open] sets the key and nothing else. It applies no pragma and checks nothing about the
 * file: the caller applies its pinned cipher pragmas before the first read, and verifies.
 *
 * Methods block and are safe to call from any thread. Messages name the statement and what
 * SQLite said about it, never a bound value.
 */
class SqlcipherConnection private constructor(private var handle: Long) : Closeable {

    /** First column of the first row as text, or null if there is no row or the value is NULL. */
    @Synchronized
    fun scalar(sql: String, args: List<Any?> = emptyList()): String? =
        withStatement(sql, args) { statement ->
            when (val rc = SqlcipherNative.step(statement)) {
                ROW -> SqlcipherNative.columnText(statement, 0)?.toString(Charsets.UTF_8)
                DONE -> null
                else -> throw failure(sql, rc)
            }
        }

    /** Runs a statement to its end, discarding any rows. */
    @Synchronized
    fun execute(sql: String, args: List<Any?> = emptyList()) {
        withStatement(sql, args) { statement ->
            while (true) {
                when (val rc = SqlcipherNative.step(statement)) {
                    ROW -> continue
                    DONE -> break
                    else -> throw failure(sql, rc)
                }
            }
        }
    }

    /** Runs an INSERT and returns the new row id. */
    @Synchronized
    fun insert(sql: String, args: List<Any?>): Long {
        execute(sql, args)
        return SqlcipherNative.lastInsertRowid(handle)
    }

    /** Runs an UPDATE or DELETE and returns how many rows it changed. */
    @Synchronized
    fun update(sql: String, args: List<Any?>): Int {
        execute(sql, args)
        return SqlcipherNative.changes(handle)
    }

    /** How long a statement waits for another connection's lock before failing with SQLITE_BUSY. */
    @Synchronized
    fun busyTimeout(milliseconds: Int) {
        val db = requireOpen()
        val rc = SqlcipherNative.busyTimeout(db, milliseconds)
        if (rc != OK) throw SqlcipherException("setting the busy timeout failed: ${lastError(db)}", rc)
    }

    /** Closing twice is harmless. */
    @Synchronized
    override fun close() {
        val db = handle
        handle = 0
        if (db != 0L) SqlcipherNative.close(db)
    }

    private fun requireOpen(): Long = handle.takeIf { it != 0L } ?: throw SqlcipherException("the connection is closed")

    private fun failure(sql: String, rc: Int) = SqlcipherException("$sql: ${lastError(handle)}", rc)

    private fun <T> withStatement(sql: String, args: List<Any?>, body: (Long) -> T): T {
        val db = requireOpen()
        val out = LongArray(1)
        val prepared = SqlcipherNative.prepare(db, sql.toByteArray(Charsets.UTF_8), out)
        val statement = out[0]
        if (prepared != OK || statement == 0L) {
            // A statement that is empty or only a comment prepares to nothing without an error.
            if (statement != 0L) SqlcipherNative.finalizeStatement(statement)
            throw failure(sql, prepared)
        }
        try {
            args.forEachIndexed { offset, value ->
                val index = offset + 1
                val rc = when (value) {
                    null -> SqlcipherNative.bindNull(statement, index)
                    is Long -> SqlcipherNative.bindLong(statement, index, value)
                    is Int -> SqlcipherNative.bindLong(statement, index, value.toLong())
                    is Double -> SqlcipherNative.bindDouble(statement, index, value)
                    is String -> SqlcipherNative.bindText(statement, index, value.toByteArray(Charsets.UTF_8))
                    else -> throw IllegalArgumentException("unsupported bind type ${value::class.java.simpleName}")
                }
                if (rc != OK) throw SqlcipherException("$sql: bind $index: ${lastError(db)}", rc)
            }
            return body(statement)
        } finally {
            SqlcipherNative.finalizeStatement(statement)
        }
    }

    companion object {
        // SQLite result codes; fmp_store_jni.c asserts these values at compile time.
        private const val OK = 0
        private const val ROW = 100
        private const val DONE = 101

        /** The file name, without its extension, of the library that holds the one SQLite of the app. */
        const val ENGINE_LIBRARY_NAME = "libop-sqlite"

        @Volatile
        private var engineChecked = false

        private fun lastError(db: Long): String =
            if (db == 0L) "no connection" else SqlcipherNative.errmsg(db)?.toString(Charsets.UTF_8) ?: "no message"

        /**
         * Opens [file] read-write and sets [keyLiteral] (a raw-key literal, `x'<64 hex>'`) as
         * its key. The file is created only if [create]; a native writer that must never be
         * the one to create the store passes false. Throws [SqlcipherException].
         */
        fun open(file: File, keyLiteral: String, create: Boolean): SqlcipherConnection {
            requireSharedEngine()
            val out = LongArray(1)
            val opened = SqlcipherNative.open(file.path.toByteArray(Charsets.UTF_8), create, out)
            val db = out[0]
            if (opened != OK || db == 0L) {
                val detail = if (db == 0L) "result code $opened" else lastError(db)
                if (db != 0L) SqlcipherNative.close(db)
                throw SqlcipherException("could not open the store file: $detail", opened)
            }
            val key = keyLiteral.toByteArray(Charsets.US_ASCII)
            try {
                val keyed = SqlcipherNative.key(db, key)
                if (keyed != OK) {
                    val detail = lastError(db)
                    SqlcipherNative.close(db)
                    throw SqlcipherException("setting the key failed: $detail", keyed)
                }
            } finally {
                key.fill(0)
            }
            return SqlcipherConnection(db)
        }

        /**
         * The file of the library this process's native SQLite calls are bound to, as the
         * dynamic linker reports it. On a phone it ends in `libop-sqlite.so`. Throws
         * [SqlcipherException] if the native library cannot be loaded or the linker cannot say.
         */
        fun engineLibrary(): String {
            try {
                SqlcipherNative.load()
            } catch (e: LinkageError) {
                throw SqlcipherException("could not load lib${SqlcipherNative.LIBRARY}: ${e.message}", cause = e)
            }
            return SqlcipherNative.engineLibrary()?.toString(Charsets.UTF_8)
                ?: throw SqlcipherException("the dynamic linker did not say which library holds SQLite")
        }

        /**
         * Refuses to open anything unless the SQLite this code calls is the one in op-sqlite's
         * library. The build links it that way; this is the same fact read back from the
         * running process, where a stray second SQLite would otherwise go unnoticed until it
         * damaged the file.
         */
        private fun requireSharedEngine() {
            if (engineChecked) return
            val library = engineLibrary()
            val name = library.substringAfterLast('/').substringBeforeLast('.')
            if (name != ENGINE_LIBRARY_NAME) {
                throw SqlcipherException("SQLite is bound to $library, not to op-sqlite's $ENGINE_LIBRARY_NAME")
            }
            engineChecked = true
        }
    }
}
