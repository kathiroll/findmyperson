package dev.findmyperson.locationcapture.core

/*
 * The decisions of the module that are pure functions of their inputs: which fix is stored,
 * what the permission state is and what a permission request may show, and when missed wakes
 * amount to a suspected vendor restriction. Kept apart from the engine so each can be tested
 * on its own table of cases.
 */

object SampleFilter {
    enum class Verdict {
        STORE,

        /** Sooner than `minIntervalSec` after the last stored sample and not `minDistanceM` away. */
        FILTERED,

        /** Not a usable fix: no accuracy, or a latitude or longitude out of range. */
        INVALID,
    }

    /**
     * The rule of `CaptureConfig`: a fix is stored when `minIntervalSec` has passed since the
     * last stored sample OR the phone has moved `minDistanceM` from it.
     *
     * [lastStoredFix] is that sample's position, which this process knows only if it stored the
     * sample itself: positions are never kept outside the encrypted store, and the store
     * contract has no statement to read one back. When it is unknown (the first fix after a
     * process start) the distance half of the rule cannot be evaluated, and the fix is kept
     * only if the interval has passed. The cadence is unaffected; at worst one early
     * "the phone moved" sample is skipped after a restart.
     */
    fun judge(fix: Fix, lastStoredTsUtc: Long?, lastStoredFix: Fix?, config: CaptureConfig): Verdict {
        val accuracy = fix.accuracyM
        if (accuracy == null || !accuracy.isFinite() || accuracy < 0 || !Geo.isValidLatLon(fix.lat, fix.lon)) {
            return Verdict.INVALID
        }
        if (lastStoredTsUtc == null) return Verdict.STORE
        if (fix.tsUtc - lastStoredTsUtc >= config.minIntervalSec) return Verdict.STORE
        if (lastStoredFix == null) return Verdict.FILTERED
        val moved = Geo.haversineMeters(lastStoredFix.lat, lastStoredFix.lon, fix.lat, fix.lon)
        return if (moved >= config.minDistanceM) Verdict.STORE else Verdict.FILTERED
    }
}

object PermissionRules {
    /**
     * The spec's `PermissionState` from what Android reports.
     *
     * Android has no "never asked" state: a permission is granted or it is not. So the module
     * records that it has shown the foreground prompt ([askedForeground]) and reports
     * `undetermined` before that and `denied` after. This is stricter than the platform, which
     * would show its dialog a second time; it matches the spec ("a refusal is not asked again;
     * only system settings changes it") and the iOS behaviour, so the permission screens have
     * one flow for both platforms.
     */
    fun state(device: DeviceSnapshot, askedForeground: Boolean): PermissionState = when {
        device.locationRestricted -> PermissionState.RESTRICTED
        !device.fineGranted && !device.coarseGranted ->
            if (askedForeground) PermissionState.DENIED else PermissionState.UNDETERMINED
        device.backgroundGranted -> PermissionState.ALWAYS
        else -> PermissionState.FOREGROUND_ONLY
    }

    enum class Action {
        /** Show nothing and resolve with the current state. */
        NONE,

        /** The runtime dialog for fine and coarse location. */
        FOREGROUND_DIALOG,

        /** Android 10 only: the runtime dialog for background location. */
        BACKGROUND_DIALOG,

        /** Android 11 and later have no dialog for "Allow all the time": open the app's settings. */
        BACKGROUND_SETTINGS,
    }

    /** What `requestPermission(step)` does in a given state. */
    fun action(step: PermissionStep, state: PermissionState, sdkInt: Int): Action = when (step) {
        PermissionStep.FOREGROUND ->
            if (state == PermissionState.UNDETERMINED) Action.FOREGROUND_DIALOG else Action.NONE
        PermissionStep.BACKGROUND -> when {
            // Also covers "background asked before foreground is granted": nothing is shown.
            state != PermissionState.FOREGROUND_ONLY -> Action.NONE
            sdkInt >= 30 -> Action.BACKGROUND_SETTINGS
            else -> Action.BACKGROUND_DIALOG
        }
    }
}

/**
 * `oem_restriction_suspected`: a heuristic from capture wakes that did not happen.
 *
 * A "wake" is this process getting to run for capture: a run of the periodic job, a run of the
 * watchdog, a delivery of fixes to the foreground service or that service's heartbeat. The M0
 * field trial showed the failure on real phones is silent starvation, not a crash: the app
 * keeps its permission and its schedule, and the phone simply stops running it. Missing wakes
 * are the one trace that leaves.
 *
 * The rule: over the time a mode has been selected (at most the last 24 hours, and never
 * reaching back before the last boot, when the phone could not have run anything), split the
 * time into slots one wake period long. If fewer than a third of the slots contain a wake, the
 * flag is raised. Stock Android's Doze also skips wakes overnight, but a phone that is used
 * during the day still covers well over a third; the phones in the trial that vendors starved
 * covered 3 to 13 percent.
 *
 * It needs [MIN_OBSERVATION_SEC] of evidence before it says anything, so it is silent right
 * after `start` and right after a reboot.
 */
object WakeHeuristic {
    const val WINDOW_SEC = 86_400L
    const val MIN_OBSERVATION_SEC = 6 * 3_600L

    /** Raised when covered slots * DENOMINATOR < total slots * NUMERATOR, i.e. under one third. */
    const val NUMERATOR = 1
    const val DENOMINATOR = 3

    /** WorkManager will not run a periodic job more often than this. */
    const val MIN_WORK_PERIOD_SEC = 900L

    /** How often a mode is expected to wake the process. */
    fun wakePeriodSec(config: CaptureConfig): Long {
        val interval = Math.ceil(config.minIntervalSec).toLong()
        return when (config.mode) {
            CaptureMode.WM -> maxOf(interval, MIN_WORK_PERIOD_SEC)
            CaptureMode.FGS -> maxOf(interval, CaptureState.WAKE_SPACING_SEC)
        }
    }

    fun suspected(now: Long, selectedSince: Long?, bootTsUtc: Long, wakePeriodSec: Long, wakes: List<Long>): Boolean {
        if (selectedSince == null) return false
        val from = maxOf(now - WINDOW_SEC, selectedSince, bootTsUtc)
        if (now - from < MIN_OBSERVATION_SEC) return false
        val slots = ((now - from) / wakePeriodSec).toInt()
        if (slots == 0) return false
        val covered = wakes.asSequence()
            .filter { it >= from && it < from + slots * wakePeriodSec }
            .map { (it - from) / wakePeriodSec }
            .toSet()
            .size
        return covered * DENOMINATOR < slots * NUMERATOR
    }
}

/**
 * The two answers of `getDeviceConditions`, from what Android reports.
 *
 * `charging` is external power, whether or not the battery is still filling: the question is
 * whether rewriting the store file costs the user battery. `idle` is "nobody is using the app":
 * the screen is off, or the app is not what is on it. A phone left on a charger overnight is
 * both; a phone in use on a charger is not idle; a phone in a pocket is not charging.
 */
object MaintenanceRules {
    fun conditions(power: PowerSnapshot) = MaintenanceConditions(
        charging = power.onExternalPower,
        idle = !power.screenOn || !power.appInForeground,
    )

    /** What is answered when Android will not say: the vacuum waits. */
    val UNKNOWN = MaintenanceConditions(charging = false, idle = false)
}

/**
 * The answer of `getNetworkConditions`, from what Android reports.
 *
 * `metered` is Android's own judgement of the active network, which already covers mobile data,
 * a hotspot the phone was told is limited and having no network at all. Nothing is added to it:
 * the fetcher's question is whether the download costs the user, and that is the question
 * Android answers.
 */
object NetworkRules {
    fun conditions(network: NetworkSnapshot) = NetworkConditions(metered = network.activeNetworkMetered)

    /** What is answered when Android will not say: the fetcher waits, as it does with no answer. */
    val UNKNOWN = NetworkConditions(metered = true)
}
