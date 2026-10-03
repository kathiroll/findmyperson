package dev.findmyperson.encryptedstore

import java.security.SecureRandom

/** Pure key helpers (no Android types), so they run in plain JVM unit tests. */
object StoreKeys {
    private val HEX = Regex("^[0-9a-fA-F]{${StoreContract.KEY_BYTES * 2}}$")

    fun requireKeyHex(hex: String): String {
        require(HEX.matches(hex)) {
            "store key must be ${StoreContract.KEY_BYTES * 2} hex characters (${StoreContract.KEY_BYTES} bytes)"
        }
        return hex.lowercase()
    }

    /** SQLCipher raw-key literal x'<hex>': no PBKDF2 on every open, which matters on a background wake. */
    fun keyLiteral(hex: String): String = "x'${requireKeyHex(hex)}'"

    /** 32 bytes from the platform CSPRNG (plan 4.4). */
    fun randomKey(random: SecureRandom = SecureRandom()): ByteArray =
        ByteArray(StoreContract.KEY_BYTES).also(random::nextBytes)

    fun toHex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
