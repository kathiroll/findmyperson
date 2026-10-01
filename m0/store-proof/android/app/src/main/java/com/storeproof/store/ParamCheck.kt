package com.storeproof.store

/** Thrown for every failure to open the store with the pinned parameters. Never swallowed. */
class StoreOpenException(val code: String, message: String, cause: Throwable? = null) :
    Exception("$code: $message", cause)

/**
 * Compares what the engine reports against the pinned constant. With a raw key SQLCipher
 * decrypts the file whatever kdf_iter is, so reading the pragma back is the only way a
 * kdf_iter mismatch is noticed. Pure function so it is unit-testable without SQLCipher.
 */
object ParamCheck {
    fun mismatches(read: (pragma: String) -> String?): List<String> =
        CipherParams.READ_BACK.mapNotNull { (pragma, expected) ->
            val actual = read(pragma)
            if (actual == expected) null else "$pragma: pinned $expected, effective ${actual ?: "unreadable"}"
        }

    fun requireSqlcipherMajor(version: String?) {
        if (version == null || !version.startsWith("${CipherParams.SQLCIPHER_MAJOR}.")) {
            throw StoreOpenException(
                "NOT_SQLCIPHER",
                "expected SQLCipher ${CipherParams.SQLCIPHER_MAJOR}.x, cipher_version returned ${version ?: "nothing"}",
            )
        }
    }

    fun requireMatch(read: (pragma: String) -> String?) {
        val bad = mismatches(read)
        if (bad.isNotEmpty()) {
            throw StoreOpenException("PARAM_MISMATCH", "cipher parameters differ from the pinned constant (${bad.joinToString("; ")})")
        }
    }
}
