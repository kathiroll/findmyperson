package dev.findmyperson.encryptedstore

/**
 * The functions of src/main/cpp/fmp_store_jni.c, one to one. Each returns the SQLite result
 * code unchanged; text crosses as UTF-8 bytes and a handle is a pointer. Nothing here checks
 * anything: [SqlcipherConnection] is the only caller and the only place that may be.
 */
internal object SqlcipherNative {
    /** `libfmp-store-jni.so`. It holds no SQLite; loading it loads `libop-sqlite.so`. */
    const val LIBRARY = "fmp-store-jni"

    @Volatile
    private var loaded = false

    /** Throws [UnsatisfiedLinkError] if the library, or the op-sqlite library it needs, is missing. */
    fun load() {
        if (loaded) return
        synchronized(this) {
            if (!loaded) {
                System.loadLibrary(LIBRARY)
                loaded = true
            }
        }
    }

    @JvmStatic external fun open(path: ByteArray, create: Boolean, out: LongArray): Int

    @JvmStatic external fun key(db: Long, key: ByteArray): Int

    @JvmStatic external fun busyTimeout(db: Long, milliseconds: Int): Int

    @JvmStatic external fun close(db: Long): Int

    @JvmStatic external fun errmsg(db: Long): ByteArray?

    @JvmStatic external fun changes(db: Long): Int

    @JvmStatic external fun lastInsertRowid(db: Long): Long

    @JvmStatic external fun prepare(db: Long, sql: ByteArray, out: LongArray): Int

    @JvmStatic external fun bindLong(statement: Long, index: Int, value: Long): Int

    @JvmStatic external fun bindDouble(statement: Long, index: Int, value: Double): Int

    @JvmStatic external fun bindText(statement: Long, index: Int, value: ByteArray): Int

    @JvmStatic external fun bindNull(statement: Long, index: Int): Int

    @JvmStatic external fun step(statement: Long): Int

    @JvmStatic external fun columnText(statement: Long, column: Int): ByteArray?

    @JvmStatic external fun finalizeStatement(statement: Long): Int

    @JvmStatic external fun engineLibrary(): ByteArray?
}
