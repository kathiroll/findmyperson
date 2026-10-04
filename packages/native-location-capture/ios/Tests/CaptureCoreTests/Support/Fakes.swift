import Foundation

@testable import CaptureCore

// The phone, as a test drives it. Each fake keeps what the real thing would keep, so a test can
// kill "the process" and start a new engine against the same phone.

final class TestClock {
    var now: Int64
    init(_ now: Int64) { self.now = now }
    func advance(_ seconds: Int64) { now += seconds }
}

/// Core Location. `continuousRunning` belongs to the process and ends with it; the other three
/// registrations are kept by iOS across process deaths, which is what makes a relaunch possible.
final class FakeLocationSystem: LocationSystem {
    weak var events: LocationSystemEvents?

    var authorization: LocationAuthorization = .notDetermined
    var preciseLocation = true
    var locationServicesEnabled = true
    var significantChangeAvailable = true
    var regionMonitoringAvailable = true

    private(set) var continuousRunning = false
    private(set) var continuousAccuracy: Accuracy?
    private(set) var significantChangesRegistered = false
    private(set) var visitsRegistered = false
    private(set) var exitRegion: (center: Coordinate, radiusM: Double)?
    /// Every call the engine made, in order.
    private(set) var calls: [String] = []

    func requestWhenInUseAuthorization() { calls.append("requestWhenInUse") }
    func requestAlwaysAuthorization() { calls.append("requestAlways") }

    func startContinuous(accuracy: Accuracy) {
        calls.append("startContinuous:\(accuracy.rawValue)")
        continuousRunning = true
        continuousAccuracy = accuracy
    }

    func stopContinuous() {
        calls.append("stopContinuous")
        continuousRunning = false
    }

    func startSignificantChanges() {
        calls.append("startSignificantChanges")
        significantChangesRegistered = true
    }

    func stopSignificantChanges() {
        calls.append("stopSignificantChanges")
        significantChangesRegistered = false
    }

    func startVisits() {
        calls.append("startVisits")
        visitsRegistered = true
    }

    func stopVisits() {
        calls.append("stopVisits")
        visitsRegistered = false
    }

    func monitorExit(from center: Coordinate, radiusM: Double) {
        calls.append("monitorExit")
        exitRegion = (center, radiusM)
    }

    func stopMonitoringExit() {
        calls.append("stopMonitoringExit")
        exitRegion = nil
    }

    // What a test does to the phone.

    func clearCalls() { calls.removeAll() }

    /// iOS killed the process (or the user force-quit the app).
    func processDied() {
        continuousRunning = false
        events = nil
    }

    /// True if iOS would relaunch a dead app when the phone moves or settles.
    var canRelaunchApp: Bool {
        authorization == .always
            && (significantChangesRegistered || visitsRegistered || exitRegion != nil)
    }

    /// The user answered a prompt, or changed the permission in Settings.
    func setAuthorization(_ value: LocationAuthorization) {
        authorization = value
        events?.locationAuthorizationChanged()
    }

    /// A fix arrives, if the service that would produce it is running.
    @discardableResult
    func deliver(_ fix: Fix, from origin: FixOrigin = .continuous) -> Bool {
        switch origin {
        case .continuous: guard continuousRunning else { return false }
        case .significantChange: guard significantChangesRegistered else { return false }
        }
        events?.locationDelivered(fix, from: origin)
        return true
    }

    @discardableResult
    func report(_ visit: Visit) -> Bool {
        guard visitsRegistered else { return false }
        events?.visitReported(visit)
        return true
    }

    @discardableResult
    func exitRegionNow() -> Bool {
        guard exitRegion != nil else { return false }
        events?.exitedMonitoredRegion()
        return true
    }
}

final class FakeDevice: DeviceConditions {
    var backgroundRefreshAvailable = true
    var lowPowerMode = false
    var bootTimeSec: Double? = 1_700_000_000
    /// On battery, with the app on screen: a phone in somebody's hand.
    var onExternalPower = false
    var appActive = true
    /// On mobile data. nil is no usable connection, or iOS not having said yet.
    var networkPath: NetworkPath? = NetworkPath(expensive: true, constrained: false)
    var settingsOpenResult = true
    private(set) var settingsOpened = 0

    func openAppSettings(completion: @escaping (Bool) -> Void) {
        settingsOpened += 1
        completion(settingsOpenResult)
    }
}

/// The store, in memory. Coordinates are visible here, as they are to a reader of the store.
/// Its purge is the contract's rule; StoreTests runs the real statements on the real schema.
final class FakeStore: CaptureStore {
    /// When set, the check `initStore` makes fails with it.
    var failure: StoreFailure?
    /// When set, the next write fails with it although the check passed.
    var writeFailure: StoreFailure?
    /// When set, a purge fails with it although the check passed (the store is busy).
    var purgeFailure: StoreFailure?
    private(set) var samples: [SampleRow] = []
    private(set) var stays: [VisitStayRow] = []
    private(set) var checks = 0
    /// The time each purge was given, in order.
    private(set) var purges: [Int64] = []

    func purgeExpired(nowTsUtc: Int64) throws -> PurgeCounts {
        if let purgeFailure { throw purgeFailure }
        purges.append(nowTsUtc)
        let cutoff = nowTsUtc - StoreContract.retentionSec
        var counts = PurgeCounts(samples: samples.count, stays: stays.count, staysTrimmed: 0)
        samples.removeAll { $0.tsUtc < cutoff }
        stays.removeAll { $0.endTs < cutoff }
        counts.samples -= samples.count
        counts.stays -= stays.count
        for index in stays.indices where stays[index].startTs < cutoff {
            stays[index].startTs = cutoff
            counts.staysTrimmed += 1
        }
        return counts
    }

    func check() throws {
        checks += 1
        if let failure { throw failure }
    }

    func insertSample(_ row: SampleRow) throws {
        if let writeFailure { throw writeFailure }
        samples.append(row)
    }

    func insertVisitStay(_ row: VisitStayRow) throws {
        if let writeFailure { throw writeFailure }
        stays.append(row)
    }

    func closeVisitStay(endTs: Int64, startTs: Int64) throws -> Bool {
        if let writeFailure { throw writeFailure }
        guard let index = stays.firstIndex(where: { !$0.closed && $0.startTs == startTs }) else {
            return false
        }
        stays[index].endTs = endTs
        stays[index].closed = true
        return true
    }
}

final class FakeKeys: StoreKeySource {
    var keyHex = String(repeating: "ab", count: 32)
    var locked = false

    func getOrCreateKeyHex() throws -> String {
        if locked {
            throw StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")
        }
        return keyHex
    }
}

final class MemoryStateStorage: StateStorage {
    enum Condition {
        case readable
        /// Before the first unlock after a restart.
        case locked
        case corrupt
    }

    var condition = Condition.readable
    var saved: PersistedState?
    private(set) var saves = 0

    func load() throws -> PersistedState? {
        switch condition {
        case .readable: return saved
        case .locked: throw StateStorageError.unreadable("locked")
        case .corrupt: throw StateStorageError.corrupt("not JSON")
        }
    }

    func save(_ state: PersistedState) throws {
        if condition == .locked { throw StateStorageError.unreadable("locked") }
        condition = .readable
        saved = state
        saves += 1
    }
}

final class MemoryDiagnostics: DiagnosticsLog {
    private(set) var all: [DiagnosticEntry] = []

    func append(_ entry: DiagnosticEntry) { all.append(entry) }

    func entries(since sinceTsUtc: Int64) -> [DiagnosticEntry] {
        all.filter { $0.tsUtc >= sinceTsUtc }
    }

    /// `event` or `event:detail`, in order: what a test compares against.
    var lines: [String] {
        all.map { $0.detail.isEmpty ? $0.event : "\($0.event):\($0.detail)" }
    }

    func clear() { all.removeAll() }
}

/// Timers do not run by themselves in a test: `fire` plays the passage of time.
final class ManualScheduler: Scheduler {
    private var pending: [(seconds: Double, work: () -> Void)] = []

    func after(seconds: Double, _ work: @escaping () -> Void) {
        pending.append((seconds, work))
    }

    var pendingDelays: [Double] { pending.map(\.seconds) }

    func fire() {
        let due = pending
        pending.removeAll()
        due.forEach { $0.work() }
    }
}

final class RecordingListener: CaptureEngineListener {
    private(set) var samples: [SampleWrittenEvent] = []
    private(set) var statuses: [CaptureStatus] = []

    func sampleWritten(_ event: SampleWrittenEvent) { samples.append(event) }
    func statusChanged(_ status: CaptureStatus) { statuses.append(status) }

    func clear() {
        samples.removeAll()
        statuses.removeAll()
    }
}

/// One phone and the engine running on it.
final class Harness {
    static let t0: Int64 = 1_790_000_000

    let clock = TestClock(Harness.t0)
    let location = FakeLocationSystem()
    let device = FakeDevice()
    let store = FakeStore()
    let keys = FakeKeys()
    let stateStorage = MemoryStateStorage()
    let diagnostics = MemoryDiagnostics()
    let scheduler = ManualScheduler()
    let listener = RecordingListener()
    var debugBuild = true
    /// The real implementations, for a test that wants files instead of the in-memory fakes.
    var realStore: CaptureStore?
    var realStateStorage: StateStorage?
    var realDiagnostics: DiagnosticsLog?
    private(set) var engine: CaptureEngine!

    init(authorization: LocationAuthorization = .always, launch: Bool = true) {
        location.authorization = authorization
        if launch {
            self.launch()
        }
    }

    /// The app starts: by the user, or by iOS for a location event.
    func launch(forLocation: Bool = false) {
        engine = CaptureEngine(
            CaptureEngine.Dependencies(
                location: location, device: device, store: realStore ?? store, keys: keys,
                stateStorage: realStateStorage ?? stateStorage,
                diagnostics: realDiagnostics ?? diagnostics, scheduler: scheduler,
                now: { [clock] in clock.now }, storeDirectory: "/store", debugBuild: debugBuild))
        engine.listener = listener
        engine.resume(launchedForLocation: forLocation)
    }

    /// iOS killed the process. Nothing of the engine survives; the phone does.
    func kill() {
        location.processDied()
        engine = nil
    }

    func start(interval: Double = 900, distance: Double = 100, accuracy: String = "balanced") throws {
        try engine.start(minIntervalSec: interval, minDistanceM: distance, accuracy: accuracy)
    }

    var status: CaptureStatus { engine.status() }
}

// Places a test can stand in. About 111 m per 0.001 degree of latitude.
enum Place {
    static let home = Coordinate(lat: 12.9716, lon: 77.5946)
    /// 50 m north of home: inside the 100 m filter.
    static let nearHome = Coordinate(lat: 12.97205, lon: 77.5946)
    /// 1.1 km north of home.
    static let office = Coordinate(lat: 12.9816, lon: 77.5946)
}

extension Fix {
    init(_ coordinate: Coordinate, at tsUtc: Int64, accuracyM: Double = 20) {
        self.init(coordinate: coordinate, tsUtc: tsUtc, accuracyM: accuracyM)
    }
}
