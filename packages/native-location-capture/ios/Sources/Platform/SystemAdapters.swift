import Foundation
import Network
import Security
import UIKit

/// Low Power Mode, Background App Refresh, the boot time, the battery, whether the app is on
/// screen, the network path, and the Settings app. Main thread only, like the engine that
/// reads it.
final class SystemDeviceConditions: DeviceConditions {
    private let pathMonitor = NWPathMonitor()
    /// The path iOS last reported. nil until its first report, which follows `start` at once.
    private var lastPath: NWPath?

    init() {
        // UIDevice reports `.unknown` until monitoring is on. It stays on for the process.
        UIDevice.current.isBatteryMonitoringEnabled = true
        // Reports arrive on the main queue, where `networkPath` is read. The monitor runs for
        // the life of the process, like this object.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.lastPath = path
        }
        pathMonitor.start(queue: .main)
    }

    /// A path that is not `.satisfied` cannot carry a request, so it is no path.
    var networkPath: NetworkPath? {
        guard let path = lastPath, path.status == .satisfied else { return nil }
        return NetworkPath(expensive: path.isExpensive, constrained: path.isConstrained)
    }

    /// `.charging`, or `.full`, which is "plugged in and at 100%". `.unknown` counts as on
    /// battery.
    var onExternalPower: Bool {
        let state = UIDevice.current.batteryState
        return state == .charging || state == .full
    }

    var appActive: Bool { UIApplication.shared.applicationState == .active }

    var backgroundRefreshAvailable: Bool {
        UIApplication.shared.backgroundRefreshStatus == .available
    }

    var lowPowerMode: Bool { ProcessInfo.processInfo.isLowPowerModeEnabled }

    /// The kernel's boot time. Not "now minus uptime": uptime stops while the phone sleeps.
    var bootTimeSec: Double? {
        var time = timeval()
        var size = MemoryLayout<timeval>.stride
        guard sysctlbyname("kern.boottime", &time, &size, nil, 0) == 0 else { return nil }
        return Double(time.tv_sec)
    }

    func openAppSettings(completion: @escaping (Bool) -> Void) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            completion(false)
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: completion)
    }
}

final class MainQueueScheduler: Scheduler {
    func after(seconds: Double, _ work: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }
}

/// The 32-byte store key in the Keychain (plan 4.4), as proved in m0/store-proof.
///
/// kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, not WhenUnlocked: capture must read the
/// key while the phone is locked in a pocket. ThisDeviceOnly keeps it out of iCloud Keychain
/// and out of backups. Before the first unlock after a restart the read fails with
/// errSecInteractionNotAllowed; that is reported, never answered by minting a new key, which
/// would orphan the store.
final class KeychainKeySource: StoreKeySource {
    private static let service = "dev.findmyperson.store"
    private static let account = "store-key-v1"

    func getOrCreateKeyHex() throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data, let hex = String(data: data, encoding: .ascii) else {
                throw StoreFailure(step: "key", message: "the keychain item is not a key")
            }
            return try StoreKeys.requireKeyHex(hex)
        case errSecItemNotFound:
            let hex = try Self.randomKeyHex()
            let add: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: Self.service,
                kSecAttrAccount as String: Self.account,
                kSecValueData as String: Data(hex.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                kSecAttrSynchronizable as String: false,
            ]
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess else {
                throw StoreFailure(step: "key", message: "keychain add failed: OSStatus \(added)")
            }
            return hex
        default:
            // errSecInteractionNotAllowed (-25308): not unlocked since the phone restarted.
            throw StoreFailure(step: "key", message: "keychain read failed: OSStatus \(status)")
        }
    }

    private static func randomKeyHex() throws -> String {
        var bytes = [UInt8](repeating: 0, count: CipherParams.keyBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw StoreFailure(step: "key", message: "SecRandomCopyBytes failed: \(status)")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}

/// Where the store and the module's two files live.
enum StoreLocation {
    /// Application Support, not Documents: private to the app and never shown to the user.
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("findmyperson-store", isDirectory: true)
    }

    /// Creates the directory, keeps it out of iCloud and iTunes backups (plan 4.5: a backup
    /// would take 30 days of location history off the phone), and sets the protection class
    /// that lets a background launch write while the phone is locked, once it has been
    /// unlocked after a restart. New files inherit the class from the directory; the ones
    /// already there are set one by one.
    static func prepare() {
        let manager = FileManager.default
        var url = directory
        let protection = [FileAttributeKey.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        try? manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: protection)
        try? manager.setAttributes(protection, ofItemAtPath: url.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        for name in (try? manager.contentsOfDirectory(atPath: url.path)) ?? [] {
            try? manager.setAttributes(protection, ofItemAtPath: url.appendingPathComponent(name).path)
        }
    }
}
