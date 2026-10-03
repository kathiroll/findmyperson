import Foundation
import Security

/// Where the store key is kept. The real one is `KeychainKeyStorage`; the host check uses one
/// in memory, because a command-line tool must not write to the Keychain of the Mac it runs on.
protocol KeyStorage {
    /// The stored key, or nil if there is none. Throws `keyUnavailable` if there is one that
    /// cannot be read right now.
    func read() throws -> Data?
    /// Stores the key. Returns false if one was already there, which is then left as it is.
    func add(_ key: Data) throws -> Bool
    /// Deletes the key. Deleting nothing is not an error.
    func delete() throws
}

/// The store key as a Keychain generic password (plan 4.4).
///
/// ACCESSIBILITY: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly.
///   AfterFirstUnlock, not WhenUnlocked: background capture must read the key while the phone
///     is locked in a pocket. With WhenUnlocked every sample taken while locked would be lost.
///   ThisDeviceOnly: the item is never synced to iCloud Keychain and is not restored onto
///     another device from a backup. Without it the key would quietly leave the phone.
/// kSecAttrSynchronizable is false for the same reason. src/policy.test.ts fails if this file
/// ever names another accessibility class.
///
/// Before the first unlock after a reboot the read fails with errSecInteractionNotAllowed.
/// That is reported as `keyUnavailable` and capture waits; it is never answered with a new key.
struct KeychainKeyStorage: KeyStorage {
    private var item: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: StoreContract.keychainService,
            kSecAttrAccount as String: StoreContract.keychainAccount,
            kSecAttrSynchronizable as String: false,
        ]
    }

    func read() throws -> Data? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else {
                throw StoreError(.keyUnavailable, "the Keychain item has unexpected content")
            }
            return data
        case errSecItemNotFound:
            return nil
        default:
            throw StoreError(.keyUnavailable, "Keychain read failed: OSStatus \(status)")
        }
    }

    func add(_ key: Data) throws -> Bool {
        var attributes = item
        attributes[kSecValueData as String] = key
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return true
        case errSecDuplicateItem:
            return false
        default:
            throw StoreError(.keyUnavailable, "Keychain add failed: OSStatus \(status)")
        }
    }

    func delete() throws {
        let status = SecItemDelete(item as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError(.deleteFailed, "Keychain delete failed: OSStatus \(status)")
        }
    }
}
