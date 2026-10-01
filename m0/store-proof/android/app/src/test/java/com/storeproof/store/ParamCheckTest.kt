package com.storeproof.store

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** The mismatch path of the native open, driven by a fake pragma reader (real SQLCipher needs a device). */
class ParamCheckTest {
    private val pinned = CipherParams.READ_BACK.toMap()

    @Test fun pinnedValuesPass() {
        ParamCheck.requireMatch { pinned[it] }
    }

    @Test fun differentKdfIterationCountFailsLoudly() {
        val e = assertThrows(StoreOpenException::class.java) {
            ParamCheck.requireMatch { if (it == "kdf_iter") "1000" else pinned[it] }
        }
        assertEquals("PARAM_MISMATCH", e.code)
        assertTrue(e.message!!, e.message!!.contains("kdf_iter: pinned 256000, effective 1000"))
    }

    @Test fun unreadablePragmaFailsLoudly() {
        val e = assertThrows(StoreOpenException::class.java) {
            ParamCheck.requireMatch { if (it == "cipher_page_size") null else pinned[it] }
        }
        assertTrue(e.message!!, e.message!!.contains("cipher_page_size: pinned 4096, effective unreadable"))
    }

    @Test fun missingOrWrongSqlcipherVersionIsRejected() {
        assertThrows(StoreOpenException::class.java) { ParamCheck.requireSqlcipherMajor(null) }
        assertThrows(StoreOpenException::class.java) { ParamCheck.requireSqlcipherMajor("3.4.2") }
        ParamCheck.requireSqlcipherMajor("4.19.0 community")
    }
}
