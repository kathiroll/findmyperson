import XCTest

@testable import CaptureCore

/// Plan 5.5 rule 1: coordinates never cross the bridge on the capture path. The spec has no
/// coordinate field in any event or return value (src/codegen.test.ts checks that); these tests
/// check that the implementation puts none in either, by any route: not in an event, not in a
/// status, not in a diagnostic line, and not in the files the module keeps outside the store.
final class PrivacyTests: XCTestCase {
    // Digits chosen to be unmistakable in a dump.
    private let home = Coordinate(lat: 12.971634, lon: 77.594562)
    private let office = Coordinate(lat: 13.035817, lon: 77.612943)
    private let injected = Coordinate(lat: -33.868819, lon: 151.209296)

    /// Every string in which a coordinate would show up if one leaked.
    private var needles: [String] {
        [home, office, injected].flatMap { point in
            [point.lat, point.lon].flatMap { value -> [String] in
                let text = String(abs(value))
                // The full value, and enough of it to catch a rounded or truncated copy.
                return [text, String(text.prefix(6))]
            }
        }
    }

    /// Runs capture through every path that handles a position, with real files for the state
    /// and the diagnostics log, and returns everything that left the engine.
    private func exercise() throws -> (phone: Harness, directory: URL) {
        let directory = try temporaryDirectory()
        let phone = Harness(launch: false)
        phone.realStateStorage = FileStateStorage(url: directory.appendingPathComponent("state.json"))
        phone.realDiagnostics = FileDiagnosticsLog(
            url: directory.appendingPathComponent("diagnostics.jsonl"))
        phone.launch()
        try phone.start()

        // Stored fixes from each source, a dropped fix, an invalid one.
        phone.location.deliver(Fix(home, at: Harness.t0, accuracyM: 12.5))
        phone.location.deliver(Fix(home, at: Harness.t0 + 30))
        phone.location.deliver(Fix(office, at: Harness.t0 + 400), from: .significantChange)
        phone.location.deliver(Fix(office, at: Harness.t0 + 410, accuracyM: -1))
        phone.location.exitRegionNow()
        phone.location.deliver(Fix(home, at: Harness.t0 + 500))
        // A visit, arrival then departure, and one that is skipped.
        phone.location.report(
            Visit(coordinate: office, accuracyM: 40, arrivalTsUtc: Harness.t0 + 600, departureTsUtc: nil))
        phone.location.report(
            Visit(
                coordinate: office, accuracyM: 40, arrivalTsUtc: Harness.t0 + 600,
                departureTsUtc: Harness.t0 + 4000))
        phone.location.report(
            Visit(coordinate: home, accuracyM: 40, arrivalTsUtc: nil, departureTsUtc: Harness.t0 + 5000))
        // The debug injector is the one call that takes a coordinate from JavaScript.
        try phone.engine.debugInjectSample(
            lat: injected.lat, lon: injected.lon, tsUtc: Double(Harness.t0 + 700), accuracyM: 8)
        // Failures on the write path, whose messages are logged.
        phone.store.writeFailure = StoreFailure(step: "insert_sample", message: "disk I/O error")
        phone.clock.advance(2000)
        phone.location.deliver(Fix(office, at: phone.clock.now))
        phone.location.report(
            Visit(coordinate: home, accuracyM: 40, arrivalTsUtc: phone.clock.now, departureTsUtc: nil))
        phone.store.writeFailure = nil
        // A relaunch, so that whatever is persisted is read back and used.
        phone.kill()
        phone.launch(forLocation: true)
        phone.clock.advance(2000)
        phone.location.deliver(Fix(home, at: phone.clock.now))
        try phone.engine.stop()
        return (phone, directory)
    }

    func testTheStoreIsTheOnlyPlaceACoordinateGoes() throws {
        let (phone, directory) = try exercise()
        defer { try? FileManager.default.removeItem(at: directory) }

        // The test means something only if positions really went through.
        XCTAssertEqual(
            phone.store.samples.map(\.source), ["continuous", "slc", "region", "manual", "continuous"])
        XCTAssertEqual(phone.store.samples.map(\.coordinate), [home, office, home, injected, home])
        XCTAssertEqual(phone.store.stays.map(\.coordinate), [office])
        XCTAssertEqual(phone.listener.samples.count, 5)
        XCTAssertFalse(phone.listener.statuses.isEmpty)

        var outputs: [String: String] = [:]
        outputs["onSampleWritten"] = phone.listener.samples.map { "\($0.bridgeValue)" }.joined()
        outputs["onStatusChanged"] = phone.listener.statuses.map { "\($0.bridgeValue)" }.joined()
        outputs["getStatus"] = "\(phone.engine.status().bridgeValue)"
        outputs["getDiagnostics"] = phone.engine.diagnostics(since: 0).map { "\($0.bridgeValue)" }.joined()
        outputs["state file"] = try String(
            contentsOf: directory.appendingPathComponent("state.json"), encoding: .utf8)
        outputs["diagnostics file"] = try String(
            contentsOf: directory.appendingPathComponent("diagnostics.jsonl"), encoding: .utf8)

        for (name, text) in outputs {
            XCTAssertFalse(text.isEmpty, "\(name) produced nothing")
            for needle in needles {
                XCTAssertFalse(text.contains(needle), "\(name) contains the coordinate digits \(needle)")
            }
        }
    }

    func testNoNumberInAnEventIsACoordinate() throws {
        let (phone, directory) = try exercise()
        defer { try? FileManager.default.removeItem(at: directory) }
        let coordinates = [home, office, injected].flatMap { [$0.lat, $0.lon] }

        func numbers(in value: Any) -> [Double] {
            if let dictionary = value as? [String: Any] {
                return dictionary.values.flatMap(numbers)
            }
            if let array = value as? [Any] {
                return array.flatMap(numbers)
            }
            if value is Bool || value is String || value is NSNull {
                return []
            }
            if let integer = value as? Int64 { return [Double(integer)] }
            if let integer = value as? Int { return [Double(integer)] }
            if let double = value as? Double { return [double] }
            XCTFail("unexpected value \(value) in an event")
            return []
        }

        let payloads: [[String: Any]] =
            phone.listener.samples.map(\.bridgeValue) + phone.listener.statuses.map(\.bridgeValue)
        XCTAssertFalse(payloads.isEmpty)
        for payload in payloads {
            for number in numbers(in: payload) {
                for coordinate in coordinates {
                    XCTAssertGreaterThan(
                        abs(number - coordinate), 1e-3, "\(payload) carries a coordinate")
                }
            }
        }
    }

    func testEventsHaveExactlyTheFieldsOfTheSpec() throws {
        let schema = try Repo.json("packages/native-location-capture/contracts/schema.json")
        let modules = try XCTUnwrap(schema["modules"] as? [String: Any])
        let module = try XCTUnwrap(modules["NativeLocationCapture"] as? [String: Any])
        let aliases = try XCTUnwrap(module["aliasMap"] as? [String: Any])

        func fields(_ alias: String) throws -> Set<String> {
            let type = try XCTUnwrap(aliases[alias] as? [String: Any])
            let properties = try XCTUnwrap(type["properties"] as? [[String: Any]])
            return Set(properties.compactMap { $0["name"] as? String })
        }

        let sample = SampleWrittenEvent(tsUtc: 1, accuracyM: 2, source: "continuous")
        XCTAssertEqual(Set(sample.bridgeValue.keys), try fields("SampleWrittenEvent"))
        XCTAssertEqual(Set(Harness().status.bridgeValue.keys), try fields("CaptureStatus"))
        let entry = DiagnosticEntry(tsUtc: 1, event: "launch", detail: "")
        XCTAssertEqual(Set(entry.bridgeValue.keys), try fields("DiagnosticEntry"))

        for alias in ["SampleWrittenEvent", "CaptureStatus", "DiagnosticEntry"] {
            for field in try fields(alias) {
                let lowered = field.lowercased()
                XCTAssertFalse(
                    lowered.contains("lat") || lowered.contains("lon") || lowered.contains("coord"),
                    "\(alias).\(field) looks like a position")
            }
        }
    }

    func testThePersistedStateHasNoFieldThatCouldHoldAPosition() throws {
        var state = PersistedState()
        state.selection = CaptureConfig(minIntervalSec: 900, minDistanceM: 100, accuracy: .balanced)
        state.lastClosedVisit = PersistedState.VisitTimes(arrivalTsUtc: 1, departureTsUtc: 2)
        state.selectedPeriods = [PersistedState.Period(from: 1, to: 2)]
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])

        // The complete list. A field added to PersistedState has to be added here, by someone
        // who has checked that it is not a position.
        XCTAssertEqual(
            Set(json.keys),
            [
                "selection", "selectedPeriods", "sampleTimestamps", "lastClosedVisit",
                "alwaysPromptShown",
            ])
        let optional = [
            "intervalSec", "lastSampleTsUtc", "lastWrittenTsUtc", "openVisitArrivalTsUtc",
            "lastAuthorization", "lastPreciseLocation", "lastBootTimeSec",
        ]
        state.intervalSec = 900
        state.lastSampleTsUtc = 1
        state.lastWrittenTsUtc = 1
        state.openVisitArrivalTsUtc = 1
        state.lastAuthorization = "always"
        state.lastPreciseLocation = true
        state.lastBootTimeSec = 1
        let full = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        XCTAssertEqual(Set(full.keys), Set(json.keys).union(optional))
    }
}
