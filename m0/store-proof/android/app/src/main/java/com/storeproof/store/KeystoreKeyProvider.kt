package com.storeproof.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The 32-byte database key, wrapped by an AES-GCM key held in the Android Keystore and stored
 * in app-private SharedPreferences (architecture plan section 4.4).
 *
 * The Keystore key deliberately sets neither setUnlockedDeviceRequired nor
 * setUserAuthenticationRequired: background capture must read the key while the phone is
 * locked. Whether this behaves as "AfterFirstUnlock" on real devices is a device check.
 */
class KeystoreKeyProvider(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun getOrCreateKeyHex(): String {
        val stored = prefs.getString(PREF_WRAPPED, null)
        if (stored != null) {
            // If the Keystore key is gone but the blob remains, fail loudly: silently minting a
            // new key would orphan every row already in the database.
            return decrypt(stored)
        }
        val keyHex = StoreKeys.randomKeyHex()
        val wrapped = encrypt(keyHex)
        check(prefs.edit().putString(PREF_WRAPPED, wrapped).commit()) { "could not persist wrapped store key" }
        return keyHex
    }

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private fun encrypt(keyHex: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, wrapKey()) }
        val ct = cipher.doFinal(keyHex.toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    }

    private fun decrypt(stored: String): String {
        val (iv, ct) = stored.split(":").map { Base64.decode(it, Base64.NO_WRAP) }
        val cipher = Cipher.getInstance(TRANSFORM).apply {
            init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, iv))
        }
        return StoreKeys.requireKeyHex(String(cipher.doFinal(ct), Charsets.US_ASCII))
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "fmp_store_wrap_v1"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val PREFS = "fmp_store_key"
        const val PREF_WRAPPED = "wrapped_v1"
    }
}
