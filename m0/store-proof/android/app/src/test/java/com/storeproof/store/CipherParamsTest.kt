package com.storeproof.store

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The generated Kotlin constant must equal shared/cipher-params.json, which the TypeScript and
 * Swift constants are also generated from. Regenerate with `npm run gen:cipher`.
 */
class CipherParamsTest {
    private val shared: JSONObject = run {
        // Gradle runs unit tests with the module dir (android/app) as the working directory.
        val f = File("../../shared/cipher-params.json")
        assertTrue("cannot find ${f.absolutePath}", f.exists())
        JSONObject(f.readText())
    }

    @Test fun scalarsMatchSharedJson() {
        assertEquals(shared.getInt("sqlcipherMajor"), CipherParams.SQLCIPHER_MAJOR)
        assertEquals(shared.getInt("cipherCompatibility"), CipherParams.CIPHER_COMPATIBILITY)
        assertEquals(shared.getInt("pageSizeBytes"), CipherParams.PAGE_SIZE_BYTES)
        assertEquals(shared.getInt("kdfIterations"), CipherParams.KDF_ITERATIONS)
        assertEquals(shared.getString("kdfAlgorithm"), CipherParams.KDF_ALGORITHM)
        assertEquals(shared.getString("hmacAlgorithm"), CipherParams.HMAC_ALGORITHM)
        assertEquals(shared.getInt("keyBytes"), CipherParams.KEY_BYTES)
        assertEquals(shared.getString("journalMode"), CipherParams.JOURNAL_MODE)
        assertEquals(shared.getString("dbFileName"), CipherParams.DB_FILE_NAME)
        assertEquals(shared.getString("createTableSql"), CipherParams.CREATE_TABLE_SQL)
        assertEquals(shared.getString("insertSql"), CipherParams.INSERT_SQL)
        assertEquals(shared.getString("selectSql"), CipherParams.SELECT_SQL)
    }

    @Test fun pinnedValuesAreTheSqlcipher4Defaults() {
        assertEquals(4096, CipherParams.PAGE_SIZE_BYTES)
        assertEquals(256000, CipherParams.KDF_ITERATIONS)
        assertEquals("PBKDF2_HMAC_SHA512", CipherParams.KDF_ALGORITHM)
        assertEquals("HMAC_SHA512", CipherParams.HMAC_ALGORITHM)
    }

    @Test fun pragmasAreDerivedFromTheScalars() {
        assertEquals(
            listOf(
                "PRAGMA cipher_compatibility = ${shared.getInt("cipherCompatibility")}",
                "PRAGMA cipher_page_size = ${shared.getInt("pageSizeBytes")}",
                "PRAGMA kdf_iter = ${shared.getInt("kdfIterations")}",
                "PRAGMA cipher_kdf_algorithm = ${shared.getString("kdfAlgorithm")}",
                "PRAGMA cipher_hmac_algorithm = ${shared.getString("hmacAlgorithm")}",
            ),
            CipherParams.APPLY_PRAGMAS,
        )
    }

    @Test fun keyLiteralGoldenVector() {
        val v = shared.getJSONObject("keyVector")
        assertEquals(v.getString("literal"), StoreKeys.keyLiteral(v.getString("hex")))
        assertEquals(v.getString("literal"), StoreKeys.keyLiteral(v.getString("hex").uppercase()))
    }

    @Test fun malformedKeysAreRejected() {
        for (bad in listOf("", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33))) {
            assertThrows(IllegalArgumentException::class.java) { StoreKeys.keyLiteral(bad) }
        }
    }

    @Test fun randomKeysAreValidAndDistinct() {
        val a = StoreKeys.randomKeyHex()
        val b = StoreKeys.randomKeyHex()
        StoreKeys.requireKeyHex(a)
        assertTrue(a != b)
    }
}
