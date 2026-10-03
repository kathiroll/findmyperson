import XCTest

@testable import CaptureCore

/// The scenarios the M0 iPhone trial (plan S0.3, m0/ios/README.md "The 6-day plan") checked by
/// hand on a real phone, as regressions of the state machine: backgrounding, force-quit followed
/// by movement, restart followed by the first unlock, Low Power Mode, and Background App Refresh
/// switched off. What iOS itself does in each case is the trial's finding; these tests fix what
/// the module does when iOS behaves that way.
final class RelaunchTests: XCTestCase {
    private func capturing() throws -> Harness {
        let phone = Harness()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        return phone
    }

    // MARK: backgrounding

    func testCaptureContinuesWhenTheAppLeavesTheScreen() throws {
        let phone = try capturing()
        phone.location.clearCalls()

        phone.engine.appWillResignActive()
        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))

        XCTAssertEqual(phone.store.samples.count, 3)
        XCTAssertEqual(phone.location.calls, ["monitorExit", "monitorExit"], "nothing was stopped")

        phone.engine.appDidBecomeActive()
        XCTAssertEqual(phone.location.calls.filter { $0.hasPrefix("start") }, [], "and nothing restarted")
        XCTAssertTrue(phone.status.running)
    }

    // MARK: force-quit, then movement

    func testAfterAForceQuitIosCanStillRelaunchTheApp() throws {
        let phone = try capturing()
        phone.kill()

        XCTAssertFalse(phone.location.continuousRunning, "continuous updates die with the process")
        XCTAssertTrue(phone.location.significantChangesRegistered)
        XCTAssertTrue(phone.location.visitsRegistered)
        XCTAssertEqual(phone.location.exitRegion?.center, Place.home)
        XCTAssertTrue(phone.location.canRelaunchApp)
    }

    func testARelaunchForALocationEventRestartsCaptureWithNoJavaScript() throws {
        let phone = try capturing()
        phone.kill()
        phone.location.clearCalls()
        phone.diagnostics.clear()
        phone.listener.clear()
        phone.clock.advance(1200)

        // iOS starts the process again. No start() is called: nothing but resume runs.
        phone.launch(forLocation: true)

        XCTAssertEqual(
            phone.location.calls, ["startContinuous:balanced", "startSignificantChanges", "startVisits"])
        XCTAssertEqual(
            phone.diagnostics.lines,
            [
                "launch:location", "env:bg_refresh=on;low_power=0", "capture_started:ios",
                "wake_sources:slc+visit",
            ])
        XCTAssertEqual(
            phone.status,
            CaptureStatus(
                running: true, mode: .ios, tier: .backgroundUpdates, permission: .always, health: [],
                lastSampleTsUtc: Harness.t0, samplesLast24h: 1, expectedLast24h: 1))

        // The significant-change fix that caused the relaunch is stored.
        phone.location.deliver(Fix(Place.office, at: phone.clock.now), from: .significantChange)
        XCTAssertEqual(phone.store.samples.map(\.source), ["continuous", "slc"])
        XCTAssertEqual(phone.location.exitRegion?.center, Place.office)
    }

    func testTheSameConfigIsRestoredAfterARelaunch() throws {
        let phone = Harness()
        try phone.start(interval: 600, distance: 250, accuracy: "high")
        phone.kill()
        phone.launch(forLocation: true)

        XCTAssertEqual(phone.location.continuousAccuracy, .high)
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.location.deliver(Fix(Place.home, at: Harness.t0 + 599))
        phone.location.deliver(Fix(Place.home, at: Harness.t0 + 600))
        XCTAssertEqual(phone.store.samples.map(\.tsUtc), [Harness.t0, Harness.t0 + 600])
        XCTAssertEqual(phone.location.exitRegion?.radiusM, 250)
    }

    func testAfterARelaunchTheIntervalStillCountsFromTheLastStoredSample() throws {
        let phone = try capturing()
        phone.kill()
        phone.clock.advance(300)
        phone.launch(forLocation: true)

        // Five minutes after the last sample, at an unknown distance from it: not stored yet.
        phone.location.deliver(Fix(Place.office, at: phone.clock.now), from: .significantChange)
        XCTAssertEqual(phone.store.samples.count, 1)
        // 100 m farther on is movement the new process has seen for itself.
        let farther = Coordinate(lat: Place.office.lat + 0.001, lon: Place.office.lon)
        phone.location.deliver(Fix(farther, at: phone.clock.now + 30))
        XCTAssertEqual(phone.store.samples.map(\.coordinate), [Place.home, farther])
    }

    func testARelaunchBecauseThePhoneLeftTheLastPlaceStoresTheNextFix() throws {
        let phone = try capturing()
        phone.kill()
        phone.clock.advance(300)
        phone.launch(forLocation: true)

        XCTAssertTrue(phone.location.exitRegionNow())
        phone.location.deliver(Fix(Place.office, at: phone.clock.now))

        XCTAssertEqual(phone.store.samples.map(\.source), ["continuous", "region"])
    }

    func testAVisitThatRelaunchesTheAppIsWrittenAsAStay() throws {
        let phone = try capturing()
        phone.kill()
        phone.clock.advance(3600)
        phone.launch(forLocation: true)

        XCTAssertTrue(
            phone.location.report(
                Visit(
                    coordinate: Place.office, accuracyM: 40, arrivalTsUtc: phone.clock.now - 600,
                    departureTsUtc: nil)))

        XCTAssertEqual(phone.store.stays.map(\.startTs), [phone.clock.now - 600])
    }

    func testAUserLaunchIsLoggedAsNormalAndResumeRunsOnce() throws {
        let phone = try capturing()
        phone.kill()
        phone.location.clearCalls()
        phone.diagnostics.clear()
        phone.launch()
        phone.engine.resume(launchedForLocation: true)

        XCTAssertEqual(phone.diagnostics.lines.first, "launch:normal")
        XCTAssertEqual(phone.diagnostics.lines.filter { $0.hasPrefix("launch") }.count, 1)
        XCTAssertEqual(phone.location.calls.filter { $0 == "startContinuous:balanced" }.count, 1)
    }

    func testAfterStopARelaunchStartsNothing() throws {
        let phone = try capturing()
        try phone.engine.stop()
        phone.kill()
        phone.location.clearCalls()

        XCTAssertFalse(phone.location.canRelaunchApp, "iOS has nothing left to relaunch the app for")
        phone.launch()

        XCTAssertEqual(phone.location.calls, [])
        XCTAssertEqual(phone.status.mode, .stopped)
        XCTAssertEqual(phone.status.lastSampleTsUtc, Harness.t0, "what was captured is still counted")
    }

    func testPermissionRevokedWhileTheAppWasDeadIsFoundOnTheNextLaunch() throws {
        let phone = try capturing()
        phone.kill()
        phone.location.authorization = .denied
        phone.location.clearCalls()
        phone.diagnostics.clear()

        phone.launch()

        XCTAssertEqual(phone.status.mode, .ios)
        XCTAssertFalse(phone.status.running)
        XCTAssertEqual(phone.status.health, [.backgroundPermissionMissing, .serviceNotRunning])
        // The registrations the dead process left with iOS are removed.
        XCTAssertEqual(
            phone.location.calls,
            ["stopContinuous", "stopSignificantChanges", "stopVisits", "stopMonitoringExit"])
        XCTAssertNil(phone.location.exitRegion)
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)),
            ["perm_changed:always_to_denied", "mechanism_lost:permission_denied"])

        phone.engine.appDidBecomeActive()
        XCTAssertEqual(
            phone.diagnostics.lines.filter { $0.hasPrefix("mechanism_lost") }.count, 1,
            "the same loss is logged once")
    }

    // MARK: restart, then first unlock

    func testBeforeTheFirstUnlockNothingIsForgottenAndNothingIsWritten() throws {
        let phone = try capturing()
        phone.kill()
        phone.location.clearCalls()
        phone.diagnostics.clear()
        // The phone restarted and has not been unlocked: the module's file and the Keychain
        // are out of reach.
        phone.device.bootTimeSec = 1_700_500_000
        phone.stateStorage.condition = .locked
        phone.keys.locked = true
        phone.store.failure = StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")
        phone.clock.advance(7200)

        phone.launch(forLocation: true)

        XCTAssertEqual(phone.diagnostics.lines, ["state_locked"])
        XCTAssertEqual(phone.location.calls, [])
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertNotNil(phone.stateStorage.saved?.selection, "the selection was not overwritten")
        assertRejects(.storeUnusable) { try phone.start() }
        assertRejects(.storeUnusable) { try phone.engine.stop() }
        assertRejects(.storeUnusable) { try phone.engine.initStore() }

        phone.engine.locationDelivered(Fix(Place.office, at: phone.clock.now), from: .significantChange)
        XCTAssertEqual(phone.store.samples.count, 1)
        XCTAssertEqual(phone.diagnostics.lines, ["state_locked"], "logged once")
    }

    func testTheFirstUnlockAfterARestartResumesCapture() throws {
        let phone = try capturing()
        phone.kill()
        phone.location.clearCalls()
        phone.diagnostics.clear()
        phone.device.bootTimeSec = 1_700_500_000
        phone.stateStorage.condition = .locked
        phone.store.failure = StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")
        phone.clock.advance(7200)
        phone.launch(forLocation: true)

        // The user unlocks the phone.
        phone.stateStorage.condition = .readable
        phone.store.failure = nil
        phone.engine.protectedDataBecameAvailable()

        XCTAssertEqual(
            phone.diagnostics.lines,
            [
                "state_locked", "launch:location", "boot_restart", "env:bg_refresh=on;low_power=0",
                "capture_started:ios", "wake_sources:slc+visit",
            ])
        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.health, [])

        phone.location.deliver(Fix(Place.office, at: phone.clock.now))
        XCTAssertEqual(phone.store.samples.count, 2)
    }

    func testAKeychainStillLockedAtLaunchIsRetriedWhenThePhoneIsUnlocked() throws {
        let phone = try capturing()
        phone.kill()
        phone.diagnostics.clear()
        // The module's file is readable but the key is not yet.
        phone.store.failure = StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")
        phone.launch(forLocation: true)

        XCTAssertTrue(phone.status.running, "the sources are started so that iOS keeps waking the app")
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertTrue(
            phone.diagnostics.lines.contains("store_unusable:key: keychain read failed: OSStatus -25308"))

        phone.store.failure = nil
        phone.engine.protectedDataBecameAvailable()

        XCTAssertEqual(phone.status.health, [])
        XCTAssertEqual(phone.diagnostics.lines.last, "store_usable")
    }

    func testAnUnreadableStateFileIsStartedAfreshAndSaidSo() {
        let phone = Harness(launch: false)
        phone.stateStorage.condition = .corrupt
        phone.launch()

        XCTAssertEqual(phone.diagnostics.lines.first, "state_reset")
        XCTAssertEqual(phone.status.mode, .stopped)
        XCTAssertEqual(phone.status.health, [])
    }

    func testTheStoreIsCheckedOnEveryWakeWhileCaptureIsSelected() throws {
        let phone = try capturing()
        phone.kill()
        let checks = phone.store.checks
        phone.launch(forLocation: true)
        XCTAssertEqual(phone.store.checks, checks + 1)

        try phone.engine.stop()
        phone.kill()
        let checksWhenStopped = phone.store.checks
        phone.launch()
        XCTAssertEqual(phone.store.checks, checksWhenStopped, "a stopped module does not open the store")
    }

    // MARK: Low Power Mode and Background App Refresh

    func testLowPowerModeIsFlaggedAndCaptureKeepsRunning() throws {
        let phone = try capturing()
        phone.device.lowPowerMode = true
        phone.engine.deviceConditionsChanged()

        XCTAssertEqual(phone.status.health, [.lowPowerMode])
        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.tier, .backgroundUpdates)
        XCTAssertEqual(phone.diagnostics.lines.last, "env:bg_refresh=on;low_power=1")
        XCTAssertEqual(phone.listener.statuses.last?.health, [.lowPowerMode])

        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.samples.count, 2)

        phone.device.lowPowerMode = false
        phone.engine.deviceConditionsChanged()
        XCTAssertEqual(phone.status.health, [])
    }

    func testBackgroundAppRefreshOffIsFlaggedBecauseIosWillNotRelaunchTheApp() throws {
        let phone = try capturing()
        phone.device.backgroundRefreshAvailable = false
        phone.engine.deviceConditionsChanged()

        XCTAssertEqual(phone.status.health, [.backgroundRefreshOff])
        XCTAssertEqual(phone.diagnostics.lines.last, "env:bg_refresh=off;low_power=0")
        // While the process lives, capture goes on. It is the relaunch that is lost.
        XCTAssertTrue(phone.status.running)

        phone.kill()
        phone.diagnostics.clear()
        phone.launch()
        XCTAssertEqual(phone.status.health, [.backgroundRefreshOff], "still reported after a launch")
        XCTAssertTrue(phone.diagnostics.lines.contains("env:bg_refresh=off;low_power=0"))
    }
}
