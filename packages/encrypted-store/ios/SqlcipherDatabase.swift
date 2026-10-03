import Foundation

/// A value bound to a statement parameter. The store has no BLOB and no boolean columns.
public enum SqlArgument {
    case int(Int64)
    case double(Double)
    case text(String)
}

/// An open SQLCipher connection, through the C front in FMPSqlcipher.h.
///
/// `init` sets the key and applies the cipher pragmas before anything is read, which is the
/// only moment they can be applied. It does not check anything: `StoreVerifier` does.
final class SqlcipherDatabase {
    // SQLite result codes; FMPSqlcipher.c asserts these values at compile time.
    private static let ok: Int32 = 0
    private static let row: Int32 = 100
    private static let done: Int32 = 101

    private var handle: OpaquePointer?

    /// `pragmas` exists so the host check can play a writer that drifted; everything else
    /// passes the pinned list.
    init(path: String, keyHex: String, pragmas: [String] = StoreContract.applyPragmas) throws {
        let literal = try StoreKeys.keyLiteral(keyHex)
        var opened: OpaquePointer?
        let status = fmp_db_open(path, &opened)
        guard status == Self.ok, let db = opened else {
            let detail = opened.map { String(cString: fmp_db_errmsg($0)) } ?? "result code \(status)"
            if let opened { fmp_db_close(opened) }
            throw StoreError(.openFailed, "could not open the store file: \(detail)")
        }
        handle = db
        do {
            let keyStatus = literal.withCString { fmp_db_key(db, $0, Int32(strlen($0))) }
            guard keyStatus == Self.ok else { throw StoreError(.openFailed, "setting the key failed: \(lastError)") }
            for pragma in pragmas {
                _ = try scalar(pragma)
            }
            guard fmp_db_busy_timeout(db, Int32(StoreContract.busyTimeoutMs)) == Self.ok else {
                throw StoreError(.openFailed, "setting the busy timeout failed: \(lastError)")
            }
        } catch {
            close()
            throw error
        }
    }

    deinit { close() }

    func close() {
        if let db = handle {
            handle = nil
            fmp_db_close(db)
        }
    }

    private var lastError: String { handle.map { String(cString: fmp_db_errmsg($0)) } ?? "the connection is closed" }

    /// First column of the first row as text, or nil if there is no row or the value is NULL.
    func scalar(_ sql: String, _ arguments: [SqlArgument] = []) throws -> String? {
        try withStatement(sql, arguments) { statement in
            switch fmp_stmt_step(statement) {
            case Self.row:
                return fmp_stmt_column_text(statement, 0).map { String(cString: $0) }
            case Self.done:
                return nil
            default:
                throw StoreError(.openFailed, "\(sql): \(lastError)")
            }
        }
    }

    /// Runs an INSERT and returns the new row id.
    func insert(_ sql: String, _ arguments: [SqlArgument]) throws -> Int64 {
        try run(sql, arguments)
        return fmp_db_last_insert_rowid(handle)
    }

    /// Runs an UPDATE and returns how many rows it changed.
    func update(_ sql: String, _ arguments: [SqlArgument]) throws -> Int {
        try run(sql, arguments)
        return Int(fmp_db_changes(handle))
    }

    private func run(_ sql: String, _ arguments: [SqlArgument]) throws {
        try withStatement(sql, arguments) { statement in
            guard fmp_stmt_step(statement) == Self.done else {
                throw StoreError(.openFailed, "\(sql): \(lastError)")
            }
        }
    }

    private func withStatement<T>(_ sql: String, _ arguments: [SqlArgument], _ body: (OpaquePointer) throws -> T) throws -> T {
        guard let db = handle else { throw StoreError(.openFailed, "the connection is closed") }
        var prepared: OpaquePointer?
        guard fmp_stmt_prepare(db, sql, &prepared) == Self.ok, let statement = prepared else {
            throw StoreError(.openFailed, "\(sql): \(lastError)")
        }
        defer { fmp_stmt_finalize(statement) }
        for (offset, argument) in arguments.enumerated() {
            let index = Int32(offset + 1)
            let status: Int32
            switch argument {
            case .int(let value): status = fmp_stmt_bind_int64(statement, index, value)
            case .double(let value): status = fmp_stmt_bind_double(statement, index, value)
            case .text(let value): status = fmp_stmt_bind_text(statement, index, value)
            }
            guard status == Self.ok else { throw StoreError(.openFailed, "\(sql): bind \(index): \(lastError)") }
        }
        return try body(statement)
    }
}

/// The checks every open makes before a single row is written, the same ones TypeScript's
/// openStore makes and in the same order.
enum StoreVerifier {
    /// SQLCipher 4, every pinned parameter in effect, the file decrypts, WAL.
    static func verifyCipher(_ db: SqlcipherDatabase) throws {
        let version = try? db.scalar("PRAGMA cipher_version")
        guard let version, version.hasPrefix("\(StoreContract.sqlcipherMajor).") else {
            throw StoreError(.notSqlcipher, "expected SQLCipher \(StoreContract.sqlcipherMajor).x, cipher_version is \(version ?? "unreadable")")
        }

        // With a raw key SQLCipher decrypts the file whatever kdf_iter is, so reading each
        // pragma back is the only check that notices a side that drifted on it.
        let mismatches = StoreContract.readBack.compactMap { item -> String? in
            let actual = try? db.scalar("PRAGMA \(item.pragma)")
            return actual == item.expected ? nil : "\(item.pragma): pinned \(item.expected), effective \(actual ?? "unreadable")"
        }
        guard mismatches.isEmpty else {
            throw StoreError(.paramMismatch, "cipher parameters differ from the pinned constant (\(mismatches.joined(separator: "; ")))")
        }

        // The first real read. A wrong key, a page-size, HMAC or KDF-algorithm mismatch and a
        // plaintext file all surface here as "file is not a database".
        do {
            _ = try db.scalar("SELECT count(*) FROM sqlite_master")
        } catch {
            throw StoreError(.badKeyOrParams, "the store did not decrypt with the stored key and the pinned parameters: \(error)")
        }

        let mode = try db.scalar("PRAGMA journal_mode = \(StoreContract.journalMode)")
        guard mode?.lowercased() == StoreContract.journalMode else {
            throw StoreError(.paramMismatch, "journal_mode is \(mode ?? "unreadable"), pinned \(StoreContract.journalMode)")
        }
    }

    /// TypeScript owns migrations. Native code never creates or alters a table: it compares
    /// `PRAGMA user_version` with the version it was built for and, if they differ, writes
    /// nothing. A store that TypeScript has not migrated yet (version 0, straight after install
    /// or after "delete all data") and one migrated by a newer build are both refused.
    static func requireSchemaVersion(_ db: SqlcipherDatabase) throws {
        let found = try db.scalar(StoreContract.readSchemaVersionSql).flatMap { Int($0) }
        guard found == StoreContract.schemaVersion else {
            throw StoreError(.schemaMismatch, "store schema is version \(found.map(String.init) ?? "unreadable"), this build writes version \(StoreContract.schemaVersion)")
        }
    }
}
