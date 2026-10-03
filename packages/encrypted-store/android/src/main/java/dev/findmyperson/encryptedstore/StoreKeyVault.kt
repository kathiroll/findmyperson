package dev.findmyperson.encryptedstore

import java.io.File
import java.io.FileOutputStream
import java.security.SecureRandom
import kotlin.io.encoding.Base64

/**
 * The store key on Android: 32 random bytes, wrapped by [KeyWrapper] and kept in one file in
 * the store's no-backup directory (plan 4.4).
 *
 * The plan names EncryptedSharedPreferences for the wrapped blob. That library is deprecated,
 * and shared preferences are part of what Android backs up, so the blob is a plain file beside
 * the database instead: wrapped by the Keystore key either way, and outside backups by where it
 * is. m0/store-proof made the same substitution.
 *
 * FILE FORMAT: ASCII text, base64(iv) ":" base64(ciphertext), where the plaintext is the key
 * as 64 hex characters. This is the format the capture module's own copy of this logic writes
 * (KeystoreStoreKey in packages/native-location-capture/android), under the same file name and
 * the same Keystore alias, so both read one key until that copy is replaced by this class.
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
            return try {
                val parts = keyFile.readText(Charsets.US_ASCII).trim().split(":")
                require(parts.size == 2) { "the key file is not iv:ciphertext" }
                val wrapped = WrappedKey(Base64.Default.decode(parts[0]), Base64.Default.decode(parts[1]))
                StoreKeys.requireKeyHex(String(wrapper.unwrap(wrapped), Charsets.US_ASCII))
            } catch (e: Exception) {
                throw StoreException(StoreException.KEY_UNAVAILABLE, "the stored key cannot be unwrapped: ${e.message}", e)
            }
        }
        val keyHex = StoreKeys.toHex(StoreKeys.randomKey(random))
        val wrapped = wrapper.wrap(keyHex.toByteArray(Charsets.US_ASCII))
        writeAtomically(Base64.Default.encode(wrapped.iv) + ":" + Base64.Default.encode(wrapped.ciphertext))
        return keyHex
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
    private fun writeAtomically(text: String) {
        keyFile.parentFile?.mkdirs()
        val temporary = File(keyFile.path + ".tmp")
        FileOutputStream(temporary).use { out ->
            out.write(text.toByteArray(Charsets.US_ASCII))
            out.fd.sync()
        }
        if (!temporary.renameTo(keyFile)) {
            temporary.delete()
            throw StoreException(StoreException.OPEN_FAILED, "could not persist the wrapped store key")
        }
    }
}
