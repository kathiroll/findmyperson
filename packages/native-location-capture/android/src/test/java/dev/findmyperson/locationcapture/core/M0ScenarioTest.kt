package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The scenarios the M0 Android spike (plan S0.2, m0/android/README.md "Cable tests") checked by
 * hand with a phone and adb, as automated regressions: screen-off overnight, forced Doze,
 * forced App Standby, reboot, 72 hours untouched, a replaced package, hibernation, and the
 * foreground service being refused. Each runs for both modes where the spike ran both.
 *
 * What these prove is the module's own behaviour when Android does those things: that it
 * keeps or regains its mechanism, stores what it is handed, and reports the gap honestly.
 * What Android really does on a given phone is not something a unit test can know; that is
 * the field trial's job, and README.md lists it as unverified.
 */
class M0ScenarioTest {
    /**
     * Plays the phone over time, in steps of one minute: runs the periodic job and the hourly
     * watchdog when they are due and the phone lets them run, and feeds the foreground service
     * a fix per interval and a heartbeat while it is alive.
     */
    private class Phone(val h: Harness) {
        /** Doze: WorkManager jobs are deferred. A foreground service keeps receiving fixes. */
        var dozing = false

        /** A vendor battery manager freezes the app: nothing of it runs at all. */
        var frozen = false

        /** App Standby: of the job runs that fall due, only every n-th happens. */
        var runEveryNthJob = 1

        private var nextWorkAt = h.clock.now
        private var nextWatchdogAt = h.clock.now + 3600
        private var nextServiceFixAt = h.clock.now
        private var dueJobs = 0

        fun run(seconds: Long) {
            val end = h.clock.now + seconds
            while (h.clock.now < end) {
                h.advance(60)
                step()
            }
        }

        private fun step() {
            val now = h.clock.now
            val period = h.mechanisms.workPeriodSec ?: 900
            if (h.mechanisms.workScheduled && now >= nextWorkAt && !dozing && !frozen) {
                nextWorkAt = now + period
                if (dueJobs++ % runEveryNthJob == 0) h.runWork()
            }
            if (h.mechanisms.watchdogScheduled && now >= nextWatchdogAt && !dozing && !frozen) {
                nextWatchdogAt = now + 3600
                h.engine.onWatchdog()
            }
            if (h.mechanisms.serviceAlive && now >= nextServiceFixAt && !frozen) {
                nextServiceFixAt = now + (h.mechanisms.servicePlan?.intervalSec ?: 900)
                h.engine.onServiceHeartbeat()
                h.deliverToService(h.location.fixAt())
            }
        }
    }

    private fun started(useForegroundService: Boolean, device: FakeDevice = FakeDevice()): Phone {
        val h = Harness(device = device)
        h.engine.start(h.config(useForegroundService = useForegroundService))
        return Phone(h)
    }

    private fun Harness.rate(): Double = engine.status().let { it.samplesLast24h.toDouble() / it.expectedLast24h }

    // ---- screen-off overnight ----

    @Test
    fun `overnight with the screen off, mode wm stores a sample every interval`() {
        val phone = started(useForegroundService = false)
        phone.run(8 * 3600)
        val h = phone.h
        assertEquals(32, h.store.samples.size)
        assertTrue(h.store.samples.all { it.source == "wm" })
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureTier.PERIODIC_WORK, it.tier)
            assertEquals(emptyList<HealthFlag>(), it.health)
            assertEquals(32, it.samplesLast24h)
            assertEquals(32, it.expectedLast24h)
        }
    }

    @Test
    fun `overnight with the screen off, mode fgs stores a sample every interval`() {
        val phone = started(useForegroundService = true)
        phone.run(8 * 3600)
        val h = phone.h
        assertEquals(32, h.store.samples.size)
        assertTrue(h.store.samples.all { it.source == "fgs" })
        assertEquals(CaptureTier.FOREGROUND_SERVICE, h.engine.status().tier)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertFalse("no periodic job runs beside a healthy service", h.mechanisms.workScheduled)
    }

    // ---- forced Doze, then unforce ----

    @Test
    fun `forced Doze in mode wm leaves a gap, and capture resumes by itself afterwards`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(3600)
        val before = h.store.samples.size

        phone.dozing = true
        phone.run(3 * 3600)
        assertEquals("nothing runs in Doze", before, h.store.samples.size)

        phone.dozing = false
        phone.run(3600)
        assertTrue("capture resumed without a restart", h.store.samples.size >= before + 4)
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)
        assertTrue("the job kept its schedule, so the watchdog had nothing to restart",
            h.log.lines(DiagnosticEvents.WATCHDOG_RESTART).isEmpty())
        assertTrue(h.log.lines(DiagnosticEvents.WATCHDOG_OK).isNotEmpty())
        // The gap is visible in the capture rate, which is the number the app shows.
        assertEquals(20, h.engine.status().expectedLast24h)
        assertTrue(h.rate() < 0.5)
    }

    @Test
    fun `after Doze, a recent cached fix is used when no fresh one comes, and a stale one is not`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(900)
        val stored = h.store.samples.size
        h.location.position = null

        // The platform's cache holds a fix from before the last stored sample: not news.
        h.location.cached = h.location.fixAt(tsUtc = h.clock.now - 7200)
        h.advance(900)
        assertEquals(CaptureEngine.WakeOutcome.NO_FIX, h.runWork())
        assertEquals(stored, h.store.samples.size)

        // Another app got a fix five minutes ago: that is where the phone was, then.
        val cachedAt = h.clock.now - 300
        h.location.cached = h.location.fixAt(tsUtc = cachedAt)
        assertEquals(CaptureEngine.WakeOutcome.STORED, h.runWork())
        assertEquals(cachedAt, h.store.samples.last().tsUtc)
        assertEquals("the row carries the time of the fix, not of the run", cachedAt, h.listener.written.last().tsUtc)

        val wakes = h.log.lines(DiagnosticEvents.CAPTURE_WAKE)
        assertEquals("capture_wake:wm:no_fix", wakes[wakes.size - 2])
        assertEquals("capture_wake:wm:stored:last_known", wakes.last())
    }

    @Test
    fun `forced Doze in mode fgs keeps storing, and a batch delivered late loses nothing`() {
        val phone = started(useForegroundService = true)
        val h = phone.h
        phone.dozing = true
        phone.run(2 * 3600)
        assertEquals("a foreground service is not deferred by Doze", 8, h.store.samples.size)

        // Batching (maxUpdateDelay) hands over several fixes at once after a quiet spell.
        val now = h.clock.now
        h.deliverToService(
            h.location.fixAt(tsUtc = now + 900),
            h.location.fixAt(tsUtc = now + 1800),
            h.location.fixAt(tsUtc = now + 2700),
        )
        assertEquals(11, h.store.samples.size)
        assertEquals(h.store.samples.map { it.tsUtc }.sorted(), h.store.samples.map { it.tsUtc })
    }

    // ---- forced App Standby ----

    @Test
    fun `in a restricted standby bucket capture thins out, and the status and the log say so`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(3600)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)

        h.device.standbyBucket = "rare"
        phone.runEveryNthJob = 6
        phone.run(12 * 3600)

        assertTrue("still capturing, at the rate the OS allows", h.store.samples.size in 8..20)
        assertTrue(h.engine.status().running)
        assertTrue(h.rate() < 0.4)
        assertEquals(listOf("standby_bucket:rare"), h.log.lines(DiagnosticEvents.STANDBY_BUCKET))
        assertEquals(listOf("start:wm"), h.mechanisms.transitions)

        // Back in an active bucket it recovers by itself.
        h.device.standbyBucket = "active"
        phone.runEveryNthJob = 1
        val before = h.store.samples.size
        phone.run(3600)
        assertEquals(before + 4, h.store.samples.size)
        assertEquals(listOf("standby_bucket:rare", "standby_bucket:active"), h.log.lines(DiagnosticEvents.STANDBY_BUCKET))
    }

    // ---- reboot ----

    @Test
    fun `after a reboot mode wm continues with no JavaScript and no new schedule`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(3600)
        val before = h.store.samples.size

        h.reboot()
        assertEquals(listOf("boot_restart:"), h.log.lines(DiagnosticEvents.BOOT_RESTART))
        assertEquals("WorkManager kept the job; restoring must not reset it", listOf("start:wm"), h.mechanisms.transitions)
        assertTrue(h.engine.status().running)

        Phone(h).run(3600)
        assertTrue(h.store.samples.size >= before + 4)
        assertEquals(CaptureMode.WM, h.engine.status().mode)
    }

    @Test
    fun `after a reboot mode wm is rescheduled if WorkManager lost the job`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        h.mechanisms.loseWork()
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), h.engine.status().health)

        h.reboot()
        assertEquals(listOf("start:wm", "killed:wm", "start:wm"), h.mechanisms.transitions)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
    }

    @Test
    fun `after a reboot mode fgs comes back with the same notification text`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true, notificationTitle = "Title", notificationBody = "Body"))
        Phone(h).run(1800)

        h.reboot()
        assertEquals(listOf("start:fgs", "killed:fgs", "start:fgs"), h.mechanisms.transitions)
        assertEquals(ServicePlan("Title", "Body", 900, Accuracy.BALANCED), h.mechanisms.servicePlan)
        assertEquals(listOf("boot_restart:"), h.log.lines(DiagnosticEvents.BOOT_RESTART))
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureTier.FOREGROUND_SERVICE, it.tier)
        }
        val before = h.store.samples.size
        Phone(h).run(1800)
        assertTrue(h.store.samples.size > before)
    }

    @Test
    fun `when Android refuses the service after a reboot, the periodic job captures until the app is opened`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        Phone(h).run(1800)
        val before = h.store.samples.size

        // Android 12+ refuses a foreground service started from the background.
        h.mechanisms.refuseService = "ForegroundServiceStartNotAllowedException"
        h.reboot()
        h.engine.status().let {
            assertFalse(it.running)
            assertEquals(CaptureMode.FGS, it.mode)
            assertEquals(CaptureTier.STOPPED, it.tier)
            assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), it.health)
        }
        assertTrue("the fallback job is scheduled", h.mechanisms.workScheduled)
        assertEquals(listOf("fallback_started:"), h.log.lines(DiagnosticEvents.FALLBACK_STARTED))

        // It degrades instead of going silent: samples keep arriving, labelled as what they are.
        Phone(h).run(4 * 3600)
        val fallbackSamples = h.store.samples.drop(before)
        assertTrue(fallbackSamples.size >= 15)
        assertTrue(fallbackSamples.all { it.source == "wm" })
        assertTrue(h.log.lines(DiagnosticEvents.CAPTURE_WAKE).any { it == "capture_wake:fallback:stored:current" })
        // The watchdog kept trying, and the log has one fallback_started, not one per attempt.
        assertTrue(h.log.lines(DiagnosticEvents.WATCHDOG_RESTART).size >= 3)
        assertEquals(1, h.log.lines(DiagnosticEvents.FALLBACK_STARTED).size)
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), h.engine.status().health)

        // The user opens the app: a foreground start is allowed, and the fallback ends.
        h.mechanisms.refuseService = null
        h.engine.restore(CaptureEngine.RestoreReason.APP_LAUNCH)
        assertTrue(h.mechanisms.serviceAlive)
        assertFalse(h.mechanisms.workScheduled)
        assertEquals(listOf("fallback_stopped:"), h.log.lines(DiagnosticEvents.FALLBACK_STOPPED))
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertEquals(1, h.mechanisms.peakAlive)
    }

    // ---- 72 hours untouched ----

    @Test
    fun `72 hours untouched in mode wm, capture holds and the ledger stays bounded`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(72 * 3600)

        assertEquals(288, h.store.samples.size)
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(emptyList<HealthFlag>(), it.health)
            assertEquals(96, it.samplesLast24h)
            assertEquals(96, it.expectedLast24h)
        }
        assertEquals("one watchdog run an hour", 72, h.log.lines(DiagnosticEvents.WATCHDOG_OK).size)
        assertTrue(h.log.lines(DiagnosticEvents.WATCHDOG_RESTART).isEmpty())
        // The persisted state does not grow with uptime.
        val saved = (h.stateStore as MemoryStateStore).saved
        assertTrue(saved.sampleTimes.size <= 97)
        assertTrue(saved.wakes.size <= 24 * 12 + 1)
        assertEquals(1, saved.periods.size)
    }

    @Test
    fun `72 hours untouched in mode fgs, a killed process is noticed and restarted by the watchdog`() {
        val phone = started(useForegroundService = true)
        val h = phone.h
        phone.run(20 * 3600)
        val before = h.store.samples.size

        // The OS kills the process in the night. Nothing of the app runs until the next wake.
        h.restartProcess()
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), h.engine.status().health)

        Phone(h).run(52 * 3600)
        assertEquals(listOf("watchdog_restart:fgs"), h.log.lines(DiagnosticEvents.WATCHDOG_RESTART))
        assertEquals(listOf("start:fgs", "killed:fgs", "start:fgs"), h.mechanisms.transitions)
        assertTrue(h.store.samples.size >= before + 200)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertEquals(1, h.mechanisms.peakAlive)
    }

    @Test
    fun `a phone whose vendor freezes the app is flagged, and unflagged once it runs again`() {
        val phone = started(useForegroundService = false)
        val h = phone.h
        phone.run(2 * 3600)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)

        // The M0 finding: no crash, no restart, the phone just stops running the app.
        phone.frozen = true
        phone.run(10 * 3600)
        h.engine.status().let {
            assertTrue("the schedule is intact, which is why nothing else notices", it.running)
            assertEquals(listOf(HealthFlag.OEM_RESTRICTION_SUSPECTED), it.health)
        }

        phone.frozen = false
        phone.run(24 * 3600)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertTrue(h.log.lines(DiagnosticEvents.HEALTH_CHANGED).contains("health_changed:oem_restriction_suspected"))
    }

    // ---- the app is replaced (adb install -r, an update) ----

    @Test
    fun `a replaced package restarts the selected mode and is logged as the trial app logged it`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.restartProcess()
        h.engine.restore(CaptureEngine.RestoreReason.PACKAGE_REPLACED)
        assertEquals(listOf("boot_restart:package_replaced"), h.log.lines(DiagnosticEvents.BOOT_RESTART))
        assertTrue(h.engine.status().running)
    }

    // ---- hibernation ----

    @Test
    fun `hibernation resets the permission, and the status reports it instead of pretending`() {
        val device = FakeDevice().apply { hibernation = Hibernation.NOT_EXEMPT }
        val phone = started(useForegroundService = false, device = device)
        val h = phone.h
        h.engine.onPermissionPromptShown(PermissionStep.FOREGROUND)
        phone.run(3600)
        assertEquals(listOf(HealthFlag.HIBERNATION_NOT_EXEMPT), h.engine.status().health)
        val before = h.store.samples.size

        // The platform hibernated the app: permissions are gone, and so is every fix.
        h.device.grantNothing()
        h.location.position = null
        phone.run(3600)

        assertEquals(before, h.store.samples.size)
        h.engine.status().let {
            assertEquals(PermissionState.DENIED, it.permission)
            assertEquals(CaptureTier.STOPPED, it.tier)
            assertEquals(
                listOf(HealthFlag.BACKGROUND_PERMISSION_MISSING, HealthFlag.HIBERNATION_NOT_EXEMPT),
                it.health,
            )
        }
        assertEquals(PermissionState.DENIED, h.listener.statuses.last().permission)
        assertTrue(h.log.lines(DiagnosticEvents.PERMISSION_CHANGED).contains("permission_changed:denied"))
        assertEquals("capture_wake:wm:no_fix", h.log.lines(DiagnosticEvents.CAPTURE_WAKE).last())
    }

    // ---- the foreground service is refused or loses its updates ----

    @Test
    fun `a service that cannot get location updates is reported, and the fallback takes over`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        // The trial app logged this as fgs_updates_failed:SecurityException and stopped the service.
        h.mechanisms.killService()
        h.engine.onServiceFailed("SecurityException")

        assertEquals(listOf("start_failed:SecurityException"), h.log.lines(DiagnosticEvents.START_FAILED))
        assertTrue(h.mechanisms.workScheduled)
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), h.engine.status().health)
        assertEquals(CaptureEngine.WakeOutcome.STORED, h.runWork())
    }

    @Test
    fun `a service the OS destroyed is reported, and a service the OS revived ends the fallback`() {
        val h = Harness()
        h.engine.start(h.config(useForegroundService = true))
        h.mechanisms.killService()
        h.engine.onServiceDestroyed()
        assertEquals(listOf("service_destroyed:"), h.log.lines(DiagnosticEvents.SERVICE_DESTROYED))
        assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), h.listener.statuses.last().health)

        h.mechanisms.refuseService = "ForegroundServiceStartNotAllowedException"
        h.engine.onWatchdog()
        assertTrue(h.mechanisms.workScheduled)

        // START_STICKY: the OS recreates the service by itself, without the engine asking.
        h.mechanisms.stopWork()
        h.mechanisms.serviceAlive = true
        h.mechanisms.workScheduled = true
        h.engine.onServiceRevived()
        assertFalse(h.mechanisms.workScheduled)
        assertEquals(emptyList<HealthFlag>(), h.engine.status().health)
        assertEquals("capture_started:fgs", h.log.lines(DiagnosticEvents.CAPTURE_STARTED).last())
    }

    @Test
    fun `a permission granted after start brings back a mechanism that was refused for lack of it`() {
        // The trial app restarted the selected mode on every grant; so does the module.
        val h = Harness(device = FakeDevice().apply { grantForegroundOnly() })
        h.mechanisms.refuseService = "SecurityException"
        assertEquals(ErrorCode.START_FAILED, codeOf { h.engine.start(h.config(useForegroundService = true)) })
        assertFalse(h.engine.status().running)

        h.device.background = true
        h.mechanisms.refuseService = null
        assertEquals(PermissionState.ALWAYS, h.engine.onPermissionAnswered())
        h.engine.status().let {
            assertTrue(it.running)
            assertEquals(CaptureTier.FOREGROUND_SERVICE, it.tier)
            assertEquals(emptyList<HealthFlag>(), it.health)
        }
        assertFalse(h.mechanisms.workScheduled)
    }

    // ---- leftovers ----

    @Test
    fun `a job that runs with nothing selected removes itself`() {
        // The state file was lost (cleared storage) but WorkManager still has the jobs.
        val h = Harness()
        h.mechanisms.workScheduled = true
        h.mechanisms.watchdogScheduled = true
        assertEquals(CaptureEngine.WakeOutcome.SKIPPED, h.engine.onWorkWake(h.location))
        h.engine.onWatchdog()
        assertFalse(h.mechanisms.workScheduled)
        assertFalse(h.mechanisms.watchdogScheduled)
        assertNull(h.engine.servicePlan())
        assertEquals(0, h.store.samples.size)
    }
}
