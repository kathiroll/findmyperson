import Foundation
import XCTest

@testable import CaptureCore

/// Files elsewhere in the repository that the Swift module has to agree with.
enum Repo {
    /// .../packages/native-location-capture/ios/Tests/CaptureCoreTests/Support/Repo.swift
    static let root: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 {
            url.deleteLastPathComponent()
        }
        return url
    }()

    static func text(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    static func json(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: root.appendingPathComponent(path))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}

/// A JSON number. Foundation hands numbers back as NSNumber on Apple platforms and not always so
/// on Linux, and `swift test` runs on both.
func double(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let double = value as? Double { return double }
    if let integer = value as? Int { return Double(integer) }
    return nil
}

func integer(_ value: Any?) -> Int? {
    double(value).flatMap { Int(exactly: $0) }
}

/// Runs `body` and checks it throws a CaptureError with this code.
func assertRejects(
    _ code: CaptureErrorCode, file: StaticString = #filePath, line: UInt = #line,
    _ body: () throws -> Void
) {
    do {
        try body()
        XCTFail("expected a rejection with \(code.rawValue)", file: file, line: line)
    } catch let error as CaptureError {
        XCTAssertEqual(error.code, code, error.message, file: file, line: line)
    } catch {
        XCTFail("unexpected error \(error)", file: file, line: line)
    }
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("fmp-capture-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}
