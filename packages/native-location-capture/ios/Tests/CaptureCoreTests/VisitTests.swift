import XCTest

@testable import CaptureCore

/// CLVisit arrivals and departures become `stay` rows with source 'visit' (plan 5.4). The row
/// contract is in packages/shared/src/store/tables/stay.ts; VisitStoreTests runs the same
/// sequence against the real schema.
final class VisitTests: XCTestCase {
    private let arrival = Harness.t0 + 1000
    private let departure = Harness.t0 + 5000

    private func capturing() throws -> Harness {
        let phone = Harness()
        try phone.start()
        return phone
    }

    private func visit(arrival: Int64?, departure: Int64?, at place: Coordinate = Place.office) -> Visit {
        Visit(coordinate: place, accuracyM: 45, arrivalTsUtc: arrival, departureTsUtc: departure)
    }

    func testAnArrivalIsWrittenAsAnOpenStay() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil))

        XCTAssertEqual(
            phone.store.stays,
            [
                VisitStayRow(
                    startTs: arrival, endTs: arrival, coordinate: Place.office, radiusM: 45,
                    h3r7: try XCTUnwrap(Geo.matchCell(Place.office)), closed: false)
            ])
        XCTAssertEqual(phone.diagnostics.lines.last, "visit_arrival")
        XCTAssertEqual(phone.stateStorage.saved?.openVisitArrivalTsUtc, arrival)
    }

    func testTheDepartureClosesTheStayTheArrivalOpened() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil))
        phone.location.report(visit(arrival: arrival, departure: departure))

        XCTAssertEqual(phone.store.stays.count, 1)
        XCTAssertEqual(phone.store.stays[0].startTs, arrival)
        XCTAssertEqual(phone.store.stays[0].endTs, departure)
        XCTAssertTrue(phone.store.stays[0].closed)
        XCTAssertEqual(phone.diagnostics.lines.last, "visit_departure")
        XCTAssertNil(phone.stateStorage.saved?.openVisitArrivalTsUtc)
    }

    func testAVisitSeenOnlyAtDepartureIsWrittenWholeAndClosed() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: departure))

        XCTAssertEqual(
            phone.store.stays,
            [
                VisitStayRow(
                    startTs: arrival, endTs: departure, coordinate: Place.office, radiusM: 45,
                    h3r7: try XCTUnwrap(Geo.matchCell(Place.office)), closed: true)
            ])
    }

    func testVisitsAreNotAlsoStoredAsSamples() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil))
        phone.location.report(visit(arrival: arrival, departure: departure))

        XCTAssertEqual(phone.store.samples, [])
        XCTAssertEqual(phone.listener.samples, [])
        XCTAssertEqual(phone.status.samplesLast24h, 0)
    }

    func testADepartureWithAnUnknownArrivalClosesTheOpenVisit() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil))
        phone.location.report(visit(arrival: nil, departure: departure))

        XCTAssertEqual(phone.store.stays.map(\.endTs), [departure])
        XCTAssertEqual(phone.store.stays.map(\.closed), [true])
    }

    func testAVisitWhoseArrivalIsUnknownIsNotWritten() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: nil, departure: departure))
        phone.location.report(visit(arrival: nil, departure: nil))

        XCTAssertEqual(phone.store.stays, [])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(2)),
            ["visit_skipped:arrival_unknown", "visit_skipped:no_times"])
    }

    func testAVisitReportedAgainAfterARelaunchIsWrittenOnce() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil))
        phone.kill()
        phone.launch(forLocation: true)
        phone.location.report(visit(arrival: arrival, departure: nil))
        XCTAssertEqual(phone.store.stays.count, 1)

        phone.location.report(visit(arrival: arrival, departure: departure))
        phone.kill()
        phone.launch(forLocation: true)
        phone.location.report(visit(arrival: arrival, departure: departure))
        phone.location.report(visit(arrival: arrival, departure: nil))

        XCTAssertEqual(phone.store.stays.count, 1)
        XCTAssertEqual(phone.store.stays[0].endTs, departure)
    }

    func testANewArrivalLeavesAVisitThatNeverGotADepartureOpen() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: arrival, departure: nil, at: Place.home))
        phone.location.report(visit(arrival: arrival + 9000, departure: nil))

        // The first visit's departure time is not known, so the row is not marked closed.
        XCTAssertEqual(phone.store.stays.map(\.closed), [false, false])
        XCTAssertEqual(phone.stateStorage.saved?.openVisitArrivalTsUtc, arrival + 9000)

        // A later departure with an unknown arrival belongs to the newer visit.
        phone.location.report(visit(arrival: nil, departure: arrival + 12_000))
        XCTAssertEqual(phone.store.stays.map(\.closed), [false, true])
    }

    func testImpossibleVisitsAreSkipped() throws {
        let phone = try capturing()
        phone.location.report(visit(arrival: departure, departure: arrival))
        phone.location.report(
            Visit(coordinate: Place.office, accuracyM: -1, arrivalTsUtc: arrival, departureTsUtc: nil))
        phone.location.report(
            Visit(
                coordinate: Coordinate(lat: 95, lon: 0), accuracyM: 30, arrivalTsUtc: arrival,
                departureTsUtc: nil))

        XCTAssertEqual(phone.store.stays, [])
        XCTAssertEqual(
            Array(phone.diagnostics.lines.suffix(3)),
            [
                "visit_skipped:departure_before_arrival", "visit_skipped:invalid_visit",
                "visit_skipped:invalid_visit",
            ])
    }

    func testAVisitThatCannotBeStoredIsLoggedAndCanBeWrittenWhenReportedAgain() throws {
        let phone = try capturing()
        phone.store.failure = StoreFailure(step: "open", message: "unable to open database file")
        phone.location.report(visit(arrival: arrival, departure: nil))

        XCTAssertEqual(phone.store.stays, [])
        XCTAssertEqual(phone.diagnostics.lines.last, "visit_skipped:store_unusable")
        XCTAssertEqual(phone.status.health, [.storeUnusable])
        XCTAssertNil(phone.stateStorage.saved?.openVisitArrivalTsUtc)

        phone.store.failure = nil
        phone.clock.advance(60)
        phone.location.report(visit(arrival: arrival, departure: departure))
        XCTAssertEqual(phone.store.stays.map(\.closed), [true])
    }

    func testVisitsStopWithCapture() throws {
        let phone = try capturing()
        try phone.engine.stop()
        XCTAssertFalse(phone.location.report(visit(arrival: arrival, departure: nil)))
        XCTAssertEqual(phone.store.stays, [])
    }
}
