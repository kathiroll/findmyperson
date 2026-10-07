import Foundation
import Network
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
