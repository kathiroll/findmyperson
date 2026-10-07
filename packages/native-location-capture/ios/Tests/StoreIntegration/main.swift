import Foundation
@testable import FindMyPersonEncryptedStore

// Runs the production capture adapter and the real engine on host SQLCipher. The phone and
// key storage are fakes; the reader plays TypeScript's migration/read/close lifecycle.
final class MemoryKeys: KeyStorage {
    var key: Data?
    func read() throws -> Data? { key }
    func add(_ value: Data) throws -> Bool {
        guard key == nil else { return false }
        key = value
        return true
    }
    func delete() throws { key = nil }
}
func require(_ value: Bool, _ message: String) {
    guard value else { fatalError(message) }
}
let migration = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
let scratch = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for nativeFirst in [false, true] {
    let support = scratch.appendingPathComponent(nativeFirst ? "native-first" : "js-first")
    let location = FindMyPersonEncryptedStore.StoreLocation(applicationSupport: support)
    let owner = EncryptedStore(location: { location }, storage: MemoryKeys())
    let adapter = EncryptedCaptureStore(store: owner)
    let oldKey = try owner.keyHex()
    require(try EncryptedStoreKeySource(store: owner).getOrCreateKeyHex() == oldKey, "capture and vault keys agree")
    _ = try owner.directory()
    func reader(_ key: String) throws -> SqlcipherDatabase {
        let db = try SqlcipherDatabase(path: location.database.path, keyHex: key)
        try StoreVerifier.verifyCipher(db)
        for sql in migration.components(separatedBy: "\n;\n") where !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            _ = try db.scalar(sql)
        }
        return db
    }
    if nativeFirst {
        do { try adapter.check(); fatalError("native must refuse an unmigrated store") }
        catch let failure as StoreFailure { require(failure.step == "schema_mismatch", "must fail schema gate") }
    }
    var js = try reader(oldKey)
    let phone = Harness(launch: false)
    phone.realStore = adapter
    phone.launch()
    try phone.start(interval: 1, distance: 100)
    require(phone.location.deliver(Fix(Place.home, at: phone.clock.now)), "capture must run")
    require(try js.scalar("SELECT count(*) FROM location_sample") == "1", "reader must see native A")
    try phone.engine.stop()
    js.close()
    try owner.deleteAllData()
    let newKey = try owner.keyHex()
    require(newKey != oldKey, "delete must rotate key")
    js = try reader(newKey)
    try phone.engine.initStore()
    try phone.start(interval: 1, distance: 100)
    phone.clock.advance(10)
    require(phone.location.deliver(Fix(Place.office, at: phone.clock.now)), "resumed capture must run")
    require(try js.scalar("SELECT count(*) FROM location_sample") == "1", "only native B in new file")
    require(try js.scalar("SELECT ts_utc FROM location_sample") == String(phone.clock.now), "B is visible to reader")
    let old = try SqlcipherDatabase(path: location.database.path, keyHex: oldKey)
    do { try StoreVerifier.verifyCipher(old); fatalError("old key must refuse new file") }
    catch let error as StoreError { require(error.code == .badKeyOrParams, "wrong-key failure") }
    old.close()
    let cutoff = phone.clock.now - Int64(FindMyPersonEncryptedStore.StoreContract.retentionSec)
    try adapter.insertSample(SampleRow(tsUtc: cutoff - 1, coordinate: Place.home, accuracyM: 20,
                                     source: "continuous", h3r7: "8760145b4ffffff", h3r5: "8560145bfffffff"))
    _ = try js.update("INSERT INTO kv (k,v) VALUES ('stay_derivation.last_sample_id','999')", [])
    try adapter.insertVisitStay(VisitStayRow(startTs: cutoff - 50, endTs: cutoff + 50,
                                           coordinate: Place.home, radiusM: 20, h3r7: "8760145b4ffffff", closed: true))
    let counts = try adapter.purgeExpired(nowTsUtc: phone.clock.now)
    require(counts.samples == 1 && counts.staysTrimmed == 1, "shared native purge and trim")
    require(try js.scalar("SELECT start_ts FROM stay") == String(cutoff), "visit trimmed at shared cutoff")
    require(try js.scalar("SELECT v FROM kv WHERE k='stay_derivation.last_sample_id'") == "1", "purge rewinds cursor")
    try phone.engine.stop()
    js.close()
    owner.close()
    print("ok: \(nativeFirst ? "native-first" : "js-first") capture A, stop/delete/key rotation, resume B, reader and purge")
}
