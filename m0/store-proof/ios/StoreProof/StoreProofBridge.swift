import Foundation
import UIKit

/// Thin @objc entry point the Turbo module (RCTNativeStoreProof.mm) calls. All work happens on
/// a background queue; completions carry a value or an error message, never both.
@objc(StoreProofBridge)
public final class StoreProofBridge: NSObject {
    private static let queue = DispatchQueue(label: "dev.findmyperson.storeproof", qos: .utility)

    @objc public static func databaseDirectory() -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("fmp", isDirectory: true).path
    }

    @objc public static func getOrCreateKeyHex(_ completion: @escaping (String?, String?) -> Void) {
        queue.async {
            do {
                completion(try KeychainKeyProvider.getOrCreateKeyHex(), nil)
            } catch {
                completion(nil, "\(error)")
            }
        }
    }

    /// With delaySeconds > 0 the write is held open by a background-task assertion, so a tester
    /// can lock the phone while it is pending. iOS grants roughly 30 s, then ends the task.
    @objc public static func writeProbeRow(_ dbPath: String, label: String, delaySeconds: Double,
                                           completion: @escaping (NSNumber?, String?) -> Void) {
        var task = UIBackgroundTaskIdentifier.invalid
        if delaySeconds > 0 {
            task = UIApplication.shared.beginBackgroundTask(withName: "fmp-store-proof-write") {
                completion(nil, "iOS ended the background task before the delayed write ran")
            }
        }
        queue.asyncAfter(deadline: .now() + max(delaySeconds, 0)) {
            defer {
                if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
            }
            do {
                let key = try KeychainKeyProvider.getOrCreateKeyHex()
                let ts = try NativeStoreWriter.writeProbeRow(dbPath: dbPath, keyHex: key, label: label)
                StoreFiles.applyProtection(dbPath: dbPath)
                completion(NSNumber(value: ts), nil)
            } catch {
                completion(nil, "\(error)")
            }
        }
    }
}

enum StoreFiles {
    /// NSFileProtectionCompleteUntilFirstUserAuthentication on the database and its WAL/SHM
    /// files (a locked phone that was unlocked once since boot can still write), and excluded
    /// from backup so history never reaches iCloud (plan section 4.5).
    static func applyProtection(dbPath: String) {
        let fm = FileManager.default
        for suffix in ["", "-wal", "-shm"] where fm.fileExists(atPath: dbPath + suffix) {
            try? fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: dbPath + suffix)
        }
        var url = URL(fileURLWithPath: dbPath)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
