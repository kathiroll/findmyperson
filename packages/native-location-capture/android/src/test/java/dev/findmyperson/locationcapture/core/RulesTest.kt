package dev.findmyperson.locationcapture.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RulesTest {
    private val config = CaptureConfig(900.0, 100.0, Accuracy.BALANCED, false, "", "")
    private fun fix(lat: Double = HOME_LAT, tsUtc: Long = T0, accuracyM: Double? = 20.0) = Fix(lat, HOME_LON, tsUtc, accuracyM)

    // ---- which fix is stored ----

    @Test
    fun `the first fix is always stored`() {
        assertEquals(SampleFilter.Verdict.STORE, SampleFilter.judge(fix(), null, null, config))
    }

    @Test
    fun `a fix is stored when the interval has passed or the phone has moved`() {
        val last = fix()
        fun judge(lat: Double, after: Long) = SampleFilter.judge(fix(lat, T0 + after), T0, last, config)
        assertEquals(SampleFilter.Verdict.FILTERED, judge(HOME_LAT, 899))
        assertEquals(SampleFilter.Verdict.STORE, judge(HOME_LAT, 900))
        assertEquals(SampleFilter.Verdict.FILTERED, judge(NEAR_HOME_LAT, 60))
        assertEquals(SampleFilter.Verdict.STORE, judge(FAR_LAT, 60))
    }

    @Test
    fun `a zero distance stores every fix, as the config says`() {
        val everything = config.copy(minDistanceM = 0.0)
        assertEquals(SampleFilter.Verdict.STORE, SampleFilter.judge(fix(tsUtc = T0 + 1), T0, fix(), everything))
    }

    @Test
    fun `when the last position is not known, only the interval can pass a fix`() {
        // A new process knows when the last sample was stored but not where: the position
        // exists only inside the encrypted store.
        assertEquals(SampleFilter.Verdict.FILTERED, SampleFilter.judge(fix(FAR_LAT, T0 + 60), T0, null, config))
        assertEquals(SampleFilter.Verdict.STORE, SampleFilter.judge(fix(FAR_LAT, T0 + 900), T0, null, config))
    }

    @Test
    fun `a fix with no accuracy or an impossible position is invalid`() {
        assertEquals(SampleFilter.Verdict.INVALID, SampleFilter.judge(fix(accuracyM = null), null, null, config))
        assertEquals(SampleFilter.Verdict.INVALID, SampleFilter.judge(fix(accuracyM = Double.NaN), null, null, config))
        assertEquals(SampleFilter.Verdict.INVALID, SampleFilter.judge(fix(lat = 90.0001), null, null, config))
        assertEquals(SampleFilter.Verdict.INVALID, SampleFilter.judge(Fix(0.0, 180.0001, T0, 5.0), null, null, config))
    }

    // ---- permission ----

    private fun device(fine: Boolean, coarse: Boolean, background: Boolean, restricted: Boolean = false) =
        FakeDevice().also {
            it.fine = fine
            it.coarse = coarse
            it.background = background
            it.restricted = restricted
        }.snapshot()

    @Test
    fun `the permission state follows what Android granted and whether the prompt was shown`() {
        val none = device(fine = false, coarse = false, background = false)
        assertEquals(PermissionState.UNDETERMINED, PermissionRules.state(none, askedForeground = false))
        assertEquals(PermissionState.DENIED, PermissionRules.state(none, askedForeground = true))
        assertEquals(
            PermissionState.FOREGROUND_ONLY,
            PermissionRules.state(device(fine = true, coarse = true, background = false), true),
        )
        assertEquals(
            "approximate only is still a foreground grant",
            PermissionState.FOREGROUND_ONLY,
            PermissionRules.state(device(fine = false, coarse = true, background = false), true),
        )
        assertEquals(PermissionState.ALWAYS, PermissionRules.state(device(true, true, true), true))
        assertEquals(PermissionState.RESTRICTED, PermissionRules.state(device(true, true, true, restricted = true), true))
    }

    @Test
    fun `permission is asked in two steps, foreground first, and a refusal is not asked again`() {
        val action = PermissionRules::action
        // Foreground: only when never asked.
        assertEquals(PermissionRules.Action.FOREGROUND_DIALOG, action(PermissionStep.FOREGROUND, PermissionState.UNDETERMINED, 34))
        for (state in PermissionState.entries - PermissionState.UNDETERMINED) {
            assertEquals(PermissionRules.Action.NONE, action(PermissionStep.FOREGROUND, state, 34))
        }
        // Background: only on top of a foreground grant.
        for (state in PermissionState.entries - PermissionState.FOREGROUND_ONLY) {
            assertEquals(PermissionRules.Action.NONE, action(PermissionStep.BACKGROUND, state, 34))
        }
        // Android 11+ has no dialog for "Allow all the time"; Android 10 has one.
        assertEquals(PermissionRules.Action.BACKGROUND_SETTINGS, action(PermissionStep.BACKGROUND, PermissionState.FOREGROUND_ONLY, 30))
        assertEquals(PermissionRules.Action.BACKGROUND_SETTINGS, action(PermissionStep.BACKGROUND, PermissionState.FOREGROUND_ONLY, 36))
        assertEquals(PermissionRules.Action.BACKGROUND_DIALOG, action(PermissionStep.BACKGROUND, PermissionState.FOREGROUND_ONLY, 29))
    }

    @Test
    fun `the staged flow, as the engine sees it`() {
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        assertEquals(PermissionRules.Action.NONE, h.engine.permissionAction(PermissionStep.BACKGROUND, 34))
        assertEquals(PermissionRules.Action.FOREGROUND_DIALOG, h.engine.permissionAction(PermissionStep.FOREGROUND, 34))

        h.engine.onPermissionPromptShown(PermissionStep.FOREGROUND)
        h.device.grantForegroundOnly()
        assertEquals(PermissionState.FOREGROUND_ONLY, h.engine.onPermissionAnswered())
        assertEquals(PermissionRules.Action.NONE, h.engine.permissionAction(PermissionStep.FOREGROUND, 34))
        assertEquals(PermissionRules.Action.BACKGROUND_SETTINGS, h.engine.permissionAction(PermissionStep.BACKGROUND, 34))

        // The user comes back from settings without granting: the step can be tried again
        // (the M0 trial saw a Samsung need exactly that second pass).
        h.engine.onPermissionPromptShown(PermissionStep.BACKGROUND)
        assertEquals(PermissionState.FOREGROUND_ONLY, h.engine.onPermissionAnswered())
        assertEquals(PermissionRules.Action.BACKGROUND_SETTINGS, h.engine.permissionAction(PermissionStep.BACKGROUND, 34))

        h.engine.onPermissionPromptShown(PermissionStep.BACKGROUND)
        h.device.background = true
        assertEquals(PermissionState.ALWAYS, h.engine.onPermissionAnswered())
        assertEquals(PermissionRules.Action.NONE, h.engine.permissionAction(PermissionStep.BACKGROUND, 34))

        assertEquals(
            listOf("permission_prompt:foreground", "permission_prompt:background", "permission_prompt:background"),
            h.log.lines(DiagnosticEvents.PERMISSION_PROMPT),
        )
        assertEquals(
            listOf("permission_changed:foreground_only", "permission_changed:always"),
            h.log.lines(DiagnosticEvents.PERMISSION_CHANGED),
        )
    }

    @Test
    fun `a refused foreground prompt is remembered across processes`() {
        val h = Harness(device = FakeDevice().apply { grantNothing() })
        h.engine.onPermissionPromptShown(PermissionStep.FOREGROUND)
        h.restartProcess()
        assertEquals(PermissionState.DENIED, h.engine.permissionState())
        assertEquals(PermissionRules.Action.NONE, h.engine.permissionAction(PermissionStep.FOREGROUND, 34))
    }

    // ---- missed wakes ----

    private fun everyPeriod(from: Long, until: Long, period: Long = 900) = (from until until step period).toList()

    @Test
    fun `no suspicion without enough evidence`() {
        val now = T0 + 5 * 3600
        assertFalse(WakeHeuristic.suspected(now, selectedSince = T0, bootTsUtc = 0, wakePeriodSec = 900, wakes = emptyList()))
        assertFalse(WakeHeuristic.suspected(now, selectedSince = null, bootTsUtc = 0, wakePeriodSec = 900, wakes = emptyList()))
    }

    @Test
    fun `suspected when under a third of the expected wakes happened`() {
        val now = T0 + 12 * 3600
        val healthy = everyPeriod(T0, now)
        assertFalse(WakeHeuristic.suspected(now, T0, 0, 900, healthy))
        // 48 slots: 16 covered is exactly a third and passes, 15 does not.
        assertFalse(WakeHeuristic.suspected(now, T0, 0, 900, healthy.take(16)))
        assertTrue(WakeHeuristic.suspected(now, T0, 0, 900, healthy.take(15)))
        assertTrue(WakeHeuristic.suspected(now, T0, 0, 900, emptyList()))
    }

    @Test
    fun `an ordinary night in Doze is not a suspicion`() {
        // 16 hours of normal use, then 8 hours in which only three maintenance windows ran.
        val now = T0 + 24 * 3600
        val wakes = everyPeriod(T0, T0 + 16 * 3600) + listOf(T0 + 17 * 3600, T0 + 19 * 3600, T0 + 23 * 3600)
        assertFalse(WakeHeuristic.suspected(now, T0, 0, 900, wakes))
    }

    @Test
    fun `several wakes in one period count once`() {
        // A burst after a long freeze must not look like a healthy day.
        val now = T0 + 12 * 3600
        val burst = (0 until 40).map { now - 600 + it }
        assertTrue(WakeHeuristic.suspected(now, T0, 0, 900, burst))
    }

    @Test
    fun `time before the last boot does not count against the phone`() {
        // Switched off for a day, booted two hours ago: nothing could have run, nothing is owed.
        val now = T0 + 30 * 3600
        assertFalse(WakeHeuristic.suspected(now, T0, bootTsUtc = now - 2 * 3600, wakePeriodSec = 900, wakes = emptyList()))
        // Seven hours after boot with no wake at all is evidence again.
        assertTrue(WakeHeuristic.suspected(now, T0, bootTsUtc = now - 7 * 3600, wakePeriodSec = 900, wakes = emptyList()))
    }

    @Test
    fun `only the last 24 hours count`() {
        val now = T0 + 72 * 3600
        val recent = everyPeriod(now - 24 * 3600, now)
        assertFalse(WakeHeuristic.suspected(now, T0, 0, 900, recent))
        val old = everyPeriod(T0, T0 + 24 * 3600)
        assertTrue(WakeHeuristic.suspected(now, T0, 0, 900, old))
    }

    @Test
    fun `the expected wake period follows the mode`() {
        assertEquals(900, WakeHeuristic.wakePeriodSec(config))
        assertEquals("WorkManager's floor", 900, WakeHeuristic.wakePeriodSec(config.copy(minIntervalSec = 60.0)))
        assertEquals(1800, WakeHeuristic.wakePeriodSec(config.copy(minIntervalSec = 1800.0)))
        val fgs = config.copy(useForegroundService = true, notificationTitle = "t")
        assertEquals(900, WakeHeuristic.wakePeriodSec(fgs))
        assertEquals(600, WakeHeuristic.wakePeriodSec(fgs.copy(minIntervalSec = 600.0)))
        assertEquals("wakes are recorded at most every five minutes", 300, WakeHeuristic.wakePeriodSec(fgs.copy(minIntervalSec = 60.0)))
    }

    // ---- config ----

    @Test
    fun `two configs are the same capture when every field the mode uses is equal`() {
        val wm = config
        assertTrue(wm.sameCaptureAs(wm.copy(notificationTitle = "x", notificationBody = "y")))
        assertFalse(wm.sameCaptureAs(wm.copy(minIntervalSec = 901.0)))
        assertFalse(wm.sameCaptureAs(wm.copy(minDistanceM = 50.0)))
        assertFalse(wm.sameCaptureAs(wm.copy(accuracy = Accuracy.HIGH)))
        assertFalse(wm.sameCaptureAs(wm.copy(useForegroundService = true)))
        val fgs = wm.copy(useForegroundService = true, notificationTitle = "t", notificationBody = "b")
        assertTrue(fgs.sameCaptureAs(fgs.copy()))
        assertFalse(fgs.sameCaptureAs(fgs.copy(notificationTitle = "other")))
        assertFalse(fgs.sameCaptureAs(fgs.copy(notificationBody = "other")))
    }
}
