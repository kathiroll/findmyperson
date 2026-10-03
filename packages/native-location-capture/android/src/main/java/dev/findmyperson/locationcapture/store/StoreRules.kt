package dev.findmyperson.locationcapture.store

import dev.findmyperson.locationcapture.core.StoredSample
import java.io.Closeable
import java.security.SecureRandom

/*
 * STAND-IN. Plan task C2.3 (fmp-encrypted-store) owns key management and the native store
 * wiring; its Android side had not landed when this module was written. Everything in this
 * package exists so capture can write samples until it does, behind the `SampleStore` port of
 * core/Ports.kt. When C2.3 lands, replace this package with its store and keep the port.
 *
 * It is the M0 store proof (m0/store-proof/android, PR #7) with the proof's table replaced by
 * the real contract: the SQL and the cipher parameters come from StoreContract, which the
 * build generates from packages/shared/contracts.
 *
 * This file is the part with no Android type in it, so the unit tests run it: against the
 * contract files, and against a real SQLite holding the real schema.
 */

/** The little of a SQLite connection the native writer uses. */
interface SqlDatabase : Closeable {
    /** First column of the first row as text, or null when there is no row. */
    fun scalar(sql: String): String?

    fun execute(sql: String, args: Array<Any?>)
}

/** Thrown for every failure to open the store with the pinned parameters. Never swallowed. */
class StoreOpenException(val step: String, message: String, cause: Throwable? = null) :
    Exception("$step: $message", cause)

/** The pragma lists of packages/shared/src/store/cipher.ts, built from the same numbers. */
object CipherPragmas {
    /** Run right after the key is set and before the first read, in this order. */
    val APPLY: List<String> = listOf(
        "PRAGMA cipher_compatibility = ${StoreContract.CIPHER_COMPATIBILITY}",
        "PRAGMA cipher_page_size = ${StoreContract.PAGE_SIZE_BYTES}",
        "PRAGMA kdf_iter = ${StoreContract.KDF_ITERATIONS}",
        "PRAGMA cipher_kdf_algorithm = ${StoreContract.KDF_ALGORITHM}",
        "PRAGMA cipher_hmac_algorithm = ${StoreContract.HMAC_ALGORITHM}",
    )

    /** Pragma name and the value that must be read back after opening. */
    val READ_BACK: List<Pair<String, String>> = listOf(
        "cipher_page_size" to StoreContract.PAGE_SIZE_BYTES.toString(),
        "kdf_iter" to StoreContract.KDF_ITERATIONS.toString(),
        "cipher_kdf_algorithm" to StoreContract.KDF_ALGORITHM,
        "cipher_hmac_algorithm" to StoreContract.HMAC_ALGORITHM,
    )
}

/**
 * The checks of `initStore` and the one write, as functions of a connection.
 *
 * With a raw key SQLCipher decrypts the file whatever kdf_iter is, so reading the pragmas back
 * is the only way a drifted parameter is noticed (found in the M0 store proof).
 */
object StoreRules {
    /** Throws [StoreOpenException] naming the first check the connection fails. */
    fun verify(db: SqlDatabase) {
        val version = db.scalar("PRAGMA cipher_version")
        if (version == null || !version.startsWith("${StoreContract.SQLCIPHER_MAJOR}.")) {
            throw StoreOpenException(
                "NOT_SQLCIPHER",
                "expected SQLCipher ${StoreContract.SQLCIPHER_MAJOR}.x, cipher_version returned ${version ?: "nothing"}",
            )
        }
        val mismatches = CipherPragmas.READ_BACK.mapNotNull { (pragma, expected) ->
            val actual = db.scalar("PRAGMA $pragma")
            if (actual == expected) null else "$pragma: pinned $expected, effective ${actual ?: "unreadable"}"
        }
        if (mismatches.isNotEmpty()) {
            throw StoreOpenException("PARAM_MISMATCH", "cipher parameters differ from the pinned ones (${mismatches.joinToString("; ")})")
        }
        val journal = db.scalar("PRAGMA journal_mode")
        if (journal?.lowercase() != StoreContract.JOURNAL_MODE) {
            throw StoreOpenException("PARAM_MISMATCH", "journal_mode is ${journal ?: "unreadable"}, pinned ${StoreContract.JOURNAL_MODE}")
        }
        requireSchemaVersion(db)
    }

    /**
     * TypeScript owns migrations. If the store is not at the version this build writes, the
     * module must not write at all (packages/shared/src/store/nativeWriter.ts).
     */
    fun requireSchemaVersion(db: SqlDatabase) {
        val found = db.scalar(StoreContract.READ_SCHEMA_VERSION_SQL)
        if (found?.toIntOrNull() != StoreContract.SCHEMA_VERSION) {
            throw StoreOpenException(
                "SCHEMA_VERSION",
                "store schema is version ${found ?: "unreadable"}, this build writes version ${StoreContract.SCHEMA_VERSION}",
            )
        }
    }

    /**
     * The one statement this module runs against `location_sample`. Parameter order: ts_utc,
     * lat, lon, accuracy_m, source, h3_r7, h3_r5 (packages/shared/src/store/tables/locationSample.ts).
     */
    fun insert(db: SqlDatabase, sample: StoredSample) {
        db.execute(
            StoreContract.INSERT_LOCATION_SAMPLE_SQL,
            arrayOf(sample.tsUtc, sample.lat, sample.lon, sample.accuracyM, sample.source, sample.h3R7, sample.h3R5),
        )
    }
}

/** Pure key helpers, from the M0 store proof. */
object StoreKeys {
    private val HEX = Regex("^[0-9a-fA-F]{${StoreContract.KEY_BYTES * 2}}$")

    fun requireKeyHex(hex: String): String {
        require(HEX.matches(hex)) {
            "store key must be ${StoreContract.KEY_BYTES * 2} hex characters (${StoreContract.KEY_BYTES} bytes)"
        }
        return hex.lowercase()
    }

    /** SQLCipher raw-key literal x'<hex>': no PBKDF2 on the background-launch path. */
    fun keyLiteral(hex: String): String = "x'${requireKeyHex(hex)}'"

    fun randomKeyHex(random: SecureRandom = SecureRandom()): String =
        ByteArray(StoreContract.KEY_BYTES).also(random::nextBytes).joinToString("") { "%02x".format(it) }
}
