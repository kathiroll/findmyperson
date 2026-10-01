package com.storeproof.store

import java.security.SecureRandom

/** Pure key helpers (no Android types), so they run in plain JVM unit tests. */
object StoreKeys {
    private val HEX = Regex("^[0-9a-fA-F]{${CipherParams.KEY_BYTES * 2}}$")

    fun requireKeyHex(hex: String): String {
        require(HEX.matches(hex)) { "store key must be ${CipherParams.KEY_BYTES * 2} hex characters (${CipherParams.KEY_BYTES} bytes)" }
        return hex.lowercase()
    }

    /** SQLCipher raw-key literal x'<hex>'; keeps PBKDF2 out of the background-launch path. */
    fun keyLiteral(hex: String): String = "x'${requireKeyHex(hex)}'"

    fun randomKeyHex(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(CipherParams.KEY_BYTES).also(random::nextBytes)
        return bytes.toHex()
    }

    fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
