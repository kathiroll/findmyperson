import Foundation
import Security

/// The 32-byte database key in the Keychain (architecture plan section 4.4).
///
/// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, not WhenUnlocked: background capture must
/// read the key while the phone is locked in a pocket. ThisDeviceOnly keeps it out of iCloud
/// Keychain. Before the first unlock after a reboot the read fails with errSecInteractionNotAllowed
/// and capture simply waits; that is reported, not papered over by minting a new key.
enum KeychainKeyProvider {
    private static let service = "dev.findmyperson.storeproof"
    private static let account = "store-key-v1"

    static func getOrCreateKeyHex() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let hex = String(data: data, encoding: .ascii) else {
                throw StoreOpenError.openFailed("keychain item has unexpected content")
            }
            return try StoreKeys.requireKeyHex(hex)
        case errSecItemNotFound:
            let hex = try StoreKeys.randomKeyHex()
            let add: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecValueData as String: Data(hex.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                kSecAttrSynchronizable as String: false,
            ]
            let addStatus = SecItemAdd(add as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw StoreOpenError.openFailed("keychain add failed: OSStatus \(addStatus)")
            }
            return hex
        default:
            // errSecInteractionNotAllowed (-25308) means the device has not been unlocked since boot.
            throw StoreOpenError.openFailed("keychain read failed: OSStatus \(status)")
        }
    }
}
