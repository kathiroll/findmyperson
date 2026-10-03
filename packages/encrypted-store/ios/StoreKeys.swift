import Foundation
import Security

/// Pure key helpers: no Keychain and no SQLCipher.
enum StoreKeys {
    static func requireKeyHex(_ hex: String) throws -> String {
        let want = StoreContract.keyBytes * 2
        let isHex = hex.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 70) || ($0 >= 97 && $0 <= 102) }
        guard hex.utf8.count == want, isHex else {
            throw StoreError(.invalidKey, "store key must be \(want) hex characters (\(StoreContract.keyBytes) bytes)")
        }
        return hex.lowercased()
    }

    /// SQLCipher raw-key literal x'<hex>': no PBKDF2 on every open, which matters on a background launch.
    static func keyLiteral(_ hex: String) throws -> String {
        "x'\(try requireKeyHex(hex))'"
    }

    /// 32 bytes from the system CSPRNG (plan 4.4), as hex.
    static func randomKeyHex() throws -> String {
        var bytes = [UInt8](repeating: 0, count: StoreContract.keyBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw StoreError(.openFailed, "SecRandomCopyBytes failed: \(status)")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
