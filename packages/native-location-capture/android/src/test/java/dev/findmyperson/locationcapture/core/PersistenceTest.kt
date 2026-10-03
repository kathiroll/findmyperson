package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * What survives a process: the selection (so a reboot restarts the same mode with no
 * JavaScript running), the ledger behind the capture-rate numbers, and the diagnostics.
 * These run on the real file-backed implementations.
 */
class PersistenceTest {
    @get:Rule
    val temp = TemporaryFolder()

    private fun onDisk(directory: File, mechanisms: FakeMechanisms = FakeMechanisms(), clock: FakeClock = FakeClock()) =
        Harness(
            clock = clock,
            stateStore = FileStateStore(directory),
            diagnostics = FileDiagnosticsLog(directory),
            mechanisms = mechanisms,
        )

    @Test
    fun `the state file round-trips every field`() {
        val store = FileStateStore(temp.root)
        assertEquals(CaptureState(), store.load())
        val state = CaptureState(
            selection = CaptureConfig(
                minIntervalSec = 900.5,
                minDistanceM = 100.0,
                accuracy = Accuracy.HIGH,
                useForegroundService = true,
                notificationTitle = "Título: «findmyperson» = on\\off",
                notificationBody = "two\nlines, a tab\t, a # and a !",
            ),
            intervalSec = 900.5,
            periods = listOf(Period(T0 - 5000, T0 - 4000), Period(T0, null)),
            sampleTimes = listOf(T0, T0 + 900),
            newestSampleTsUtc = T0 + 900,
            lastStoredTsUtc = T0 + 900,
            wakes = listOf(T0, T0 + 900, T0 + 1800),
            askedForeground = true,
            storeFailure = "schema is version 2, this build writes version 1",
            loggedHealth = "background_permission_missing,store_unusable",
            loggedPermission = "foreground_only",
            loggedStandbyBucket = "rare",
        )
        store.save(state)
        assertEquals(state, FileStateStore(temp.root).load())

        store.save(CaptureState())
        assertEquals(CaptureState(), FileStateStore(temp.root).load())
    }

    @Test
    fun `a new process restores the selected mode, config and counters from disk`() {
        val directory = temp.newFolder()
        val clock = FakeClock()
        val mechanisms = FakeMechanisms()
        val first = onDisk(directory, mechanisms, clock)
        first.engine.start(first.config(useForegroundService = true, notificationTitle = "Title", minIntervalSec = 1800.0))
        first.deliverToService(first.location.fixAt())
        clock.now += 3600

        // The process is gone; a boot receiver builds everything again from the files.
        mechanisms.killService()
        val second = onDisk(directory, mechanisms, clock)
        second.engine.status().let {
            assertEquals(CaptureMode.FGS, it.mode)
            assertEquals(listOf(HealthFlag.SERVICE_NOT_RUNNING), it.health)
            assertEquals(T0, it.lastSampleTsUtc)
            assertEquals(1, it.samplesLast24h)
            assertEquals(2, it.expectedLast24h)
        }
        second.engine.restore(CaptureEngine.RestoreReason.BOOT)
        assertEquals(ServicePlan("Title", first.config().notificationBody!!, 1800, Accuracy.BALANCED), mechanisms.servicePlan)
        assertTrue(second.engine.status().running)

        // The diagnostics of both processes are one log.
        val events = second.engine.diagnosticsSince(0.0).map { it.event }
        assertTrue(events.containsAll(listOf("mode_changed", "capture_started", "capture_wake", "boot_restart")))
    }

    @Test
    fun `after stop, a new process restarts nothing`() {
        val directory = temp.newFolder()
        val mechanisms = FakeMechanisms()
        val first = onDisk(directory, mechanisms)
        first.engine.start(first.config())
        first.engine.stop()

        val second = onDisk(directory, mechanisms)
        second.engine.restore(CaptureEngine.RestoreReason.BOOT)
        second.engine.onWatchdog()
        assertNull(second.engine.status().mode)
        assertEquals(listOf("start:wm", "stop:wm"), mechanisms.transitions)
    }

    @Test
    fun `a state file that cannot be read means nothing is selected, and the log says so`() {
        val directory = temp.newFolder()
        val first = onDisk(directory)
        first.engine.start(first.config())
        File(directory, "capture-state.properties").writeText("version=1\nselection.minIntervalSec=not a number\n")

        val second = onDisk(directory)
        assertNull(second.engine.status().mode)
        assertTrue(second.engine.diagnosticsSince(0.0).any { it.event == DiagnosticEvents.STATE_RESET })
        // It is usable again from there.
        second.engine.start(second.config())
        assertEquals(CaptureMode.WM, onDisk(directory, second.mechanisms).engine.status().mode)
    }

    @Test
    fun `a state file of an unknown version is not guessed at`() {
        File(temp.root, "capture-state.properties").writeText("version=99\n")
        assertEquals("IllegalStateException", FileStateStore(temp.root).load().loadProblem)
    }

    @Test
    fun `the first fix after a restart is held to the interval, because the last position is not on disk`() {
        val directory = temp.newFolder()
        val clock = FakeClock()
        val mechanisms = FakeMechanisms()
        val first = onDisk(directory, mechanisms, clock)
        first.engine.start(first.config())
        first.runWork()

        val second = onDisk(directory, mechanisms, clock)
        second.location.position = FAR_LAT to HOME_LON
        clock.now += 60
        assertEquals(CaptureEngine.WakeOutcome.FILTERED, second.runWork())
        clock.now += 840
        assertEquals(CaptureEngine.WakeOutcome.STORED, second.runWork())
        // From here the process knows the last position again, and a move passes at once.
        second.location.position = HOME_LAT to HOME_LON
        clock.now += 60
        assertEquals(CaptureEngine.WakeOutcome.STORED, second.runWork())
    }

    // ---- the diagnostics file ----

    @Test
    fun `diagnostics entries come back in order, whatever text they hold`() {
        val log = FileDiagnosticsLog(temp.root)
        log.append(DiagnosticEntry(T0, "start_failed", "a\ttab, a\nnewline"))
        log.append(DiagnosticEntry(T0 + 1, "watchdog_ok", ""))
        assertEquals(
            listOf(
                DiagnosticEntry(T0, "start_failed", "a tab, a newline"),
                DiagnosticEntry(T0 + 1, "watchdog_ok", ""),
            ),
            FileDiagnosticsLog(temp.root).since(0),
        )
        assertEquals(listOf("watchdog_ok"), log.since(T0 + 1).map { it.event })
    }

    @Test
    fun `the diagnostics are bounded by rotation and keep the newest entries`() {
        val log = FileDiagnosticsLog(temp.root, maxEntriesPerFile = 100)
        repeat(1_000) { log.append(DiagnosticEntry(T0 + it, "capture_wake", "wm:stored:current")) }
        val kept = log.since(0)
        assertTrue("between one and two files' worth is kept", kept.size in 100..200)
        assertEquals(T0 + 999, kept.last().tsUtc)
        assertEquals(kept.sortedBy { it.tsUtc }, kept)
        assertTrue(temp.root.listFiles()!!.size <= 2)

        // A new process continues the same files and the same bound.
        val again = FileDiagnosticsLog(temp.root, maxEntriesPerFile = 100)
        repeat(150) { again.append(DiagnosticEntry(T0 + 1_000 + it, "watchdog_ok", "")) }
        assertTrue(again.since(0).size in 100..200)
        assertEquals(T0 + 1_149, again.since(0).last().tsUtc)
    }

    @Test
    fun `a line damaged by a killed process is skipped, and the rest is read`() {
        val log = FileDiagnosticsLog(temp.root)
        log.append(DiagnosticEntry(T0, "capture_started", "wm"))
        File(temp.root, "diagnostics.log").appendText("17800")
        assertEquals(listOf(DiagnosticEntry(T0, "capture_started", "wm")), FileDiagnosticsLog(temp.root).since(0))
    }
}
