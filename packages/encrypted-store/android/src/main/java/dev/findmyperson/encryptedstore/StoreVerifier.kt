package dev.findmyperson.encryptedstore

/**
 * The checks every open makes before a single row is written, the same ones TypeScript's
 * openStore makes and in the same order. Pure over [StoreDatabase], so they are unit tested
 * without SQLCipher.
 */
object StoreVerifier {
    /** SQLCipher 4, every pinned parameter in effect, the file decrypts, WAL. */
    fun verifyCipher(db: StoreDatabase) {
        val version = db.scalar("PRAGMA cipher_version")
        if (version == null || !version.startsWith("${StoreContract.SQLCIPHER_MAJOR}.")) {
            throw StoreException(
                StoreException.NOT_SQLCIPHER,
                "expected SQLCipher ${StoreContract.SQLCIPHER_MAJOR}.x, cipher_version is ${version ?: "unreadable"}",
            )
        }

        // With a raw key SQLCipher decrypts the file whatever kdf_iter is, so reading each
        // pragma back is the only check that notices a side that drifted on it.
        val mismatches = StoreContract.READ_BACK.mapNotNull { (pragma, expected) ->
            val actual = db.scalar("PRAGMA $pragma")
            if (actual == expected) null else "$pragma: pinned $expected, effective ${actual ?: "unreadable"}"
        }
        if (mismatches.isNotEmpty()) {
            throw StoreException(
                StoreException.PARAM_MISMATCH,
                "cipher parameters differ from the pinned constant (${mismatches.joinToString("; ")})",
            )
        }

        try {
            db.scalar("SELECT count(*) FROM sqlite_master")
        } catch (e: Exception) {
            throw StoreException(
                StoreException.BAD_KEY_OR_PARAMS,
                "the store did not decrypt with the stored key and the pinned parameters: ${e.message}",
                e,
            )
        }

        val mode = db.scalar("PRAGMA journal_mode")
        if (mode?.lowercase() != StoreContract.JOURNAL_MODE) {
            throw StoreException(
                StoreException.PARAM_MISMATCH,
                "journal_mode is ${mode ?: "unreadable"}, pinned ${StoreContract.JOURNAL_MODE}",
            )
        }
    }

    /**
     * TypeScript owns migrations. Native code never creates or alters a table: it compares
     * `PRAGMA user_version` with the version it was built for and, if they differ, writes
     * nothing. A store that TypeScript has not migrated yet (version 0, straight after install
     * or after "delete all data") and one migrated by a newer build are both refused.
     */
    fun requireSchemaVersion(db: StoreDatabase) {
        val found = db.scalar(StoreContract.READ_SCHEMA_VERSION_SQL)?.toIntOrNull()
        if (found != StoreContract.SCHEMA_VERSION) {
            throw StoreException(
                StoreException.SCHEMA_MISMATCH,
                "store schema is version ${found ?: "unreadable"}, this build writes version ${StoreContract.SCHEMA_VERSION}",
            )
        }
    }
}
