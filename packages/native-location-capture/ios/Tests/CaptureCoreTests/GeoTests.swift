import XCTest

@testable import CaptureCore

/// packages/shared/contracts/geo-vectors.json: the golden vectors TypeScript, Kotlin and Swift
/// must all reproduce. Cells must match exactly, as strings.
final class GeoTests: XCTestCase {
    private func coordinate(_ value: Any?) throws -> Coordinate {
        let point = try XCTUnwrap(value as? [String: Any])
        return Coordinate(
            lat: try XCTUnwrap(double(point["lat"])), lon: try XCTUnwrap(double(point["lon"])))
    }

    func testCellVectors() throws {
        let vectors = try Repo.json("packages/shared/contracts/geo-vectors.json")
        let points = try XCTUnwrap(vectors["points"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(points.count, 17)

        var parentDiffersFromContainingCell = 0
        for point in points {
            let name = try XCTUnwrap(point["name"] as? String)
            let cells = try XCTUnwrap(Geo.sampleCells(try coordinate(point)), name)
            XCTAssertEqual(cells.h3r7, point["h3_r7"] as? String, name)
            XCTAssertEqual(cells.h3r5, point["h3_r5"] as? String, name)
            XCTAssertEqual(Geo.matchCell(try coordinate(point)), point["h3_r7"] as? String, name)
            XCTAssertEqual(cells.h3r7.count, 15, name)
            if point["h3_r5"] as? String != point["h3_r5_containing"] as? String {
                parentDiffersFromContainingCell += 1
            }
        }
        // The vectors include points where writing the containing res-5 cell would be wrong.
        XCTAssertGreaterThan(parentDiffersFromContainingCell, 0)
    }

    func testDistanceVectors() throws {
        let vectors = try Repo.json("packages/shared/contracts/geo-vectors.json")
        XCTAssertEqual(double(vectors["earth_radius_m"]), GeoContract.earthRadiusM)
        let tolerance = try XCTUnwrap(double(vectors["distance_tolerance_m"]))
        let distances = try XCTUnwrap(vectors["distances"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(distances.count, 14)

        for distance in distances {
            let name = try XCTUnwrap(distance["name"] as? String)
            let meters = try XCTUnwrap(double(distance["meters"]), name)
            let computed = Geo.haversineMeters(
                try coordinate(distance["from"]), try coordinate(distance["to"]))
            XCTAssertEqual(computed, meters, accuracy: tolerance, name)
        }
    }

    func testCoordinatesOutOfRangeHaveNoCell() {
        for point in [
            Coordinate(lat: 90.0001, lon: 0), Coordinate(lat: -91, lon: 0), Coordinate(lat: 0, lon: 180.5),
            Coordinate(lat: 0, lon: -181), Coordinate(lat: .nan, lon: 0), Coordinate(lat: 0, lon: .infinity),
        ] {
            XCTAssertFalse(Geo.isValid(point))
            XCTAssertNil(Geo.matchCell(point))
            XCTAssertNil(Geo.sampleCells(point))
        }
        XCTAssertNotNil(Geo.sampleCells(Coordinate(lat: 90, lon: 180)))
        XCTAssertNotNil(Geo.sampleCells(Coordinate(lat: -90, lon: -180)))
    }
}

final class FixFilterTests: XCTestCase {
    private let config = CaptureConfig(minIntervalSec: 900, minDistanceM: 100, accuracy: .balanced)

    private func stores(
        at fixTs: Int64, last: Int64?, distance: Double?, leftRegion: Bool = false
    ) -> Bool {
        FixFilter.shouldStore(
            fixTsUtc: fixTs, lastWrittenTsUtc: last, distanceFromLastM: distance,
            leftLastRegion: leftRegion, config: config)
    }

    func testTheFirstFixIsStored() {
        XCTAssertTrue(stores(at: 1000, last: nil, distance: nil))
    }

    func testStoredWhenTheIntervalHasPassedOrThePhoneHasMovedFarEnough() {
        XCTAssertFalse(stores(at: 1899, last: 1000, distance: 99.9))
        XCTAssertTrue(stores(at: 1900, last: 1000, distance: 0), "interval reached, phone still")
        XCTAssertTrue(stores(at: 1001, last: 1000, distance: 100), "distance reached, a second later")
        XCTAssertTrue(stores(at: 1900, last: 1000, distance: 5000))
    }

    func testAnUnknownDistanceNeverPassesTheDistanceRule() {
        XCTAssertFalse(stores(at: 1899, last: 1000, distance: nil))
        XCTAssertTrue(stores(at: 1900, last: 1000, distance: nil))
    }

    func testLeavingTheRegionOfTheLastSampleCountsAsMovement() {
        XCTAssertTrue(stores(at: 1001, last: 1000, distance: nil, leftRegion: true))
        XCTAssertTrue(stores(at: 1001, last: 1000, distance: 10, leftRegion: true))
    }

    func testAFixTimedBeforeTheLastSampleUsesTheSizeOfTheGap() {
        XCTAssertFalse(stores(at: 900, last: 1000, distance: 0))
        XCTAssertTrue(stores(at: 100, last: 1000, distance: 0))
    }

    func testAZeroMinimumDistanceStoresEveryFixOnceTheLastPositionIsKnown() {
        let every = CaptureConfig(minIntervalSec: 900, minDistanceM: 0, accuracy: .balanced)
        XCTAssertTrue(
            FixFilter.shouldStore(
                fixTsUtc: 1001, lastWrittenTsUtc: 1000, distanceFromLastM: 0, leftLastRegion: false,
                config: every))
    }
}
