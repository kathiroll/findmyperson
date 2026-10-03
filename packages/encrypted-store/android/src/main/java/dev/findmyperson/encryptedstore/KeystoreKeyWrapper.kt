package dev.findmyperson.encryptedstore

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Wraps the store key with an AES-256-GCM key that lives in the Android Keystore and never
 * leaves it (plan 4.4).
 *
 * ACCESSIBILITY, the Android equivalent of iOS "after first unlock, this device only":
 * the key spec sets neither an unlocked-device requirement nor a user-authentication
 * requirement. Background capture must read the key while the phone is locked in a pocket; with
 * either requirement every sample taken while locked would be lost. Keystore keys cannot be
 * exported or backed up, so the key is bound to this device. src/policy.test.ts fails if either
 * requirement is ever added.
 *
 * Whether every phone maker's Keystore behaves like AOSP here is a device check
 * (README, "Not verified").
 */
class KeystoreKeyWrapper(private val alias: String = StoreContract.KEYSTORE_ALIAS) : KeyWrapper {

    override fun wrap(plain: ByteArray): WrappedKey {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key(create = true)) }
        val ciphertext = cipher.doFinal(plain)
        // The Keystore chooses the IV; it is stored beside the ciphertext.
        return WrappedKey(cipher.iv, ciphertext)
    }

    override fun unwrap(wrapped: WrappedKey): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(TAG_BITS, wrapped.iv))
        }
        return cipher.doFinal(wrapped.ciphertext)
    }

    override fun destroy() {
        val keyStore = keyStore()
        if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun key(create: Boolean): SecretKey {
        (keyStore().getKey(alias, null) as? SecretKey)?.let { return it }
        // Unwrapping must never make a key: a fresh one cannot open the old blob, and the
        // failure has to be reported as the lost key it is.
        check(create) { "Keystore has no key under alias $alias" }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
    }
}
