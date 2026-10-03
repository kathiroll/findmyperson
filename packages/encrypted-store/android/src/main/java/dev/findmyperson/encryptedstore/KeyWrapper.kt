package dev.findmyperson.encryptedstore

/**
 * Encrypts the store key for storage on disk. The real one is [KeystoreKeyWrapper]; unit tests
 * use a software one, because the Android Keystore does not exist on a plain JVM.
 */
interface KeyWrapper {
    /** Returns an opaque blob that only [unwrap] of the same wrapper can turn back. */
    fun wrap(plain: ByteArray): ByteArray

    /** Throws if the blob is damaged or the wrapping key is gone or unusable. */
    fun unwrap(wrapped: ByteArray): ByteArray

    /** Deletes the wrapping key, so every blob made with it is dead. The next [wrap] makes a new one. */
    fun destroy()
}
