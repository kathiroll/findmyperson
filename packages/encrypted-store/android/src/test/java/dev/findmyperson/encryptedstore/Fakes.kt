package dev.findmyperson.encryptedstore

import java.io.File
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Stands in for the Android Keystore on a plain JVM: real AES-GCM with a key held in memory.
 * Hand the same instance to two vaults to play an app restart, where the Keystore still has
 * the key.
 */
class SoftwareKeyWrapper : KeyWrapper {
    private var key: SecretKey? = null
    var destroyed = 0
        private set

    private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    override fun wrap(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, key ?: newKey().also { key = it })
        }
        val ciphertext = cipher.doFinal(plain)
        return byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + ciphertext
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        val ivLength = wrapped[0].toInt()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, checkNotNull(key) { "no wrapping key" }, GCMParameterSpec(128, wrapped, 1, ivLength))
        }
        return cipher.doFinal(wrapped, 1 + ivLength, wrapped.size - 1 - ivLength)
    }

    override fun destroy() {
        key = null
        destroyed += 1
    }

    /** What a phone that lost its Keystore key looks like: the blob is there, the key is not. */
    fun loseKey() {
        key = null
    }
}

/**
 * Stands in for an open SQLCipher connection. `values` answers PRAGMA and SELECT reads; the
 * defaults are what a healthy, migrated store reports.
 */
class FakeDatabase(val values: MutableMap<String, String?> = healthy()) : StoreDatabase {
    val inserts = mutableListOf<Pair<String, List<Any>>>()
    val updates = mutableListOf<Pair<String, List<Any>>>()
    var closed = false
        private set
    var failFirstRead = false

    override fun scalar(sql: String, args: List<Any>): String? {
        check(!closed) { "connection is closed" }
        if (failFirstRead && sql.contains("sqlite_master")) throw IllegalStateException("file is not a database")
        return values[sql]
    }

    override fun insert(sql: String, args: List<Any>): Long {
        check(!closed) { "connection is closed" }
        inserts += sql to args
        return inserts.size.toLong()
    }

    override fun update(sql: String, args: List<Any>): Int {
        check(!closed) { "connection is closed" }
        updates += sql to args
        return 1
    }

    override fun close() {
        closed = true
    }

    companion object {
        fun healthy(): MutableMap<String, String?> = mutableMapOf<String, String?>(
            "PRAGMA cipher_version" to "4.19.0 community",
            "PRAGMA journal_mode" to StoreContract.JOURNAL_MODE,
            StoreContract.READ_SCHEMA_VERSION_SQL to StoreContract.SCHEMA_VERSION.toString(),
            "SELECT count(*) FROM sqlite_master" to "12",
        ).apply { StoreContract.READ_BACK.forEach { (pragma, expected) -> put("PRAGMA $pragma", expected) } }
    }
}

/** Opens [FakeDatabase]s and creates the file, as SQLCipher would, so deletion can be observed. */
class FakeOpener : StoreDatabaseOpener {
    val opened = mutableListOf<FakeDatabase>()
    val keys = mutableListOf<String>()
    var next: () -> FakeDatabase = { FakeDatabase() }

    override fun open(file: File, keyHex: String): StoreDatabase {
        file.parentFile?.mkdirs()
        file.writeText("ciphertext")
        File(file.path + "-wal").writeText("wal")
        File(file.path + "-shm").writeText("shm")
        keys += keyHex
        return next().also { opened += it }
    }
}

inline fun <reified T : Throwable> expectThrows(block: () -> Unit): T {
    try {
        block()
    } catch (e: Throwable) {
        if (e is T) return e
        throw AssertionError("expected ${T::class.java.simpleName}, got $e", e)
    }
    throw AssertionError("expected ${T::class.java.simpleName}, nothing was thrown")
}
