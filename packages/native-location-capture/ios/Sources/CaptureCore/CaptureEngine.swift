import Foundation

/// The capture module as a state machine (plan 5.5 rule 2): everything the spec's methods do,
/// and everything Core Location reports, goes through here. It has no Core Location, UIKit or
/// React Native in it, so `swift test` runs it with fakes for the phone.
///
/// The shape of iOS capture (plan 5.3):
///
///   continuous updates   the sampler. Runs while the process lives and dies with it.
///   significant change,  survive the process: iOS relaunches the app for them, `resume` runs
///   visits, exit region  again, and continuous updates are restarted. All three need Always.
///   visits               also the dwell source: each CLVisit becomes a `stay` row (plan 5.4).
///
/// "The mechanism is alive" in the spec's sense means continuous updates are running.
///
/// Retention: the full purge is TypeScript and runs when the app does. A phone on which the
/// app is never opened only ever runs this, so storing a fix or a visit, and every launch,
/// also purges (`purgeIfDue`).
///
/// Every method must be called on the main thread, where Core Location delivers its callbacks.
/// The engine has no locks of its own.
final class CaptureEngine {
    struct Tunables {
        /// The exit region is this wide at least. Smaller circles are unreliable on iOS.
        var minRegionRadiusM: Double = 150
        /// While the store is unusable it is re-checked at most this often on the capture path.
        var storeRetrySec: Int64 = 30
        /// If the app has not gone inactive this long after the Always prompt was requested,
        /// iOS showed nothing.
        var alwaysPromptGraceSec: Double = 3
        /// How long after the app is active again a pending Always prompt counts as refused.
        /// The authorization callback of a grant can arrive just after the app is active.
        var alwaysPromptSettleSec: Double = 1
        /// A process purges at most this often: a moving phone stores a fix every few seconds.
        /// An hour past 30 days is still "30 days".
        var purgeIntervalSec: Int64 = 3600
    }

    struct Dependencies {
        var location: LocationSystem
        var device: DeviceConditions
        var store: CaptureStore
        var keys: StoreKeySource
        var stateStorage: StateStorage
        var diagnostics: DiagnosticsLog
        var scheduler: Scheduler
        /// The clock, Unix seconds.
        var now: () -> Int64
        var storeDirectory: String
        /// False in a release build, where `debugInjectSample` is not available.
        var debugBuild: Bool
        var tunables = Tunables()
    }

    weak var listener: CaptureEngineListener?

    private let deps: Dependencies
    private var state = PersistedState()

    // Launch.
    private var resumeRequested = false
    private var resumed = false
    private var launchDetail = "normal"
    private var stateLockLogged = false
    private var stateSaveFailureLogged = false

    // Which Core Location services this process has started.
    private var continuousOn = false
    private var significantChangeOn = false
    private var visitsOn = false
    private var regionOn = false
    /// False until this process has told iOS to stop everything once. Significant-change,
    /// visit and region monitoring outlive the process, so a fresh one cannot assume they are off.
    private var servicesCleared = false
    /// iOS answered a running service with "denied". Cleared whenever something may have changed.
    private var refusedByOS = false
    private var lossReason: String?

    // The store.
    private var storeFailure: String?
    private var lastStoreCheckAt: Int64?
    /// When this process last purged. Memory only: a new process purges on its first wake.
    private var lastPurgeAt: Int64?

    // The filter. Positions live in memory only.
    /// Where the last stored sample was taken or, in a process that has not stored one yet,
    /// the first fix it saw.
    private var referencePosition: Coordinate?
    private var leftLastRegion = false
    private var lastFixFailureLogAt: Int64?

    // Permission prompts.
    private var pendingPrompt: PermissionStep?
    private var permissionWaiters: [(PermissionState) -> Void] = []
    private var resignedSincePrompt = false

    private var lastEnvironment: String?
    private var lastEmitted: CaptureStatus?

    private static let daySec: Int64 = 86_400

    init(_ dependencies: Dependencies) {
        deps = dependencies
        deps.location.events = self
    }

    // MARK: launch

    /// Call on every launch, before `application(_:didFinishLaunchingWithOptions:)` returns:
    /// it is the only code that runs when iOS relaunches a dead app for a location event, and
    /// iOS never restarts continuous updates by itself. Restarts the selected capture with no
    /// JavaScript involved. Later calls do nothing.
    func resume(launchedForLocation: Bool) {
        guard !resumeRequested else { return }
        resumeRequested = true
        launchDetail = launchedForLocation ? "location" : "normal"
        finishResume()
    }

    private func finishResume() {
        guard !resumed else { return }
        do {
            state = try deps.stateStorage.load() ?? PersistedState()
        } catch StateStorageError.corrupt {
            state = PersistedState()
            log(DiagnosticEvent.stateReset)
        } catch {
            // Before the first unlock after a restart the file cannot be read. Do not treat
            // that as "nothing selected": wait, and try again on the next thing that happens.
            if !stateLockLogged {
                stateLockLogged = true
                log(DiagnosticEvent.stateLocked)
            }
            return
        }
        resumed = true

        log(DiagnosticEvent.launch, launchDetail)
        if let boot = deps.device.bootTimeSec {
            // The kernel's boot time moves only when the phone restarts.
            if let last = state.lastBootTimeSec, abs(boot - last) > 60 {
                log(DiagnosticEvent.bootRestart)
            }
            state.lastBootTimeSec = boot
        }
        logEnvironment()
        recordAuthorization()
        if state.selection != nil {
            // The spec: the module repeats the store check by itself on every background wake.
            _ = checkStore(force: true)
            // A relaunch is a wake whether or not a fix follows it.
            purgeIfDue()
        }
        reconcile()
        save()
        lastEmitted = computeStatus()
    }

    /// Makes sure the module's state is loaded. False while it cannot be read.
    @discardableResult
    private func ready() -> Bool {
        if !resumeRequested {
            resume(launchedForLocation: false)
        } else {
            finishResume()
        }
        return resumed
    }

    private var lockedError: CaptureError {
        CaptureError(
            code: .storeUnusable,
            message: "state: the phone has not been unlocked since it restarted")
    }

    // MARK: the spec's methods

    func storeKeyHex() throws -> String {
        do {
            return try StoreKeys.requireKeyHex(try deps.keys.getOrCreateKeyHex())
        } catch {
            throw CaptureError(code: .storeUnusable, message: describe(error))
        }
    }

    var storeDirectory: String { deps.storeDirectory }

    func initStore() throws {
        guard ready() else { throw lockedError }
        let failure = checkStore(force: true)
        notify()
        if let failure {
            throw CaptureError(code: .storeUnusable, message: failure)
        }
    }

    func start(minIntervalSec: Double, minDistanceM: Double, accuracy: String) throws {
        guard minIntervalSec.isFinite, minIntervalSec > 0 else {
            throw CaptureError(code: .invalidArgument, message: "minIntervalSec must be greater than 0")
        }
        guard minDistanceM.isFinite, minDistanceM >= 0 else {
            throw CaptureError(code: .invalidArgument, message: "minDistanceM must be 0 or more")
        }
        guard let accuracy = Accuracy(rawValue: accuracy) else {
            throw CaptureError(code: .invalidArgument, message: "accuracy must be balanced or high")
        }
        guard ready() else { throw lockedError }
        guard permission.allowsCapture else {
            throw CaptureError(
                code: .permissionDenied, message: "location permission is \(permission.rawValue)")
        }
        if let failure = checkStore(force: true) {
            notify()
            throw CaptureError(code: .storeUnusable, message: failure)
        }

        let next = CaptureConfig(
            minIntervalSec: minIntervalSec, minDistanceM: minDistanceM, accuracy: accuracy)
        if state.selection == next, continuousOn {
            // Safe to call on every app launch: nothing is restarted and no schedule is reset.
            notify()
            return
        }
        // Stop first, then start: a changed config never runs beside the old one.
        if state.selection != nil, continuousOn {
            stopMechanism()
        }
        if state.selection == nil {
            state.selectedPeriods.append(PersistedState.Period(from: deps.now(), to: nil))
            log(DiagnosticEvent.modeChanged, CaptureMode.ios.rawValue)
        }
        state.selection = next
        state.intervalSec = next.minIntervalSec
        refusedByOS = false
        save()

        // The selection is kept even if iOS refuses: `reconcile` tries again on the next
        // launch, permission change or return to the foreground.
        if let reason = blocker() {
            lossReason = reason
            log(DiagnosticEvent.startFailed, reason)
            notify()
            throw CaptureError(code: .startFailed, message: reason)
        }
        reconcile()
        notify()
    }

    func stop() throws {
        guard ready() else { throw lockedError }
        guard state.selection != nil else { return }
        stopMechanism()
        state.selection = nil
        if let last = state.selectedPeriods.indices.last, state.selectedPeriods[last].to == nil {
            state.selectedPeriods[last].to = deps.now()
        }
        log(DiagnosticEvent.modeChanged, CaptureMode.stopped.rawValue)
        save()
        notify()
    }

    func status() -> CaptureStatus {
        ready()
        return computeStatus()
    }

    /// Shows the system prompt for one step and calls back when the user has answered. Calls
    /// back at once, showing nothing, in every case the spec lists: the step is already
    /// granted, `background` is asked before `foreground` is granted, or iOS will not ask again.
    func requestPermission(_ step: PermissionStep, completion: @escaping (PermissionState) -> Void) {
        ready()
        let authorization = deps.location.authorization
        switch step {
        case .foreground:
            guard authorization == .notDetermined else {
                completion(authorization.permission)
                return
            }
            permissionWaiters.append(completion)
            guard pendingPrompt == nil else { return }
            pendingPrompt = .foreground
            log(DiagnosticEvent.permForegroundPromptShown)
            deps.location.requestWhenInUseAuthorization()

        case .background:
            if pendingPrompt == .background {
                permissionWaiters.append(completion)
                return
            }
            // iOS shows the Always prompt once per install. Asking again shows nothing.
            guard authorization == .whenInUse, !state.alwaysPromptShown else {
                completion(authorization.permission)
                return
            }
            permissionWaiters.append(completion)
            pendingPrompt = .background
            resignedSincePrompt = false
            state.alwaysPromptShown = true
            save()
            log(DiagnosticEvent.permAlwaysPromptShown)
            deps.location.requestAlwaysAuthorization()
            deps.scheduler.after(seconds: deps.tunables.alwaysPromptGraceSec) { [weak self] in
                self?.alwaysPromptGraceElapsed()
            }
        }
    }

    func openSystemSettings(_ target: SettingsTarget, completion: @escaping (Bool) -> Void) {
        // iOS has one settings page per app and none for battery or hibernation.
        guard target == .app else {
            completion(false)
            return
        }
        log(DiagnosticEvent.settingsOpened, target.rawValue)
        deps.device.openAppSettings(completion: completion)
    }

    func diagnostics(since sinceTsUtc: Double) -> [DiagnosticEntry] {
        guard sinceTsUtc.isFinite else { return deps.diagnostics.entries(since: Int64.min) }
        let bounded = max(-9e18, min(9e18, sinceTsUtc.rounded(.up)))
        return deps.diagnostics.entries(since: Int64(bounded))
    }

    /// `getDeviceConditions`: on external power, and nobody using the app. Never throws.
    ///
    /// `charging` is external power, whether or not the battery is still filling: the question
    /// is whether rewriting the store file costs the user battery. `idle` is the app not being
    /// active, which covers the background, a locked phone and a dark screen alike. A phone
    /// left on a charger overnight is both; one in use on a charger is not idle; one in a
    /// pocket is not charging.
    func deviceConditions() -> MaintenanceConditions {
        MaintenanceConditions(charging: deps.device.onExternalPower, idle: !deps.device.appActive)
    }

    /// `getNetworkConditions`: whether the active connection is metered. Never throws.
    ///
    /// Metered is what iOS calls expensive (mobile data, a personal hotspot) or constrained
    /// (Low Data Mode, which is the user asking for less traffic on that network). With no
    /// usable connection, or before iOS has said anything, the answer is metered: the bundle
    /// fetcher waits, as it does with no answer at all.
    func networkConditions() -> NetworkConditions {
        guard let path = deps.device.networkPath else { return NetworkConditions(metered: true) }
        return NetworkConditions(metered: path.expensive || path.constrained)
    }

    func debugInjectSample(lat: Double, lon: Double, tsUtc: Double, accuracyM: Double) throws {
        guard deps.debugBuild else {
            throw CaptureError(
                code: .notAvailable, message: "debugInjectSample exists only in debug builds")
        }
        let coordinate = Coordinate(lat: lat, lon: lon)
        guard Geo.isValid(coordinate), tsUtc.isFinite, accuracyM >= 0,
            let seconds = Int64(exactly: tsUtc.rounded(.towardZero))
        else {
            throw CaptureError(
                code: .invalidArgument, message: "debugInjectSample: a value is out of range")
        }
        guard ready() else { throw lockedError }
        let fix = Fix(coordinate: coordinate, tsUtc: seconds, accuracyM: accuracyM)
        let failure = write(fix, source: .manual, forceStoreCheck: true)
        notify()
        if let failure {
            throw CaptureError(code: .storeUnusable, message: failure)
        }
    }

    // MARK: the app's lifecycle

    func appWillResignActive() {
        if pendingPrompt == .background {
            resignedSincePrompt = true
        }
    }

    func appDidBecomeActive() {
        guard ready() else { return }
        if pendingPrompt == .background, resignedSincePrompt {
            // "Keep Only While Using" changes nothing, so iOS sends no callback for it. The
            // prompt did make the app inactive, and now it is active again: unless a grant
            // arrives in the next moment, the user refused.
            deps.scheduler.after(seconds: deps.tunables.alwaysPromptSettleSec) { [weak self] in
                self?.alwaysPromptSettled()
            }
        }
        // The user may be back from Settings. Everything that could have changed is re-read.
        refusedByOS = false
        recordAuthorization()
        if state.selection != nil, storeFailure != nil {
            _ = checkStore(force: true)
        }
        reconcile()
        logEnvironment()
        save()
        notify()
    }

    /// Low Power Mode or Background App Refresh changed.
    func deviceConditionsChanged() {
        guard ready() else { return }
        logEnvironment()
        notify()
    }

    /// The phone was unlocked: files and the Keychain that were out of reach are readable now.
    func protectedDataBecameAvailable() {
        guard ready() else { return }
        if state.selection != nil, storeFailure != nil {
            _ = checkStore(force: true)
        }
        reconcile()
        notify()
    }

    // MARK: status

    private var permission: PermissionState { deps.location.authorization.permission }

    private func computeStatus() -> CaptureStatus {
        let at = deps.now()
        let dayAgo = at - Self.daySec
        let permission = self.permission
        let selected = state.selection != nil
        let running = selected && continuousOn

        var raised: Set<HealthFlag> = []
        if permission != .always { raised.insert(.backgroundPermissionMissing) }
        if !deps.location.preciseLocation { raised.insert(.preciseLocationOff) }
        if !deps.location.locationServicesEnabled { raised.insert(.locationServicesOff) }
        if selected, !continuousOn { raised.insert(.serviceNotRunning) }
        if storeFailure != nil || !resumed { raised.insert(.storeUnusable) }
        if !deps.device.backgroundRefreshAvailable { raised.insert(.backgroundRefreshOff) }
        if deps.device.lowPowerMode { raised.insert(.lowPowerMode) }

        var tier = CaptureTier.stopped
        if running, permission.allowsCapture {
            tier = permission == .always ? .backgroundUpdates : .throttled
        }

        var selectedSec: Int64 = 0
        for period in state.selectedPeriods {
            selectedSec += max(0, (period.to ?? at) - max(period.from, dayAgo))
        }
        let expected = state.intervalSec.map { Int((Double(selectedSec) / $0).rounded(.down)) } ?? 0

        return CaptureStatus(
            running: running,
            mode: selected ? .ios : .stopped,
            tier: tier,
            permission: permission,
            health: HealthFlag.allCases.filter(raised.contains),
            lastSampleTsUtc: state.lastSampleTsUtc,
            samplesLast24h: state.sampleTimestamps.filter { $0 >= dayAgo }.count,
            expectedLast24h: expected)
    }

    /// Emits `onStatusChanged` if the status differs from the one last emitted.
    private func notify() {
        let status = computeStatus()
        if status != lastEmitted {
            lastEmitted = status
            listener?.statusChanged(status)
        }
    }

    // MARK: the mechanism

    /// Why iOS will not run capture right now, or nil if it will.
    private func blocker() -> String? {
        let permission = self.permission
        if !permission.allowsCapture {
            return "permission_\(permission.rawValue)"
        }
        if !deps.location.locationServicesEnabled {
            return "location_services_off"
        }
        if refusedByOS {
            return "os_refused"
        }
        return nil
    }

    /// Makes what is running match what is selected and what iOS allows. Idempotent, and called
    /// from every wake path, so it is also the watchdog: iOS runs no timer for a suspended app,
    /// and the wake paths are the only moments the module can act.
    private func reconcile() {
        guard let config = state.selection else { return }
        if let reason = blocker() {
            let wasAlive = continuousOn
            stopServices()
            if wasAlive || lossReason != reason {
                log(DiagnosticEvent.mechanismLost, reason)
            }
            lossReason = reason
            return
        }
        lossReason = nil
        if !continuousOn {
            deps.location.startContinuous(accuracy: config.accuracy)
            continuousOn = true
            servicesCleared = false
            log(DiagnosticEvent.captureStarted, CaptureMode.ios.rawValue)
        }

        let before = wakeSources
        if deps.location.authorization == .always {
            if !significantChangeOn, deps.location.significantChangeAvailable {
                deps.location.startSignificantChanges()
                significantChangeOn = true
            }
            if !visitsOn {
                deps.location.startVisits()
                visitsOn = true
            }
        } else {
            // "While using" delivers none of them in the background. Keeping them registered
            // would only suggest a safety net that is not there.
            stopWakeSources()
        }
        if wakeSources != before {
            log(DiagnosticEvent.wakeSources, wakeSources)
        }
    }

    private var wakeSources: String {
        var on: [String] = []
        if significantChangeOn { on.append("slc") }
        if visitsOn { on.append("visit") }
        if regionOn { on.append("region") }
        return on.isEmpty ? "none" : on.joined(separator: "+")
    }

    private func stopWakeSources() {
        if significantChangeOn {
            deps.location.stopSignificantChanges()
            significantChangeOn = false
        }
        if visitsOn {
            deps.location.stopVisits()
            visitsOn = false
        }
        if regionOn {
            deps.location.stopMonitoringExit()
            regionOn = false
        }
    }

    /// Stops all four services, including ones an earlier process left registered with iOS.
    private func stopServices() {
        guard continuousOn || significantChangeOn || visitsOn || regionOn || !servicesCleared else {
            return
        }
        deps.location.stopContinuous()
        deps.location.stopSignificantChanges()
        deps.location.stopVisits()
        deps.location.stopMonitoringExit()
        continuousOn = false
        significantChangeOn = false
        visitsOn = false
        regionOn = false
        servicesCleared = true
        leftLastRegion = false
    }

    /// Stops capture on purpose (`stop`, or `start` with a changed config).
    private func stopMechanism() {
        let wasAlive = continuousOn
        stopServices()
        lossReason = nil
        if wasAlive {
            log(DiagnosticEvent.captureStopped, CaptureMode.ios.rawValue)
        }
    }

    /// Moves the exit region onto the sample just stored. iOS keeps the circle after the
    /// process dies, so "the phone left the place of the last sample" can relaunch the app,
    /// and it is the one place the last position is remembered outside the encrypted store.
    private func relocateRegion(around center: Coordinate) {
        guard let config = state.selection, continuousOn,
            deps.location.authorization == .always, deps.location.regionMonitoringAvailable
        else { return }
        let radius = max(config.minDistanceM, deps.tunables.minRegionRadiusM)
        deps.location.monitorExit(from: center, radiusM: radius)
        if !regionOn {
            regionOn = true
            log(DiagnosticEvent.wakeSources, wakeSources)
        }
    }

    // MARK: the store

    /// The check `initStore` makes. Returns why the store is unusable, or nil if it is usable.
    private func checkStore(force: Bool) -> String? {
        let at = deps.now()
        if !force, let failure = storeFailure, let last = lastStoreCheckAt,
            abs(at - last) < deps.tunables.storeRetrySec
        {
            // Continuous updates arrive about once a second. Without this, a locked Keychain
            // would be asked for the key at that rate.
            return failure
        }
        lastStoreCheckAt = at
        do {
            try deps.store.check()
            if storeFailure != nil {
                storeFailure = nil
                log(DiagnosticEvent.storeUsable)
            }
            return nil
        } catch {
            return storeFailed(describe(error))
        }
    }

    private func storeFailed(_ why: String) -> String {
        if storeFailure == nil {
            log(DiagnosticEvent.storeUnusable, why)
        }
        storeFailure = why
        return why
    }

    /// Stores one sample and announces it. Returns why it could not, or nil.
    private func write(_ fix: Fix, source: SampleSource, forceStoreCheck: Bool = false) -> String? {
        if let failure = checkStore(force: forceStoreCheck) {
            return failure
        }
        guard let cells = Geo.sampleCells(fix.coordinate) else {
            return "cells: no H3 cell for the fix"
        }
        do {
            try deps.store.insertSample(
                SampleRow(
                    tsUtc: fix.tsUtc, coordinate: fix.coordinate, accuracyM: fix.accuracyM,
                    source: source.rawValue, h3r7: cells.h3r7, h3r5: cells.h3r5))
        } catch {
            return storeFailed(describe(error))
        }

        state.lastWrittenTsUtc = fix.tsUtc
        state.lastSampleTsUtc = max(state.lastSampleTsUtc ?? fix.tsUtc, fix.tsUtc)
        state.sampleTimestamps.append(fix.tsUtc)
        referencePosition = fix.coordinate
        leftLastRegion = false
        save()
        relocateRegion(around: fix.coordinate)
        listener?.sampleWritten(
            SampleWrittenEvent(tsUtc: fix.tsUtc, accuracyM: fix.accuracyM, source: source.rawValue))
        purgeIfDue()
        return nil
    }

    /// The retention purge of a wake with no JavaScript: fixes and stays that are past
    /// retention are deleted from the store, by the statements of native-writer.json. Nothing
    /// is derived and nothing is vacuumed here; both are TypeScript's (packages/shared,
    /// retention/).
    ///
    /// At most once per `purgeIntervalSec` in a process. The time of the last purge is not
    /// kept between processes and never decides what is deleted: the cutoff is computed from
    /// the clock on every run, so a purge after a long gap, or after the clock was changed,
    /// deletes exactly what one at that moment should. The gap is measured both ways, so a
    /// clock set back does not put the purge off.
    ///
    /// A purge that fails changes nothing (it is one transaction), is written to the
    /// diagnostics, and is tried again at the next wake. It does not raise `store_unusable`: a
    /// store that is unusable is reported by the write path, and is not purged at all.
    private func purgeIfDue() {
        let at = deps.now()
        if let last = lastPurgeAt, abs(at - last) < deps.tunables.purgeIntervalSec {
            return
        }
        guard storeFailure == nil else { return }
        do {
            let purged = try deps.store.purgeExpired(nowTsUtc: at)
            lastPurgeAt = at
            if !purged.nothing {
                log(
                    DiagnosticEvent.retentionPurge,
                    "samples=\(purged.samples),stays=\(purged.stays),trimmed=\(purged.staysTrimmed)")
            }
        } catch {
            log(DiagnosticEvent.retentionPurgeFailed, describe(error))
        }
    }

    private func describe(_ error: Error) -> String {
        (error as? StoreFailure)?.description ?? "\(error)"
    }

    // MARK: visits (plan 5.4)

    private func recordArrival(_ visit: Visit, arrival: Int64, cell: String) {
        // iOS can report the same visit again after a relaunch.
        guard state.openVisitArrivalTsUtc != arrival, state.lastClosedVisit?.arrivalTsUtc != arrival
        else { return }
        let row = VisitStayRow(
            startTs: arrival, endTs: arrival, coordinate: visit.coordinate,
            radiusM: visit.accuracyM, h3r7: cell, closed: false)
        guard writeVisit({ try self.deps.store.insertVisitStay(row) }) else { return }
        // A visit left open by a departure iOS never reported stays open in the store: its
        // departure time is not known, and `closed` claims that it is.
        state.openVisitArrivalTsUtc = arrival
        log(DiagnosticEvent.visitArrival)
    }

    private func recordDeparture(_ visit: Visit, departure: Int64, cell: String) {
        // iOS reports an arrival it did not see as unknown. There is one visit at a time, so
        // if one is open here, it is the one that just ended.
        guard let arrival = visit.arrivalTsUtc ?? state.openVisitArrivalTsUtc else {
            log(DiagnosticEvent.visitSkipped, "arrival_unknown")
            return
        }
        guard departure >= arrival else {
            log(DiagnosticEvent.visitSkipped, "departure_before_arrival")
            return
        }
        let times = PersistedState.VisitTimes(arrivalTsUtc: arrival, departureTsUtc: departure)
        guard state.lastClosedVisit != times else { return }
        let row = VisitStayRow(
            startTs: arrival, endTs: departure, coordinate: visit.coordinate,
            radiusM: visit.accuracyM, h3r7: cell, closed: true)
        let written = writeVisit {
            // No open row for this arrival: the whole visit is being seen only now.
            if try !self.deps.store.closeVisitStay(endTs: departure, startTs: arrival) {
                try self.deps.store.insertVisitStay(row)
            }
        }
        guard written else { return }
        if let open = state.openVisitArrivalTsUtc, open <= arrival {
            state.openVisitArrivalTsUtc = nil
        }
        state.lastClosedVisit = times
        log(DiagnosticEvent.visitDeparture)
    }

    private func writeVisit(_ statements: () throws -> Void) -> Bool {
        if checkStore(force: false) != nil {
            log(DiagnosticEvent.visitSkipped, "store_unusable")
            return false
        }
        do {
            try statements()
            purgeIfDue()
            return true
        } catch {
            _ = storeFailed(describe(error))
            log(DiagnosticEvent.visitSkipped, "store_unusable")
            return false
        }
    }

    // MARK: permission

    private func resolvePrompt() {
        pendingPrompt = nil
        let waiters = permissionWaiters
        permissionWaiters = []
        let permission = self.permission
        waiters.forEach { $0(permission) }
    }

    private func alwaysPromptGraceElapsed() {
        guard pendingPrompt == .background, !resignedSincePrompt else { return }
        // iOS showed nothing (it does that after "Allow Once"), so the one prompt is unspent.
        state.alwaysPromptShown = false
        save()
        resolvePrompt()
    }

    private func alwaysPromptSettled() {
        guard pendingPrompt == .background else { return }
        if deps.location.authorization == .whenInUse {
            log(DiagnosticEvent.permAlwaysDenied)
        }
        resolvePrompt()
    }

    /// Logs a permission change once, with the M0 trial's event names.
    private func recordAuthorization() {
        let authorization = deps.location.authorization
        let previous = state.lastAuthorization.flatMap(LocationAuthorization.init(rawValue:))
        if previous != authorization {
            switch (previous, authorization) {
            case (nil, _):
                break
            case (.notDetermined?, .whenInUse):
                log(DiagnosticEvent.permForegroundGranted)
            case (.notDetermined?, .always):
                log(DiagnosticEvent.permForegroundGranted)
                log(DiagnosticEvent.permAlwaysGranted)
            case (.notDetermined?, .denied), (.notDetermined?, .restricted):
                log(DiagnosticEvent.permForegroundDenied)
            case (.whenInUse?, .always):
                log(DiagnosticEvent.permAlwaysGranted)
            case (let from?, let to):
                log(DiagnosticEvent.permChanged, "\(from.rawValue)_to_\(to.rawValue)")
            }
            state.lastAuthorization = authorization.rawValue
        }
        let precise = deps.location.preciseLocation
        if state.lastPreciseLocation != precise {
            if state.lastPreciseLocation != nil || !precise {
                log(DiagnosticEvent.permAccuracy, precise ? "full" : "reduced")
            }
            state.lastPreciseLocation = precise
        }
    }

    // MARK: bookkeeping

    private func log(_ event: String, _ detail: String = "") {
        deps.diagnostics.append(DiagnosticEntry(tsUtc: deps.now(), event: event, detail: detail))
    }

    private func logEnvironment() {
        let environment =
            "bg_refresh=\(deps.device.backgroundRefreshAvailable ? "on" : "off");"
            + "low_power=\(deps.device.lowPowerMode ? 1 : 0)"
        if environment != lastEnvironment {
            lastEnvironment = environment
            log(DiagnosticEvent.environment, environment)
        }
    }

    /// At most one `fix_failed` line per capture interval: errors can arrive every second.
    private func noteFixFailure(_ detail: String) {
        let at = deps.now()
        let interval = Int64(state.selection?.minIntervalSec ?? 0)
        if let last = lastFixFailureLogAt, abs(at - last) < interval {
            return
        }
        lastFixFailureLogAt = at
        log(DiagnosticEvent.fixFailed, detail)
    }

    private func save() {
        let dayAgo = deps.now() - Self.daySec
        state.sampleTimestamps.removeAll { $0 < dayAgo }
        state.selectedPeriods.removeAll { period in
            period.to.map { $0 < dayAgo } ?? false
        }
        do {
            try deps.stateStorage.save(state)
            stateSaveFailureLogged = false
        } catch {
            if !stateSaveFailureLogged {
                stateSaveFailureLogged = true
                log(DiagnosticEvent.stateLocked, "save")
            }
        }
    }
}

// MARK: - Core Location's callbacks

extension CaptureEngine: LocationSystemEvents {
    func locationAuthorizationChanged() {
        guard ready() else { return }
        recordAuthorization()
        let authorization = deps.location.authorization
        if (pendingPrompt == .foreground && authorization != .notDetermined)
            || (pendingPrompt == .background && authorization != .whenInUse)
        {
            resolvePrompt()
        }
        refusedByOS = false
        reconcile()
        save()
        notify()
    }

    func locationDelivered(_ fix: Fix, from origin: FixOrigin) {
        guard ready(), let config = state.selection, continuousOn, permission.allowsCapture else {
            return
        }
        guard fix.accuracyM >= 0, Geo.isValid(fix.coordinate) else {
            noteFixFailure("invalid_fix")
            return
        }
        let distance = referencePosition.map { Geo.haversineMeters($0, fix.coordinate) }
        let store = FixFilter.shouldStore(
            fixTsUtc: fix.tsUtc, lastWrittenTsUtc: state.lastWrittenTsUtc,
            distanceFromLastM: distance, leftLastRegion: leftLastRegion, config: config)
        guard store else {
            if referencePosition == nil {
                referencePosition = fix.coordinate
            }
            return
        }
        let source: SampleSource
        switch origin {
        case .significantChange: source = .slc
        case .continuous: source = leftLastRegion ? .region : .continuous
        }
        if write(fix, source: source) != nil {
            noteFixFailure("store_unusable")
        }
        notify()
    }

    func locationFailed(_ failure: LocationFailure, from origin: FixOrigin) {
        guard ready(), state.selection != nil else { return }
        switch failure {
        case .denied:
            refusedByOS = true
            reconcile()
            notify()
        case .other(let code):
            // kCLErrorLocationUnknown is normal indoors: iOS keeps trying.
            noteFixFailure("cl_error_\(code)")
        }
    }

    func visitReported(_ visit: Visit) {
        guard ready(), state.selection != nil, continuousOn else { return }
        guard visit.accuracyM >= 0, let cell = Geo.matchCell(visit.coordinate) else {
            log(DiagnosticEvent.visitSkipped, "invalid_visit")
            return
        }
        if let departure = visit.departureTsUtc {
            recordDeparture(visit, departure: departure, cell: cell)
        } else if let arrival = visit.arrivalTsUtc {
            recordArrival(visit, arrival: arrival, cell: cell)
        } else {
            log(DiagnosticEvent.visitSkipped, "no_times")
        }
        save()
        notify()
    }

    func exitedMonitoredRegion() {
        guard ready(), state.selection != nil else { return }
        leftLastRegion = true
        log(DiagnosticEvent.regionExit)
    }
}
