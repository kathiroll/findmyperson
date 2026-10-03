package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Every `HealthFlag` Android can raise, each produced by the condition it stands for and
 * cleared when the condition ends. A flag is never set by hand: a test changes the device,
 * the mechanism or the store, and reads the status.
 *
 * The conditions themselves are read from Android in platform/AndroidDeviceConditions.kt; which
 * system call backs each field is listed in README.md.
 */
class HealthFlagTest {
    private fun running(device: FakeDevice = FakeDevice(), fgs: Boolean = false): Harness {
        val h = Harness(device = device)
        h.engine.start(h.config(useForegroundService = fgs))
        return h
    }

    private fun Harness.health(): List<HealthFlag> = engine.status().health

    @Test
    fun `a healthy, fully set-up phone raises nothing`() {
        assertEquals(emptyList<HealthFlag>(), running().health())
    }

    @Test
    fun `background_permission_missing whenever permission is not always`() {
        val h = running()
        h.device.background = false
        assertEquals(listOf(HealthFlag.BACKGROUND_PERMISSION_MISSING), h.health())
        assertEquals(CaptureTier.THROTTLED, h.engine.status().tier)
        h.device.background = true
        assertEquals(emptyList<HealthFlag>(), h.health())

        // It describes the device, so it is reported before capture is ever started.
        val fresh = Harness(device = FakeDevice().apply { grantNothing() })
        assertEquals(listOf(HealthFlag.BACKGROUND_PERMISSION_MISSING), fresh.health())
    }

    @Test
    fun `precise_location_off when the user granted approximate location only`() {
        val h = running()
        h.device.fine = false
        assertEquals(listOf(HealthFlag.PRECISE_LOCATION_OFF), h.health())
        h.device.fine = true
        assertEquals(emptyList<HealthFlag>(), h.health())

        // No permission at all is a different problem and is not reported as "imprecise".
        h.device.grantNothing()
        assertFalse(HealthFlag.PRECISE_LOCATION_OFF in h.health())
    }

    @Test
    fun `location_services_off when location is switched off for the whole phone`() {
        val h = running()
        h.device.locationServicesOn = false
        assertEquals(listOf(HealthFlag.LOCATION_SERVICES_OFF), h.health())
        h.device.locationServicesOn = true
        assertEquals(emptyList<HealthFlag>(), h.health())
    }

    @Test
    fun `service_not_running when the selected mechanism is not alive, in either mode`() {
        val wm = running()
        wm.mechanisms.loseWork()
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), wm.health())
        assertFalse(wm.engine.status().running)
        assertEquals(CaptureTier.STOPPED, wm.engine.status().tier)
        wm.engine.onWatchdog()
        assertEquals(emptyList<HealthFlag>(), wm.health())

        val fgs = running(fgs = true)
        fgs.mechanisms.killService()
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), fgs.health())
        fgs.engine.onWatchdog()
        assertEquals(emptyList<HealthFlag>(), fgs.health())

        // The only flag that is about capture and not the device: never raised while stopped.
        fgs.engine.stop()
        assertEquals(emptyList<HealthFlag>(), fgs.health())
    }

    @Test
    fun `store_unusable from a failed check, until a later check passes`() {
        val h = running()
        h.store.failure = "schema is version 2, this build writes version 1"
        assertEquals(ErrorCode.STORE_UNUSABLE, codeOf { h.engine.initStore() })
        assertEquals(listOf(HealthFlag.STORE_UNUSABLE), h.health())
        assertEquals(
            listOf("store_unusable:schema is version 2, this build writes version 1"),
            h.log.lines(DiagnosticEvents.STORE_UNUSABLE),
        )

        h.store.failure = null
        h.engine.initStore()
        assertEquals(emptyList<HealthFlag>(), h.health())
        assertEquals(listOf("store_usable:"), h.log.lines(DiagnosticEvents.STORE_USABLE))
    }

    @Test
    fun `store_unusable from a failed write on a background wake, and nothing is written meanwhile`() {
        val h = running()
        h.store.failure = "store did not decrypt with the pinned parameters"
        assertEquals(CaptureEngine.WakeOutcome.STORE_UNUSABLE, h.runWork())
        assertEquals(listOf(HealthFlag.STORE_UNUSABLE), h.health())
        assertEquals(listOf(HealthFlag.STORE_UNUSABLE), h.listener.statuses.last().health)
        assertEquals(0, h.store.samples.size)
        assertTrue(h.listener.written.isEmpty())
        // Logged once, not once per wake.
        h.advance(900)
        h.runWork()
        assertEquals(1, h.log.lines(DiagnosticEvents.STORE_UNUSABLE).size)

        // The module repeats the check by itself: the next wake that can write clears the flag.
        h.store.failure = null
        h.advance(900)
        assertEquals(CaptureEngine.WakeOutcome.STORED, h.runWork())
        assertEquals(emptyList<HealthFlag>(), h.health())
    }

    @Test
    fun `the store failure is still reported by a new process that has not checked yet`() {
        val h = running()
        h.store.failure = "store did not decrypt"
        h.runWork()
        h.restartProcess()
        assertTrue(HealthFlag.STORE_UNUSABLE in h.health())
    }

    @Test
    fun `battery_optimisation_active while the app is not exempt, or is restricted outright`() {
        val h = running()
        h.device.ignoringBatteryOptimisations = false
        assertEquals(listOf(HealthFlag.BATTERY_OPTIMISATION_ACTIVE), h.health())
        h.device.ignoringBatteryOptimisations = true
        assertEquals(emptyList<HealthFlag>(), h.health())

        h.device.backgroundRestricted = true
        assertEquals(listOf(HealthFlag.BATTERY_OPTIMISATION_ACTIVE), h.health())
        h.device.backgroundRestricted = false
        assertEquals(emptyList<HealthFlag>(), h.health())
    }

    @Test
    fun `hibernation_not_exempt while the platform may hibernate the app`() {
        val h = running()
        h.device.hibernation = Hibernation.NOT_EXEMPT
        assertEquals(listOf(HealthFlag.HIBERNATION_NOT_EXEMPT), h.health())
        h.device.hibernation = Hibernation.EXEMPT
        assertEquals(emptyList<HealthFlag>(), h.health())
        // A phone with no hibernation has nothing to be exempted from.
        h.device.hibernation = Hibernation.NOT_AVAILABLE
        assertEquals(emptyList<HealthFlag>(), h.health())
    }

    @Test
    fun `oem_restriction_suspected when the wakes that should have happened did not`() {
        val h = running()
        // Six hours in which the job ran every 15 minutes.
        repeat(24) {
            h.runWork()
            h.advance(900)
        }
        assertEquals(emptyList<HealthFlag>(), h.health())

        // Then the phone stops running it. The schedule is intact; nothing else can tell.
        h.advance(13 * 3600)
        assertEquals(listOf(HealthFlag.OEM_RESTRICTION_SUSPECTED), h.health())
        assertTrue(h.engine.status().running)

        // Wakes return, and once they cover the window again the flag clears.
        repeat(96) {
            h.runWork()
            h.advance(900)
        }
        assertEquals(emptyList<HealthFlag>(), h.health())
    }

    @Test
    fun `oem_restriction_suspected is raised in mode fgs from missing heartbeats`() {
        val h = running(fgs = true)
        repeat(24) {
            h.engine.onServiceHeartbeat()
            h.advance(900)
        }
        assertEquals(emptyList<HealthFlag>(), h.health())
        h.advance(13 * 3600)
        assertEquals(listOf(HealthFlag.OEM_RESTRICTION_SUSPECTED), h.health())
    }

    @Test
    fun `flags appear in the spec's order, and a change is sent to listeners once`() {
        val h = running()
        val before = h.listener.statuses.size
        h.device.hibernation = Hibernation.NOT_EXEMPT
        h.device.ignoringBatteryOptimisations = false
        h.device.locationServicesOn = false
        h.device.fine = false
        h.device.background = false
        h.mechanisms.loseWork()
        h.engine.refresh()
        h.engine.refresh()

        val expected = listOf(
            HealthFlag.BACKGROUND_PERMISSION_MISSING,
            HealthFlag.PRECISE_LOCATION_OFF,
            HealthFlag.LOCATION_SERVICES_OFF,
            HealthFlag.SERVICE_NOT_RUNNING,
            HealthFlag.BATTERY_OPTIMISATION_ACTIVE,
            HealthFlag.HIBERNATION_NOT_EXEMPT,
        )
        assertEquals(expected, h.health())
        assertEquals(expected, expected.sortedBy { it.ordinal })
        assertEquals("one event for one change", before + 1, h.listener.statuses.size)
        assertEquals(expected, h.listener.statuses.last().health)
        assertEquals(
            "health_changed:" + expected.joinToString(",") { it.wire },
            h.log.lines(DiagnosticEvents.HEALTH_CHANGED).last(),
        )
    }
}
