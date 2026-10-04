import XCTest

@testable import CaptureCore

/// Retention with no JavaScript running, and the answer the weekly VACUUM waits for.
///
/// The full purge is TypeScript (packages/shared, retention/) and runs when the app does. A
/// phone on which the app is never opened only ever runs this module, so storing a fix or a
/// visit, and every launch, purges fixes and stays too. What the purge does to a store is in
/// StoreTests, on the real schema; here the store is the fake, and the tests are about when it
/// is asked.
final class RetentionTests: XCTestCase {
    private static let day: Int64 = 86_400
    private static let retention = StoreContract.retentionSec

    private func capturing() throws -> Harness {
        let phone = Harness()
        try phone.start()
        return phone
    }

    private func storedTimes(_ phone: Harness) -> [Int64] {
        phone.store.samples.map(\.tsUtc)
    }

    private func purgeLines(_ phone: Harness) -> [String] {
        phone.diagnostics.lines.filter { $0.hasPrefix("retention_purge") }
    }

    // MARK: purge on wake

    func testAPhoneWhoseAppIsNeverOpenedStillHoldsNoMoreThanThirtyDays() throws {
        let phone = try capturing()
        // Forty days of a phone sitting still, one stored fix every fifteen minutes.
        for _ in 0..<(40 * 96) {
            phone.location.deliver(Fix(Place.home, at: phone.clock.now))
            phone.clock.advance(900)
        }
        let oldest = try XCTUnwrap(storedTimes(phone).min())
        XCTAssertGreaterThanOrEqual(oldest, phone.clock.now - Self.retention - 3600)
        XCTAssertEqual(storedTimes(phone).max(), phone.clock.now - 900)
        XCTAssertTrue((30 * 96...30 * 96 + 5).contains(phone.store.samples.count))
    }

    func testStoringAFixPurgesAtMostOnceAnHour() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges, [Harness.t0])
        // A phone on the move stores a fix far more often than once an interval.
        for step in 1...20 {
            phone.clock.advance(60)
            let place = Coordinate(lat: Place.home.lat + 0.002 * Double(step), lon: Place.home.lon)
            phone.location.deliver(Fix(place, at: phone.clock.now))
        }
        XCTAssertEqual(phone.store.samples.count, 21)
        XCTAssertEqual(phone.store.purges, [Harness.t0])

        phone.clock.advance(2400)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges, [Harness.t0, Harness.t0 + 3600])
    }

    func testWhatAPurgeRemovedIsInTheDiagnosticsAsCountsAndAPurgeOfNothingIsNot() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        XCTAssertEqual(purgeLines(phone), [])

        phone.clock.advance(Self.retention + 3600)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(purgeLines(phone), ["retention_purge:samples=1,stays=0,trimmed=0"])
        XCTAssertEqual(storedTimes(phone), [phone.clock.now])
    }

    func testARelaunchPurgesBeforeAnyFixArrives() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.kill()
        phone.clock.advance(Self.retention + Self.day)

        // iOS starts the process for a location event. Nothing but resume runs.
        phone.launch(forLocation: true)
        XCTAssertEqual(storedTimes(phone), [])
        XCTAssertEqual(phone.store.purges.last, phone.clock.now)
    }

    func testVisitsPastRetentionGoAndOneStillRunningIsCutAtTheCutoff() throws {
        let phone = try capturing()
        let arrival = Harness.t0
        phone.location.report(
            Visit(coordinate: Place.home, accuracyM: 40, arrivalTsUtc: arrival, departureTsUtc: arrival + 3600))
        phone.location.report(
            Visit(
                coordinate: Place.office, accuracyM: 40, arrivalTsUtc: arrival + 2 * Self.day,
                departureTsUtc: arrival + 40 * Self.day))

        phone.clock.advance(33 * Self.day)
        phone.location.deliver(Fix(Place.office, at: phone.clock.now))

        let cutoff = phone.clock.now - Self.retention
        XCTAssertEqual(phone.store.stays.map(\.startTs), [cutoff])
        XCTAssertEqual(phone.store.stays.map(\.endTs), [arrival + 40 * Self.day])
        XCTAssertEqual(purgeLines(phone), ["retention_purge:samples=0,stays=1,trimmed=1"])
    }

    func testStoringAVisitPurgesToo() throws {
        let phone = try capturing()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))
        phone.clock.advance(Self.retention + Self.day)

        // No fix arrives: the phone has not moved and continuous updates are quiet.
        phone.location.report(
            Visit(coordinate: Place.home, accuracyM: 40, arrivalTsUtc: phone.clock.now, departureTsUtc: nil))
        XCTAssertEqual(storedTimes(phone), [])
        XCTAssertEqual(phone.store.stays.count, 1)
    }

    func testAClockThatWasSetBackDoesNotPutThePurgeOff() throws {
        let phone = try capturing()
        phone.clock.advance(10 * Self.day)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges.last, Harness.t0 + 10 * Self.day)

        // Ten days back: an hour "since the last purge" would take ten days to pass.
        phone.clock.now = Harness.t0 + 3600
        phone.location.deliver(Fix(Place.office, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges.last, Harness.t0 + 3600)
    }

    func testAPurgeThatFailsIsLoggedChangesNothingAboutCaptureAndIsTriedAtTheNextWake() throws {
        let phone = try capturing()
        phone.clock.advance(3600)
        phone.store.purgeFailure = StoreFailure(step: "purge", message: "database is locked")

        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(purgeLines(phone), ["retention_purge_failed:purge: database is locked"])
        XCTAssertEqual(phone.store.samples.count, 1)
        XCTAssertEqual(phone.status.health, [])
        XCTAssertTrue(phone.status.running)

        phone.store.purgeFailure = nil
        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges.last, phone.clock.now)
    }

    func testAnUnusableStoreIsNotPurged() throws {
        let phone = try capturing()
        phone.clock.advance(3600)
        let before = phone.store.purges
        phone.store.failure = StoreFailure(step: "schema_version", message: "store schema is version 2")

        phone.location.deliver(Fix(Place.home, at: phone.clock.now))
        XCTAssertEqual(phone.store.purges, before)
        // The write path has already said why; the purge adds no second line for the same thing.
        XCTAssertEqual(purgeLines(phone), [])
        XCTAssertEqual(phone.status.health, [.storeUnusable])
    }

    func testNothingIsPurgedWhileNothingIsSelected() {
        let phone = Harness()
        XCTAssertEqual(phone.store.purges, [])
        phone.engine.appDidBecomeActive()
        XCTAssertEqual(phone.store.purges, [])
    }

    // MARK: getDeviceConditions

    func testOnBatteryAndInUseThePhoneIsNeitherChargingNorIdle() {
        let phone = Harness()
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: false, idle: false))
    }

    func testChargingIsExternalPower() {
        let phone = Harness()
        phone.device.onExternalPower = true
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: true, idle: false))
        phone.device.onExternalPower = false
        XCTAssertFalse(phone.engine.deviceConditions().charging)
    }

    func testIdleIsTheAppNotBeingActive() {
        let phone = Harness()
        // In the background, locked, or with the screen dark: iOS reports all three the same way.
        phone.device.appActive = false
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: false, idle: true))
        phone.device.appActive = true
        XCTAssertFalse(phone.engine.deviceConditions().idle)
    }

    func testOnAChargerOvernightItIsBothWhichIsWhatTheVacuumWaitsFor() {
        let phone = Harness()
        phone.device.onExternalPower = true
        phone.device.appActive = false
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: true, idle: true))
    }

    func testItIsReadAtTheMomentOfTheCallWithCaptureStoppedAndWithNoPermission() {
        let phone = Harness(authorization: .denied)
        phone.device.onExternalPower = true
        phone.device.appActive = false
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: true, idle: true))
        phone.device.onExternalPower = false
        XCTAssertEqual(phone.engine.deviceConditions(), MaintenanceConditions(charging: false, idle: true))
        XCTAssertEqual(phone.listener.statuses, [])
    }

    func testWhatCrossesTheBridgeIsExactlyTheTwoFieldsOfTheSpec() throws {
        let value = MaintenanceConditions(charging: true, idle: false).bridgeValue
        XCTAssertEqual(value.keys.sorted(), ["charging", "idle"])
        XCTAssertEqual(value["charging"] as? Bool, true)
        XCTAssertEqual(value["idle"] as? Bool, false)

        let schema = try Repo.json("packages/native-location-capture/contracts/schema.json")
        let modules = try XCTUnwrap(schema["modules"] as? [String: Any])
        let module = try XCTUnwrap(modules["NativeLocationCapture"] as? [String: Any])
        let aliases = try XCTUnwrap(module["aliasMap"] as? [String: Any])
        let type = try XCTUnwrap(aliases["DeviceConditions"] as? [String: Any])
        let properties = try XCTUnwrap(type["properties"] as? [[String: Any]])
        XCTAssertEqual(properties.compactMap { $0["name"] as? String }.sorted(), value.keys.sorted())
    }
}
