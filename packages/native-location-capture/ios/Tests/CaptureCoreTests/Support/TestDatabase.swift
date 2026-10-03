import FMPSQLite
import Foundation
import XCTest

@testable import CaptureCore

/// A store file as the TypeScript side makes it, and a way to read back what the module wrote.
/// It talks to SQLite directly so that the tests do not check SQLiteCaptureStore with itself.
final class TestDatabase {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static let keyHex = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

    let path: String
    private var db: OpaquePointer?

    /// Opens the file, creating it if absent. `pragmas` run first: the key and cipher settings.
    init(path: String, pragmas: [String] = []) throws {
        self.path = path
        let createFlag: Int32 = 0x0000_0004
        let code = sqlite3_open_v2(path, &db, FMP_SQLITE_OPEN_READWRITE | createFlag, nil)
        guard code == FMP_SQLITE_OK else { throw Failure(description: "open: code \(code)") }
        for pragma in pragmas {
            try execute(pragma)
        }
    }

    deinit {
        close()
    }

    func close() {
        if let db {
            sqlite3_close_v2(db)
        }
        db = nil
    }

    func execute(_ sql: String) throws {
        _ = try column(sql)
    }

    /// The first column of every row, as text.
    func column(_ sql: String) throws -> [String] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == FMP_SQLITE_OK, let statement else {
            throw Failure(description: "\(sql): \(String(cString: sqlite3_errmsg(db)))")
        }
        defer { sqlite3_finalize(statement) }
        var values: [String] = []
        while true {
            switch sqlite3_step(statement) {
            case FMP_SQLITE_ROW:
                values.append(sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? "NULL")
            case FMP_SQLITE_DONE:
                return values
            default:
                throw Failure(description: "\(sql): \(String(cString: sqlite3_errmsg(db)))")
            }
        }
    }

    /// Applies packages/shared/contracts/migration-v1.sql: the schema the app really has.
    func migrate() throws {
        let script = try Repo.text("packages/shared/contracts/migration-v1.sql")
        // "In the .sql file statements are separated by a line holding only ;"
        for statement in script.components(separatedBy: "\n;\n") {
            let sql = statement.trimmingCharacters(in: .whitespacesAndNewlines)
            if !sql.isEmpty {
                try execute(sql)
            }
        }
    }

    var samples: [String] {
        get throws {
            try column(
                """
                SELECT ts_utc || '|' || lat || '|' || lon || '|' || accuracy_m || '|' || source
                  || '|' || h3_r7 || '|' || h3_r5 FROM location_sample ORDER BY id
                """)
        }
    }

    var stays: [String] {
        get throws {
            try column(
                """
                SELECT start_ts || '|' || end_ts || '|' || lat || '|' || lon || '|' || radius_m
                  || '|' || h3_r7 || '|' || sample_count || '|' || closed || '|' || source
                FROM stay ORDER BY id
                """)
        }
    }
}

/// A temporary directory holding a migrated store, removed when the test ends.
///
/// In plain `swift test` the store is an unencrypted SQLite file. Under scripts/test-sqlcipher.sh
/// the same fixture is encrypted with the pinned parameters and opened the way the app opens
/// it, so every store test also runs against real SQLCipher.
final class StoreFixture {
    #if FMP_HOST_SQLCIPHER
    static let defaultEngine = SQLiteCaptureStore.Engine.sqlcipher
    static let defaultPragmas =
        ["PRAGMA key = \"x'\(TestDatabase.keyHex)'\""] + CipherParams.applyPragmas
    #else
    static let defaultEngine = SQLiteCaptureStore.Engine.plainSQLiteForTests
    static let defaultPragmas: [String] = []
    #endif

    let directory: URL
    let path: String
    let database: TestDatabase

    /// `pragmas` are the key and cipher settings the file is created with.
    init(pragmas: [String] = StoreFixture.defaultPragmas, migrate: Bool = true) throws {
        directory = try temporaryDirectory()
        path = directory.appendingPathComponent(StoreContract.storeFileName).path
        database = try TestDatabase(path: path, pragmas: pragmas)
        if migrate {
            try database.migrate()
        }
    }

    deinit {
        database.close()
        try? FileManager.default.removeItem(at: directory)
    }

    func store(
        engine: SQLiteCaptureStore.Engine = StoreFixture.defaultEngine,
        keyHex: String = TestDatabase.keyHex
    ) -> SQLiteCaptureStore {
        SQLiteCaptureStore(path: path, engine: engine) { keyHex }
    }
}
