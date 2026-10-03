package dev.findmyperson.locationcapture.core

/*
 * Everything the state machine needs from Android, as interfaces. `platform` implements them
 * with WorkManager, the foreground service, the location providers and the system services;
 * the unit tests implement them with fakes that play the operating system.
 */

fun interface Clock {
    /** Unix seconds. */
    fun nowUtcSec(): Long
}

/** The OS refused to start a capture mechanism. [reason] goes into the diagnostics as is. */
class MechanismRefusedException(val reason: String) : Exception(reason)

/** What the foreground service needs to run: its notification text and its location request. */
data class ServicePlan(
    val notificationTitle: String,
    val notificationBody: String,
    val intervalSec: Long,
    val accuracy: Accuracy,
)

/**
 * The two capture mechanisms and the watchdog. Calls are synchronous: when `stop…` returns, the
 * mechanism delivers nothing more, which is what lets the engine promise that the two are never
 * alive together.
 */
interface Mechanisms {
    /** Schedules the periodic capture job, replacing any existing schedule. */
    @Throws(MechanismRefusedException::class)
    fun startWork(periodSec: Long)

    fun stopWork()

    /** True while the periodic capture job is queued or running. */
    fun isWorkScheduled(): Boolean

    /** Starts the foreground service and returns once it is in the foreground and listening. */
    @Throws(MechanismRefusedException::class)
    fun startService(plan: ServicePlan)

    fun stopService()

    /** True while the foreground service is alive in this process. */
    fun isServiceAlive(): Boolean

    /** Makes sure the hourly watchdog is scheduled, without resetting its schedule. */
    fun startWatchdog()

    fun stopWatchdog()
}

enum class Hibernation {
    /** "Pause app activity if unused" is switched off for this app. */
    EXEMPT,

    /** The platform may hibernate this app: reset its permissions and block its background work. */
    NOT_EXEMPT,

    /** This Android version has no hibernation, or the state could not be read. */
    NOT_AVAILABLE,
}

/** The facts about the device the status is computed from, read at one moment. */
data class DeviceSnapshot(
    val fineGranted: Boolean,
    val coarseGranted: Boolean,
    /**
     * "Allow all the time". Below Android 10 there is no separate background permission, and
     * this is true whenever a foreground permission is granted.
     */
    val backgroundGranted: Boolean,
    /** Device policy or parental controls forbid sharing location (`DISALLOW_SHARE_LOCATION`). */
    val locationRestricted: Boolean,
    val locationServicesOn: Boolean,
    /** The app is on the battery-optimisation exemption list ("Unrestricted" battery use). */
    val ignoringBatteryOptimisations: Boolean,
    /** The user set battery use to "Restricted": background work is blocked outright. */
    val backgroundRestricted: Boolean,
    val hibernation: Hibernation,
    /** When the phone last booted, Unix seconds. Wakes cannot have happened before it. */
    val bootTsUtc: Long,
    /** App Standby bucket name (`active`, `rare`, …) or null where unknown. Diagnostics only. */
    val standbyBucket: String?,
)

fun interface DeviceConditions {
    fun snapshot(): DeviceSnapshot
}

/** One-shot location for the periodic job. Both calls block and neither throws. */
interface LocationSource {
    /** A fresh fix, or null: timed out, permission missing, location services off. */
    fun currentFix(accuracy: Accuracy, timeoutSec: Long): Fix?

    /** The platform's cached last fix, which can be hours old, or null. */
    fun lastKnownFix(): Fix?
}

/** The store failed its check or refused a write. [reason] names the failed step. */
class StoreUnusableException(val reason: String, cause: Throwable? = null) : Exception(reason, cause)

/**
 * The encrypted store, as far as capture needs it.
 *
 * A seam: plan task C2.3 (fmp-encrypted-store) owns key management and the native store wiring.
 * Until its Android side lands, `store/` in this module holds a stand-in implementation.
 */
interface SampleStore {
    /**
     * The check `initStore` makes: the store opens with the pinned cipher parameters, in WAL
     * mode, at the schema version this build writes. Returns why it is unusable, or null.
     */
    fun check(): String?

    /** Runs the same check, then inserts the row. */
    @Throws(StoreUnusableException::class)
    fun insert(sample: StoredSample)
}

/** Receives what the spec's two event emitters send. Called on the thread that caused the event. */
interface CaptureListener {
    fun onSampleWritten(event: SampleWrittenEvent)

    fun onStatusChanged(status: CaptureStatus)
}

/** The local capture-health log. An entry never holds a coordinate. */
interface DiagnosticsLog {
    fun append(entry: DiagnosticEntry)

    /** Entries with tsUtc >= sinceTsUtc, oldest first. */
    fun since(sinceTsUtc: Long): List<DiagnosticEntry>
}

/** Persists [CaptureState] so that a new process continues where the last one stopped. */
interface StateStore {
    fun load(): CaptureState

    fun save(state: CaptureState)
}
