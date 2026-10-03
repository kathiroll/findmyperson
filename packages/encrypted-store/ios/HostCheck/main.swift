import Foundation

// macOS host check for the iOS half of the store. It is compiled from the real ios/*.swift and
// FMPSqlcipher.c against SQLCipher built from the same C source op-sqlite compiles into the
// app (build-host-check.sh). This is NOT an iPhone: it proves the Swift code compiles, opens a
// SQLCipher file with the pinned parameters, writes through the contract statements, refuses a
// schema it was not built for, excludes its directory from backup and rotates its key. The
// Keychain is compiled but never called: a command-line tool must not write to the Keychain of
// the Mac it runs on, so the key lives in `MemoryKeyStorage` here.
//
//   host-check selftest <scratch dir> <packages/shared/contracts/migration-v1.sql>
//   host-check check <application support dir> <key hex>
//   host-check write-sample <application support dir> <key hex> <ts> <source>
//   host-check write-visit <application support dir> <key hex> <start ts> <end ts>
//   host-check delete-all <application support dir> <key hex>
//
// A StoreError exits with status 2 and prints its code on the first line of stderr.

final class MemoryKeyStorage: KeyStorage {
    var stored: Data?
    var unreadable = false
    var adds = 0

    init(keyHex: String? = nil) {
        stored = keyHex.map { Data($0.utf8) }
    }

    func read() throws -> Data? {
        if unreadable { throw StoreError(.keyUnavailable, "the device has not been unlocked since boot") }
        return stored
    }

    func add(_ key: Data) throws -> Bool {
        adds += 1
        if stored != nil { return false }
        stored = key
        return true
    }

    func delete() throws {
        stored = nil
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func expect(_ condition: Bool, _ what: String) {
    if !condition { fail("FAIL: \(what)") }
    print("ok: \(what)")
}

func expectThrows(_ what: String, _ code: StoreError.Code, _ body: () throws -> Void) {
    do {
        try body()
        fail("FAIL: \(what): nothing was thrown")
    } catch let error as StoreError {
        expect(error.code == code, "\(what) throws \(code.rawValue) (got \(error.code.rawValue))")
    } catch {
        fail("FAIL: \(what): unexpected error \(error)")
    }
}

func store(in applicationSupport: String, storage: KeyStorage) -> EncryptedStore {
    EncryptedStore(location: { StoreLocation(applicationSupport: URL(fileURLWithPath: applicationSupport, isDirectory: true)) }, storage: storage)
}

let sample = LocationSampleRow(
    tsUtc: 1_700_000_000, lat: 12.9716, lon: 77.5946, accuracyM: 12, source: "continuous",
    h3R7: "8760145b4ffffff", h3R5: "8560145bfffffff"
)

func selftest(scratch: String, migrationSql: String) throws {
    let isHexKey: (String) -> Bool = { $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }

    // Keys.
    expect(try StoreKeys.keyLiteral(StoreContract.keyVectorHex) == StoreContract.keyVectorLiteral, "key literal matches the shared golden vector")
    expect(try StoreKeys.keyLiteral(StoreContract.keyVectorHex.uppercased()) == StoreContract.keyVectorLiteral, "key literal lower-cases")
    for bad in ["", String(repeating: "zz", count: 32), String(repeating: "ab", count: 31), String(repeating: "ab", count: 33)] {
        expectThrows("malformed key of \(bad.count) characters", .invalidKey) { _ = try StoreKeys.keyLiteral(bad) }
    }
    expect(isHexKey(try StoreKeys.randomKeyHex()), "a random key is 64 hex characters")
    expect(try StoreKeys.randomKeyHex() != StoreKeys.randomKeyHex(), "two random keys differ")

    // The vault.
    let storage = MemoryKeyStorage()
    let first = try StoreKeyVault(storage: storage).getOrCreateKeyHex()
    expect(isHexKey(first), "the first call makes a 32-byte key")
    expect(try StoreKeyVault(storage: storage).getOrCreateKeyHex() == first, "the key survives an app restart")
    expect(storage.adds == 1, "an existing key is never written again")

    storage.unreadable = true
    expectThrows("a key that cannot be read", .keyUnavailable) { _ = try StoreKeyVault(storage: storage).getOrCreateKeyHex() }
    storage.unreadable = false
    expect(storage.stored == Data(first.utf8) && storage.adds == 1, "an unreadable key is never answered with a new key")

    let garbage = MemoryKeyStorage()
    garbage.stored = Data("not a key".utf8)
    expectThrows("a stored value that is not a key", .keyUnavailable) { _ = try StoreKeyVault(storage: garbage).getOrCreateKeyHex() }
    expect(garbage.stored == Data("not a key".utf8), "a damaged key is left as it is")

    let vault = StoreKeyVault(storage: storage)
    try vault.destroy()
    expect(storage.stored == nil, "destroy deletes the key")
    let rotated = try vault.getOrCreateKeyHex()
    expect(isHexKey(rotated) && rotated != first, "the key after destroy is a new one")

    // The location.
    let applicationSupport = scratch + "/Library/Application Support"
    let location = StoreLocation(applicationSupport: URL(fileURLWithPath: applicationSupport, isDirectory: true))
    expect(location.directory.path == applicationSupport + "/findmyperson-store", "the store directory is <Application Support>/findmyperson-store")
    expect(location.databaseFiles.map { $0.lastPathComponent } == ["findmyperson.db", "findmyperson.db-wal", "findmyperson.db-shm"], "the database files are the store file, its -wal and its -shm")
    expect(location.databaseFiles.allSatisfy { $0.deletingLastPathComponent().path == location.directory.path }, "every store file is inside the store directory")
    expectThrows("a directory that does not exist yet", .backupNotExcluded) { try location.requireExcludedFromBackup() }
    try FileManager.default.createDirectory(at: location.directory, withIntermediateDirectories: true)
    expectThrows("a directory that is not excluded from backup", .backupNotExcluded) { try location.requireExcludedFromBackup() }
    try location.prepare()
    let flag = try URL(fileURLWithPath: location.directory.path, isDirectory: true).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
    expect(flag == true, "prepare leaves the directory excluded from backup, read back from the file system")
    try location.requireExcludedFromBackup()
    try location.prepare()
    print("ok: prepare is repeatable")

    // The store, on real SQLCipher.
    let keys = MemoryKeyStorage()
    let native = store(in: applicationSupport, storage: keys)
    expect(try native.directory() == location.directory.path, "the store hands out the prepared directory")
    expectThrows("a store TypeScript has not migrated yet (version 0)", .schemaMismatch) { try native.check() }
    expectThrows("a write to an unmigrated store", .schemaMismatch) { _ = try native.insertLocationSample(sample) }
    expect(FileManager.default.fileExists(atPath: location.database.path), "the file was created, empty, with the pinned parameters")
    let header = try FileHandle(forReadingFrom: location.database).readData(ofLength: 15)
    expect(header != Data("SQLite format 3".utf8), "the file is not a plaintext SQLite file")

    // What TypeScript does on first open: migration 1, from the committed contract file.
    let key = try native.keyHex()
    let script = try String(contentsOfFile: migrationSql, encoding: .utf8)
    let migrator = try SqlcipherDatabase(path: location.database.path, keyHex: key)
    try StoreVerifier.verifyCipher(migrator)
    for statement in script.components(separatedBy: "\n;\n") where !statement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        _ = try migrator.scalar(statement)
    }
    expect(try migrator.scalar("PRAGMA user_version") == "1", "migration 1 ran on the Swift-created file")

    try native.check()
    print("ok: a migrated store passes the check")
    expect(try native.insertLocationSample(sample) == 1, "a sample is written and its row id returned")
    expect(try native.readScalar("SELECT count(*) FROM location_sample") == "1", "the sample is in the table")
    expect(try native.readScalar("SELECT source || ':' || h3_r7 || ':' || h3_r5 || ':' || ts_utc FROM location_sample") == "continuous:8760145b4ffffff:8560145bfffffff:1700000000", "the columns hold what was passed, in the contract order")
    expect(try native.readScalar("SELECT max(ts_utc) FROM location_sample WHERE ts_utc >= ?", [.int(1_700_000_000)]) == "1700000000", "a read with a parameter works")
    expectThrows("readScalar with a statement that is not a SELECT", .openFailed) { _ = try native.readScalar("DELETE FROM location_sample") }

    let visit = VisitStayRow(startTs: 1_700_000_100, endTs: 1_700_000_100, lat: 12.9716, lon: 77.5946, radiusM: 50, h3R7: "8760145b4ffffff", closed: false)
    expect(try native.insertVisitStay(visit) == 1, "a visit arrival is written as an open stay")
    expect(try native.closeVisitStay(startTs: 1_700_000_100, endTs: 1_700_000_900) == true, "the departure closes it")
    expect(try native.readScalar("SELECT end_ts || ':' || closed || ':' || source || ':' || sample_count FROM stay") == "1700000900:1:visit:0", "the closed visit row is what the contract says")
    expect(try native.closeVisitStay(startTs: 42, endTs: 43) == false, "closing a visit that was never opened changes nothing")
    expect(try migrator.scalar("SELECT count(*) FROM location_sample") == "1", "a second connection sees the native write (WAL)")

    // A synthetic version 2: native code must stop writing until it is rebuilt for it.
    _ = try migrator.scalar("PRAGMA user_version = 2")
    native.close()
    expectThrows("a store migrated to a synthetic version 2", .schemaMismatch) { try native.check() }
    expectThrows("a write to a version-2 store", .schemaMismatch) { _ = try native.insertLocationSample(sample) }
    expect(try migrator.scalar("SELECT count(*) FROM location_sample") == "1", "nothing was written at version 2")
    _ = try migrator.scalar("PRAGMA user_version = 1")
    try native.check()
    print("ok: a failed open is not remembered")

    // A writer that drifted, and a wrong key.
    let driftedPragmas = StoreContract.applyPragmas.map { $0.hasPrefix("PRAGMA kdf_iter") ? "PRAGMA kdf_iter = 1000" : $0 }
    let drifted = try SqlcipherDatabase(path: location.database.path, keyHex: key, pragmas: driftedPragmas)
    expect(try drifted.scalar("SELECT count(*) FROM sqlite_master") != nil, "SQLCipher alone decrypts with a drifted kdf_iter and a raw key")
    expectThrows("a drifted kdf_iter", .paramMismatch) { try StoreVerifier.verifyCipher(drifted) }
    drifted.close()
    let smallPages = try SqlcipherDatabase(path: location.database.path, keyHex: key, pragmas: StoreContract.applyPragmas.map { $0.hasPrefix("PRAGMA cipher_page_size") ? "PRAGMA cipher_page_size = 1024" : $0 })
    expectThrows("a drifted page size", .paramMismatch) { try StoreVerifier.verifyCipher(smallPages) }
    smallPages.close()
    let wrongKey = try SqlcipherDatabase(path: location.database.path, keyHex: String(repeating: "ab", count: 32))
    expectThrows("a wrong key", .badKeyOrParams) { try StoreVerifier.verifyCipher(wrongKey) }
    wrongKey.close()
    native.close()
    migrator.close()
    expectThrows("a store whose key was replaced", .badKeyOrParams) {
        try store(in: applicationSupport, storage: MemoryKeyStorage(keyHex: String(repeating: "cd", count: 32))).check()
    }

    // Delete all data.
    try native.check()
    try native.deleteAllData()
    expect(location.databaseFiles.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) }, "delete all data removes the store file, its -wal and its -shm")
    expect(keys.stored == nil, "delete all data deletes the key")
    let newKey = try native.keyHex()
    expect(newKey != key, "the key after delete all data is a new one")
    expectThrows("the recreated store before TypeScript has migrated it", .schemaMismatch) { try native.check() }
    native.close()
    expectThrows("the old key on the new file", .badKeyOrParams) {
        try store(in: applicationSupport, storage: MemoryKeyStorage(keyHex: key)).check()
    }

    let lost = MemoryKeyStorage(keyHex: newKey)
    lost.unreadable = true
    let stuck = store(in: applicationSupport, storage: lost)
    expectThrows("a store whose key cannot be read", .keyUnavailable) { try stuck.check() }
    try stuck.deleteAllData()
    expect(!FileManager.default.fileExists(atPath: location.database.path), "delete all data works when the key is unreadable")
}

func run(_ arguments: [String]) throws {
    guard arguments.count >= 2 else { fail("usage: host-check selftest|check|write-sample|write-visit|delete-all ...") }
    let command = arguments[1]
    if command == "selftest" {
        guard arguments.count == 4 else { fail("usage: host-check selftest <scratch dir> <migration-v1.sql>") }
        try selftest(scratch: arguments[2], migrationSql: arguments[3])
        print("selftest passed")
        return
    }
    guard arguments.count >= 4 else { fail("usage: host-check \(command) <application support dir> <key hex> ...") }
    let keys = MemoryKeyStorage(keyHex: arguments[3])
    let native = store(in: arguments[2], storage: keys)
    defer { native.close() }
    switch command {
    case "check":
        try native.check()
        print("usable")
    case "write-sample":
        guard arguments.count == 6, let ts = Int64(arguments[4]) else { fail("usage: host-check write-sample <dir> <key> <ts> <source>") }
        var row = sample
        row.tsUtc = ts
        row.source = arguments[5]
        print("row=\(try native.insertLocationSample(row))")
    case "write-visit":
        guard arguments.count == 6, let start = Int64(arguments[4]), let end = Int64(arguments[5]) else { fail("usage: host-check write-visit <dir> <key> <start> <end>") }
        let id = try native.insertVisitStay(VisitStayRow(startTs: start, endTs: start, lat: sample.lat, lon: sample.lon, radiusM: 50, h3R7: sample.h3R7, closed: false))
        print("row=\(id) closed=\(try native.closeVisitStay(startTs: start, endTs: end))")
    case "delete-all":
        try native.deleteAllData()
        print("deleted key=\(keys.stored == nil ? "gone" : "kept") directory=\(try native.directory())")
    default:
        fail("unknown command \(command)")
    }
}

do {
    try run(CommandLine.arguments)
} catch let error as StoreError {
    FileHandle.standardError.write(Data("\(error.code.rawValue)\n\(error.message)\n".utf8))
    exit(2)
} catch {
    fail("\(error)")
}
