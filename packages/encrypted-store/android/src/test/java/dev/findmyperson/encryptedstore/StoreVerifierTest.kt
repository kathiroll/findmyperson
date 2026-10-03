package dev.findmyperson.encryptedstore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreVerifierTest {
    private fun cipherFailure(db: FakeDatabase) = expectThrows<StoreException> { StoreVerifier.verifyCipher(db) }
    private fun schemaFailure(db: FakeDatabase) = expectThrows<StoreException> { StoreVerifier.requireSchemaVersion(db) }

    @Test
    fun aHealthyStorePasses() {
        val db = FakeDatabase()
        StoreVerifier.verifyCipher(db)
        StoreVerifier.requireSchemaVersion(db)
    }

    @Test
    fun aLibraryWithoutSqlcipher4IsRefused() {
        for (version in listOf(null, "3.4.2", "")) {
            val db = FakeDatabase().apply { values["PRAGMA cipher_version"] = version }
            assertEquals(StoreException.NOT_SQLCIPHER, cipherFailure(db).code)
        }
    }

    @Test
    fun aDriftedKdfIterationCountIsNoticedThoughSqlcipherWouldDecrypt() {
        val db = FakeDatabase().apply { values["PRAGMA kdf_iter"] = "1000" }
        val error = cipherFailure(db)
        assertEquals(StoreException.PARAM_MISMATCH, error.code)
        assertTrue(error.message!!.contains("kdf_iter: pinned 256000, effective 1000"))
    }

    @Test
    fun everyPinnedParameterIsReadBack() {
        for ((pragma, _) in StoreContract.READ_BACK) {
            val db = FakeDatabase().apply { values["PRAGMA $pragma"] = "something-else" }
            assertEquals(pragma, StoreException.PARAM_MISMATCH, cipherFailure(db).code)
        }
    }

    @Test
    fun aFileThatDoesNotDecryptIsReportedAsSuch() {
        val db = FakeDatabase().apply { failFirstRead = true }
        assertEquals(StoreException.BAD_KEY_OR_PARAMS, cipherFailure(db).code)
    }

    @Test
    fun aJournalThatIsNotWalIsRefused() {
        val db = FakeDatabase().apply { values["PRAGMA journal_mode"] = "delete" }
        assertEquals(StoreException.PARAM_MISMATCH, cipherFailure(db).code)
    }

    @Test
    fun onlyTheSchemaVersionThisBuildWritesIsAccepted() {
        // 0: TypeScript has not migrated yet. 2: a synthetic newer schema. Neither is written to.
        for (version in listOf("0", "2", null, "not-a-number")) {
            val db = FakeDatabase().apply { values[StoreContract.READ_SCHEMA_VERSION_SQL] = version }
            assertEquals(StoreException.SCHEMA_MISMATCH, schemaFailure(db).code)
        }
    }
}
