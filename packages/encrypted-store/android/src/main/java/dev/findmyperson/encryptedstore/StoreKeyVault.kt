package dev.findmyperson.encryptedstore

import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom

/**
 * The store key on Android: 32 random bytes, wrapped by [KeyWrapper] and kept in one file in
 * the store's no-backup directory (plan 4.4).
 *
 * The plan names EncryptedSharedPreferences for the wrapped blob. That library is deprecated,
 * and shared preferences are part of what Android backs up, so the blob is a plain file beside
 * the database instead: wrapped by the Keystore key either way, and outside backups by where it
 * is. m0/store-proof made the same substitution.
 *
 * Survives app restart and reboot: the file and the Keystore key are both persistent.
 */
class StoreKeyVault(
    private val keyFile: File,
    private val wrapper: KeyWrapper,
    private val random: SecureRandom = SecureRandom(),
) {
    /**
     * The key as 64 hex characters, made on first call.
     *
     * If the file is there but cannot be unwrapped this throws KEY_UNAVAILABLE. It never makes
     * a new key in that case: that would silently orphan every row already stored. The way out
     * is [destroy], which "delete all data" calls.
     */
    @Synchronized
    fun getOrCreateKeyHex(): String {
        if (keyFile.exists()) {
            val key = try {
                wrapper.unwrap(keyFile.readBytes())
            } catch (e: Exception) {
                throw StoreException(StoreException.KEY_UNAVAILABLE, "the stored key cannot be unwrapped: ${e.message}", e)
            }
            if (key.size != StoreContract.KEY_BYTES) {
                throw StoreException(StoreException.KEY_UNAVAILABLE, "the stored key is ${key.size} bytes, expected ${StoreContract.KEY_BYTES}")
            }
            return StoreKeys.toHex(key)
        }
        val key = StoreKeys.randomKey(random)
        writeAtomically(wrapper.wrap(key))
        return StoreKeys.toHex(key)
    }

    /** Deletes the wrapped key and the key that wrapped it. The next [getOrCreateKeyHex] makes both anew. */
    @Synchronized
    fun destroy() {
        if (keyFile.exists() && !keyFile.delete()) {
            throw StoreException(StoreException.DELETE_FAILED, "could not delete the wrapped key file")
        }
        try {
            wrapper.destroy()
        } catch (e: Exception) {
            throw StoreException(StoreException.DELETE_FAILED, "could not delete the wrapping key: ${e.message}", e)
        }
    }

    /** Write, sync, then rename: a crash leaves either no key file or a whole one, never half. */
    private fun writeAtomically(bytes: ByteArray) {
        keyFile.parentFile?.mkdirs()
        val temporary = File(keyFile.path + ".tmp")
        FileOutputStream(temporary).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
        if (!temporary.renameTo(keyFile)) {
            temporary.delete()
            throw StoreException(StoreException.OPEN_FAILED, "could not persist the wrapped store key")
        }
    }
}
