package dev.findmyperson.locationcapture.platform

import dev.findmyperson.locationcapture.Contracts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The parts of the Android layer that can be checked without a phone: what the manifest
 * declares (a missing line there is a silent failure on a device, months later) and the order
 * in which settings pages are tried.
 */
class ManifestAndSettingsTest {
    private val android = "http://schemas.android.com/apk/res/android"
    private val manifest: Element = DocumentBuilderFactory.newInstance()
        .apply { isNamespaceAware = true }
        .newDocumentBuilder()
        .parse(Contracts.manifest())
        .documentElement

    private fun elements(tag: String): List<Element> {
        val nodes = manifest.getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun Element.attr(name: String): String = getAttributeNS(android, name)

    @Test
    fun `the manifest asks for exactly the permissions the module needs`() {
        assertEquals(
            setOf(
                "android.permission.ACCESS_FINE_LOCATION",
                "android.permission.ACCESS_COARSE_LOCATION",
                "android.permission.ACCESS_BACKGROUND_LOCATION",
                "android.permission.FOREGROUND_SERVICE",
                "android.permission.FOREGROUND_SERVICE_LOCATION",
                "android.permission.RECEIVE_BOOT_COMPLETED",
                // Not capture's: without it `isActiveNetworkMetered` throws, and every
                // connection would count as metered.
                "android.permission.ACCESS_NETWORK_STATE",
            ),
            elements("uses-permission").map { it.attr("name") }.toSet(),
        )
    }

    @Test
    fun `the capture service is a private foreground service of type location`() {
        val service = elements("service").single()
        assertEquals(".platform.CaptureService", service.attr("name"))
        assertEquals(CaptureService::class.java.name, "dev.findmyperson.locationcapture" + service.attr("name"))
        assertEquals("location", service.attr("foregroundServiceType"))
        assertEquals("false", service.attr("exported"))
    }

    @Test
    fun `the boot receiver hears a reboot and a replaced package, and nothing before first unlock`() {
        val receiver = elements("receiver").single()
        assertEquals(BootReceiver::class.java.name, "dev.findmyperson.locationcapture" + receiver.attr("name"))
        val actions = elements("action").filter { it.parentNode.parentNode == receiver }.map { it.attr("name") }
        assertEquals(
            listOf("android.intent.action.BOOT_COMPLETED", "android.intent.action.MY_PACKAGE_REPLACED"),
            actions,
        )
    }

    @Test
    fun `the hibernation status can be queried on Android 11 and later`() {
        val queried = elements("queries").single().getElementsByTagName("action").item(0) as Element
        assertEquals("android.intent.action.AUTO_REVOKE_PERMISSIONS", queried.attr("name"))
    }

    @Test
    fun `backup is left to the app's manifest`() {
        // Plan C2.3 tests that the app sets allowBackup=false. A library that set it too would
        // only cause a manifest-merge conflict.
        assertFalse(elements("application").single().hasAttributeNS(android, "allowBackup"))
    }

    @Test
    fun `work names are stable, because WorkManager stores them on the phone`() {
        assertEquals("fmp_capture", AndroidMechanisms.CAPTURE_WORK)
        assertEquals("fmp_capture_watchdog", AndroidMechanisms.WATCHDOG_WORK)
        assertEquals(1L, AndroidMechanisms.WATCHDOG_PERIOD_HOURS)
    }

    // ---- settings pages ----

    @Test
    fun `phone makers are recognised from the manufacturer string`() {
        assertEquals(Brand.XIAOMI, Brand.detect("Xiaomi"))
        assertEquals(Brand.XIAOMI, Brand.detect("Redmi"))
        assertEquals(Brand.XIAOMI, Brand.detect("POCO"))
        assertEquals(Brand.ONEPLUS, Brand.detect("OnePlus"))
        assertEquals(Brand.SAMSUNG, Brand.detect(" samsung "))
        assertEquals(Brand.OTHER, Brand.detect("Google"))
        assertEquals(Brand.OTHER, Brand.detect(null))
    }

    @Test
    fun `while the app is battery-optimised, the battery target opens Android's own page`() {
        for (brand in Brand.entries) {
            assertEquals(
                listOf(BatteryPages.BATTERY_OPTIMISATION, BatteryPages.APP_DETAILS),
                BatteryPages.order(batteryOptimised = true, brand = brand),
            )
        }
    }

    @Test
    fun `once it is not, the phone maker's pages come first, and there is always a fallback`() {
        assertEquals("miui_autostart", BatteryPages.order(false, Brand.XIAOMI).first())
        assertEquals("oneplus_autolaunch", BatteryPages.order(false, Brand.ONEPLUS).first())
        // The one vendor page the M0 field trial saw open on a real phone.
        assertEquals("samsung_battery", BatteryPages.order(false, Brand.SAMSUNG).first())
        for (brand in Brand.entries) {
            val order = BatteryPages.order(false, brand)
            assertEquals(listOf(BatteryPages.BATTERY_OPTIMISATION, BatteryPages.APP_DETAILS), order.takeLast(2))
            assertEquals(order.distinct(), order)
        }
        assertTrue(BatteryPages.order(false, Brand.OTHER).size == 2)
    }
}
