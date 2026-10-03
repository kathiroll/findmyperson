package dev.findmyperson.encryptedstore

/**
 * Every failure of the native store. Never swallowed: a caller either gets a working store or
 * this, and the capture module turns it into the `store_unusable` health flag.
 *
 * The first four codes are the ones TypeScript's StoreError uses for the same condition.
 */
class StoreException(val code: String, message: String, cause: Throwable? = null) :
    Exception("$code: $message", cause) {
    companion object {
        const val NOT_SQLCIPHER = "NOT_SQLCIPHER"
        const val PARAM_MISMATCH = "PARAM_MISMATCH"
        const val BAD_KEY_OR_PARAMS = "BAD_KEY_OR_PARAMS"
        const val OPEN_FAILED = "OPEN_FAILED"

        /** The schema is not the version this build writes. TypeScript has not migrated yet, or is newer. */
        const val SCHEMA_MISMATCH = "SCHEMA_MISMATCH"

        /** The key exists but cannot be read. Never answered by making a new key. */
        const val KEY_UNAVAILABLE = "KEY_UNAVAILABLE"

        /** The app's merged manifest allows backup, so the store refuses to exist. */
        const val BACKUP_NOT_EXCLUDED = "BACKUP_NOT_EXCLUDED"

        /** "Delete all data" could not remove a file or the key. */
        const val DELETE_FAILED = "DELETE_FAILED"
    }
}
