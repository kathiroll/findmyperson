package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Retention with no JavaScript running, and the answer the weekly VACUUM waits for.
 *
 * The full purge is TypeScript (packages/shared, retention/) and runs when the app does. A
 * phone on which the app is never opened is woken only by the mechanisms of this module, so
 * its wakes purge fixes and stays too. What the purge does to a store is in StoreContractTest,
 * on the real schema; here the store is the fake, and the tests are about when it is asked.
 */
class RetentionTest {
    private val day = 86_400L

    private fun running(fgs: Boolean = false): Harness {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = fgs))
        return h
    }

    private fun Harness.storedTimes(): List<Long> = store.samples.map { it.tsUtc }

    // ---- purge on wake ----

    @Test
    fun `a phone whose app is never opened still holds no more than thirty days`() {
        val h = running()
        // Forty days of the periodic job, one run every fifteen minutes, and no JavaScript.
        repeat(40 * 96) {
            h.runWork()
            h.advance(900)
        }
        val oldest = h.storedTimes().min()
        assertTrue("oldest fix is ${(h.clock.now - oldest) / day} days old", oldest >= h.clock.now - RETENTION_SEC - CaptureEngine.PURGE_INTERVAL_SEC)
        assertEquals(h.clock.now - 900, h.storedTimes().max())
        // An hour's worth past the cutoff at most, never the forty days that were captured.
        assertTrue(h.store.samples.size in (30 * 96)..(30 * 96 + 5))
    }

    @Test
    fun `the periodic job purges on its wake, at most once an hour`() {
        val h = running()
        h.runWork()
        assertEquals(listOf(T0), h.store.purges)

        repeat(3) {
            h.advance(900)
            h.runWork()
        }
        assertEquals(listOf(T0), h.store.purges)

        h.advance(900)
        h.runWork()
        assertEquals(listOf(T0, T0 + 3600), h.store.purges)
    }

    @Test
    fun `what a purge removed is in the diagnostics, as counts, and a purge of nothing is not`() {
        val h = running()
        h.runWork()
        assertEquals(emptyList<String>(), h.log.lines(DiagnosticEvents.RETENTION_PURGE))

        h.advance(RETENTION_SEC + 3600)
        h.runWork()
        assertEquals(listOf("retention_purge:samples=1,stays=0,trimmed=0"), h.log.lines(DiagnosticEvents.RETENTION_PURGE))
        assertEquals(listOf(h.clock.now), h.storedTimes())
    }

    @Test
    fun `a wake that gets no fix still purges`() {
        val h = running()
        h.runWork()
        h.advance(RETENTION_SEC + 3600)
        h.location.position = null

        assertEquals(CaptureEngine.WakeOutcome.NO_FIX, h.runWork())
        assertEquals(emptyList<Long>(), h.storedTimes())
    }

    @Test
    fun `the watchdog purges when the capture job itself no longer runs`() {
        val h = running()
        h.runWork()
        // A force stop, or a vendor's battery manager: the job is gone and only the watchdog comes.
        h.mechanisms.loseWork()
        h.mechanisms.refuseWork = "work manager is not available"
        h.advance(RETENTION_SEC + 3600)

        h.engine.onWatchdog()
        assertEquals(emptyList<Long>(), h.storedTimes())
        assertEquals(listOf(T0, h.clock.now), h.store.purges)
    }

    @Test
    fun `the foreground service purges on a delivery, not on every one`() {
        val h = running(fgs = true)
        h.deliverToService(h.location.fixAt())
        repeat(10) {
            h.advance(180)
            h.deliverToService(h.location.fixAt())
        }
        assertEquals(listOf(T0), h.store.purges)

        h.advance(RETENTION_SEC + 3600)
        h.deliverToService(h.location.fixAt())
        assertEquals(listOf(h.clock.now), h.storedTimes())
    }

    @Test
    fun `a new process purges on its first wake`() {
        val h = running()
        h.runWork()
        h.advance(900)
        h.restartProcess()
        h.runWork()
        assertEquals(listOf(T0, T0 + 900), h.store.purges)
    }

    @Test
    fun `a clock that was set back does not put the purge off`() {
        val h = running()
        h.advance(10 * day)
        h.runWork()
        // Ten days back: an hour "since the last purge" would take ten days to pass.
        h.clock.now = T0
        h.runWork()
        assertEquals(listOf(T0 + 10 * day, T0), h.store.purges)
    }

    @Test
    fun `a purge that fails is logged, changes nothing about capture, and is tried at the next wake`() {
        val h = running()
        h.store.purgeFailure = "SQLiteDatabaseLockedException: database is locked"

        assertEquals(CaptureEngine.WakeOutcome.STORED, h.runWork())
        assertEquals(listOf("retention_purge_failed:SQLiteDatabaseLockedException: database is locked"), h.log.lines(DiagnosticEvents.RETENTION_PURGE_FAILED))
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertTrue(h.engine.status().running)

        h.store.purgeFailure = null
        h.advance(900)
        h.runWork()
        assertEquals(listOf(T0 + 900), h.store.purges)
    }

    @Test
    fun `an unusable store is not purged, and is purged again once it is back`() {
        val h = running()
        h.store.failure = "SCHEMA_VERSION: store schema is version 2, this build writes version 1"
        assertEquals(CaptureEngine.WakeOutcome.STORE_UNUSABLE, h.runWork())
        assertEquals(emptyList<Long>(), h.store.purges)
        // The write path has already said why; the purge adds no second line for the same thing.
        assertEquals(emptyList<String>(), h.log.lines(DiagnosticEvents.RETENTION_PURGE_FAILED))

        h.store.failure = null
        h.advance(900)
        h.runWork()
        assertEquals(listOf(T0 + 900), h.store.purges)
    }

    @Test
    fun `nothing is purged for a job that runs with nothing selected`() {
        val h = Harness()
        h.mechanisms.workScheduled = true
        assertEquals(CaptureEngine.WakeOutcome.SKIPPED, h.runWork())
        h.engine.onWatchdog()
        assertEquals(emptyList<Long>(), h.store.purges)
    }

    // ---- getDeviceConditions ----

    @Test
    fun `on battery and in use, the phone is neither charging nor idle`() {
        val h = Harness()
        assertEquals(MaintenanceConditions(charging = false, idle = false), h.engine.deviceConditions())
    }

    @Test
    fun `charging is external power`() {
        val h = Harness()
        h.device.onExternalPower = true
        assertEquals(MaintenanceConditions(charging = true, idle = false), h.engine.deviceConditions())
        h.device.onExternalPower = false
        assertFalse(h.engine.deviceConditions().charging)
    }

    @Test
    fun `idle is the screen off, or the app not on it`() {
        val h = Harness()
        h.device.screenOn = false
        assertTrue(h.engine.deviceConditions().idle)

        // Screen on, somebody is using the phone, but another app: only the service or a job runs here.
        h.device.screenOn = true
        h.device.appInForeground = false
        assertTrue(h.engine.deviceConditions().idle)

        h.device.appInForeground = true
        assertFalse(h.engine.deviceConditions().idle)
    }

    @Test
    fun `on a charger overnight it is both, which is what the vacuum waits for`() {
        val h = Harness()
        h.device.onExternalPower = true
        h.device.screenOn = false
        h.device.appInForeground = false
        assertEquals(MaintenanceConditions(charging = true, idle = true), h.engine.deviceConditions())
    }

    @Test
    fun `it is read at the moment of the call, with capture stopped and with no permission`() {
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        h.device.onExternalPower = true
        h.device.screenOn = false
        assertEquals(MaintenanceConditions(charging = true, idle = true), h.engine.deviceConditions())
        h.device.onExternalPower = false
        assertEquals(MaintenanceConditions(charging = false, idle = true), h.engine.deviceConditions())
        assertEquals(emptyList<CaptureStatus>(), h.listener.statuses)
    }

    @Test
    fun `when Android will not say, the answer is the one that makes the vacuum wait`() {
        val h = Harness()
        h.device.onExternalPower = true
        h.device.screenOn = false
        h.device.powerUnreadable = true
        assertEquals(MaintenanceConditions(charging = false, idle = false), h.engine.deviceConditions())
    }

    @Test
    fun `what crosses the bridge is exactly the two fields of the spec`() {
        assertEquals(
            mapOf<String, Any?>("charging" to true, "idle" to false),
            MaintenanceConditions(charging = true, idle = false).toWire(),
        )
    }
}
