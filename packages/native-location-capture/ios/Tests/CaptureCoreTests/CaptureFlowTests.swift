import XCTest

@testable import CaptureCore

/// The capture path: a fix arrives from Core Location and is stored, dropped or refused, and
/// what happens to capture when the phone's settings change under it.
final class CaptureFlowTests: XCTestCase {
    private func capturing(_ authorization: LocationAuthorization = .always) throws -> Harness {
        let phone = Harness(authorization: authorization)
        try phone.start()
        phone.location.clearCalls()
        return phone
    }

    // MARK: storing

    func testTheFirstFixIsStoredWithItsCellsAndAnnounced() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0, accuracyM: 35))

        XCTAssertEqual(
            phone.store.samples,
            [
                SampleRow(
                    tsUtc: Harness.t0, coordinate: Place.home, accuracyM: 35, source: "continuous",
                    h3r7: "8760145b4ffffff", h3r5: "8560145bfffffff")
            ])
        XCTAssertEqual(
            phone.listener.samples,
            [SampleWrittenEvent(tsUtc: Harness.t0, accuracyM: 35, source: "continuous")])
        XCTAssertEqual(phone.status.lastSampleTsUtc, Harness.t0)
        XCTAssertEqual(phone.status.samplesLast24h, 1)
    }

    func testAPhoneSittingStillIsSampledOncePerInterval() throws {
        let phone = try capturing()
        // Core Location delivers about one fix a second.
        for second in stride(from: Int64(0), through: 1800, by: 60) {
            phone.clock.now = Harness.t0 + second
            phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        }
        XCTAssertEqual(
            phone.store.samples.map(\.tsUtc), [Harness.t0, Harness.t0 + 900, Harness.t0 + 1800])
    }

    func testMovingFartherThanTheMinimumDistanceStoresBeforeTheIntervalIsUp() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.location.deliver(Fix(Place.nearHome, at: Harness.t0 + 60))
        XCTAssertEqual(phone.store.samples.count, 1, "50 m in a minute is neither far nor late enough")

        phone.location.deliver(Fix(Place.office, at: Harness.t0 + 120))
        XCTAssertEqual(phone.store.samples.map(\.coordinate), [Place.home, Place.office])

        // The distance is measured from the sample stored last, not from the first one.
        phone.location.deliver(Fix(Place.office, at: Harness.t0 + 180))
        XCTAssertEqual(phone.store.samples.count, 2)
    }

    func testASignificantChangeFixIsStoredWithItsOwnSource() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.location.deliver(Fix(Place.office, at: Harness.t0 + 300), from: .significantChange)
        XCTAssertEqual(phone.store.samples.map(\.source), ["continuous", "slc"])
        XCTAssertEqual(phone.listener.samples.map(\.source), ["continuous", "slc"])
    }

    func testTheExitRegionFollowsTheLastStoredSample() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertEqual(phone.location.exitRegion?.center, Place.home)
        XCTAssertEqual(phone.location.exitRegion?.radiusM, 150)
        XCTAssertEqual(phone.diagnostics.lines.last, "wake_sources:slc+visit+region")

        phone.location.deliver(Fix(Place.nearHome, at: Harness.t0 + 60))
        XCTAssertEqual(phone.location.exitRegion?.center, Place.home, "a dropped fix moves nothing")

        phone.location.deliver(Fix(Place.office, at: Harness.t0 + 120))
        XCTAssertEqual(phone.location.exitRegion?.center, Place.office)
        XCTAssertEqual(phone.location.calls, ["monitorExit", "monitorExit"])
    }

    func testTheExitRegionIsNeverSmallerThanTheMinimumDistance() throws {
        let phone = Harness()
        try phone.start(distance: 400)
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertEqual(phone.location.exitRegion?.radiusM, 400)
    }

    func testNoRegionWithoutAlwaysOrWhereTheDeviceCannotMonitorOne() throws {
        let foregroundOnly = try capturing(.whenInUse)
        foregroundOnly.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertNil(foregroundOnly.location.exitRegion)
        XCTAssertEqual(foregroundOnly.store.samples.count, 1)

        let noRegions = Harness()
        noRegions.location.regionMonitoringAvailable = false
        noRegions.location.significantChangeAvailable = false
        try noRegions.start()
        noRegions.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertNil(noRegions.location.exitRegion)
        XCTAssertEqual(noRegions.location.calls, ["startContinuous:balanced", "startVisits"])
    }

    func testLeavingTheRegionStoresTheNextFixAsARegionSample() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))

        XCTAssertTrue(phone.location.exitRegionNow())
        // Close in time, and this fix alone would not pass the distance rule.
        phone.location.deliver(Fix(Place.nearHome, at: Harness.t0 + 60))

        XCTAssertEqual(phone.store.samples.map(\.source), ["continuous", "region"])
        XCTAssertTrue(phone.diagnostics.lines.contains("region_exit"))

        phone.location.deliver(Fix(Place.nearHome, at: Harness.t0 + 120))
        XCTAssertEqual(phone.store.samples.count, 2, "the exit is used once")
    }

    func testAClockSetBackDoesNotHoldCaptureOff() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.clock.now = Harness.t0 - 7200
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.samples.count, 2)
    }

    // MARK: dropping

    func testAnInvalidFixIsDroppedAndLoggedOncePerInterval() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0, accuracyM: -1))
        phone.location.deliver(Fix(Coordinate(lat: .nan, lon: 0), at: Harness.t0 + 1))
        phone.location.deliver(Fix(Coordinate(lat: 0, lon: 200), at: Harness.t0 + 2))

        XCTAssertEqual(phone.store.samples, [])
        XCTAssertEqual(phone.diagnostics.lines.filter { $0 == "fix_failed:invalid_fix" }.count, 1)

        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now, accuracyM: -1))
        XCTAssertEqual(phone.diagnostics.lines.filter { $0 == "fix_failed:invalid_fix" }.count, 2)
    }

    func testATransientCoreLocationErrorIsLoggedAndCaptureKeepsRunning() throws {
        let phone = try capturing()
        phone.engine.locationFailed(.other(code: 0), from: .continuous)
        phone.engine.locationFailed(.other(code: 0), from: .continuous)

        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.diagnostics.lines.filter { $0 == "fix_failed:cl_error_0" }.count, 1)
    }

    func testNothingIsStoredWhenCaptureIsNotSelected() {
        let phone = Harness()
        XCTAssertFalse(phone.location.deliver(Fix(Place.home, at: Harness.t0)))
        // Even if Core Location did call back, the engine would not write.
        phone.engine.locationDelivered(Fix(Place.home, at: Harness.t0), from: .continuous)
        phone.engine.visitReported(
            Visit(coordinate: Place.home, accuracyM: 30, arrivalTsUtc: Harness.t0, departureTsUtc: nil))
        XCTAssertEqual(phone.store.samples, [])
        XCTAssertEqual(phone.store.stays, [])
    }

    // MARK: the store going away

    func testNothingIsWrittenWhileTheStoreIsUnusableAndCaptureResumesWhenItReturns() throws {
        let phone = try capturing()
        phone.store.failure = StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")

        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertEqual(phone.store.samples, [])
        XCTAssertEqual(phone.listener.samples, [])
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertTrue(phone.status.running, "Core Location is still delivering")

        // The stream continues at one fix a second; the store is not hammered.
        let checksBefore = phone.store.checks
        for second in 1...20 {
            phone.clock.now = Harness.t0 + Int64(second)
            phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        }
        XCTAssertEqual(phone.store.checks, checksBefore)
        XCTAssertEqual(phone.diagnostics.lines.filter { $0.hasPrefix("store_unusable") }.count, 1)
        XCTAssertEqual(phone.diagnostics.lines.filter { $0 == "fix_failed:store_unusable" }.count, 1)

        phone.store.failure = nil
        phone.clock.now = Harness.t0 + 31
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))

        XCTAssertEqual(phone.store.samples.count, 1)
        XCTAssertEqual(phone.status.health, [])
        XCTAssertTrue(phone.diagnostics.lines.contains("store_usable"))
    }

    func testAFailedWriteIsReportedAsAnUnusableStore() throws {
        let phone = try capturing()
        phone.store.writeFailure = StoreFailure(step: "insert_sample", message: "disk I/O error")
        phone.location.deliver(Fix(Place.home, at: Harness.t0))

        XCTAssertEqual(phone.store.samples, [])
        XCTAssertEqual(phone.listener.samples, [])
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertNil(phone.status.lastSampleTsUtc)
        XCTAssertTrue(
            phone.diagnostics.lines.contains("store_unusable:insert_sample: disk I/O error"))
    }

    // MARK: settings changing under capture

    func testRevokingPermissionStopsTheMechanismAndGrantingItAgainRestartsIt() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.location.clearCalls()

        phone.location.setAuthorization(.denied)

        XCTAssertEqual(
            phone.location.calls,
            ["stopContinuous", "stopSignificantChanges", "stopVisits", "stopMonitoringExit"])
        XCTAssertEqual(phone.status.mode, .ios, "the selection stays")
        XCTAssertFalse(phone.status.running)
        XCTAssertEqual(phone.status.tier, .stopped)
        XCTAssertEqual(phone.status.permission, .denied)
        XCTAssertEqual(phone.status.health, [.backgroundPermissionMissing, .serviceNotRunning])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)),
            ["perm_changed:always_to_denied", "mechanism_lost:permission_denied"])

        phone.location.setAuthorization(.always)

        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.tier, .backgroundUpdates)
        XCTAssertEqual(phone.status.health, [])
        XCTAssertTrue(phone.location.canRelaunchApp)
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(3)),
            ["perm_changed:denied_to_always", "capture_started:ios", "wake_sources:slc+visit"])
    }

    func testDowngradingToWhileUsingKeepsSamplingButDropsTheRelaunchSources() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.location.clearCalls()

        phone.location.setAuthorization(.whenInUse)

        XCTAssertEqual(
            phone.location.calls, ["stopSignificantChanges", "stopVisits", "stopMonitoringExit"])
        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(phone.status.tier, .throttled)
        XCTAssertEqual(phone.status.health, [.backgroundPermissionMissing])
        XCTAssertEqual(phone.diagnostics.lines.last, "wake_sources:none")

        phone.location.setAuthorization(.always)
        XCTAssertEqual(phone.status.tier, .backgroundUpdates)
        XCTAssertEqual(phone.diagnostics.lines.last, "wake_sources:slc+visit")
    }

    func testLocationServicesSwitchedOffIsItsOwnFlag() throws {
        let phone = try capturing()
        // iOS reports the global switch as "denied" for the app, and the switch itself apart.
        phone.location.locationServicesEnabled = false
        phone.location.setAuthorization(.denied)

        XCTAssertEqual(
            phone.status.health,
            [.backgroundPermissionMissing, .locationServicesOff, .serviceNotRunning])
    }

    func testCoreLocationRefusingARunningServiceIsReportedAndRetriedOnTheNextForeground() throws {
        let phone = try capturing()
        phone.engine.locationFailed(.denied, from: .continuous)

        XCTAssertFalse(phone.status.running)
        XCTAssertEqual(phone.status.health, [.serviceNotRunning])
        XCTAssertEqual(phone.diagnostics.lines.last, "mechanism_lost:os_refused")
        XCTAssertFalse(phone.location.continuousRunning)

        phone.engine.appDidBecomeActive()

        XCTAssertTrue(phone.status.running)
        XCTAssertTrue(phone.location.continuousRunning)
    }

    func testApproximateLocationIsFlaggedAndStillCaptured() throws {
        let phone = try capturing()
        phone.location.preciseLocation = false
        phone.location.setAuthorization(.always)
        phone.location.deliver(Fix(Place.home, at: Harness.t0, accuracyM: 3000))

        XCTAssertEqual(phone.status.health, [.preciseLocationOff])
        XCTAssertEqual(phone.store.samples.map(\.accuracyM), [3000])
        XCTAssertTrue(phone.diagnostics.lines.contains("perm_accuracy:reduced"))
    }
}
