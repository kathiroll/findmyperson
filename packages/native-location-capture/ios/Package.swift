// swift-tools-version:5.9
import Foundation
import PackageDescription

// This package exists so the capture state machine can be tested with `swift test`, on a Mac or
// on Linux, with no simulator and no phone. The app does not use it: FMPLocationCapture.podspec
// compiles the same files, together with Sources/Platform and Sources/Bridge, into the app.
//
// FMP_HOST_SQLCIPHER_DIR points the store at a real SQLCipher instead of the system SQLite and
// turns on the tests that need one. scripts/test-sqlcipher.sh builds it and sets the variable.
let sqlcipherDir = ProcessInfo.processInfo.environment["FMP_HOST_SQLCIPHER_DIR"]

let sqliteLinkerSettings: [LinkerSetting]
if let sqlcipherDir {
    sqliteLinkerSettings = [
        .unsafeFlags(["-L\(sqlcipherDir)"]),
        .linkedLibrary("fmpsqlcipher"),
        .linkedFramework("Security"),
    ]
} else {
    sqliteLinkerSettings = [.linkedLibrary("sqlite3")]
}

let package = Package(
    name: "FMPLocationCapture",
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [.library(name: "CaptureCore", targets: ["CaptureCore"])],
    targets: [
        // Vendored, unmodified H3 (scripts/vendor-h3.sh).
        .target(
            name: "CH3",
            path: "Sources/CH3",
            exclude: ["LICENSE", "NOTICE"],
            sources: ["h3lib/lib"],
            publicHeadersPath: "include",
            // -w: upstream's warnings are upstream's; this copy is never edited.
            cSettings: [.headerSearchPath("h3lib/include"), .unsafeFlags(["-w"])],
            linkerSettings: [.linkedLibrary("m", .when(platforms: [.linux]))]
        ),
        .target(name: "FMPSQLite", path: "Sources/FMPSQLite", linkerSettings: sqliteLinkerSettings),
        .target(name: "CaptureCore", dependencies: ["CH3", "FMPSQLite"], path: "Sources/CaptureCore"),
        .testTarget(
            name: "CaptureCoreTests",
            dependencies: ["CaptureCore", "FMPSQLite"],
            path: "Tests/CaptureCoreTests",
            swiftSettings: sqlcipherDir == nil ? [] : [.define("FMP_HOST_SQLCIPHER")]
        ),
    ]
)
