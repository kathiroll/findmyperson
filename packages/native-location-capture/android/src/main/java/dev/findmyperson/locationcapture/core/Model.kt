package dev.findmyperson.locationcapture.core

/*
 * The values of src/specs/NativeLocationCapture.ts, in Kotlin. `wire` is the exact string the
 * spec uses; SpecConformanceTest compares each against contracts/schema.json.
 *
 * Everything in `core` is plain Kotlin with no Android type in it, so the whole state machine
 * runs in JVM unit tests. The Android side is in `platform`.
 */

/** The two Android capture mechanisms. "Nothing selected" is a null mode, written `stopped`. */
enum class CaptureMode(val wire: String, val healthyTier: CaptureTier) {
    /** WorkManager periodic job, no notification. The default. */
    WM("wm", CaptureTier.PERIODIC_WORK),

    /** Foreground service of type location, with a permanent notification. */
    FGS("fgs", CaptureTier.FOREGROUND_SERVICE);

    companion object {
        const val STOPPED = "stopped"

        fun fromWire(value: String?): CaptureMode? = entries.firstOrNull { it.wire == value }
    }
}

enum class CaptureTier(val wire: String) {
    PERIODIC_WORK("periodic_work"),
    FOREGROUND_SERVICE("foreground_service"),
    THROTTLED("throttled"),
    STOPPED("stopped"),
}

enum class PermissionState(val wire: String) {
    UNDETERMINED("undetermined"),
    DENIED("denied"),
    FOREGROUND_ONLY("foreground_only"),
    ALWAYS("always"),
    RESTRICTED("restricted");

    /** True when the platform hands this app a location at all. */
    val hasLocation: Boolean get() = this == FOREGROUND_ONLY || this == ALWAYS
}

/**
 * The health flags Android can raise, declared in the order the spec lists them, which is the
 * order they must appear in `CaptureStatus.health`. The two iOS-only flags are not here.
 */
enum class HealthFlag(val wire: String) {
    BACKGROUND_PERMISSION_MISSING("background_permission_missing"),
    PRECISE_LOCATION_OFF("precise_location_off"),
    LOCATION_SERVICES_OFF("location_services_off"),
    SERVICE_NOT_RUNNING("service_not_running"),
    STORE_UNUSABLE("store_unusable"),
    BATTERY_OPTIMISATION_ACTIVE("battery_optimisation_active"),
    HIBERNATION_NOT_EXEMPT("hibernation_not_exempt"),
    OEM_RESTRICTION_SUSPECTED("oem_restriction_suspected"),
}

enum class Accuracy(val wire: String) {
    BALANCED("balanced"),
    HIGH("high");

    companion object {
        fun fromWire(value: String?): Accuracy? = entries.firstOrNull { it.wire == value }
    }
}

enum class PermissionStep(val wire: String) {
    FOREGROUND("foreground"),
    BACKGROUND("background");

    companion object {
        fun fromWire(value: String?): PermissionStep? = entries.firstOrNull { it.wire == value }
    }
}

enum class SettingsTarget(val wire: String) {
    APP("app"),
    BATTERY("battery"),
    HIBERNATION("hibernation");

    companion object {
        fun fromWire(value: String?): SettingsTarget? = entries.firstOrNull { it.wire == value }
    }
}

/** CAPTURE_ERROR_CODES of src/constants.ts: the `code` of a rejected promise. */
enum class ErrorCode(val wire: String) {
    INVALID_ARGUMENT("invalid_argument"),
    PERMISSION_DENIED("permission_denied"),
    STORE_UNUSABLE("store_unusable"),
    START_FAILED("start_failed"),
    NOT_AVAILABLE("not_available"),
}

/** Thrown by the engine for everything the spec says a call rejects with. */
class CaptureException(val code: ErrorCode, message: String) : Exception(message)

/** The config as it arrives from JavaScript, before validation. */
data class RawConfig(
    val minIntervalSec: Double,
    val minDistanceM: Double,
    val accuracy: String?,
    val useForegroundService: Boolean,
    val notificationTitle: String?,
    val notificationBody: String?,
)

/** A validated `CaptureConfig`. Build one with [CaptureConfig.validate]. */
data class CaptureConfig(
    val minIntervalSec: Double,
    val minDistanceM: Double,
    val accuracy: Accuracy,
    val useForegroundService: Boolean,
    val notificationTitle: String,
    val notificationBody: String,
) {
    val mode: CaptureMode get() = if (useForegroundService) CaptureMode.FGS else CaptureMode.WM

    /**
     * True when `other` asks for the same capture: every field the mode actually uses is equal.
     * The notification text is used only in mode `fgs`, so changing it in mode `wm` is not a
     * change (the same rule as `sameCapture` in src/fake.ts).
     */
    fun sameCaptureAs(other: CaptureConfig): Boolean =
        mode == other.mode &&
            minIntervalSec == other.minIntervalSec &&
            minDistanceM == other.minDistanceM &&
            accuracy == other.accuracy &&
            (mode != CaptureMode.FGS ||
                (notificationTitle == other.notificationTitle && notificationBody == other.notificationBody))

    companion object {
        /** Throws [CaptureException] with `invalid_argument`, the message naming the field. */
        fun validate(raw: RawConfig): CaptureConfig {
            fun invalid(message: String): Nothing = throw CaptureException(ErrorCode.INVALID_ARGUMENT, message)

            if (!(raw.minIntervalSec.isFinite() && raw.minIntervalSec > 0)) {
                invalid("minIntervalSec must be greater than 0")
            }
            if (!(raw.minDistanceM.isFinite() && raw.minDistanceM >= 0)) {
                invalid("minDistanceM must be 0 or more")
            }
            val accuracy = Accuracy.fromWire(raw.accuracy) ?: invalid("accuracy must be balanced or high")
            val title = raw.notificationTitle ?: ""
            if (raw.useForegroundService && title.isBlank()) {
                invalid("notificationTitle must not be empty when useForegroundService is true")
            }
            return CaptureConfig(
                minIntervalSec = raw.minIntervalSec,
                minDistanceM = raw.minDistanceM,
                accuracy = accuracy,
                useForegroundService = raw.useForegroundService,
                notificationTitle = title,
                notificationBody = raw.notificationBody ?: "",
            )
        }
    }
}

/** `CaptureStatus` of the spec. [toWire] is exactly what crosses the bridge. */
data class CaptureStatus(
    val running: Boolean,
    val mode: CaptureMode?,
    val tier: CaptureTier,
    val permission: PermissionState,
    val health: List<HealthFlag>,
    val lastSampleTsUtc: Long?,
    val samplesLast24h: Int,
    val expectedLast24h: Int,
) {
    fun toWire(): Map<String, Any?> = linkedMapOf(
        "running" to running,
        "mode" to (mode?.wire ?: CaptureMode.STOPPED),
        "tier" to tier.wire,
        "permission" to permission.wire,
        "health" to health.map { it.wire },
        "lastSampleTsUtc" to lastSampleTsUtc?.toDouble(),
        "samplesLast24h" to samplesLast24h,
        "expectedLast24h" to expectedLast24h,
    )
}

/**
 * `SampleWrittenEvent` of the spec: what JavaScript is told when a sample is stored. It has no
 * field that could hold a coordinate, and PrivacyTest fails if one is added.
 */
data class SampleWrittenEvent(val tsUtc: Long, val accuracyM: Double, val source: String) {
    fun toWire(): Map<String, Any?> = linkedMapOf(
        "tsUtc" to tsUtc.toDouble(),
        "accuracyM" to accuracyM,
        "source" to source,
    )
}

/**
 * `DeviceConditions` of the spec: what `getDeviceConditions` answers. Named for its use here,
 * because `DeviceConditions` in this package is the port the engine reads the device through.
 */
data class MaintenanceConditions(val charging: Boolean, val idle: Boolean) {
    fun toWire(): Map<String, Any?> = linkedMapOf(
        "charging" to charging,
        "idle" to idle,
    )
}

/** One line of the local capture-health log. Never transmitted, and never holds a coordinate. */
data class DiagnosticEntry(val tsUtc: Long, val event: String, val detail: String) {
    fun toWire(): Map<String, Any?> = linkedMapOf(
        "tsUtc" to tsUtc.toDouble(),
        "event" to event,
        "detail" to detail,
    )
}

/**
 * `DiagnosticEntry.event` names. The first five are DIAGNOSTIC_EVENTS of src/constants.ts, shared
 * with iOS. The rest are Android's own; README.md lists what each one's `detail` holds.
 */
object DiagnosticEvents {
    const val MODE_CHANGED = "mode_changed"
    const val CAPTURE_STARTED = "capture_started"
    const val CAPTURE_STOPPED = "capture_stopped"
    const val START_FAILED = "start_failed"
    const val STORE_UNUSABLE = "store_unusable"

    const val STORE_USABLE = "store_usable"
    const val CAPTURE_WAKE = "capture_wake"
    const val FALLBACK_STARTED = "fallback_started"
    const val FALLBACK_STOPPED = "fallback_stopped"
    const val WATCHDOG_OK = "watchdog_ok"
    const val WATCHDOG_RESTART = "watchdog_restart"
    const val BOOT_RESTART = "boot_restart"
    const val SERVICE_DESTROYED = "service_destroyed"
    const val INTERVAL_CLAMPED = "interval_clamped"
    const val HEALTH_CHANGED = "health_changed"
    const val PERMISSION_CHANGED = "permission_changed"
    const val PERMISSION_PROMPT = "permission_prompt"
    const val SETTINGS_OPENED = "settings_opened"
    const val STANDBY_BUCKET = "standby_bucket"
    const val PROCESS_STARTED = "process_started"
    const val STATE_RESET = "state_reset"
    const val INTERNAL_ERROR = "internal_error"
    const val RETENTION_PURGE = "retention_purge"
    const val RETENTION_PURGE_FAILED = "retention_purge_failed"
}
