import Foundation

// The values of src/specs/NativeLocationCapture.ts as Swift types. Every raw value is a string
// of the spec; ContractTests checks them against contracts/schema.json, so a renamed union
// member in the spec fails `swift test` instead of reaching JavaScript as an unknown string.

enum Accuracy: String, Codable {
    case balanced
    case high
}

enum PermissionState: String {
    case undetermined
    case denied
    case foregroundOnly = "foreground_only"
    case always
    case restricted

    /// "While using the app" or "Always": the two states in which iOS delivers fixes at all.
    var allowsCapture: Bool { self == .foregroundOnly || self == .always }
}

enum PermissionStep: String {
    case foreground
    case background
}

enum SettingsTarget: String {
    case app
    case battery
    case hibernation
}

/// iOS has one capture mode. `wm` and `fgs` are Android's and are never reported here.
enum CaptureMode: String {
    case ios
    case stopped
}

enum CaptureTier: String {
    case backgroundUpdates = "background_updates"
    case throttled
    case stopped
}

/// The flags iOS can raise, in the order they appear in `CaptureStatus.health`.
enum HealthFlag: String, CaseIterable {
    case backgroundPermissionMissing = "background_permission_missing"
    case preciseLocationOff = "precise_location_off"
    case locationServicesOff = "location_services_off"
    case serviceNotRunning = "service_not_running"
    case storeUnusable = "store_unusable"
    case backgroundRefreshOff = "background_refresh_off"
    case lowPowerMode = "low_power_mode"
}

/// The `source` column of a `location_sample` row this module writes.
enum SampleSource: String {
    case continuous
    case slc
    /// The first fix after iOS reported that the phone left the region around the last sample.
    case region
    case manual
}

/// The `code` of a rejected promise (CAPTURE_ERROR_CODES in src/constants.ts).
enum CaptureErrorCode: String {
    case invalidArgument = "invalid_argument"
    case permissionDenied = "permission_denied"
    case storeUnusable = "store_unusable"
    case startFailed = "start_failed"
    case notAvailable = "not_available"
}

struct CaptureError: Error, Equatable {
    let code: CaptureErrorCode
    let message: String
}

/// The fields of the spec's `CaptureConfig` that iOS uses. `useForegroundService` and the
/// notification text are Android's and are dropped at the bridge, so two configs that differ
/// only there are the same capture, as the spec requires of `start`.
struct CaptureConfig: Codable, Equatable {
    var minIntervalSec: Double
    var minDistanceM: Double
    var accuracy: Accuracy
}

struct CaptureStatus: Equatable {
    var running: Bool
    var mode: CaptureMode
    var tier: CaptureTier
    var permission: PermissionState
    var health: [HealthFlag]
    var lastSampleTsUtc: Int64?
    var samplesLast24h: Int
    var expectedLast24h: Int

    /// The object JavaScript receives. Keys are the spec's property names.
    var bridgeValue: [String: Any] {
        [
            "running": running,
            "mode": mode.rawValue,
            "tier": tier.rawValue,
            "permission": permission.rawValue,
            "health": health.map(\.rawValue),
            "lastSampleTsUtc": lastSampleTsUtc.map { $0 as Any } ?? NSNull(),
            "samplesLast24h": samplesLast24h,
            "expectedLast24h": expectedLast24h,
        ]
    }
}

/// Sent after a sample is committed. It has no coordinate field, and must never get one.
struct SampleWrittenEvent: Equatable {
    var tsUtc: Int64
    var accuracyM: Double
    var source: String

    var bridgeValue: [String: Any] {
        ["tsUtc": tsUtc, "accuracyM": accuracyM, "source": source]
    }
}

/// One line of the local capture-health log. Never holds a coordinate.
struct DiagnosticEntry: Codable, Equatable {
    var tsUtc: Int64
    var event: String
    var detail: String

    var bridgeValue: [String: Any] {
        ["tsUtc": tsUtc, "event": event, "detail": detail]
    }
}

/// `DiagnosticEntry.event` names. The first five are DIAGNOSTIC_EVENTS in src/constants.ts and
/// mean the same on Android; the rest are iOS's own, most of them the M0 trial app's log lines.
enum DiagnosticEvent {
    static let modeChanged = "mode_changed"
    static let captureStarted = "capture_started"
    static let captureStopped = "capture_stopped"
    static let startFailed = "start_failed"
    static let storeUnusable = "store_unusable"

    /// The process started. detail: `location` if iOS relaunched it for a location event.
    static let launch = "launch"
    /// First launch since the phone was restarted.
    static let bootRestart = "boot_restart"
    /// The module's own files cannot be read yet: the phone was not unlocked since it restarted.
    static let stateLocked = "state_locked"
    /// The module's state file could not be decoded and was started afresh.
    static let stateReset = "state_reset"
    /// The store passed its check again after `store_unusable`.
    static let storeUsable = "store_usable"
    /// Capture is selected but iOS will not run it. detail: why.
    static let mechanismLost = "mechanism_lost"
    /// Which sources that can relaunch the app are on. detail: e.g. `slc+visit`, or `none`.
    static let wakeSources = "wake_sources"
    /// detail: `bg_refresh=<on|off>;low_power=<0|1>`.
    static let environment = "env"
    static let regionExit = "region_exit"
    static let visitArrival = "visit_arrival"
    static let visitDeparture = "visit_departure"
    /// A visit was not written. detail: why.
    static let visitSkipped = "visit_skipped"
    /// A fix could not be stored or was not obtained. detail: why.
    static let fixFailed = "fix_failed"
    static let permForegroundPromptShown = "perm_fg_prompt_shown"
    static let permForegroundGranted = "perm_fg_granted"
    static let permForegroundDenied = "perm_fg_denied"
    static let permAlwaysPromptShown = "perm_always_prompt_shown"
    static let permAlwaysGranted = "perm_always_granted"
    static let permAlwaysDenied = "perm_always_denied"
    /// detail: `<from>_to_<to>`, a change made in Settings.
    static let permChanged = "perm_changed"
    static let permAccuracy = "perm_accuracy"
    static let settingsOpened = "settings_opened"
}

// MARK: values that hold a position

/// A latitude and longitude in degrees. These exist only between Core Location and the store:
/// nothing that holds one is ever logged, persisted outside the store, or sent to JavaScript.
struct Coordinate: Equatable {
    var lat: Double
    var lon: Double
}

struct Fix: Equatable {
    var coordinate: Coordinate
    /// Time of the fix, Unix seconds.
    var tsUtc: Int64
    /// Horizontal accuracy in metres. Core Location reports an invalid fix as a negative value.
    var accuracyM: Double
}

/// A CLVisit. iOS reports an arrival it did not see, and a departure that has not happened, as
/// sentinel dates; the adapter turns both into nil.
struct Visit: Equatable {
    var coordinate: Coordinate
    var accuracyM: Double
    var arrivalTsUtc: Int64?
    var departureTsUtc: Int64?
}
