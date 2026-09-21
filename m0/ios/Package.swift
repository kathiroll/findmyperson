// swift-tools-version:5.9
import PackageDescription

// This package exists ONLY so the log format and log writer (pure Foundation, no
// CoreLocation, no UIKit) can be unit-tested on the Mac with `swift test`.
// The iPhone app does not depend on this package: FindMyPersonM0.xcodeproj compiles
// the very same files from Sources/CaptureLog straight into the app target.
let package = Package(
    name: "CaptureLog",
    platforms: [.macOS(.v11), .iOS(.v15)],
    products: [.library(name: "CaptureLog", targets: ["CaptureLog"])],
    targets: [
        .target(name: "CaptureLog", path: "Sources/CaptureLog"),
        .testTarget(name: "CaptureLogTests", dependencies: ["CaptureLog"], path: "Tests/CaptureLogTests"),
    ]
)
