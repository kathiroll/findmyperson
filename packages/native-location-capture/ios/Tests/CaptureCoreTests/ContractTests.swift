import XCTest

@testable import CaptureCore

/// The Swift module against the files it must agree with: the generated spec
/// (contracts/schema.json), the store contract and cipher parameters (packages/shared/contracts)
/// and the values in src/constants.ts. A change on the TypeScript side that the Swift side has
/// not followed fails here.
final class ContractTests: XCTestCase {
    private func spec() throws -> [String: Any] {
        let schema = try Repo.json("packages/native-location-capture/contracts/schema.json")
        let modules = try XCTUnwrap(schema["modules"] as? [String: Any])
        return try XCTUnwrap(modules["NativeLocationCapture"] as? [String: Any])
    }

    /// The string literals of a union type annotation.
    private func literals(_ annotation: Any?) throws -> [String] {
        var annotation = try XCTUnwrap(annotation as? [String: Any])
        if annotation["type"] as? String == "ArrayTypeAnnotation" {
            annotation = try XCTUnwrap(annotation["elementType"] as? [String: Any])
        }
        let types = try XCTUnwrap(annotation["types"] as? [[String: Any]])
        return types.compactMap { $0["value"] as? String }
    }

    private func property(_ alias: String, _ name: String) throws -> Any? {
        let aliases = try XCTUnwrap(try spec()["aliasMap"] as? [String: Any])
        let type = try XCTUnwrap(aliases[alias] as? [String: Any])
        let properties = try XCTUnwrap(type["properties"] as? [[String: Any]])
        return try XCTUnwrap(properties.first { $0["name"] as? String == name })["typeAnnotation"]
    }

    private func methods() throws -> [[String: Any]] {
        let body = try XCTUnwrap(try spec()["spec"] as? [String: Any])
        return try XCTUnwrap(body["methods"] as? [[String: Any]])
    }

    private func parameter(of method: String) throws -> Any? {
        let found = try XCTUnwrap(try methods().first { $0["name"] as? String == method })
        let annotation = try XCTUnwrap(found["typeAnnotation"] as? [String: Any])
        let params = try XCTUnwrap(annotation["params"] as? [[String: Any]])
        return try XCTUnwrap(params.first)["typeAnnotation"]
    }

    // MARK: the spec's strings

    func testStatusStringsAreTheSpecs() throws {
        XCTAssertEqual(
            try literals(property("CaptureStatus", "permission")),
            [
                PermissionState.undetermined, .denied, .foregroundOnly, .always, .restricted,
            ].map(\.rawValue))
        XCTAssertEqual(
            try literals(property("CaptureConfig", "accuracy")),
            [Accuracy.balanced, .high].map(\.rawValue))

        let modes = try literals(property("CaptureStatus", "mode"))
        XCTAssertTrue(modes.contains(CaptureMode.ios.rawValue))
        XCTAssertTrue(modes.contains(CaptureMode.stopped.rawValue))

        let tiers = try literals(property("CaptureStatus", "tier"))
        for tier in [CaptureTier.backgroundUpdates, .throttled, .stopped] {
            XCTAssertTrue(tiers.contains(tier.rawValue), tier.rawValue)
        }
    }

    func testMethodArgumentStringsAreTheSpecs() throws {
        XCTAssertEqual(
            try literals(parameter(of: "requestPermission")),
            [PermissionStep.foreground, .background].map(\.rawValue))
        XCTAssertEqual(
            try literals(parameter(of: "openSystemSettings")),
            [SettingsTarget.app, .battery, .hibernation].map(\.rawValue))
    }

    func testHealthFlagsAreTheIosFlagsInSpecOrder() throws {
        let all = try literals(property("CaptureStatus", "health"))
        let constants = try Repo.text("packages/native-location-capture/src/constants.ts")
        // Lines of HEALTH_FLAG_PLATFORMS: `  low_power_mode: ['ios'],`
        let raisedOnIos = all.filter { flag in
            constants.split(separator: "\n").contains { line in
                line.trimmingCharacters(in: .whitespaces).hasPrefix("\(flag):") && line.contains("'ios'")
            }
        }
        XCTAssertEqual(raisedOnIos.count, 7)
        XCTAssertEqual(HealthFlag.allCases.map(\.rawValue), raisedOnIos)
    }

    func testErrorCodesAndSharedDiagnosticEventsAreThoseOfTheConstantsFile() throws {
        let constants = try Repo.text("packages/native-location-capture/src/constants.ts")
        for code in [
            CaptureErrorCode.invalidArgument, .permissionDenied, .storeUnusable, .startFailed,
            .notAvailable,
        ] {
            XCTAssertTrue(constants.contains("  '\(code.rawValue)',"), code.rawValue)
        }
        let shared = [
            "modeChanged": DiagnosticEvent.modeChanged,
            "captureStarted": DiagnosticEvent.captureStarted,
            "captureStopped": DiagnosticEvent.captureStopped,
            "startFailed": DiagnosticEvent.startFailed,
            "storeUnusable": DiagnosticEvent.storeUnusable,
        ]
        for (name, value) in shared {
            XCTAssertTrue(constants.contains("  \(name): '\(value)',"), name)
        }
    }

    /// The ObjC++ shim is not compiled by `swift test`. This at least notices a spec method
    /// that it does not implement, or an event it does not emit.
    func testTheTurboModuleShimNamesEveryMethodAndEventOfTheSpec() throws {
        let shim = try Repo.text(
            "packages/native-location-capture/ios/Sources/Bridge/RCTNativeLocationCapture.mm")
        let names = try methods().compactMap { $0["name"] as? String }
        XCTAssertEqual(names.count, 11)
        for name in names {
            XCTAssertTrue(shim.contains("- (void)\(name):"), "\(name) is missing from the shim")
        }
        let body = try XCTUnwrap(try spec()["spec"] as? [String: Any])
        let emitters = try XCTUnwrap(body["eventEmitters"] as? [[String: Any]])
        for emitter in emitters.compactMap({ $0["name"] as? String }) {
            let selector = "emit" + emitter.prefix(1).uppercased() + emitter.dropFirst() + ":"
            XCTAssertTrue(shim.contains(selector), "\(selector) is never called")
        }
        XCTAssertTrue(shim.contains("RCT_EXPORT_MODULE(NativeLocationCapture)"))
    }

    // MARK: the store contract

    func testGeneratedStoreContractMatchesTheSharedFile() throws {
        let writer = try Repo.json("packages/shared/contracts/native-writer.json")
        XCTAssertEqual(integer(writer["schemaVersion"]), StoreContract.schemaVersion)
        XCTAssertEqual(writer["readSchemaVersionSql"] as? String, StoreContract.readSchemaVersionSql)
        XCTAssertEqual(writer["storeFileName"] as? String, StoreContract.storeFileName)
        XCTAssertEqual(writer["insertLocationSampleSql"] as? String, StoreContract.insertLocationSampleSql)
        XCTAssertEqual(writer["insertVisitStaySql"] as? String, StoreContract.insertVisitStaySql)
        XCTAssertEqual(writer["closeVisitStaySql"] as? String, StoreContract.closeVisitStaySql)
        XCTAssertEqual(writer["sampleSources"] as? [String], StoreContract.sampleSources)
        XCTAssertEqual(integer(writer["retentionSec"]).map(Int64.init), StoreContract.retentionSec)
        XCTAssertEqual(writer["deleteSamplesBeforeSql"] as? String, StoreContract.deleteSamplesBeforeSql)
        XCTAssertEqual(
            writer["deleteStaysEndedBeforeSql"] as? String, StoreContract.deleteStaysEndedBeforeSql)
        XCTAssertEqual(
            writer["trimStaysStartedBeforeSql"] as? String, StoreContract.trimStaysStartedBeforeSql)
        XCTAssertEqual(writer["rewindStayCursorSql"] as? String, StoreContract.rewindStayCursorSql)
        XCTAssertEqual(writer.count, 12, "a statement was added to the contract: regenerate, then decide")
    }

    func testEverySampleSourceThisModuleWritesIsInTheContract() {
        for source in [SampleSource.continuous, .slc, .region, .manual] {
            XCTAssertTrue(StoreContract.sampleSources.contains(source.rawValue), source.rawValue)
        }
    }

    func testGeneratedCipherParametersMatchTheSharedFile() throws {
        let cipher = try Repo.json("packages/shared/contracts/cipher-params.json")
        let compatibility = try XCTUnwrap(integer(cipher["cipherCompatibility"]))
        let pageSize = try XCTUnwrap(integer(cipher["pageSizeBytes"]))
        let iterations = try XCTUnwrap(integer(cipher["kdfIterations"]))
        let kdf = try XCTUnwrap(cipher["kdfAlgorithm"] as? String)
        let hmac = try XCTUnwrap(cipher["hmacAlgorithm"] as? String)

        XCTAssertEqual(integer(cipher["sqlcipherMajor"]), CipherParams.sqlcipherMajor)
        XCTAssertEqual(integer(cipher["keyBytes"]), CipherParams.keyBytes)
        XCTAssertEqual(cipher["journalMode"] as? String, CipherParams.journalMode)
        XCTAssertEqual(cipher["keyFormat"] as? String, "raw-hex-literal")
        XCTAssertEqual(
            CipherParams.applyPragmas,
            [
                "PRAGMA cipher_compatibility = \(compatibility)",
                "PRAGMA cipher_page_size = \(pageSize)",
                "PRAGMA kdf_iter = \(iterations)",
                "PRAGMA cipher_kdf_algorithm = \(kdf)",
                "PRAGMA cipher_hmac_algorithm = \(hmac)",
            ])
        XCTAssertEqual(
            CipherParams.readBack.map { "\($0.pragma)=\($0.expected)" },
            [
                "cipher_page_size=\(pageSize)", "kdf_iter=\(iterations)",
                "cipher_kdf_algorithm=\(kdf)", "cipher_hmac_algorithm=\(hmac)",
            ])
    }

    func testKeyLiteralGoldenVector() throws {
        let cipher = try Repo.json("packages/shared/contracts/cipher-params.json")
        let vector = try XCTUnwrap(cipher["keyVector"] as? [String: String])
        let hex = try XCTUnwrap(vector["hex"])

        XCTAssertEqual(try StoreKeys.keyLiteral(hex), vector["literal"])
        XCTAssertEqual(try StoreKeys.keyLiteral(hex.uppercased()), vector["literal"])
        for malformed in [
            "", String(repeating: "zz", count: 32), String(repeating: "ab", count: 31),
            String(repeating: "ab", count: 33),
        ] {
            XCTAssertThrowsError(try StoreKeys.keyLiteral(malformed)) { error in
                XCTAssertEqual((error as? StoreFailure)?.step, "key")
            }
        }
    }
}
