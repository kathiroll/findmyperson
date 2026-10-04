import XCTest

@testable import CaptureCore

/// The answer the bundle fetcher waits for: whether the active connection is metered.
///
/// The fetcher is TypeScript (packages/shared, fetch/) and puts a cycle off on a metered
/// connection. What iOS says is read in Sources/Platform (NWPathMonitor); here the phone is
/// the fake, and the tests are about what the engine answers from it.
final class NetworkTests: XCTestCase {
    func testOnMobileDataTheConnectionIsMetered() {
        let phone = Harness()
        XCTAssertEqual(phone.engine.networkConditions(), NetworkConditions(metered: true))
    }

    func testOnWiFiItIsNot() {
        let phone = Harness()
        phone.device.networkPath = NetworkPath(expensive: false, constrained: false)
        XCTAssertEqual(phone.engine.networkConditions(), NetworkConditions(metered: false))
    }

    func testAPersonalHotspotIsMeteredAlthoughItIsWiFi() {
        let phone = Harness()
        // iOS marks the path expensive whatever the interface is.
        phone.device.networkPath = NetworkPath(expensive: true, constrained: false)
        XCTAssertTrue(phone.engine.networkConditions().metered)
    }

    func testLowDataModeIsMeteredAlthoughTheNetworkIsNotExpensive() {
        let phone = Harness()
        phone.device.networkPath = NetworkPath(expensive: false, constrained: true)
        XCTAssertTrue(phone.engine.networkConditions().metered)
        phone.device.networkPath = NetworkPath(expensive: true, constrained: true)
        XCTAssertTrue(phone.engine.networkConditions().metered)
    }

    func testWithNoConnectionOrNoAnswerYetItIsTheOneThatMakesTheFetcherWait() {
        let phone = Harness()
        phone.device.networkPath = nil
        XCTAssertEqual(phone.engine.networkConditions(), NetworkConditions(metered: true))
    }

    func testItIsReadAtTheMomentOfTheCallWithCaptureStoppedAndWithNoPermission() {
        let phone = Harness(authorization: .denied)
        phone.diagnostics.clear()
        phone.device.networkPath = NetworkPath(expensive: false, constrained: false)
        XCTAssertFalse(phone.engine.networkConditions().metered)
        phone.device.networkPath = NetworkPath(expensive: true, constrained: false)
        XCTAssertTrue(phone.engine.networkConditions().metered)
        XCTAssertEqual(phone.listener.statuses, [])
        XCTAssertEqual(phone.diagnostics.lines, [])
    }

    func testWhatCrossesTheBridgeIsExactlyTheOneFieldOfTheSpec() throws {
        let value = NetworkConditions(metered: false).bridgeValue
        XCTAssertEqual(value.keys.sorted(), ["metered"])
        XCTAssertEqual(value["metered"] as? Bool, false)

        let schema = try Repo.json("packages/native-location-capture/contracts/schema.json")
        let modules = try XCTUnwrap(schema["modules"] as? [String: Any])
        let module = try XCTUnwrap(modules["NativeLocationCapture"] as? [String: Any])
        let aliases = try XCTUnwrap(module["aliasMap"] as? [String: Any])
        let type = try XCTUnwrap(aliases["NetworkConditions"] as? [String: Any])
        let properties = try XCTUnwrap(type["properties"] as? [[String: Any]])
        XCTAssertEqual(properties.compactMap { $0["name"] as? String }.sorted(), value.keys.sorted())
    }
}
