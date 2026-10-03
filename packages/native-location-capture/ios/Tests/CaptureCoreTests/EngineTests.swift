import XCTest

@testable import CaptureCore

/// The spec's methods, one behaviour per test. The rules are the comments in
/// src/specs/NativeLocationCapture.ts; src/fake.test.ts states the same rules for the fake.
final class EngineTests: XCTestCase {
    // MARK: start

    func testStartSelectsTheIosModeAndStartsEverySource() throws {
        let phone = Harness()
        try phone.start()

        XCTAssertEqual(
            phone.location.calls, ["startContinuous:balanced", "startSignificantChanges", "startVisits"])
        XCTAssertEqual(
            phone.status,
            CaptureStatus(
                running: true, mode: .ios, tier: .backgroundUpdates, permission: .always, health: [],
                lastSampleTsUtc: nil, samplesLast24h: 0, expectedLast24h: 0))
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(3)),
            ["mode_changed:ios", "capture_started:ios", "wake_sources:slc+visit"])
    }

    func testAccuracyHighIsPassedToCoreLocation() throws {
        let phone = Harness()
        try phone.start(accuracy: "high")
        XCTAssertEqual(phone.location.continuousAccuracy, .high)
    }

    func testWhileUsingOnlyRunsThrottledWithoutTheSourcesThatNeedAlways() throws {
        let phone = Harness(authorization: .whenInUse)
        try phone.start()

        XCTAssertEqual(phone.location.calls, ["startContinuous:balanced"])
        XCTAssertFalse(phone.location.canRelaunchApp)
        XCTAssertEqual(phone.status.tier, .throttled)
        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.health, [.backgroundPermissionMissing])
    }

    func testStartRejectsValuesOutOfRangeAndChangesNothing() {
        let phone = Harness()
        assertRejects(.invalidArgument) { try phone.start(interval: 0) }
        assertRejects(.invalidArgument) { try phone.start(interval: -900) }
        assertRejects(.invalidArgument) { try phone.start(interval: .nan) }
        assertRejects(.invalidArgument) { try phone.start(interval: .infinity) }
        assertRejects(.invalidArgument) { try phone.start(distance: -1) }
        assertRejects(.invalidArgument) { try phone.start(distance: .nan) }
        assertRejects(.invalidArgument) { try phone.start(accuracy: "best") }

        XCTAssertEqual(phone.status.mode, .stopped)
        XCTAssertEqual(phone.location.calls, [])
    }

    func testStartNeedsAtLeastForegroundPermission() {
        for authorization in [LocationAuthorization.notDetermined, .denied, .restricted] {
            let phone = Harness(authorization: authorization)
            assertRejects(.permissionDenied) { try phone.start() }
            XCTAssertEqual(phone.status.mode, .stopped)
            XCTAssertEqual(phone.location.calls, [])
        }
    }

    func testStartRejectsWhenTheStoreIsUnusableAndLeavesARunningModeRunning() throws {
        let phone = Harness()
        try phone.start()
        phone.location.clearCalls()

        phone.store.failure = StoreFailure(step: "schema_version", message: "store schema is version 2")
        assertRejects(.storeUnusable) { try phone.start(interval: 600) }

        XCTAssertEqual(phone.location.calls, [])
        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.stateStorage.saved?.selection?.minIntervalSec, 900)
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertEqual(
            phone.diagnostics.lines.last, "store_unusable:schema_version: store schema is version 2")
    }

    func testStartWithTheSameConfigDoesNothing() throws {
        let phone = Harness()
        try phone.start()
        phone.location.clearCalls()
        let logged = phone.diagnostics.lines

        try phone.start()

        XCTAssertEqual(phone.location.calls, [])
        XCTAssertEqual(phone.diagnostics.lines, logged)
    }

    func testStartWithAChangedConfigStopsEverythingThenStartsAgain() throws {
        let phone = Harness()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        phone.location.clearCalls()

        try phone.start(interval: 600, accuracy: "high")

        XCTAssertEqual(
            phone.location.calls,
            [
                "stopContinuous", "stopSignificantChanges", "stopVisits", "stopMonitoringExit",
                "startContinuous:high", "startSignificantChanges", "startVisits",
            ])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(3)),
            ["capture_stopped:ios", "capture_started:ios", "wake_sources:slc+visit"])
        // The selection changed its settings, not its mode: no mode_changed line.
        XCTAssertEqual(phone.diagnostics.lines.filter { $0.hasPrefix("mode_changed") }.count, 1)
        XCTAssertTrue(phone.status.running)
    }

    func testStartFailedKeepsTheSelectionAndTheNextWakeRetries() throws {
        let phone = Harness()
        phone.location.locationServicesEnabled = false

        assertRejects(.startFailed) { try phone.start() }

        XCTAssertEqual(phone.status.mode, .ios)
        XCTAssertFalse(phone.status.running)
        XCTAssertEqual(phone.status.tier, .stopped)
        XCTAssertEqual(phone.status.health, [.locationServicesOff, .serviceNotRunning])
        XCTAssertEqual(phone.diagnostics.lines.last, "start_failed:location_services_off")
        XCTAssertNotNil(phone.stateStorage.saved?.selection)

        // The user switches Location Services back on; Core Location reports the change.
        phone.location.locationServicesEnabled = true
        phone.location.setAuthorization(.always)

        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.health, [])
    }

    // MARK: stop

    func testStopStopsEverySourceAndClearsTheSelection() throws {
        let phone = Harness()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        phone.location.clearCalls()

        try phone.engine.stop()

        XCTAssertEqual(
            phone.location.calls,
            ["stopContinuous", "stopSignificantChanges", "stopVisits", "stopMonitoringExit"])
        XCTAssertFalse(phone.location.canRelaunchApp)
        XCTAssertNil(phone.location.exitRegion)
        XCTAssertEqual(phone.status.mode, .stopped)
        XCTAssertFalse(phone.status.running)
        XCTAssertEqual(phone.status.health, [])
        XCTAssertNil(phone.stateStorage.saved?.selection)
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)), ["capture_stopped:ios", "mode_changed:stopped"])
    }

    func testStopIsIdempotent() throws {
        let phone = Harness()
        try phone.engine.stop()
        try phone.start()
        try phone.engine.stop()
        let logged = phone.diagnostics.lines
        phone.location.clearCalls()

        try phone.engine.stop()

        XCTAssertEqual(phone.location.calls, [])
        XCTAssertEqual(phone.diagnostics.lines, logged)
    }

    // MARK: status

    func testEveryDeviceFlagIsReportedInSpecOrderWhetherOrNotCaptureIsStarted() {
        let phone = Harness(authorization: .whenInUse)
        phone.location.preciseLocation = false
        phone.location.locationServicesEnabled = false
        phone.device.backgroundRefreshAvailable = false
        phone.device.lowPowerMode = true
        phone.store.failure = StoreFailure(step: "open", message: "unable to open database file")
        XCTAssertThrowsError(try phone.engine.initStore())

        XCTAssertEqual(
            phone.status.health,
            [
                .backgroundPermissionMissing, .preciseLocationOff, .locationServicesOff,
                .storeUnusable, .backgroundRefreshOff, .lowPowerMode,
            ])
        XCTAssertEqual(phone.status.mode, .stopped)
    }

    func testExpectedCountsOneSamplePerIntervalForTheTimeAModeWasSelected() throws {
        let phone = Harness()
        try phone.start(interval: 900)
        phone.clock.advance(3600)
        XCTAssertEqual(phone.status.expectedLast24h, 4)

        try phone.engine.stop()
        phone.clock.advance(3600)
        XCTAssertEqual(phone.status.expectedLast24h, 4, "the stopped hour expects nothing")

        try phone.start(interval: 900)
        phone.clock.advance(900)
        XCTAssertEqual(phone.status.expectedLast24h, 5)

        // 24 hours later only the still-running selection is inside the window.
        phone.clock.advance(86_400)
        XCTAssertEqual(phone.status.expectedLast24h, 96)
    }

    func testSampleCountsCoverTheLast24Hours() throws {
        let phone = Harness()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))

        XCTAssertEqual(phone.status.samplesLast24h, 2)
        XCTAssertEqual(phone.status.lastSampleTsUtc, phone.clock.now)

        phone.clock.advance(86_400 - 899)
        XCTAssertEqual(phone.status.samplesLast24h, 1)
        phone.clock.advance(900)
        XCTAssertEqual(phone.status.samplesLast24h, 0)
        XCTAssertEqual(phone.status.lastSampleTsUtc, Harness.t0 + 900)
    }

    func testStatusChangedIsEmittedOnlyWhenTheStatusDiffers() throws {
        let phone = Harness()
        try phone.start()
        XCTAssertEqual(phone.listener.statuses.count, 1)
        XCTAssertEqual(phone.listener.statuses.last, phone.status)

        try phone.start()
        phone.engine.deviceConditionsChanged()
        XCTAssertEqual(phone.listener.statuses.count, 1)

        phone.device.lowPowerMode = true
        phone.engine.deviceConditionsChanged()
        XCTAssertEqual(phone.listener.statuses.count, 2)
        XCTAssertEqual(phone.listener.statuses.last?.health, [.lowPowerMode])
    }

    // MARK: store

    func testInitStoreRejectsNamingTheFailedStepAndRecovers() throws {
        let phone = Harness()
        phone.store.failure = StoreFailure(step: "cipher_params", message: "kdf_iter is 1000, pinned 256000")

        XCTAssertThrowsError(try phone.engine.initStore()) { error in
            XCTAssertEqual(
                error as? CaptureError,
                CaptureError(code: .storeUnusable, message: "cipher_params: kdf_iter is 1000, pinned 256000"))
        }
        XCTAssertEqual(phone.status.health, [.storeUnusable])

        phone.store.failure = nil
        try phone.engine.initStore()
        try phone.engine.initStore()

        XCTAssertEqual(phone.status.health, [])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)),
            ["store_unusable:cipher_params: kdf_iter is 1000, pinned 256000", "store_usable"])
    }

    func testStoreKeyIsReturnedAsLowercaseHexAndALockedKeychainRejects() throws {
        let phone = Harness()
        phone.keys.keyHex = String(repeating: "AB", count: 32)
        XCTAssertEqual(try phone.engine.storeKeyHex(), String(repeating: "ab", count: 32))

        phone.keys.locked = true
        assertRejects(.storeUnusable) { _ = try phone.engine.storeKeyHex() }
        phone.keys.locked = false
        phone.keys.keyHex = "abc"
        assertRejects(.storeUnusable) { _ = try phone.engine.storeKeyHex() }
    }

    func testStoreDirectoryIsTheOneTheModuleWasBuiltWith() {
        XCTAssertEqual(Harness().engine.storeDirectory, "/store")
    }

    // MARK: settings and diagnostics

    func testOnlyTheAppSettingsPageExistsOnIos() {
        let phone = Harness()
        var results: [Bool] = []
        phone.engine.openSystemSettings(.app) { results.append($0) }
        phone.engine.openSystemSettings(.battery) { results.append($0) }
        phone.engine.openSystemSettings(.hibernation) { results.append($0) }

        XCTAssertEqual(results, [true, false, false])
        XCTAssertEqual(phone.device.settingsOpened, 1)
        XCTAssertEqual(phone.diagnostics.lines.last, "settings_opened:app")
    }

    func testDiagnosticsReturnsEntriesFromTheGivenTimeOldestFirst() throws {
        let phone = Harness()
        phone.clock.advance(100)
        try phone.start()
        phone.clock.advance(100)
        try phone.engine.stop()

        let recent = phone.engine.diagnostics(since: Double(Harness.t0 + 200))
        XCTAssertEqual(recent.map(\.event), ["capture_stopped", "mode_changed"])
        XCTAssertEqual(recent.map(\.detail), ["ios", "stopped"])
        XCTAssertEqual(
            phone.engine.diagnostics(since: 0).count, phone.diagnostics.all.count)
        XCTAssertEqual(phone.engine.diagnostics(since: .nan).count, phone.diagnostics.all.count)
        XCTAssertEqual(phone.engine.diagnostics(since: Double(Harness.t0 + 200) + 0.5).count, 0)
    }

    // MARK: debugInjectSample

    func testDebugInjectStoresAManualSampleWhetherOrNotCaptureIsStarted() throws {
        let phone = Harness()
        try phone.engine.debugInjectSample(lat: 19.076, lon: 72.8777, tsUtc: 1_789_999_000, accuracyM: 5)

        XCTAssertEqual(
            phone.store.samples,
            [
                SampleRow(
                    tsUtc: 1_789_999_000, coordinate: Coordinate(lat: 19.076, lon: 72.8777), accuracyM: 5,
                    source: "manual", h3r7: "87608b0b6ffffff", h3r5: "85608b0bfffffff")
            ])
        XCTAssertEqual(
            phone.listener.samples,
            [SampleWrittenEvent(tsUtc: 1_789_999_000, accuracyM: 5, source: "manual")])
        XCTAssertEqual(phone.status.mode, .stopped)
        XCTAssertNil(phone.location.exitRegion, "no region is monitored while capture is stopped")
    }

    func testDebugInjectSkipsTheIntervalAndDistanceFilter() throws {
        let phone = Harness()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        try phone.engine.debugInjectSample(
            lat: Place.home.lat, lon: Place.home.lon, tsUtc: Double(phone.clock.now + 1), accuracyM: 5)
        XCTAssertEqual(phone.store.samples.map(\.source), ["continuous", "manual"])
    }

    func testDebugInjectIsNotAvailableInAReleaseBuild() {
        let phone = Harness(launch: false)
        phone.debugBuild = false
        phone.launch()
        assertRejects(.notAvailable) {
            try phone.engine.debugInjectSample(lat: 0, lon: 0, tsUtc: 1, accuracyM: 1)
        }
        XCTAssertEqual(phone.store.samples, [])
    }

    func testDebugInjectRejectsValuesOutOfRangeAndAnUnusableStore() {
        let phone = Harness()
        assertRejects(.invalidArgument) {
            try phone.engine.debugInjectSample(lat: 91, lon: 0, tsUtc: 1, accuracyM: 1)
        }
        assertRejects(.invalidArgument) {
            try phone.engine.debugInjectSample(lat: 0, lon: 181, tsUtc: 1, accuracyM: 1)
        }
        assertRejects(.invalidArgument) {
            try phone.engine.debugInjectSample(lat: 0, lon: 0, tsUtc: .nan, accuracyM: 1)
        }
        assertRejects(.invalidArgument) {
            try phone.engine.debugInjectSample(lat: 0, lon: 0, tsUtc: 1e300, accuracyM: 1)
        }
        assertRejects(.invalidArgument) {
            try phone.engine.debugInjectSample(lat: 0, lon: 0, tsUtc: 1, accuracyM: -1)
        }
        phone.store.failure = StoreFailure(step: "open", message: "gone")
        assertRejects(.storeUnusable) {
            try phone.engine.debugInjectSample(lat: 0, lon: 0, tsUtc: 1, accuracyM: 1)
        }
        XCTAssertEqual(phone.store.samples, [])
    }
}
