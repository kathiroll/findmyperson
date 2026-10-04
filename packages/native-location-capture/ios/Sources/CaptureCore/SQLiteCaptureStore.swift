import Foundation

#if SWIFT_PACKAGE
import FMPSQLite
#endif

/// Pure key helpers (m0/store-proof). The golden vector is `keyVector` in cipher-params.json.
enum StoreKeys {
    static func requireKeyHex(_ hex: String) throws -> String {
        let want = CipherParams.keyBytes * 2
        let isHex = hex.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102)
        }
        guard hex.utf8.count == want, isHex else {
            throw StoreFailure(
                step: "key",
                message: "store key must be \(want) hex characters (\(CipherParams.keyBytes) bytes)")
        }
        return hex.lowercased()
    }

    /// SQLCipher's raw-key literal x'<hex>'. A raw key skips PBKDF2 on every open, which
    /// matters when iOS gives a background launch a few seconds.
    static func keyLiteral(_ hex: String) throws -> String {
        "x'\(try requireKeyHex(hex))'"
    }
}

/// The encrypted store, opened natively.
///
/// Why the module writes the database itself (plan 5.5 rule 1): when iOS relaunches the app for
/// a location event there may be no JavaScript to hand a fix to, and a coordinate that never
/// crosses the bridge cannot end up in a crash report or a console log.
///
/// It runs the statements of StoreContract and no others, plus the pragmas of the open check.
/// It never creates a file or a table: TypeScript owns the schema (packages/shared
/// store/migrations.ts), and a store whose version is not the one this build was made for is
/// reported unusable and left alone.
final class SQLiteCaptureStore: CaptureStore {
    enum Engine {
        /// The app: the engine must be SQLCipher 4 with the pinned parameters.
        case sqlcipher
        /// `swift test` only. macOS and Linux have plain SQLite, so the cipher checks are
        /// skipped and the same statements run against an unencrypted file with the real
        /// schema. Nothing on the device constructs the store this way.
        case plainSQLiteForTests
    }

    private let path: String
    private let keyHex: () throws -> String
    private let engine: Engine
    private var db: OpaquePointer?

    init(path: String, engine: Engine = .sqlcipher, keyHex: @escaping () throws -> String) {
        self.path = path
        self.engine = engine
        self.keyHex = keyHex
    }

    deinit {
        close()
    }

    func close() {
        if let handle = db {
            _ = sqlite3_close_v2(handle)
            db = nil
        }
    }

    // MARK: CaptureStore

    /// Opens the store if it is not open and verifies it. The connection is then kept, and each
    /// later call only re-reads the schema version, which TypeScript can change under us.
    func check() throws {
        do {
            if db == nil {
                try open()
            }
            let version = try scalar(StoreContract.readSchemaVersionSql, step: "schema_version")
            guard version == String(StoreContract.schemaVersion) else {
                throw StoreFailure(
                    step: "schema_version",
                    message: "store schema is version \(version ?? "unreadable"), "
                        + "this module writes version \(StoreContract.schemaVersion)")
            }
        } catch {
            close()
            throw error
        }
    }

    func insertSample(_ row: SampleRow) throws {
        try run(StoreContract.insertLocationSampleSql, step: "insert_sample") { statement in
            sqlite3_bind_int64(statement, 1, row.tsUtc)
            sqlite3_bind_double(statement, 2, row.coordinate.lat)
            sqlite3_bind_double(statement, 3, row.coordinate.lon)
            sqlite3_bind_double(statement, 4, row.accuracyM)
            fmp_sqlite3_bind_text_copy(statement, 5, row.source)
            fmp_sqlite3_bind_text_copy(statement, 6, row.h3r7)
            fmp_sqlite3_bind_text_copy(statement, 7, row.h3r5)
        }
    }

    func insertVisitStay(_ row: VisitStayRow) throws {
        try run(StoreContract.insertVisitStaySql, step: "insert_visit") { statement in
            sqlite3_bind_int64(statement, 1, row.startTs)
            sqlite3_bind_int64(statement, 2, row.endTs)
            sqlite3_bind_double(statement, 3, row.coordinate.lat)
            sqlite3_bind_double(statement, 4, row.coordinate.lon)
            sqlite3_bind_double(statement, 5, row.radiusM)
            fmp_sqlite3_bind_text_copy(statement, 6, row.h3r7)
            sqlite3_bind_int64(statement, 7, row.closed ? 1 : 0)
        }
    }

    func closeVisitStay(endTs: Int64, startTs: Int64) throws -> Bool {
        try run(StoreContract.closeVisitStaySql, step: "close_visit") { statement in
            sqlite3_bind_int64(statement, 1, endTs)
            sqlite3_bind_int64(statement, 2, startTs)
        }
        return sqlite3_changes(db) > 0
    }

    /// The retention purge of a capture wake: the four purge statements of the contract, in
    /// the contract's order, in one transaction (packages/shared/src/store/nativeWriter.ts says
    /// why each of those matters). It covers the two tables that hold where the phone has
    /// been; the rest of the purge is TypeScript's.
    func purgeExpired(nowTsUtc: Int64) throws -> PurgeCounts {
        let cutoff = nowTsUtc - StoreContract.retentionSec
        // IMMEDIATE takes the write lock now, so op-sqlite's connection cannot write between
        // two statements of the purge.
        try execute("BEGIN IMMEDIATE", step: "purge")
        do {
            let samples = try change(StoreContract.deleteSamplesBeforeSql, [cutoff])
            let stays = try change(StoreContract.deleteStaysEndedBeforeSql, [cutoff])
            let trimmed = try change(StoreContract.trimStaysStartedBeforeSql, [cutoff, cutoff, cutoff])
            // Sample ids are rowids: with the newest rows gone, the next fix would take an id
            // stay derivation has already passed. No parameters.
            _ = try change(StoreContract.rewindStayCursorSql, [])
            try execute("COMMIT", step: "purge")
            return PurgeCounts(samples: samples, stays: stays, staysTrimmed: trimmed)
        } catch {
            try? execute("ROLLBACK", step: "purge")
            throw error
        }
    }

    /// Runs an UPDATE or DELETE whose parameters are all integers. Returns the rows it changed.
    private func change(_ sql: String, _ arguments: [Int64]) throws -> Int {
        try run(sql, step: "purge") { statement in
            for (index, value) in arguments.enumerated() {
                sqlite3_bind_int64(statement, Int32(index + 1), value)
            }
        }
        return Int(sqlite3_changes(db))
    }

    // MARK: opening

    /// The steps m0/store-proof proved, in its order. Each failure names its step.
    private func open() throws {
        let literal: String
        do {
            literal = try StoreKeys.keyLiteral(try keyHex())
        } catch let failure as StoreFailure {
            throw failure
        } catch {
            throw StoreFailure(step: "key", message: "\(error)")
        }

        // Read-write without CREATE: a missing file means TypeScript has not made the store
        // yet, and creating an empty one here would hide that.
        var handle: OpaquePointer?
        let flags = FMP_SQLITE_OPEN_READWRITE | FMP_SQLITE_OPEN_FULLMUTEX
        let code = sqlite3_open_v2(path, &handle, flags, nil)
        guard code == FMP_SQLITE_OK, let opened = handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "code \(code)"
            _ = sqlite3_close_v2(handle)
            throw StoreFailure(step: "open", message: message)
        }
        db = opened
        // op-sqlite writes the same file from JavaScript; wait for it rather than fail.
        _ = sqlite3_busy_timeout(opened, 3000)

        // PRAGMA key, not sqlite3_key_v2: the same raw-key literal, and plain SQLite accepts
        // the statement as an unknown pragma, so one code path serves the app and the tests.
        try execute("PRAGMA key = \"\(literal)\"", step: "key")
        for pragma in CipherParams.applyPragmas {
            try execute(pragma, step: "cipher_params")
        }
        if engine == .sqlcipher {
            // Plain SQLite returns no row here. Without this check a build that linked the
            // system library would go on to write an unencrypted file.
            let version = try scalar("PRAGMA cipher_version", step: "cipher_version")
            guard let version, version.hasPrefix("\(CipherParams.sqlcipherMajor).") else {
                throw StoreFailure(
                    step: "cipher_version",
                    message: "expected SQLCipher \(CipherParams.sqlcipherMajor).x, the engine "
                        + "reports \(version ?? "nothing: it is not SQLCipher")")
            }
            // With a raw key SQLCipher decrypts whatever kdf_iter is, so reading each value
            // back is the only way a drifted parameter is noticed.
            for item in CipherParams.readBack {
                let actual = try scalar("PRAGMA \(item.pragma)", step: "cipher_params")
                guard actual == item.expected else {
                    throw StoreFailure(
                        step: "cipher_params",
                        message: "\(item.pragma) is \(actual ?? "unreadable"), pinned \(item.expected)")
                }
            }
        }
        // The first real read: a wrong key or wrong parameters surface here.
        do {
            _ = try scalar("SELECT count(*) FROM sqlite_master", step: "decrypt")
        } catch {
            throw StoreFailure(
                step: "decrypt",
                message: "the store did not open with this key and the pinned parameters (\(error))")
        }
        let mode = try scalar("PRAGMA journal_mode = \(CipherParams.journalMode)", step: "journal_mode")
        guard mode?.lowercased() == CipherParams.journalMode else {
            throw StoreFailure(
                step: "journal_mode",
                message: "journal_mode is \(mode ?? "unreadable"), pinned \(CipherParams.journalMode)")
        }
    }

    // MARK: statements

    private func lastError() -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "the store is not open"
    }

    private func execute(_ sql: String, step: String) throws {
        try run(sql, step: step) { _ in }
    }

    /// Prepares, binds, and steps a statement to completion.
    private func run(_ sql: String, step: String, bind: (OpaquePointer) -> Void) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == FMP_SQLITE_OK, let statement else {
            throw StoreFailure(step: step, message: lastError())
        }
        defer { _ = sqlite3_finalize(statement) }
        bind(statement)
        var code = sqlite3_step(statement)
        while code == FMP_SQLITE_ROW {
            code = sqlite3_step(statement)
        }
        guard code == FMP_SQLITE_DONE else {
            throw StoreFailure(step: step, message: lastError())
        }
    }

    /// First column of the first row as text, or nil if the statement returns no row.
    private func scalar(_ sql: String, step: String) throws -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == FMP_SQLITE_OK, let statement else {
            throw StoreFailure(step: step, message: lastError())
        }
        defer { _ = sqlite3_finalize(statement) }
        switch sqlite3_step(statement) {
        case FMP_SQLITE_ROW:
            return sqlite3_column_text(statement, 0).map { String(cString: $0) }
        case FMP_SQLITE_DONE:
            return nil
        default:
            throw StoreFailure(step: step, message: lastError())
        }
    }
}
