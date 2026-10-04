package dev.findmyperson.locationcapture.core

import dev.findmyperson.locationcapture.Contracts
import dev.findmyperson.locationcapture.Contracts.objects
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The answer the bundle fetcher waits for: whether the active connection is metered.
 *
 * The fetcher is TypeScript (packages/shared, fetch/) and puts a cycle off on a metered
 * connection. What Android says is read in platform/AndroidDeviceConditions.kt; here the device
 * is the fake, and the tests are about what the engine answers from it.
 */
class NetworkConditionsTest {
    @Test
    fun `on mobile data the connection is metered`() {
        val h = Harness()
        assertEquals(NetworkConditions(metered = true), h.engine.networkConditions())
    }

    @Test
    fun `on a network Android does not count as metered, it is not`() {
        val h = Harness()
        h.device.activeNetworkMetered = false
        assertEquals(NetworkConditions(metered = false), h.engine.networkConditions())
        h.device.activeNetworkMetered = true
        assertTrue(h.engine.networkConditions().metered)
    }

    @Test
    fun `it is read at the moment of the call, with capture stopped and with no permission`() {
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        h.device.activeNetworkMetered = false
        assertFalse(h.engine.networkConditions().metered)
        h.device.activeNetworkMetered = true
        assertTrue(h.engine.networkConditions().metered)
        assertEquals(emptyList<CaptureStatus>(), h.listener.statuses)
        assertEquals(emptyList<String>(), h.log.lines())
    }

    @Test
    fun `when Android will not say, the answer is the one that makes the fetcher wait`() {
        val h = Harness()
        h.device.activeNetworkMetered = false
        h.device.networkUnreadable = true
        assertEquals(NetworkConditions(metered = true), h.engine.networkConditions())
        assertEquals(NetworkRules.UNKNOWN, h.engine.networkConditions())
    }

    @Test
    fun `what crosses the bridge is exactly the one field of the spec`() {
        assertEquals(mapOf<String, Any?>("metered" to false), NetworkConditions(metered = false).toWire())

        val module = Contracts.json(Contracts.module("schema.json"))
            .getJSONObject("modules").getJSONObject("NativeLocationCapture")
        val fields = module.getJSONObject("aliasMap").getJSONObject("NetworkConditions")
            .getJSONArray("properties").objects().map { it.getString("name") }
        assertEquals(NetworkConditions(metered = true).toWire().keys.toList(), fields)
    }
}
