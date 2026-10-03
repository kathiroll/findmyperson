import Foundation

/// The @objc entry point RCTNativeEncryptedStore.mm calls. All work happens on a background
/// queue; a completion carries a value or an error, never both.
@objc(FMPEncryptedStoreBridge)
public final class EncryptedStoreBridge: NSObject {
    private static let queue = DispatchQueue(label: "dev.findmyperson.encrypted-store", qos: .utility)

    /// `code` is the lower-case StoreError code (`key_unavailable`, `backup_not_excluded`, ...).
    private static func answer<T>(_ completion: @escaping (T?, String?, String?) -> Void, _ work: @escaping () throws -> T) {
        queue.async {
            do {
                completion(try work(), nil, nil)
            } catch let error as StoreError {
                completion(nil, error.code.rawValue.lowercased(), error.description)
            } catch {
                completion(nil, "store_failed", "\(error)")
            }
        }
    }

    @objc public static func getOrCreateStoreKeyHex(_ completion: @escaping (String?, String?, String?) -> Void) {
        answer(completion) { try EncryptedStore.shared.keyHex() }
    }

    @objc public static func getStoreDirectory(_ completion: @escaping (String?, String?, String?) -> Void) {
        answer(completion) { try EncryptedStore.shared.directory() }
    }

    @objc public static func deleteAllData(_ completion: @escaping (NSNumber?, String?, String?) -> Void) {
        answer(completion) {
            try EncryptedStore.shared.deleteAllData()
            return NSNumber(value: true)
        }
    }
}
