import Foundation

// What CaptureEngine needs from the phone. On a device these are implemented in ../Platform
// over Core Location, UIKit and the Keychain; in `swift test` they are fakes a test drives, so
// the state machine runs with no phone and no simulator.

/// Core Location's authorization, before it is mapped to the spec's `PermissionState`.
enum LocationAuthorization: String {
    case notDetermined = "not_determined"
    case denied
    case restricted
    case whenInUse = "when_in_use"
    case always

    var permission: PermissionState {
        switch self {
        case .notDetermined: return .undetermined
        case .denied: return .denied
        case .restricted: return .restricted
        case .whenInUse: return .foregroundOnly
        case .always: return .always
        }
    }
}

/// Which of the two fix streams a fix or a failure came from.
enum FixOrigin {
    case continuous
    case significantChange
}

enum LocationFailure: Equatable {
    /// iOS will deliver nothing until the user changes a setting (kCLErrorDenied).
    case denied
    /// Anything else, transient or not. The value is the CLError code.
    case other(code: Int)
}

/// The four Core Location services the module uses (plan 5.3), and the permission prompts.
protocol LocationSystem: AnyObject {
    var events: LocationSystemEvents? { get set }

    var authorization: LocationAuthorization { get }
    /// False when the user allowed approximate location only.
    var preciseLocation: Bool { get }
    /// False when Location Services is switched off for the whole phone.
    var locationServicesEnabled: Bool { get }
    var significantChangeAvailable: Bool { get }
    var regionMonitoringAvailable: Bool { get }

    func requestWhenInUseAuthorization()
    func requestAlwaysAuthorization()

    /// Continuous updates that keep running in the background. Dies with the process.
    func startContinuous(accuracy: Accuracy)
    func stopContinuous()
    /// Significant-change and visit monitoring survive the process: iOS relaunches the app for
    /// them. Both need Always.
    func startSignificantChanges()
    func stopSignificantChanges()
    func startVisits()
    func stopVisits()
    /// Monitors leaving a circle, replacing the circle monitored before. Also survives the
    /// process.
    func monitorExit(from center: Coordinate, radiusM: Double)
    func stopMonitoringExit()
}

/// Core Location's callbacks. Always delivered on the main thread.
protocol LocationSystemEvents: AnyObject {
    /// Authorization, accuracy authorization or the Location Services switch changed.
    func locationAuthorizationChanged()
    func locationDelivered(_ fix: Fix, from origin: FixOrigin)
    func locationFailed(_ failure: LocationFailure, from origin: FixOrigin)
    func visitReported(_ visit: Visit)
    func exitedMonitoredRegion()
}

/// The conditions outside Core Location that degrade capture, and the Settings app.
protocol DeviceConditions: AnyObject {
    /// False when Background App Refresh is off for the app or the phone, or restricted.
    var backgroundRefreshAvailable: Bool { get }
    var lowPowerMode: Bool { get }
    /// When the phone last started, Unix seconds, or nil if it cannot be read.
    var bootTimeSec: Double? { get }
    /// Opens the app's page in Settings.
    func openAppSettings(completion: @escaping (Bool) -> Void)
}

/// The 32-byte store key, as 64 hex characters.
protocol StoreKeySource: AnyObject {
    /// Throws while the Keychain is locked: before the first unlock after a restart.
    func getOrCreateKeyHex() throws -> String
}

/// Why the store cannot be used. `step` names the check that failed.
struct StoreFailure: Error, Equatable, CustomStringConvertible {
    let step: String
    let message: String
    var description: String { "\(step): \(message)" }
}

/// One `location_sample` row.
struct SampleRow: Equatable {
    var tsUtc: Int64
    var coordinate: Coordinate
    var accuracyM: Double
    var source: String
    var h3r7: String
    var h3r5: String
}

/// One `stay` row with source 'visit'.
struct VisitStayRow: Equatable {
    var startTs: Int64
    var endTs: Int64
    var coordinate: Coordinate
    var radiusM: Double
    var h3r7: String
    var closed: Bool
}

/// The encrypted store, reduced to what packages/shared/contracts/native-writer.json allows.
protocol CaptureStore: AnyObject {
    /// The check `initStore` makes. Throws StoreFailure.
    func check() throws
    func insertSample(_ row: SampleRow) throws
    func insertVisitStay(_ row: VisitStayRow) throws
    /// Closes the open visit that began at `startTs`. False if there was no such row.
    func closeVisitStay(endTs: Int64, startTs: Int64) throws -> Bool
}

/// Thrown by StateStorage.load when the file exists but cannot be read.
enum StateStorageError: Error {
    /// The file is protected and the phone has not been unlocked since it restarted.
    case unreadable(String)
    /// The file was read but is not a state this build understands.
    case corrupt(String)
}

protocol StateStorage: AnyObject {
    /// nil when nothing was ever saved.
    func load() throws -> PersistedState?
    func save(_ state: PersistedState) throws
}

protocol DiagnosticsLog: AnyObject {
    func append(_ entry: DiagnosticEntry)
    /// Entries with tsUtc >= sinceTsUtc, oldest first.
    func entries(since sinceTsUtc: Int64) -> [DiagnosticEntry]
}

protocol Scheduler: AnyObject {
    func after(seconds: Double, _ work: @escaping () -> Void)
}

/// Receives the module's two events. The Turbo Module forwards them to JavaScript.
protocol CaptureEngineListener: AnyObject {
    func sampleWritten(_ event: SampleWrittenEvent)
    func statusChanged(_ status: CaptureStatus)
}
