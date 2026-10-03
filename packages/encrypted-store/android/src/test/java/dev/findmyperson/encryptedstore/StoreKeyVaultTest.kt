package dev.findmyperson.encryptedstore

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StoreKeyVaultTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val wrapper = SoftwareKeyWrapper()
    private fun keyFile() = File(folder.root, "fmp-store/${StoreContract.KEY_FILE_NAME}")
    private fun vault() = StoreKeyVault(keyFile(), wrapper)

    @Test
    fun theFirstCallMakesA32ByteKeyAndLaterCallsReturnIt() {
        val vault = vault()
        val key = vault.getOrCreateKeyHex()
        assertTrue(Regex("^[0-9a-f]{64}$").matches(key))
        assertEquals(key, vault.getOrCreateKeyHex())
    }

    @Test
    fun theKeySurvivesAnAppRestart() {
        val key = vault().getOrCreateKeyHex()
        // A new process: nothing in memory survives, the file and the Keystore key do.
        assertEquals(key, vault().getOrCreateKeyHex())
    }

    @Test
    fun theKeyIsNotOnDiskInTheClear() {
        val key = vault().getOrCreateKeyHex()
        val onDisk = keyFile().readBytes()
        assertFalse(String(onDisk, Charsets.ISO_8859_1).contains(key))
        val raw = key.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        assertFalse(String(onDisk, Charsets.ISO_8859_1).contains(String(raw, Charsets.ISO_8859_1)))
        assertFalse(File(keyFile().path + ".tmp").exists())
    }

    @Test
    fun aLostWrappingKeyIsReportedAndNeverAnsweredWithANewKey() {
        vault().getOrCreateKeyHex()
        val blob = keyFile().readBytes()
        wrapper.loseKey()

        val error = expectThrows<StoreException> { vault().getOrCreateKeyHex() }
        assertEquals(StoreException.KEY_UNAVAILABLE, error.code)
        // The blob is untouched: minting a key here would orphan every stored row.
        assertArrayEquals(blob, keyFile().readBytes())
    }

    @Test
    fun aDamagedKeyFileIsReported() {
        vault().getOrCreateKeyHex()
        keyFile().writeBytes(byteArrayOf(12, 1, 2, 3))
        assertEquals(StoreException.KEY_UNAVAILABLE, expectThrows<StoreException> { vault().getOrCreateKeyHex() }.code)
        keyFile().writeBytes(ByteArray(0))
        assertEquals(StoreException.KEY_UNAVAILABLE, expectThrows<StoreException> { vault().getOrCreateKeyHex() }.code)
    }

    @Test
    fun destroyRotatesTheKeyAndTheKeyThatWrappedIt() {
        val vault = vault()
        val old = vault.getOrCreateKeyHex()
        val oldBlob = keyFile().readBytes()

        vault.destroy()
        assertFalse(keyFile().exists())
        assertEquals(1, wrapper.destroyed)

        val fresh = vault.getOrCreateKeyHex()
        assertNotEquals(old, fresh)
        // The old blob is dead: its wrapping key no longer exists.
        expectThrows<Exception> { wrapper.unwrap(oldBlob) }
    }

    @Test
    fun destroyIsTheWayOutOfALostKey() {
        vault().getOrCreateKeyHex()
        wrapper.loseKey()
        val vault = vault()
        vault.destroy()
        assertTrue(Regex("^[0-9a-f]{64}$").matches(vault.getOrCreateKeyHex()))
    }

    @Test
    fun destroyWithNothingStoredIsHarmless() {
        vault().destroy()
        assertFalse(keyFile().exists())
    }
}
