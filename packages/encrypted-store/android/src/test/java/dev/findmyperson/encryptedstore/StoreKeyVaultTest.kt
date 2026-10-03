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
        val onDisk = keyFile().readText(Charsets.US_ASCII)
        assertFalse(onDisk.contains(key))
        assertFalse(File(keyFile().path + ".tmp").exists())
    }

    @Test
    fun theFileIsTheFormatTheCaptureModuleReadsAndWrites() {
        // base64(iv) ":" base64(ciphertext) of the hex key, in store-key.wrapped: what
        // KeystoreStoreKey in packages/native-location-capture/android writes.
        val key = vault().getOrCreateKeyHex()
        assertEquals("store-key.wrapped", keyFile().name)
        val parts = keyFile().readText(Charsets.US_ASCII).split(":")
        assertEquals(2, parts.size)
        val decoder = java.util.Base64.getDecoder()
        val plain = wrapper.unwrap(WrappedKey(decoder.decode(parts[0]), decoder.decode(parts[1])))
        assertEquals(key, String(plain, Charsets.US_ASCII))

        // And the reverse: a file written that way by the other implementation is read here.
        val foreign = "ab".repeat(32)
        val wrapped = wrapper.wrap(foreign.toByteArray(Charsets.US_ASCII))
        val encoder = java.util.Base64.getEncoder()
        keyFile().writeText(encoder.encodeToString(wrapped.iv) + ":" + encoder.encodeToString(wrapped.ciphertext) + "\n")
        assertEquals(foreign, vault().getOrCreateKeyHex())
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
        for (damaged in listOf("", "not base64 at all", "AAAA", "AAAA:BBBB:CCCC", "AAAAAAAAAAAAAAAA:AAAA")) {
            keyFile().writeText(damaged)
            assertEquals(damaged, StoreException.KEY_UNAVAILABLE, expectThrows<StoreException> { vault().getOrCreateKeyHex() }.code)
        }
    }

    @Test
    fun aStoredValueThatIsNotAKeyIsReported() {
        val wrapped = wrapper.wrap("not a key".toByteArray(Charsets.US_ASCII))
        val encoder = java.util.Base64.getEncoder()
        keyFile().parentFile.mkdirs()
        keyFile().writeText(encoder.encodeToString(wrapped.iv) + ":" + encoder.encodeToString(wrapped.ciphertext))
        assertEquals(StoreException.KEY_UNAVAILABLE, expectThrows<StoreException> { vault().getOrCreateKeyHex() }.code)
    }

    @Test
    fun destroyRotatesTheKeyAndTheKeyThatWrappedIt() {
        val vault = vault()
        val old = vault.getOrCreateKeyHex()
        val oldBlob = wrapper.wrap(old.toByteArray(Charsets.US_ASCII))

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
