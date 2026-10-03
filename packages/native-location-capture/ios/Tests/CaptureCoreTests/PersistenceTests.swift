import XCTest

@testable import CaptureCore

/// The two files the module keeps beside the store: its state and the diagnostics log.
final class PersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = try temporaryDirectory()
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: state

    func testStateRoundTrips() throws {
        let storage = FileStateStorage(url: directory.appendingPathComponent("nested/state.json"))
        XCTAssertNil(try storage.load(), "nothing saved yet")

        var state = PersistedState()
        state.selection = CaptureConfig(minIntervalSec: 900, minDistanceM: 100, accuracy: .high)
        state.intervalSec = 900
        state.selectedPeriods = [PersistedState.Period(from: 10, to: nil)]
        state.sampleTimestamps = [10, 20]
        state.lastSampleTsUtc = 20
        state.lastWrittenTsUtc = 20
        state.openVisitArrivalTsUtc = 15
        state.lastClosedVisit = PersistedState.VisitTimes(arrivalTsUtc: 1, departureTsUtc: 5)
        state.alwaysPromptShown = true
        state.lastAuthorization = "always"
        state.lastPreciseLocation = true
        state.lastBootTimeSec = 1_700_000_000
        try storage.save(state)

        XCTAssertEqual(try storage.load(), state)
    }

    func testAFileFromAnOlderBuildStillDecodes() throws {
        let url = directory.appendingPathComponent("state.json")
        // Only the selection: every field added since is missing.
        let old = #"{"selection":{"minIntervalSec":900,"minDistanceM":100,"accuracy":"balanced"}}"#
        try Data(old.utf8).write(to: url)

        let state = try XCTUnwrap(try FileStateStorage(url: url).load())
        XCTAssertEqual(state.selection?.minIntervalSec, 900)
        XCTAssertEqual(state.sampleTimestamps, [])
        XCTAssertFalse(state.alwaysPromptShown)
    }

    func testAFileThatIsNotStateIsCorruptNotEmpty() throws {
        let url = directory.appendingPathComponent("state.json")
        try Data("not json".utf8).write(to: url)

        XCTAssertThrowsError(try FileStateStorage(url: url).load()) { error in
            guard case StateStorageError.corrupt = error else {
                return XCTFail("expected corrupt, got \(error)")
            }
        }
    }

    func testAFileThatCannotBeReadIsUnreadableNotEmpty() throws {
        // A directory where the file should be: it exists and reading it fails, as a protected
        // file does before the first unlock.
        let url = directory.appendingPathComponent("state.json")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)

        XCTAssertThrowsError(try FileStateStorage(url: url).load()) { error in
            guard case StateStorageError.unreadable = error else {
                return XCTFail("expected unreadable, got \(error)")
            }
        }
    }

    func testTheEngineKeepsItsSelectionInTheFile() throws {
        let url = directory.appendingPathComponent("state.json")
        let phone = Harness(launch: false)
        phone.realStateStorage = FileStateStorage(url: url)
        phone.launch()
        try phone.start(interval: 600)
        phone.kill()

        phone.realStateStorage = FileStateStorage(url: url)
        phone.launch(forLocation: true)

        XCTAssertTrue(phone.status.running)
        XCTAssertEqual(try FileStateStorage(url: url).load()?.selection?.minIntervalSec, 600)
    }

    // MARK: diagnostics

    private func entry(_ ts: Int64, _ event: String = "launch") -> DiagnosticEntry {
        DiagnosticEntry(tsUtc: ts, event: event, detail: "d\(ts)")
    }

    func testEntriesAreAppendedAndReadBackOldestFirst() {
        let url = directory.appendingPathComponent("log/diagnostics.jsonl")
        let log = FileDiagnosticsLog(url: url)
        log.append(entry(1))
        log.append(entry(2))
        log.append(entry(3))

        XCTAssertEqual(log.entries(since: 2), [entry(2), entry(3)])
        // A new process reads the same file.
        XCTAssertEqual(FileDiagnosticsLog(url: url).entries(since: 0), [entry(1), entry(2), entry(3)])
    }

    func testEntriesThatCannotBeWrittenAreKeptAndWrittenLater() throws {
        // A directory in the file's place makes every write fail, as a locked phone does.
        let url = directory.appendingPathComponent("diagnostics.jsonl")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let log = FileDiagnosticsLog(url: url)
        log.append(entry(1))
        log.append(entry(2))
        XCTAssertEqual(log.entries(since: 0), [entry(1), entry(2)], "still readable from memory")

        try FileManager.default.removeItem(at: url)
        log.append(entry(3))

        XCTAssertEqual(FileDiagnosticsLog(url: url).entries(since: 0), [entry(1), entry(2), entry(3)])
        XCTAssertEqual(log.entries(since: 0), [entry(1), entry(2), entry(3)], "and not duplicated")
    }

    func testALineCutShortIsSkipped() throws {
        let url = directory.appendingPathComponent("diagnostics.jsonl")
        let log = FileDiagnosticsLog(url: url)
        log.append(entry(1))
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(#"{"tsUtc":2,"eve"#.utf8))
        try handle.close()

        XCTAssertEqual(FileDiagnosticsLog(url: url).entries(since: 0), [entry(1)])
    }

    func testTheLogIsCutBackOnceItHasGrown() {
        let url = directory.appendingPathComponent("diagnostics.jsonl")
        let log = FileDiagnosticsLog(url: url)
        let total = FileDiagnosticsLog.keptEntries * 2
        for index in 1...total {
            log.append(entry(Int64(index)))
        }

        let kept = log.entries(since: 0)
        XCTAssertEqual(kept.count, FileDiagnosticsLog.keptEntries)
        XCTAssertEqual(kept.last, entry(Int64(total)), "the newest entries are the ones kept")
    }
}
