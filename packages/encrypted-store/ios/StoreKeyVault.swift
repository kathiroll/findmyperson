import Foundation

/// The store key on iOS: 32 random bytes kept by a `KeyStorage` as 64 hex characters.
///
/// Survives app restart and reboot: a Keychain item is persistent. It also survives the app
/// being deleted and installed again, in which case a new, empty database is simply opened
/// with the old key.
final class StoreKeyVault {
    private let storage: KeyStorage

    init(storage: KeyStorage) {
        self.storage = storage
    }

    /// The key as 64 hex characters, made on first call.
    ///
    /// If a key is stored but cannot be read, or is not a key, this throws `keyUnavailable`.
    /// It never makes a new key in that case: that would silently orphan every row already
    /// stored. The way out is `destroy`, which "delete all data" calls.
    func getOrCreateKeyHex() throws -> String {
        if let stored = try storage.read() {
            return try decode(stored)
        }
        let fresh = try StoreKeys.randomKeyHex()
        if try storage.add(Data(fresh.utf8)) {
            return fresh
        }
        // Another thread stored one between the read and the add; that one is the key.
        guard let winner = try storage.read() else {
            throw StoreError(.keyUnavailable, "the key vanished while it was being created")
        }
        return try decode(winner)
    }

    /// Deletes the key. The next `getOrCreateKeyHex` makes a new one.
    func destroy() throws {
        try storage.delete()
    }

    private func decode(_ data: Data) throws -> String {
        guard let hex = String(data: data, encoding: .ascii), let key = try? StoreKeys.requireKeyHex(hex) else {
            throw StoreError(.keyUnavailable, "the stored key is not \(StoreContract.keyBytes * 2) hex characters")
        }
        return key
    }
}
