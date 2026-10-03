package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The spec's method contracts, run against the production state machine. The cases follow
 * src/fake.test.ts, which is the executable form of the spec's comments: where the fake and
 * this module would disagree, the two platforms would drift.
 */
class CaptureEngineTest {
    private val shared = arrayOf(
        DiagnosticEvents.MODE_CHANGED,
        DiagnosticEvents.CAPTURE_STARTED,
        DiagnosticEvents.CAPTURE_STOPPED,
        DiagnosticEvents.START_FAILED,
    )

    @Test
    fun `before anything is asked or started, the status says so`() {
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        assertEquals(
            CaptureStatus(
                running = false,
                mode = null,
                tier = CaptureTier.STOPPED,
                permission = PermissionState.UNDETERMINED,
                health = listOf(HealthFlag.BACKGROUND_PERMISSION_MISSING),
                lastSampleTsUtc = null,
                samplesLast24h = 0,
                expectedLast24h = 0,
            ),
            h.engine.status(),
        )
        assertEquals("stopped", h.engine.status().toWire()["mode"])
    }

    // ---- start ----

    @Test
    fun `the default mode is WorkManager, with no foreground service`() {
        val h = Harness()
        h.engine.start(h.config())
        val status = h.engine.status()
        assertTrue(status.running)
        assertEquals(CaptureMode.WM, status.mode)
        assertEquals(CaptureTier.PERIODIC_WORK, status.tier)
        assertEquals(emptyList<HealthFlag>(), status.health)
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)
        assertEquals(900L, h.mechanisms.workPeriodSec)
        assertTrue("the watchdog runs whenever a mode is selected", h.mechanisms.watchdogScheduled)
        assertFalse(h.mechanisms.serviceAlive)
    }

    @Test
    fun `start needs at least foreground permission`() {
        val states = listOf<FakeDevice.() -> Unit>(
            { grantNothing() },
            { restricted = true },
        )
        for (arrange in states) {
            val h = Harness(device = FakeDevice().apply(arrange))
            assertEquals(ErrorCode.PERMISSION_DENIED, codeOf { h.engine.start(h.config()) })
            assertEquals(emptyList<String>(), h.mechanisms.transitions)
            assertNull(h.engine.status().mode)
        }
        // A refusal the user already gave is the third state that cannot start.
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        h.engine.onPermissionPromptShown(PermissionStep.FOREGROUND)
        assertEquals(PermissionState.DENIED, h.engine.permissionState())
        assertEquals(ErrorCode.PERMISSION_DENIED, codeOf { h.engine.start(h.config()) })
    }

    @Test
    fun `with foreground permission only, capture runs throttled and says why`() {
        val h = Harness(device = FakeDevice().apply { grantForegroundOnly() })
        h.engine.start(h.config())
        val status = h.engine.status()
        assertTrue(status.running)
        assertEquals(CaptureMode.WM, status.mode)
        assertEquals(CaptureTier.THROTTLED, status.tier)
        assertEquals(listOf(HealthFlag.BACKGROUND_PERMISSION_MISSING), status.health)
    }

    @Test
    fun `an invalid config is rejected and leaves the running mode alone`() {
        val h = Harness()
        h.engine.start(h.config())
        val invalid = listOf(
            h.config(minIntervalSec = 0.0),
            h.config(minIntervalSec = Double.NaN),
            h.config(minDistanceM = -1.0),
            h.config(accuracy = "best"),
            h.config(accuracy = null),
            h.config(useForegroundService = true, notificationTitle = " "),
            h.config(useForegroundService = true, notificationTitle = null),
        )
        for (config in invalid) {
            assertEquals(ErrorCode.INVALID_ARGUMENT, codeOf { h.engine.start(config) })
        }
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)
        assertTrue(h.engine.status().running)
    }

    @Test
    fun `start with the same config again does nothing, and resets no schedule`() {
        val h = Harness()
        h.engine.start(h.config())
        val eventsSoFar = h.listener.statuses.size
        h.engine.start(h.config())
        // The notification text is not used in mode wm, so changing it is not a change.
        h.engine.start(h.config(notificationTitle = "another title"))
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)
        assertEquals(eventsSoFar, h.listener.statuses.size)
    }

    @Test
    fun `start with a changed cadence restarts the same mode`() {
        val h = Harness()
        h.engine.start(h.config())
        h.engine.start(h.config(minIntervalSec = 1800.0))
        assertEquals(listOf("start:wm", "stop:wm", "start:wm"), h.mechanisms.transitions)
        assertEquals(1800L, h.mechanisms.workPeriodSec)
    }

    @Test
    fun `WorkManager cannot run more often than every 15 minutes, and the log says so`() {
        val h = Harness()
        h.engine.start(h.config(minIntervalSec = 300.0))
        assertEquals(900L, h.mechanisms.workPeriodSec)
        assertEquals(listOf("interval_clamped:900"), h.log.lines(DiagnosticEvents.INTERVAL_CLAMPED))
        // The foreground service has no such floor.
        h.engine.start(h.config(minIntervalSec = 300.0, useForegroundService = true))
        assertEquals(300L, h.mechanisms.servicePlan?.intervalSec)
    }

    // ---- switching the mode at runtime ----

    @Test
    fun `switching stops the active mode, then starts the other, in both directions`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = false))
        h.engine.start(h.config(useForegroundService = true))
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureMode.FGS, it.mode)
            assertEquals(CaptureTier.FOREGROUND_SERVICE, it.tier)
        }
        h.engine.start(h.config(useForegroundService = false))
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureMode.WM, it.mode)
            assertEquals(CaptureTier.PERIODIC_WORK, it.tier)
        }
        assertEquals(
            listOf("start:wm", "stop:wm", "start:fgs", "stop:fgs", "start:wm"),
            h.mechanisms.transitions,
        )
        assertEquals(1, h.mechanisms.peakAlive)
    }

    @Test
    fun `a switch is recorded in the diagnostics the way the M0 trial apps log it`() {
        val h = Harness()
        h.engine.start(h.config())
        h.engine.start(h.config(useForegroundService = true))
        h.engine.stop()
        assertEquals(
            listOf(
                "mode_changed:wm",
                "capture_started:wm",
                "capture_stopped:wm",
                "mode_changed:fgs",
                "capture_started:fgs",
                "capture_stopped:fgs",
                "mode_changed:stopped",
            ),
            h.log.lines(*shared),
        )
    }

    @Test
    fun `a switch tells listeners the new mode`() {
        val h = Harness()
        h.engine.start(h.config())
        h.engine.start(h.config(useForegroundService = true))
        assertEquals(listOf(CaptureMode.WM, CaptureMode.FGS), h.listener.statuses.map { it.mode })
        assertTrue(h.listener.statuses.all { it.running })
    }

    @Test
    fun `the foreground service gets its notification text and cadence from the config`() {
        val h = Harness()
        h.engine.start(
            h.config(useForegroundService = true, notificationTitle = "Title", notificationBody = "Body", accuracy = "high"),
        )
        assertEquals(ServicePlan("Title", "Body", 900, Accuracy.HIGH), h.mechanisms.servicePlan)
        assertEquals(h.mechanisms.servicePlan, h.engine.servicePlan())
    }

    @Test
    fun `changing the notification text restarts the foreground service`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.engine.start(h.config(useForegroundService = true, notificationBody = "new text"))
        assertEquals(listOf("start:fgs", "stop:fgs", "start:fgs"), h.mechanisms.transitions)
        assertEquals("new text", h.mechanisms.servicePlan?.notificationBody)
    }

    @Test
    fun `there are never two mechanisms alive, even when calls overlap`() {
        val h = Harness()
        val pool = Executors.newFixedThreadPool(8)
        val go = CountDownLatch(1)
        val jobs = (0 until 64).map { i ->
            pool.submit {
                go.await()
                h.engine.start(h.config(useForegroundService = i % 2 == 1))
            }
        }
        go.countDown()
        jobs.forEach { it.get(30, TimeUnit.SECONDS) }
        pool.shutdown()
        assertEquals(1, h.mechanisms.peakAlive)
        val alive = (if (h.mechanisms.workScheduled) 1 else 0) + (if (h.mechanisms.serviceAlive) 1 else 0)
        assertEquals(1, alive)
        assertTrue(h.engine.status().running)
    }

    @Test
    fun `when the OS refuses the foreground service, the selection is kept and the status says so`() {
        val h = Harness()
        h.engine.start(h.config())
        h.mechanisms.refuseService = "ForegroundServiceStartNotAllowedException"
        assertEquals(ErrorCode.START_FAILED, codeOf { h.engine.start(h.config(useForegroundService = true)) })

        val status = h.engine.status()
        assertFalse(status.running)
        assertEquals(CaptureMode.FGS, status.mode)
        assertEquals(CaptureTier.STOPPED, status.tier)
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), status.health)
        assertEquals(
            listOf("start_failed:ForegroundServiceStartNotAllowedException"),
            h.log.lines(DiagnosticEvents.START_FAILED),
        )
        assertEquals(1, h.mechanisms.peakAlive)

        // The module's own watchdog retries without JavaScript.
        h.mechanisms.refuseService = null
        h.engine.onWatchdog()
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureMode.FGS, it.mode)
            assertEquals(emptyList<HealthFlag>(), it.health)
        }
    }

    @Test
    fun `a rejected start changes nothing when the store is unusable`() {
        val h = Harness()
        h.engine.start(h.config())
        h.store.failure = "schema is version 2, this build writes version 1"
        assertEquals(ErrorCode.STORE_UNUSABLE, codeOf { h.engine.start(h.config(useForegroundService = true)) })
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)
        assertEquals(CaptureMode.WM, h.engine.status().mode)
        assertTrue(h.engine.status().running)
    }

    // ---- stop ----

    @Test
    fun `stop stops the mechanism and clears the selection`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.engine.stop()
        h.engine.status().let {
            assertFalse(it.running)
            assertNull(it.mode)
            assertEquals(CaptureTier.STOPPED, it.tier)
            assertEquals(emptyList<HealthFlag>(), it.health)
        }
        assertNull(h.engine.servicePlan())
        assertFalse(h.mechanisms.watchdogScheduled)
        assertEquals(listOf("start:fgs", "stop:fgs"), h.mechanisms.transitions)

        // Nothing restarts it, and stopping again is harmless.
        h.engine.onWatchdog()
        h.engine.restore(CaptureEngine.RestoreReason.BOOT)
        h.engine.stop()
        assertEquals(listOf("start:fgs", "stop:fgs"), h.mechanisms.transitions)
        h.engine.onServiceFixes(listOf(h.location.fixAt()))
        assertEquals(0, h.store.samples.size)
    }

    // ---- the capture path ----

    @Test
    fun `a stored fix is announced with its time, accuracy and source only`() {
        val h = Harness()
        h.engine.start(h.config())
        h.location.accuracyM = 12.0
        assertEquals(CaptureEngine.WakeOutcome.STORED, h.runWork())

        assertEquals(listOf(SampleWrittenEvent(T0, 12.0, "wm")), h.listener.written)
        h.engine.status().let {
            assertEquals(T0, it.lastSampleTsUtc)
            assertEquals(1, it.samplesLast24h)
        }
        val sample = h.store.samples.single()
        assertEquals(T0, sample.tsUtc)
        assertEquals(HOME_LAT, sample.lat, 0.0)
        assertEquals(HOME_LON, sample.lon, 0.0)
        assertEquals(12.0, sample.accuracyM, 0.0)
        assertEquals("wm", sample.source)
        val cells = H3.sampleCells(HOME_LAT, HOME_LON)
        assertEquals(cells.h3R7, sample.h3R7)
        assertEquals(cells.h3R5, sample.h3R5)
    }

    @Test
    fun `each sample is labelled with the mode that captured it`() {
        val h = Harness()
        h.engine.start(h.config())
        h.runWork()
        h.engine.start(h.config(useForegroundService = true))
        h.advance(900)
        h.deliverToService(h.location.fixAt())
        assertEquals(listOf("wm", "fgs"), h.listener.written.map { it.source })
    }

    @Test
    fun `a fix is kept when enough time has passed or the phone has moved enough`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.deliverToService(h.location.fixAt())
        assertEquals(1, h.store.samples.size)

        h.advance(60)
        h.deliverToService(h.location.fixAt(lat = NEAR_HOME_LAT))
        assertEquals("55 m in a minute is neither", 1, h.store.samples.size)
        h.deliverToService(h.location.fixAt(lat = FAR_LAT))
        assertEquals("1.1 km is a move", 2, h.store.samples.size)

        // A phone sitting still is still sampled once per interval: stays are built from these.
        h.advance(899)
        h.deliverToService(h.location.fixAt(lat = FAR_LAT))
        assertEquals(2, h.store.samples.size)
        h.advance(1)
        h.deliverToService(h.location.fixAt(lat = FAR_LAT))
        assertEquals(3, h.store.samples.size)
    }

    @Test
    fun `a batch of fixes is filtered in the order the fixes were taken`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        // Batched delivery after a quiet spell: four fixes at once, handed over out of order.
        h.advance(3600)
        h.deliverToService(
            h.location.fixAt(tsUtc = T0 + 1800),
            h.location.fixAt(tsUtc = T0),
            h.location.fixAt(tsUtc = T0 + 2700),
            h.location.fixAt(tsUtc = T0 + 1000),
        )
        assertEquals(listOf(T0, T0 + 1000, T0 + 2700), h.store.samples.map { it.tsUtc })
        assertEquals(listOf("capture_wake:fgs:stored=3,filtered=1"), h.log.lines(DiagnosticEvents.CAPTURE_WAKE))
    }

    @Test
    fun `a fix that is not a place, or has no accuracy, is not stored`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.deliverToService(
            h.location.fixAt(lat = 91.0),
            h.location.fixAt(lon = -181.0),
            h.location.fixAt(lat = Double.NaN),
            h.location.fixAt(accuracyM = null),
            h.location.fixAt(accuracyM = -1.0),
        )
        assertEquals(0, h.store.samples.size)
        assertEquals(listOf("capture_wake:fgs:stored=0,filtered=0,invalid=5"), h.log.lines(DiagnosticEvents.CAPTURE_WAKE))
    }

    @Test
    fun `a fix that arrives after the mode was switched or stopped is dropped`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        val late = h.location.fixAt()
        h.engine.start(h.config(useForegroundService = false))
        h.engine.onServiceFixes(listOf(late))
        h.engine.stop()
        h.engine.onServiceFixes(listOf(late))
        assertEquals(CaptureEngine.WakeOutcome.SKIPPED, h.engine.onWorkWake(h.location))
        assertEquals(0, h.store.samples.size)
    }

    @Test
    fun `a removed listener hears nothing more`() {
        val h = Harness()
        h.engine.start(h.config())
        h.runWork()
        h.engine.removeListener(h.listener)
        h.advance(900)
        h.runWork()
        assertEquals(1, h.listener.written.size)
        assertEquals(2, h.store.samples.size)
    }

    // ---- the capture-rate numbers ----

    @Test
    fun `one sample per interval is expected while a mode is selected, over the last 24 hours`() {
        val h = Harness()
        h.engine.start(h.config(minIntervalSec = 900.0))
        h.advance(2 * 3600)
        assertEquals(8, h.engine.status().expectedLast24h)

        h.engine.stop()
        h.advance(3600)
        assertEquals(8, h.engine.status().expectedLast24h)

        // 23 hours later the two selected hours begin to leave the window; an hour on, they are gone.
        h.advance(22 * 3600)
        assertEquals(4, h.engine.status().expectedLast24h)
        h.advance(3600)
        assertEquals(0, h.engine.status().expectedLast24h)
    }

    @Test
    fun `only samples from the last 24 hours are counted`() {
        val h = Harness()
        h.engine.start(h.config())
        h.runWork()
        h.advance(86_400 - 900)
        h.runWork()
        h.engine.status().let {
            assertEquals(2, it.samplesLast24h)
            assertEquals(T0 + 86_400 - 900, it.lastSampleTsUtc)
        }
        h.advance(901)
        h.engine.status().let {
            assertEquals(1, it.samplesLast24h)
            assertEquals(96, it.expectedLast24h)
        }
    }

    // ---- debugInjectSample ----

    @Test
    fun `debugInjectSample stores a manual sample, past the filter and without capture running`() {
        val h = Harness()
        h.engine.debugInjectSample(HOME_LAT, HOME_LON, (T0 - 100).toDouble(), 5.0)
        h.engine.debugInjectSample(HOME_LAT, HOME_LON, (T0 - 99).toDouble(), 5.0)
        assertEquals(
            listOf(SampleWrittenEvent(T0 - 100, 5.0, "manual"), SampleWrittenEvent(T0 - 99, 5.0, "manual")),
            h.listener.written,
        )
        assertEquals(listOf("manual", "manual"), h.store.samples.map { it.source })
        assertEquals(2, h.engine.status().samplesLast24h)
    }

    @Test
    fun `debugInjectSample rejects values that are out of range`() {
        val h = Harness()
        assertEquals(ErrorCode.INVALID_ARGUMENT, codeOf { h.engine.debugInjectSample(91.0, 0.0, T0.toDouble(), 5.0) })
        assertEquals(ErrorCode.INVALID_ARGUMENT, codeOf { h.engine.debugInjectSample(0.0, 181.0, T0.toDouble(), 5.0) })
        assertEquals(ErrorCode.INVALID_ARGUMENT, codeOf { h.engine.debugInjectSample(0.0, 0.0, Double.NaN, 5.0) })
        assertEquals(ErrorCode.INVALID_ARGUMENT, codeOf { h.engine.debugInjectSample(0.0, 0.0, T0.toDouble(), -1.0) })
        assertEquals(0, h.store.samples.size)
    }

    @Test
    fun `debugInjectSample does not exist in a release build`() {
        val h = Harness(debugBuild = false)
        assertEquals(ErrorCode.NOT_AVAILABLE, codeOf { h.engine.debugInjectSample(HOME_LAT, HOME_LON, T0.toDouble(), 5.0) })
        assertEquals(0, h.store.samples.size)
    }

    @Test
    fun `debugInjectSample reports an unusable store`() {
        val h = Harness()
        h.store.failure = "store did not decrypt"
        assertEquals(ErrorCode.STORE_UNUSABLE, codeOf { h.engine.debugInjectSample(HOME_LAT, HOME_LON, T0.toDouble(), 5.0) })
        assertEquals(listOf(HealthFlag.STORE_UNUSABLE), h.engine.status().health)
    }

    // ---- diagnostics ----

    @Test
    fun `getDiagnostics returns entries from a time on, oldest first`() {
        val h = Harness()
        h.engine.start(h.config())
        h.advance(100)
        h.engine.stop()
        val all = h.engine.diagnosticsSince(0.0)
        assertEquals(all.sortedBy { it.tsUtc }, all)
        val late = h.engine.diagnosticsSince((T0 + 1).toDouble())
        assertTrue(late.isNotEmpty())
        assertTrue(late.all { it.tsUtc == T0 + 100 })
        assertTrue(late.any { it.event == DiagnosticEvents.MODE_CHANGED && it.detail == "stopped" })
        // A fractional bound must not let an earlier entry in.
        assertEquals(late, h.engine.diagnosticsSince(T0 + 0.5))
    }
}
