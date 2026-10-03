import Foundation
import UIKit

/// Receives the module's two events as the objects JavaScript gets. Implemented by the Turbo
/// Module (RCTNativeLocationCapture.mm).
@objc public protocol FMPCaptureEventSink: AnyObject {
    func captureSampleWritten(_ event: [String: Any])
    func captureStatusChanged(_ status: [String: Any])
}

/// The one object behind the Turbo Module, and the module's composition root: it builds
/// CaptureEngine over Core Location, the Keychain and the encrypted store.
///
/// It is a process-wide singleton and not owned by the Turbo Module, because capture has to run
/// when React Native is not: iOS relaunches the app for a location event into the background,
/// and the engine must restart capture before any JavaScript exists. `resume` is that entry
/// point.
///
/// Main thread only, like the engine. The Turbo Module's method queue is the main queue.
@objc(FMPCaptureBridge)
public final class FMPCaptureBridge: NSObject, CaptureEngineListener {
    @objc public static let shared = FMPCaptureBridge()

    public typealias Resolve = (Any?) -> Void
    /// Called with one of CAPTURE_ERROR_CODES and a message.
    public typealias Reject = (String, String) -> Void

    private let engine: CaptureEngine
    private let location: CoreLocationSystem
    private let sinks = NSHashTable<AnyObject>.weakObjects()
    private var observers: [NSObjectProtocol] = []

    private override init() {
        dispatchPrecondition(condition: .onQueue(.main))
        StoreLocation.prepare()
        let directory = StoreLocation.directory
        let keys = KeychainKeySource()
        location = CoreLocationSystem()
        #if DEBUG
        let debugBuild = true
        #else
        let debugBuild = false
        #endif
        engine = CaptureEngine(
            CaptureEngine.Dependencies(
                location: location,
                device: SystemDeviceConditions(),
                store: SQLiteCaptureStore(
                    path: directory.appendingPathComponent(StoreContract.storeFileName).path,
                    engine: .sqlcipher,
                    keyHex: keys.getOrCreateKeyHex),
                keys: keys,
                stateStorage: FileStateStorage(url: directory.appendingPathComponent("capture-state.json")),
                diagnostics: FileDiagnosticsLog(
                    url: directory.appendingPathComponent("capture-diagnostics.jsonl")),
                scheduler: MainQueueScheduler(),
                now: { Int64(Date().timeIntervalSince1970) },
                storeDirectory: directory.path,
                debugBuild: debugBuild))
        super.init()
        engine.listener = self
        observeApplication()
    }

    // MARK: launch

    /// Restarts the selected capture. Call it from
    /// `application(_:didFinishLaunchingWithOptions:)` with the launch options, on every launch.
    /// FMPCaptureLaunchObserver.m also calls it for an app that does not, so calling it is a
    /// safeguard and a statement of intent rather than a requirement. Only the first call acts.
    @objc(resumeWithLaunchOptions:)
    public static func resume(launchOptions: [AnyHashable: Any]?) {
        // iOS puts this key in the options when it relaunched the app for a location event.
        let forLocation = launchOptions?[UIApplication.LaunchOptionsKey.location.rawValue] != nil
        shared.engine.resume(launchedForLocation: forLocation)
    }

    private func observeApplication() {
        let center = NotificationCenter.default
        func observe(_ name: Notification.Name, _ action: @escaping (CaptureEngine) -> Void) {
            // Power-state changes are posted on an arbitrary thread; `queue: .main` moves them.
            observers.append(
                center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    guard let self else { return }
                    action(self.engine)
                })
        }
        observe(UIApplication.willResignActiveNotification) { $0.appWillResignActive() }
        observe(UIApplication.didBecomeActiveNotification) { $0.appDidBecomeActive() }
        observe(UIApplication.backgroundRefreshStatusDidChangeNotification) { $0.deviceConditionsChanged() }
        observe(Notification.Name.NSProcessInfoPowerStateDidChange) { $0.deviceConditionsChanged() }
        observe(UIApplication.protectedDataDidBecomeAvailableNotification) {
            $0.protectedDataBecameAvailable()
        }
    }

    // MARK: events

    @objc(addSink:)
    public func addSink(_ sink: FMPCaptureEventSink) {
        sinks.add(sink)
    }

    @objc(removeSink:)
    public func removeSink(_ sink: FMPCaptureEventSink) {
        sinks.remove(sink)
    }

    func sampleWritten(_ event: SampleWrittenEvent) {
        let value = event.bridgeValue
        for case let sink as FMPCaptureEventSink in sinks.allObjects {
            sink.captureSampleWritten(value)
        }
    }

    func statusChanged(_ status: CaptureStatus) {
        let value = status.bridgeValue
        for case let sink as FMPCaptureEventSink in sinks.allObjects {
            sink.captureStatusChanged(value)
        }
    }

    // MARK: the spec's methods
    //
    // The Objective-C selectors are spelled out because RCTNativeLocationCapture.mm calls them
    // by name; scripts/check-ios.sh compiles that file against the header these produce.

    private func settle(_ resolve: Resolve, _ reject: Reject, _ work: () throws -> Any?) {
        do {
            resolve(try work())
        } catch let error as CaptureError {
            reject(error.code.rawValue, error.message)
        } catch {
            reject(CaptureErrorCode.storeUnusable.rawValue, "\(error)")
        }
    }

    @objc(getOrCreateStoreKeyHexWithResolve:reject:)
    public func getOrCreateStoreKeyHex(resolve: Resolve, reject: Reject) {
        settle(resolve, reject) { try engine.storeKeyHex() }
    }

    @objc(getStoreDirectoryWithResolve:reject:)
    public func getStoreDirectory(resolve: Resolve, reject: Reject) {
        resolve(engine.storeDirectory)
    }

    @objc(initStoreWithResolve:reject:)
    public func initStore(resolve: Resolve, reject: Reject) {
        settle(resolve, reject) {
            try engine.initStore()
            return nil
        }
    }

    /// `useForegroundService` and the notification text of the spec's config are Android's and
    /// are not passed in.
    @objc(startWithMinIntervalSec:minDistanceM:accuracy:resolve:reject:)
    public func start(
        minIntervalSec: Double, minDistanceM: Double, accuracy: String, resolve: Resolve, reject: Reject
    ) {
        settle(resolve, reject) {
            try engine.start(
                minIntervalSec: minIntervalSec, minDistanceM: minDistanceM, accuracy: accuracy)
            return nil
        }
    }

    @objc(stopWithResolve:reject:)
    public func stop(resolve: Resolve, reject: Reject) {
        settle(resolve, reject) {
            try engine.stop()
            return nil
        }
    }

    @objc(getStatusWithResolve:reject:)
    public func getStatus(resolve: Resolve, reject: Reject) {
        resolve(engine.status().bridgeValue)
    }

    @objc(requestPermissionWithStep:resolve:reject:)
    public func requestPermission(step: String, resolve: @escaping Resolve, reject: Reject) {
        guard let step = PermissionStep(rawValue: step) else {
            reject(CaptureErrorCode.invalidArgument.rawValue, "step must be foreground or background")
            return
        }
        engine.requestPermission(step) { resolve($0.rawValue) }
    }

    @objc(openSystemSettingsWithTarget:resolve:reject:)
    public func openSystemSettings(target: String, resolve: @escaping Resolve, reject: Reject) {
        guard let target = SettingsTarget(rawValue: target) else {
            reject(CaptureErrorCode.invalidArgument.rawValue, "target must be app, battery or hibernation")
            return
        }
        engine.openSystemSettings(target) { resolve($0) }
    }

    @objc(getDiagnosticsSinceTsUtc:resolve:reject:)
    public func getDiagnostics(sinceTsUtc: Double, resolve: Resolve, reject: Reject) {
        resolve(engine.diagnostics(since: sinceTsUtc).map(\.bridgeValue))
    }

    @objc(debugInjectSampleWithLat:lon:tsUtc:accuracyM:resolve:reject:)
    public func debugInjectSample(
        lat: Double, lon: Double, tsUtc: Double, accuracyM: Double, resolve: Resolve, reject: Reject
    ) {
        settle(resolve, reject) {
            try engine.debugInjectSample(lat: lat, lon: lon, tsUtc: tsUtc, accuracyM: accuracyM)
            return nil
        }
    }
}
