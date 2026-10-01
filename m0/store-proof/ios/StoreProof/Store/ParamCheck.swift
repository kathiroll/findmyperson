import Foundation

/// Every failure to open the store with the pinned parameters. Never swallowed.
enum StoreOpenError: Error, CustomStringConvertible {
    case invalidKey(String)
    case notSqlcipher(String)
    case paramMismatch(String)
    case badKeyOrParams(String)
    case openFailed(String)

    var code: String {
        switch self {
        case .invalidKey: return "INVALID_KEY"
        case .notSqlcipher: return "NOT_SQLCIPHER"
        case .paramMismatch: return "PARAM_MISMATCH"
        case .badKeyOrParams: return "BAD_KEY_OR_PARAMS"
        case .openFailed: return "OPEN_FAILED"
        }
    }

    var description: String {
        switch self {
        case .invalidKey(let m), .notSqlcipher(let m), .paramMismatch(let m), .badKeyOrParams(let m), .openFailed(let m):
            return "\(code): \(m)"
        }
    }
}

/// Compares what the engine reports against the pinned constant. With a raw key SQLCipher
/// decrypts the file whatever kdf_iter is, so reading the pragma back is the only way a
/// kdf_iter mismatch is noticed. Pure function so it is testable without SQLCipher.
enum ParamCheck {
    static func mismatches(read: (String) -> String?) -> [String] {
        CipherParams.readBack.compactMap { item in
            let actual = read(item.pragma)
            return actual == item.expected ? nil : "\(item.pragma): pinned \(item.expected), effective \(actual ?? "unreadable")"
        }
    }

    static func requireSqlcipherMajor(_ version: String?) throws {
        guard let version, version.hasPrefix("\(CipherParams.sqlcipherMajor).") else {
            throw StoreOpenError.notSqlcipher("expected SQLCipher \(CipherParams.sqlcipherMajor).x, cipher_version returned \(version ?? "nothing")")
        }
    }

    static func requireMatch(read: (String) -> String?) throws {
        let bad = mismatches(read: read)
        if !bad.isEmpty {
            throw StoreOpenError.paramMismatch("cipher parameters differ from the pinned constant (\(bad.joined(separator: "; ")))")
        }
    }
}
