package dev.findmyperson.encryptedstore

/** What [KeyWrapper.wrap] produces: the nonce it used and the ciphertext with its tag. */
class WrappedKey(val iv: ByteArray, val ciphertext: ByteArray)

/**
 * Encrypts the store key for storage on disk. The real one is [KeystoreKeyWrapper]; unit tests
 * use a software one, because the Android Keystore does not exist on a plain JVM.
 */
interface KeyWrapper {
    fun wrap(plain: ByteArray): WrappedKey

    /** Throws if the blob is damaged or the wrapping key is gone or unusable. */
    fun unwrap(wrapped: WrappedKey): ByteArray

    /** Deletes the wrapping key, so every blob made with it is dead. The next [wrap] makes a new one. */
    fun destroy()
}
