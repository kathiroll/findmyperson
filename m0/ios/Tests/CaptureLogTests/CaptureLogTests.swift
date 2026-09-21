import XCTest
@testable import CaptureLog

final class LogFormatTests: XCTestCase {
    func testHeaderLinesMatchSpec() {
        XCTAssertEqual(LogFormat.magicLine, "#fmp-capture-log,1")
        XCTAssertEqual(LogFormat.header,
                       "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event")
        XCTAssertEqual(LogFormat.header.split(separator: ",").count, 11)
    }

    func testDeviceLine() {
        let line = LogFormat.deviceLine(label: "my,phone\n", model: "iPhone14,5", os: "18.1",
                                        appBuild: "1", utcOffsetMin: 330)
        XCTAssertEqual(line, "#device,label=my_phone_,platform=ios,model=iPhone14_5,os=18.1,app_build=1,utc_offset_min=330")
    }

    func testSampleRowWithFix() {
        let row = LogRow.sample(SampleRow(ranAtMs: 1_700_000_000_500, fixAtMs: 1_700_000_000_000,
                                          accuracyM: 65, source: .continuous, batteryPct: 83,
                                          charging: false, powerSave: true, permission: "always"))
        XCTAssertEqual(row.csv, "S,1700000000500,1700000000000,65.0,continuous,83,0,1,always,ios_all,")
    }

    func testSampleRowNoFix() {
        let row = LogRow.sample(SampleRow(ranAtMs: 5, fixAtMs: nil, accuracyM: nil, source: .none,
                                          batteryPct: 7, charging: true, powerSave: false,
                                          permission: "when_in_use_approx"))
        XCTAssertEqual(row.csv, "S,5,,,none,7,1,0,when_in_use_approx,ios_all,")
    }

    func testAccuracyOneDecimalAndBatteryClamped() {
        let row = LogRow.sample(SampleRow(ranAtMs: 1, fixAtMs: 1, accuracyM: 12.345, source: .slc,
                                          batteryPct: 140, charging: false, powerSave: false, permission: "always"))
        XCTAssertTrue(row.csv.hasPrefix("S,1,1,12.3,slc,100,"))
    }

    func testUnknownBatteryIsEmpty() {
        let row = LogRow.sample(SampleRow(ranAtMs: 1, fixAtMs: nil, accuracyM: nil, source: .visitArrival,
                                          batteryPct: nil, charging: false, powerSave: false, permission: "always"))
        XCTAssertEqual(row.csv, "S,1,,,visit_arrival,,0,0,always,ios_all,")
    }

    func testEventRowHasElevenColumnsAndEmptySampleFields() {
        let row = LogRow.event(ranAtMs: 42, name: "app_opened")
        XCTAssertEqual(row.csv, "E,42,,,,,,,,,app_opened")
        XCTAssertEqual(row.csv.split(separator: ",", omittingEmptySubsequences: false).count, 11)
    }

    func testEventNameWithExtraDataAndSanitizing() {
        XCTAssertEqual(LogRow.event(ranAtMs: 1, name: "mode_changed:a,b\nc").csv, "E,1,,,,,,,,,mode_changed:a_b_c")
    }

    func testAllSourceNames() {
        XCTAssertEqual([Source.continuous, .slc, .visitArrival, .visitDeparture, .none].map(\.rawValue),
                       ["continuous", "slc", "visit_arrival", "visit_departure", "none"])
    }

    func testPermissionStrings() {
        XCTAssertEqual(LogFormat.permission(.denied, approx: false), "denied")
        XCTAssertEqual(LogFormat.permission(.denied, approx: true), "denied")
        XCTAssertEqual(LogFormat.permission(.whenInUse, approx: false), "when_in_use")
        XCTAssertEqual(LogFormat.permission(.always, approx: true), "always_approx")
    }

    func testEpochMs() {
        XCTAssertEqual(LogFormat.epochMs(Date(timeIntervalSince1970: 1.2345)), 1235)
    }

    func testExportText() {
        let text = LogFormat.exportText(deviceLine: "#device,x", rows: "E,1,,,,,,,,,app_opened\n")
        XCTAssertEqual(text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init), [
            "#fmp-capture-log,1", "#device,x", LogFormat.header, "E,1,,,,,,,,,app_opened", "",
        ])
    }
}

final class SlotGateTests: XCTestCase {
    private let slot: Int64 = 900_000

    func testFirstFixEverWrites() {
        XCTAssertTrue(SlotGate.shouldWrite(nowMs: 123, lastWrittenSlot: nil))
    }

    func testSecondFixInSameSlotIsSkipped() {
        let t = 10 * slot + 5
        let last = SlotGate.slot(forMs: t)
        XCTAssertFalse(SlotGate.shouldWrite(nowMs: t + slot - 10, lastWrittenSlot: last))
    }

    func testFirstFixAfterSlotOpensWrites() {
        let last = SlotGate.slot(forMs: 10 * slot + 5)
        XCTAssertTrue(SlotGate.shouldWrite(nowMs: 11 * slot, lastWrittenSlot: last))
    }

    func testSlotIsWallClockQuarterHour() {
        // 2024-01-01T12:00:00Z is 1_704_110_400_000 ms: a quarter-hour boundary.
        let noon: Int64 = 1_704_110_400_000
        XCTAssertEqual(noon % slot, 0)
        let a = SlotGate.slot(forMs: noon)
        XCTAssertEqual(SlotGate.slot(forMs: noon + 14 * 60_000 + 59_000), a)   // 12:14:59
        XCTAssertEqual(SlotGate.slot(forMs: noon + 15 * 60_000), a + 1)        // 12:15:00
        XCTAssertEqual(SlotGate.slot(forMs: noon - 1), a - 1)                  // 11:59:59.999
    }
}

final class LogFileWriterTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testAppendCreatesFileAndAppendsLines() {
        let w = LogFileWriter(url: dir.appendingPathComponent("rows.csv"))
        XCTAssertTrue(w.append(.event(ranAtMs: 1, name: "app_opened")))
        XCTAssertTrue(w.append(.event(ranAtMs: 2, name: "capture_started")))
        XCTAssertEqual(w.allLines(), ["E,1,,,,,,,,,app_opened", "E,2,,,,,,,,,capture_started"])
        XCTAssertEqual(w.rowCount(), 2)
        XCTAssertEqual(w.rowsText(), "E,1,,,,,,,,,app_opened\nE,2,,,,,,,,,capture_started\n")
    }

    func testSurvivesNewWriterInstance() {
        let url = dir.appendingPathComponent("rows.csv")
        LogFileWriter(url: url).append(.event(ranAtMs: 1, name: "a"))
        LogFileWriter(url: url).append(.event(ranAtMs: 2, name: "b"))
        XCTAssertEqual(LogFileWriter(url: url).rowCount(), 2)
    }

    func testTail() {
        let w = LogFileWriter(url: dir.appendingPathComponent("rows.csv"))
        for i in 1...30 { w.append(.event(ranAtMs: Int64(i), name: "e")) }
        let t = w.tail(20)
        XCTAssertEqual(t.count, 20)
        XCTAssertEqual(t.first, "E,11,,,,,,,,,e")
        XCTAssertEqual(t.last, "E,30,,,,,,,,,e")
    }

    func testFailedWriteIsQueuedAndFlushedLater() throws {
        // Directory missing = stand-in for "file not writable yet" (locked before first unlock).
        let sub = dir.appendingPathComponent("later")
        let w = LogFileWriter(url: sub.appendingPathComponent("rows.csv"))
        XCTAssertFalse(w.append(.event(ranAtMs: 1, name: "first")))
        XCTAssertEqual(w.pendingCount, 1)
        XCTAssertEqual(w.failedWrites, 1)
        try FileManager.default.createDirectory(at: sub, withIntermediateDirectories: true)
        XCTAssertTrue(w.append(.event(ranAtMs: 2, name: "second")))
        XCTAssertEqual(w.pendingCount, 0)
        XCTAssertEqual(w.allLines(), ["E,1,,,,,,,,,first", "E,2,,,,,,,,,second"])
    }

    func testEmptyFileReadsAsNoRows() {
        let w = LogFileWriter(url: dir.appendingPathComponent("missing.csv"))
        XCTAssertEqual(w.rowCount(), 0)
        XCTAssertEqual(w.rowsText(), "")
    }
}
