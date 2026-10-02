import Foundation

// macOS host check for the iOS Swift writer. Compiled together with the app's real
// Store/*.swift (minus Keychain and UIKit code) against SQLCipher built from the same C source
// op-sqlite vendors; see build.sh. This is NOT the iPhone: it proves the Swift code compiles,
// opens a SQLCipher file with the pinned parameters, writes a row and rejects mismatches.
//
//   host-check selftest <shared/cipher-params.json>
//   host-check write <db> <keyHex> <label>
//   host-check read  <db> <keyHex>

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func expect(_ cond: Bool, _ what: String) {
    if !cond { fail("FAIL: \(what)") }
    print("ok: \(what)")
}

func expectThrows(_ what: String, code: String, _ body: () throws -> Void) {
    do {
        try body()
        fail("FAIL: \(what): did not throw")
    } catch let e as StoreOpenError {
        expect(e.code == code, "\(what) throws \(code) (got \(e.code))")
    } catch {
        fail("FAIL: \(what): unexpected error \(error)")
    }
}

func selftest(sharedPath: String) throws {
    let json = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: sharedPath))) as! [String: Any]
    expect(json["sqlcipherMajor"] as? Int == CipherParams.sqlcipherMajor, "sqlcipherMajor matches shared JSON")
    expect(json["cipherCompatibility"] as? Int == CipherParams.cipherCompatibility, "cipherCompatibility matches shared JSON")
    expect(json["pageSizeBytes"] as? Int == CipherParams.pageSizeBytes, "pageSizeBytes matches shared JSON")
    expect(json["kdfIterations"] as? Int == CipherParams.kdfIterations, "kdfIterations matches shared JSON")
    expect(json["kdfAlgorithm"] as? String == CipherParams.kdfAlgorithm, "kdfAlgorithm matches shared JSON")
    expect(json["hmacAlgorithm"] as? String == CipherParams.hmacAlgorithm, "hmacAlgorithm matches shared JSON")
    expect(json["keyBytes"] as? Int == CipherParams.keyBytes, "keyBytes matches shared JSON")
    expect(json["journalMode"] as? String == CipherParams.journalMode, "journalMode matches shared JSON")
    expect(json["createTableSql"] as? String == CipherParams.createTableSql, "createTableSql matches shared JSON")
    expect(json["insertSql"] as? String == CipherParams.insertSql, "insertSql matches shared JSON")
    expect(json["selectSql"] as? String == CipherParams.selectSql, "selectSql matches shared JSON")
    expect(CipherParams.applyPragmas == [
        "PRAGMA cipher_compatibility = \(json["cipherCompatibility"] as! Int)",
        "PRAGMA cipher_page_size = \(json["pageSizeBytes"] as! Int)",
        "PRAGMA kdf_iter = \(json["kdfIterations"] as! Int)",
        "PRAGMA cipher_kdf_algorithm = \(json["kdfAlgorithm"] as! String)",
        "PRAGMA cipher_hmac_algorithm = \(json["hmacAlgorithm"] as! String)",
    ], "applyPragmas derived from the scalars")

    let vector = json["keyVector"] as! [String: String]
    expect(try StoreKeys.keyLiteral(vector["hex"]!) == vector["literal"]!, "key literal golden vector")
    for bad in ["", String(repeating: "zz", count: 32), String(repeating: "ab", count: 31), String(repeating: "ab", count: 33)] {
        expectThrows("malformed key '\(bad.prefix(6))...'", code: "INVALID_KEY") { _ = try StoreKeys.keyLiteral(bad) }
    }

    let pinned = Dictionary(uniqueKeysWithValues: CipherParams.readBack.map { ($0.pragma, $0.expected) })
    try ParamCheck.requireMatch { pinned[$0] }
    print("ok: pinned values pass ParamCheck")
    expectThrows("different KDF iteration count", code: "PARAM_MISMATCH") {
        try ParamCheck.requireMatch { $0 == "kdf_iter" ? "1000" : pinned[$0] }
    }
    expectThrows("cipher_version missing", code: "NOT_SQLCIPHER") { try ParamCheck.requireSqlcipherMajor(nil) }
    expectThrows("cipher_version 3.x", code: "NOT_SQLCIPHER") { try ParamCheck.requireSqlcipherMajor("3.4.2") }
    try ParamCheck.requireSqlcipherMajor("4.19.0 community")
    print("ok: SQLCipher 4.x accepted")
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: host-check selftest|write|read ...") }
do {
    switch args[1] {
    case "selftest":
        try selftest(sharedPath: args[2])
    case "write":
        let ts = try NativeStoreWriter.writeProbeRow(dbPath: args[2], keyHex: args[3], label: args[4])
        print("wrote ts=\(ts)")
    case "read":
        let conn = try StoreConnection(path: args[2], keyHex: args[3])
        for r in try conn.readRows() { print("\(r.id)\t\(r.tsUtc)\t\(r.label)") }
    default:
        fail("unknown command \(args[1])")
    }
} catch {
    fail("\(error)")
}
