import XCTest

@testable import CaptureCore

/// SQLiteCaptureStore against a real database file with the app's real schema
/// (packages/shared/contracts/migration-v1.sql).
///
/// `swift test` links the system SQLite, which is not SQLCipher, so there these run with the
/// cipher checks off, on an unencrypted file. scripts/test-sqlcipher.sh builds the package
/// against real SQLCipher: then every test here runs on an encrypted store opened the way the
/// app opens it, and SQLCipherStoreTests below is added.
final class StoreTests: XCTestCase {
    private func failure(_ body: () throws -> Void) -> StoreFailure? {
        do {
            try body()
            return nil
        } catch {
            return error as? StoreFailure
        }
    }

    // MARK: the check initStore makes

    func testAMigratedStorePassesAndIsLeftInWal() throws {
        let fixture = try StoreFixture()
        let store = fixture.store()
        try store.check()
        try store.check()
        // A connection learns the journal mode when it next reads the file.
        XCTAssertEqual(try fixture.database.samples, [])
        XCTAssertEqual(try fixture.database.column("PRAGMA journal_mode"), ["wal"])
    }

    func testAMissingStoreIsUnusableAndIsNotCreated() throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent(StoreContract.storeFileName).path
        let store = SQLiteCaptureStore(path: path, engine: StoreFixture.defaultEngine) {
            TestDatabase.keyHex
        }

        XCTAssertEqual(failure { try store.check() }?.step, "open")
        XCTAssertFalse(FileManager.default.fileExists(atPath: path), "TypeScript creates the store")
    }

    func testAStoreOfAnotherSchemaVersionIsUnusable() throws {
        let newer = try StoreFixture()
        try newer.database.execute("PRAGMA user_version = 2")
        XCTAssertEqual(
            failure { try newer.store().check() },
            StoreFailure(
                step: "schema_version",
                message: "store schema is version 2, this module writes version 1"))

        let notMigrated = try StoreFixture(migrate: false)
        try notMigrated.database.execute("CREATE TABLE placeholder (x)")
        XCTAssertEqual(failure { try notMigrated.store().check() }?.step, "schema_version")
    }

    func testTheSchemaVersionIsReadAgainOnEveryCheck() throws {
        let fixture = try StoreFixture()
        let store = fixture.store()
        try store.check()

        // TypeScript migrates the store while the module has it open.
        try fixture.database.execute("PRAGMA user_version = 2")
        XCTAssertEqual(failure { try store.check() }?.step, "schema_version")

        try fixture.database.execute("PRAGMA user_version = 1")
        try store.check()
    }

    func testAKeyThatCannotBeReadOrIsMalformedFailsAtTheKeyStep() throws {
        let fixture = try StoreFixture()
        let locked = SQLiteCaptureStore(path: fixture.path, engine: StoreFixture.defaultEngine) {
            throw StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308")
        }
        XCTAssertEqual(
            failure { try locked.check() },
            StoreFailure(step: "key", message: "keychain read failed: OSStatus -25308"))
        XCTAssertEqual(failure { try fixture.store(keyHex: "abc").check() }?.step, "key")
    }

    #if !FMP_HOST_SQLCIPHER
    func testAnEngineThatIsNotSQLCipherIsRefused() throws {
        // The app's configuration, run on the system SQLite: what would happen if the app
        // linked the wrong library. It must refuse, not write a plaintext store.
        let fixture = try StoreFixture()
        let store = fixture.store(engine: .sqlcipher)

        let refused = try XCTUnwrap(failure { try store.check() })
        XCTAssertEqual(refused.step, "cipher_version")
        XCTAssertThrowsError(
            try store.insertSample(
                SampleRow(
                    tsUtc: 1, coordinate: Place.home, accuracyM: 1, source: "continuous", h3r7: "a",
                    h3r5: "b")))
        XCTAssertEqual(try fixture.database.samples, [])
    }
    #endif

    // MARK: the statements of native-writer.json

    func testASampleIsWrittenWithEveryColumn() throws {
        let fixture = try StoreFixture()
        let store = fixture.store()
        try store.check()
        try store.insertSample(
            SampleRow(
                tsUtc: 1_790_000_000, coordinate: Coordinate(lat: 12.9716, lon: 77.5946), accuracyM: 35.5,
                source: "continuous", h3r7: "8760145b4ffffff", h3r5: "8560145bfffffff"))

        XCTAssertEqual(
            try fixture.database.samples,
            ["1790000000|12.9716|77.5946|35.5|continuous|8760145b4ffffff|8560145bfffffff"])
    }

    func testAVisitIsInsertedOpenThenClosedByItsArrivalTime() throws {
        let fixture = try StoreFixture()
        let store = fixture.store()
        try store.check()
        try store.insertVisitStay(
            VisitStayRow(
                startTs: 1000, endTs: 1000, coordinate: Coordinate(lat: 12.9716, lon: 77.5946),
                radiusM: 45, h3r7: "8760145b4ffffff", closed: false))
        XCTAssertEqual(
            try fixture.database.stays, ["1000|1000|12.9716|77.5946|45.0|8760145b4ffffff|0|0|visit"])

        XCTAssertFalse(try store.closeVisitStay(endTs: 5000, startTs: 999), "no visit began then")
        XCTAssertTrue(try store.closeVisitStay(endTs: 5000, startTs: 1000))
        XCTAssertEqual(
            try fixture.database.stays, ["1000|5000|12.9716|77.5946|45.0|8760145b4ffffff|0|1|visit"])
        XCTAssertFalse(try store.closeVisitStay(endTs: 6000, startTs: 1000), "already closed")
    }

    func testClosingAVisitNeverTouchesADerivedStay() throws {
        let fixture = try StoreFixture()
        // The row TypeScript stay derivation owns, open, with the same start time.
        try fixture.database.execute(
            """
            INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source)
            VALUES (1000, 1900, 12.9716, 77.5946, 80, '8760145b4ffffff', 3, 0, 'derived')
            """)
        let store = fixture.store()
        try store.check()

        XCTAssertFalse(try store.closeVisitStay(endTs: 5000, startTs: 1000))
        XCTAssertEqual(
            try fixture.database.stays, ["1000|1900|12.9716|77.5946|80.0|8760145b4ffffff|3|0|derived"])
    }

    func testWritingBeforeTheCheckFailsInsteadOfCrashing() throws {
        let fixture = try StoreFixture()
        let store = fixture.store()
        XCTAssertThrowsError(try store.closeVisitStay(endTs: 2, startTs: 1))
    }

    // MARK: the engine on the real store

    func testCaptureWritesSamplesAndVisitStaysIntoTheRealSchema() throws {
        let fixture = try StoreFixture()
        let phone = Harness(launch: false)
        phone.realStore = fixture.store()
        phone.launch()
        try phone.engine.initStore()
        try phone.start()

        phone.location.deliver(Fix(Place.home, at: Harness.t0, accuracyM: 20))
        // The "mumbai" point of geo-vectors.json: its res-5 parent is not the containing cell.
        let mumbai = Coordinate(lat: 19.076, lon: 72.8777)
        phone.location.deliver(Fix(mumbai, at: Harness.t0 + 300), from: .significantChange)
        let arrival = Harness.t0 + 600
        phone.location.report(
            Visit(coordinate: mumbai, accuracyM: 45, arrivalTsUtc: arrival, departureTsUtc: nil))
        XCTAssertEqual(
            try fixture.database.stays,
            ["\(arrival)|\(arrival)|19.076|72.8777|45.0|87608b0b6ffffff|0|0|visit"])
        phone.location.report(
            Visit(
                coordinate: mumbai, accuracyM: 45, arrivalTsUtc: arrival,
                departureTsUtc: arrival + 3600))
        // A whole visit iOS reports only at departure.
        phone.location.report(
            Visit(
                coordinate: Place.home, accuracyM: 30, arrivalTsUtc: arrival + 7200,
                departureTsUtc: arrival + 9000))

        XCTAssertEqual(
            try fixture.database.samples,
            [
                "\(Harness.t0)|12.9716|77.5946|20.0|continuous|8760145b4ffffff|8560145bfffffff",
                "\(Harness.t0 + 300)|19.076|72.8777|20.0|slc|87608b0b6ffffff|85608b0bfffffff",
            ])
        XCTAssertEqual(
            try fixture.database.stays,
            [
                "\(arrival)|\(arrival + 3600)|19.076|72.8777|45.0|87608b0b6ffffff|0|1|visit",
                "\(arrival + 7200)|\(arrival + 9000)|12.9716|77.5946|30.0|8760145b4ffffff|0|1|visit",
            ])
        XCTAssertEqual(phone.status.health, [])
    }

    func testAStoreMigratedUnderARunningCaptureStopsBeingWritten() throws {
        let fixture = try StoreFixture()
        let phone = Harness(launch: false)
        phone.realStore = fixture.store()
        phone.launch()
        try phone.start()
        phone.location.deliver(Fix(Place.home, at: Harness.t0))

        try fixture.database.execute("PRAGMA user_version = 2")
        phone.clock.advance(900)
        phone.location.deliver(Fix(Place.home, at: phone.clock.now))

        XCTAssertEqual(try fixture.database.samples.count, 1)
        XCTAssertEqual(phone.status.health, [.storeUnusable])
    }
}

#if FMP_HOST_SQLCIPHER
/// What only real encryption can show. Built only by scripts/test-sqlcipher.sh, which links
/// the SQLCipher source that op-sqlite compiles into the app.
final class SQLCipherStoreTests: XCTestCase {
    private func step(_ body: () throws -> Void) -> String? {
        do {
            try body()
            return nil
        } catch {
            return (error as? StoreFailure)?.step
        }
    }

    func testAnEncryptedStoreOpensWithThePinnedParametersAndIsWritten() throws {
        let fixture = try StoreFixture()
        let store = fixture.store(engine: .sqlcipher)
        try store.check()
        try store.insertSample(
            SampleRow(
                tsUtc: 1_790_000_000, coordinate: Coordinate(lat: 12.9716, lon: 77.5946), accuracyM: 20,
                source: "continuous", h3r7: "8760145b4ffffff", h3r5: "8560145bfffffff"))
        try store.insertVisitStay(
            VisitStayRow(
                startTs: 1000, endTs: 1000, coordinate: Coordinate(lat: 12.9716, lon: 77.5946),
                radiusM: 45, h3r7: "8760145b4ffffff", closed: false))
        XCTAssertTrue(try store.closeVisitStay(endTs: 5000, startTs: 1000))

        // Read back through a separate connection, as op-sqlite would.
        XCTAssertEqual(
            try fixture.database.samples,
            ["1790000000|12.9716|77.5946|20.0|continuous|8760145b4ffffff|8560145bfffffff"])
        XCTAssertEqual(
            try fixture.database.stays, ["1000|5000|12.9716|77.5946|45.0|8760145b4ffffff|0|1|visit"])
    }

    func testTheFileOnDiskIsNotPlaintext() throws {
        let fixture = try StoreFixture()
        let store = fixture.store(engine: .sqlcipher)
        try store.check()
        try store.insertSample(
            SampleRow(
                tsUtc: 1, coordinate: Place.home, accuracyM: 20, source: "continuous",
                h3r7: "8760145b4ffffff", h3r5: "8560145bfffffff"))
        store.close()
        fixture.database.close()

        var bytes = try Data(contentsOf: URL(fileURLWithPath: fixture.path))
        if let wal = try? Data(contentsOf: URL(fileURLWithPath: fixture.path + "-wal")) {
            bytes.append(wal)
        }
        XCTAssertGreaterThan(bytes.count, 4096)
        for plain in ["SQLite format 3", "location_sample", "8760145b4ffffff", "continuous"] {
            XCTAssertNil(bytes.range(of: Data(plain.utf8)), "\(plain) is readable in the file")
        }
    }

    func testAWrongKeyFailsAtTheDecryptStep() throws {
        let fixture = try StoreFixture()
        let wrong = String(repeating: "ff", count: 32)
        XCTAssertEqual(step { try fixture.store(engine: .sqlcipher, keyHex: wrong).check() }, "decrypt")
    }

    func testAStoreWrittenWithOtherCipherParametersIsRefused() throws {
        let other = ["PRAGMA key = \"x'\(TestDatabase.keyHex)'\"", "PRAGMA cipher_page_size = 1024"]
        let fixture = try StoreFixture(pragmas: other)
        XCTAssertEqual(step { try fixture.store(engine: .sqlcipher).check() }, "decrypt")
    }

    func testAPlaintextFileIsRefused() throws {
        let fixture = try StoreFixture(pragmas: [])
        XCTAssertEqual(step { try fixture.store(engine: .sqlcipher).check() }, "decrypt")
    }
}
#endif
