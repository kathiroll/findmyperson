import Foundation

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

