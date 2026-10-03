package dev.findmyperson.encryptedstore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreKeysTest {
    @Test
    fun keyLiteralMatchesTheSharedGoldenVector() {
        assertEquals(StoreContract.KEY_VECTOR_LITERAL, StoreKeys.keyLiteral(StoreContract.KEY_VECTOR_HEX))
        assertEquals(StoreContract.KEY_VECTOR_LITERAL, StoreKeys.keyLiteral(StoreContract.KEY_VECTOR_HEX.uppercase()))
    }

    @Test
    fun malformedKeysAreRejected() {
        for (bad in listOf("", "zz".repeat(32), "ab".repeat(31), "ab".repeat(33), "ab".repeat(32) + "'")) {
            expectThrows<IllegalArgumentException> { StoreKeys.keyLiteral(bad) }
        }
    }

    @Test
    fun aRandomKeyIs32BytesAndDiffersEachTime() {
        val first = StoreKeys.randomKey()
        val second = StoreKeys.randomKey()
        assertEquals(StoreContract.KEY_BYTES, first.size)
        assertNotEquals(StoreKeys.toHex(first), StoreKeys.toHex(second))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(StoreKeys.toHex(first)))
        assertEquals("x'${StoreKeys.toHex(first)}'", StoreKeys.keyLiteral(StoreKeys.toHex(first)))
    }
}
