package dev.findmyperson.encryptedstore

import android.content.pm.ApplicationInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class EncryptedStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val wrapper = SoftwareKeyWrapper()
    private val opener = FakeOpener()
    private var flags = 0
    private val paths by lazy { StorePaths(folder.root) }

    private fun store() = EncryptedStore(paths, StoreKeyVault(paths.keyFile, wrapper), opener) { flags }

    private val sample = LocationSampleRow(
        tsUtc = 1_700_000_000,
        lat = 12.9716,
        lon = 77.5946,
        accuracyM = 12.0,
        source = "wm",
        h3R7 = "8760145b4ffffff",
        h3R5 = "8560145bfffffff",
    )

    private fun atVersion(version: String?): () -> FakeDatabase = {
        FakeDatabase().apply { values[StoreContract.READ_SCHEMA_VERSION_SQL] = version }
    }

    @Test
    fun aSampleIsWrittenWithTheContractStatementInItsParameterOrder() {
        val store = store()
        assertEquals(1L, store.insertLocationSample(sample))
        assertEquals(
            listOf(
                StoreContract.INSERT_LOCATION_SAMPLE_SQL to
                    listOf<Any>(1_700_000_000L, 12.9716, 77.5946, 12.0, "wm", "8760145b4ffffff", "8560145bfffffff"),
            ),
            opener.opened.single().inserts,
        )
    }

    @Test
    fun theConnectionIsOpenedOnceWithTheVaultKeyAndReused() {
        val store = store()
        store.insertLocationSample(sample)
        store.insertLocationSample(sample)
        store.check()
        assertEquals(1, opener.opened.size)
        assertEquals(listOf(store.keyHex()), opener.keys)
        assertEquals(paths.directory, store.directory())
    }

    @Test
    fun aStoreNotYetMigratedIsNotWrittenTo() {
        opener.next = atVersion("0")
        val error = expectThrows<StoreException> { store().insertLocationSample(sample) }
        assertEquals(StoreException.SCHEMA_MISMATCH, error.code)
        assertTrue(opener.opened.single().inserts.isEmpty())
        assertTrue(opener.opened.single().closed)
    }

    @Test
    fun aStoreMigratedToASyntheticVersion2IsNotWrittenTo() {
        opener.next = atVersion("2")
        val error = expectThrows<StoreException> { store().insertLocationSample(sample) }
        assertEquals(StoreException.SCHEMA_MISMATCH, error.code)
        assertTrue(opener.opened.single().inserts.isEmpty())
    }

    @Test
    fun aFailedOpenIsNotRememberedSoTheStoreComesBackOnceMigrated() {
        val store = store()
        opener.next = atVersion("0")
        expectThrows<StoreException> { store.check() }

        opener.next = { FakeDatabase() }
        store.check()
        assertEquals(1L, store.insertLocationSample(sample))
        assertEquals(2, opener.opened.size)
    }

    @Test
    fun aStoreWithDriftedCipherParametersIsNotWrittenTo() {
        opener.next = { FakeDatabase().apply { values["PRAGMA kdf_iter"] = "1000" } }
        val error = expectThrows<StoreException> { store().insertLocationSample(sample) }
        assertEquals(StoreException.PARAM_MISMATCH, error.code)
        assertTrue(opener.opened.single().inserts.isEmpty())
    }

    @Test
    fun anAppThatAllowsBackupGetsNoStoreAtAll() {
        flags = ApplicationInfo.FLAG_ALLOW_BACKUP
        val store = store()
        for (attempt in listOf<() -> Unit>({ store.keyHex() }, { store.directory() }, { store.check() }, { store.insertLocationSample(sample) })) {
            assertEquals(StoreException.BACKUP_NOT_EXCLUDED, expectThrows<StoreException>(attempt).code)
        }
        assertTrue(opener.opened.isEmpty())
        assertFalse(paths.keyFile.exists())
        assertFalse(paths.directory.exists())
    }

    @Test
    fun deleteAllDataRemovesEveryFileAndRotatesTheKey() {
        val store = store()
        store.insertLocationSample(sample)
        val oldKey = store.keyHex()
        assertTrue(paths.databaseFiles.all { it.exists() })

        store.deleteAllData()

        assertTrue(opener.opened.single().closed)
        assertTrue(paths.databaseFiles.none { it.exists() })
        assertFalse(paths.keyFile.exists())
        assertEquals(1, wrapper.destroyed)
        assertNotEquals(oldKey, store.keyHex())
    }

    @Test
    fun afterDeleteAllDataNothingIsWrittenUntilTypeScriptHasRecreatedTheSchema() {
        val store = store()
        store.insertLocationSample(sample)
        store.deleteAllData()

        opener.next = atVersion("0")
        assertEquals(StoreException.SCHEMA_MISMATCH, expectThrows<StoreException> { store.insertLocationSample(sample) }.code)

        opener.next = { FakeDatabase() }
        store.insertLocationSample(sample)
        // The new file is opened with the new key, not the old one.
        assertEquals(3, opener.keys.size)
        assertNotEquals(opener.keys.first(), opener.keys.last())
    }

    @Test
    fun deleteAllDataWorksWhenTheKeyIsAlreadyLost() {
        val store = store()
        store.insertLocationSample(sample)
        store.close()
        wrapper.loseKey()
        assertEquals(StoreException.KEY_UNAVAILABLE, expectThrows<StoreException> { store.check() }.code)

        store.deleteAllData()
        assertTrue(paths.databaseFiles.none { it.exists() })
        store.check()
    }

    @Test
    fun readScalarRunsSelectsOnly() {
        val store = store()
        opener.next = { FakeDatabase().apply { values["SELECT max(ts_utc) FROM location_sample"] = "1700000000" } }
        assertEquals("1700000000", store.readScalar("SELECT max(ts_utc) FROM location_sample"))
        expectThrows<IllegalArgumentException> { store.readScalar("DELETE FROM location_sample") }
        expectThrows<IllegalArgumentException> { store.readScalar("PRAGMA user_version = 9") }
    }
}
