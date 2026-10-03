import Foundation

/// One fix, as the capture module hands it over. The two cells are computed by the caller.
public struct LocationSampleRow {
    /// Time of the fix, Unix seconds.
    public var tsUtc: Int64
    public var lat: Double
    public var lon: Double
    public var accuracyM: Double
    /// One of `StoreContract.sampleSources`.
    public var source: String
    /// Res-7 H3 cell of (lat, lon).
    public var h3R7: String
    /// Res-5 PARENT of `h3R7`, not the res-5 cell containing the point.
    public var h3R5: String

    public init(tsUtc: Int64, lat: Double, lon: Double, accuracyM: Double, source: String, h3R7: String, h3R5: String) {
        self.tsUtc = tsUtc
        self.lat = lat
        self.lon = lon
        self.accuracyM = accuracyM
        self.source = source
        self.h3R7 = h3R7
        self.h3R5 = h3R5
    }
}

/// A CLVisit as a `stay` row with source 'visit'. What each field must hold is written in
/// packages/shared/src/store/tables/stay.ts.
public struct VisitStayRow {
    /// The arrival time, Unix seconds. A visit with an unknown arrival is not written.
    public var startTs: Int64
    /// The departure time once known, otherwise equal to `startTs`.
    public var endTs: Int64
    public var lat: Double
    public var lon: Double
    /// The visit's horizontal accuracy, metres.
    public var radiusM: Double
    /// Res-7 H3 cell of (lat, lon).
    public var h3R7: String
    /// True once the departure is known.
    public var closed: Bool

    public init(startTs: Int64, endTs: Int64, lat: Double, lon: Double, radiusM: Double, h3R7: String, closed: Bool) {
        self.startTs = startTs
        self.endTs = endTs
        self.lat = lat
        self.lon = lon
        self.radiusM = radiusM
        self.h3R7 = h3R7
        self.closed = closed
    }
}

/// THE NATIVE STORE INTERFACE ON iOS. One instance per process: `EncryptedStore.shared`.
///
/// The capture module writes every fix through `insertLocationSample`, and every CLVisit
/// through `insertVisitStay` and `closeVisitStay`. It does so with no JavaScript running: when
/// iOS relaunches the app in the background for a location event there is no React instance,
/// so the native side has to find the key, open the encrypted file and commit by itself
/// (plan 5.5, rule 1). Coordinates therefore never cross the bridge.
///
/// What this class guarantees to its callers:
///   - the file is in a directory excluded from backup, or nothing is opened (BACKUP_NOT_EXCLUDED);
///   - the connection is SQLCipher 4 with every pinned parameter in effect and WAL;
///   - the schema is the version this build writes, or nothing is written (SCHEMA_MISMATCH):
///     TypeScript owns migrations, native code never creates or alters a table;
///   - only the statements of packages/shared/contracts/native-writer.json are run as writes.
///
/// Every method is safe to call from any thread and blocks while it works, so call it off the
/// main thread. A failed open is not remembered: the next call tries again, which is how the
/// store comes back after TypeScript has migrated it or after "delete all data".
public final class EncryptedStore {
    /// The process-wide store: Application Support and the Keychain.
    public static let shared = EncryptedStore(location: { try StoreLocation.standard() }, storage: KeychainKeyStorage())

    private let location: () throws -> StoreLocation
    private let vault: StoreKeyVault
    private let lock = NSRecursiveLock()
    private var database: SqlcipherDatabase?

    init(location: @escaping () throws -> StoreLocation, storage: KeyStorage) {
        self.location = location
        self.vault = StoreKeyVault(storage: storage)
    }

    /// The store key as 64 hex characters, made on first call. For `getOrCreateStoreKeyHex`.
    public func keyHex() throws -> String {
        try locked { try vault.getOrCreateKeyHex() }
    }

    /// Absolute path of the backup-excluded directory of the store, created if absent.
    /// For `getStoreDirectory`.
    public func directory() throws -> String {
        try locked { try preparedLocation().directory.path }
    }

    /// Opens the store if it is not open and checks it is usable. For `initStore`, and for the
    /// check the capture module repeats on every background wake. Throws `StoreError`; the
    /// capture module reports that as `store_unusable`.
    public func check() throws {
        try locked { _ = try open() }
    }

    /// Stores one fix and returns its row id.
    @discardableResult
    public func insertLocationSample(_ sample: LocationSampleRow) throws -> Int64 {
        try locked {
            try write {
                try $0.insert(StoreContract.insertLocationSampleSql, [
                    .int(sample.tsUtc), .double(sample.lat), .double(sample.lon), .double(sample.accuracyM),
                    .text(sample.source), .text(sample.h3R7), .text(sample.h3R5),
                ])
            }
        }
    }

    /// Records a visit on arrival, or a whole visit seen only at departure. Returns its row id.
    @discardableResult
    public func insertVisitStay(_ visit: VisitStayRow) throws -> Int64 {
        try locked {
            try write {
                try $0.insert(StoreContract.insertVisitStaySql, [
                    .int(visit.startTs), .int(visit.endTs), .double(visit.lat), .double(visit.lon),
                    .double(visit.radiusM), .text(visit.h3R7), .int(visit.closed ? 1 : 0),
                ])
            }
        }
    }

    /// Closes the open visit that began at `startTs`. Returns false if there is none: the
    /// arrival was never recorded, and the caller then inserts a closed row instead.
    public func closeVisitStay(startTs: Int64, endTs: Int64) throws -> Bool {
        try locked {
            try write { try $0.update(StoreContract.closeVisitStaySql, [.int(endTs), .int(startTs)]) > 0 }
        }
    }

    /// A read for the capture module's own status (newest sample time, samples in the last
    /// day). SELECT only; first column of the first row as text, or nil.
    public func readScalar(_ sql: String, _ arguments: [SqlArgument] = []) throws -> String? {
        guard sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased().hasPrefix("SELECT") else {
            throw StoreError(.openFailed, "readScalar runs SELECT statements only")
        }
        return try locked { try open().scalar(sql, arguments) }
    }

    /// "Delete all my data" (plan 4.7), the native half: closes the connection, deletes the
    /// database with its -wal and -shm files, and deletes the key. The next `keyHex` makes a
    /// new key. Works when the store or the key is already unusable. TypeScript recreates the
    /// schema straight afterwards; until it has, the write methods refuse with SCHEMA_MISMATCH.
    public func deleteAllData() throws {
        try locked {
            close()
            let files = try location().databaseFiles
            for file in files where FileManager.default.fileExists(atPath: file.path) {
                do {
                    try FileManager.default.removeItem(at: file)
                } catch {
                    throw StoreError(.deleteFailed, "could not delete \(file.lastPathComponent): \(error.localizedDescription)")
                }
            }
            try vault.destroy()
        }
    }

    /// Closes the connection. The next call that needs it opens it again.
    public func close() {
        lock.lock()
        defer { lock.unlock() }
        database?.close()
        database = nil
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    private func preparedLocation() throws -> StoreLocation {
        let location = try location()
        try location.prepare()
        return location
    }

    private func open() throws -> SqlcipherDatabase {
        if let database { return database }
        let location = try preparedLocation()
        let opened = try SqlcipherDatabase(path: location.database.path, keyHex: try vault.getOrCreateKeyHex())
        do {
            try StoreVerifier.verifyCipher(opened)
            try StoreVerifier.requireSchemaVersion(opened)
        } catch {
            opened.close()
            throw error
        }
        database = opened
        return opened
    }

    private func write<T>(_ statement: (SqlcipherDatabase) throws -> T) throws -> T {
        let database = try open()
        do {
            return try statement(database)
        } catch {
            // Drop the connection so the next write starts from a fresh, re-verified open.
            close()
            throw error
        }
    }
}
