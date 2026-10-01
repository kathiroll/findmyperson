import Foundation

/// Opens the store natively and writes one row.
///
/// Why this writes the database itself instead of handing the sample to JS (architecture plan
/// section 5.5, rule 1): when iOS relaunches the app in the background for a location event
/// there is no React instance and no JS thread yet, so nothing could receive the data. The
/// native side must open the encrypted file and commit on its own. It also keeps coordinates
/// off the JS bridge, where a crash report or a stray console.log could capture them. This
/// proof writes a timestamp and a label, not a location.
///
/// SQLCipher's C API comes from the bridging header; the symbols are the ones the OPSQLite pod
/// links into the app, so this is the same engine the JS side reads with.
final class StoreConnection {
    private var db: OpaquePointer?

    /// Opens (creating if absent) with the pinned parameters and verifies them before returning.
    init(path: String, keyHex: String) throws {
        let literal = try StoreKeys.keyLiteral(keyHex)
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)

        var handle: OpaquePointer?
        let rc = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard rc == SQLITE_OK, let opened = handle else {
            let m = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 returned \(rc)"
            sqlite3_close_v2(handle)
            throw StoreOpenError.openFailed("could not open \(path): \(m)")
        }
        db = opened
        do {
            let keyRc = literal.withCString { sqlite3_key_v2(opened, "main", $0, Int32(strlen($0))) }
            guard keyRc == SQLITE_OK else { throw StoreOpenError.openFailed("sqlite3_key_v2 failed: \(lastError)") }
            for pragma in CipherParams.applyPragmas {
                try exec(pragma)
            }
            try ParamCheck.requireSqlcipherMajor(try scalar("PRAGMA cipher_version"))
            try ParamCheck.requireMatch { (try? self.scalar("PRAGMA \($0)")) ?? nil }

            // First real read: a wrong key or a page-size / HMAC / KDF-algorithm mismatch
            // surfaces here as "file is not a database".
            do {
                _ = try scalar("SELECT count(*) FROM sqlite_master")
            } catch {
                throw StoreOpenError.badKeyOrParams("store did not decrypt with the pinned parameters (wrong key, or the writer used different cipher parameters): \(error)")
            }

            let mode = try scalar("PRAGMA journal_mode = \(CipherParams.journalMode)")
            guard mode?.lowercased() == CipherParams.journalMode else {
                throw StoreOpenError.paramMismatch("journal_mode is \(mode ?? "unreadable"), pinned \(CipherParams.journalMode)")
            }
            try exec(CipherParams.createTableSql)
        } catch {
            close()
            throw error
        }
    }

    deinit { close() }

    func close() {
        if let handle = db {
            sqlite3_close_v2(handle)
            db = nil
        }
    }

    private var lastError: String { db.map { String(cString: sqlite3_errmsg($0)) } ?? "no connection" }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let m = err.map { String(cString: $0) } ?? lastError
            sqlite3_free(err)
            throw StoreOpenError.openFailed("\(sql): \(m)")
        }
    }

    /// First column of the first row as text, or nil if there are no rows.
    func scalar(_ sql: String) throws -> String? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreOpenError.openFailed("\(sql): \(lastError)")
        }
        defer { sqlite3_finalize(stmt) }
        switch sqlite3_step(stmt) {
        case SQLITE_ROW:
            return sqlite3_column_text(stmt, 0).map { String(cString: $0) }
        case SQLITE_DONE:
            return nil
        default:
            throw StoreOpenError.openFailed("\(sql): \(lastError)")
        }
    }

    func insertProbeRow(tsUtc: Int64, label: String) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, CipherParams.insertSql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreOpenError.openFailed("insert prepare: \(lastError)")
        }
        defer { sqlite3_finalize(stmt) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        sqlite3_bind_int64(stmt, 1, tsUtc)
        sqlite3_bind_text(stmt, 2, label, -1, transient)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw StoreOpenError.openFailed("insert: \(lastError)")
        }
    }

    /// All rows as (id, ts, label); used by the host check to read back what was written.
    func readRows() throws -> [(id: Int64, tsUtc: Int64, label: String)] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, CipherParams.selectSql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreOpenError.openFailed("select prepare: \(lastError)")
        }
        defer { sqlite3_finalize(stmt) }
        var rows: [(id: Int64, tsUtc: Int64, label: String)] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            rows.append((sqlite3_column_int64(stmt, 0), sqlite3_column_int64(stmt, 1), String(cString: sqlite3_column_text(stmt, 2))))
        }
        return rows
    }
}

enum NativeStoreWriter {
    /// Opens, inserts one row stamped with the current time, closes. Returns the epoch seconds written.
    static func writeProbeRow(dbPath: String, keyHex: String, label: String) throws -> Int64 {
        let ts = Int64(Date().timeIntervalSince1970)
        let conn = try StoreConnection(path: dbPath, keyHex: keyHex)
        defer { conn.close() }
        try conn.insertProbeRow(tsUtc: ts, label: label)
        return ts
    }
}
