import Foundation
import Security

/// Pure key helpers; no Keychain or SQLCipher, so the host check can test them on a Mac.
enum StoreKeys {
    static func requireKeyHex(_ hex: String) throws -> String {
        let want = CipherParams.keyBytes * 2
        let ok = hex.utf8.count == want && hex.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }
        guard ok else { throw StoreOpenError.invalidKey("store key must be \(want) hex characters (\(CipherParams.keyBytes) bytes)") }
        return hex.lowercased()
    }

    /// SQLCipher raw-key literal x'<hex>'; keeps PBKDF2 out of the background-launch path.
    static func keyLiteral(_ hex: String) throws -> String {
        "x'\(try requireKeyHex(hex))'"
    }

    static func randomKeyHex() throws -> String {
        var bytes = [UInt8](repeating: 0, count: CipherParams.keyBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw StoreOpenError.openFailed("SecRandomCopyBytes failed: \(status)") }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
