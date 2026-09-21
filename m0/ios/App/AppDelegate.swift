import UIKit

/// All work starts here, in didFinishLaunching, because that is the ONLY code that runs when iOS
/// relaunches a killed app in the background (after a significant location change, a visit, or
/// the first unlock after a reboot). If a location manager with a delegate does not exist by the
/// time this method returns, the pending location event is lost.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var pendingAppOpened = false

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UIDevice.current.isBatteryMonitoringEnabled = true
        if Prefs.firstLaunchMs == nil { Prefs.firstLaunchMs = Recorder.nowMs() }

        // A background relaunch by the location system carries the .location key.
        let relaunchedByLocation = launchOptions?[.location] != nil
        if relaunchedByLocation { Recorder.shared.event("bg_relaunch:location") }
        noteRebootIfAny()
        Recorder.shared.event("env:" + Self.environmentSnapshot())

        // Restart capture on every launch path (iOS never resumes startUpdatingLocation by itself).
        _ = CaptureController.shared
        CaptureController.shared.startIfAllowed()

        // No storyboard: a plain window with our single screen. Also fine for a background launch.
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = StatusViewController()
        win.makeKeyAndVisible()
        window = win

        // Launched by the user (not by the system in the background) counts as "app opened".
        pendingAppOpened = application.applicationState != .background
        return true
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        pendingAppOpened = true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        CaptureController.shared.appWillResignActive()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        if pendingAppOpened {
            pendingAppOpened = false
            Recorder.shared.event("app_opened")
            Recorder.shared.event("env:" + Self.environmentSnapshot())
        }
        CaptureController.shared.appDidBecomeActive()
    }

    /// The kernel records the boot time. If it moved by more than a minute since the last launch,
    /// the phone was rebooted in between, so this is the first launch after a reboot.
    /// (Not "now - systemUptime": uptime stops counting while the phone sleeps, so that drifts.)
    private func noteRebootIfAny() {
        var tv = timeval()
        var size = MemoryLayout<timeval>.stride
        guard sysctlbyname("kern.boottime", &tv, &size, nil, 0) == 0 else { return }
        let boot = Double(tv.tv_sec)
        if let last = Prefs.lastBootTimeSec, abs(boot - last) > 60 {
            Recorder.shared.event("boot_restart")
        }
        Prefs.lastBootTimeSec = boot
    }

    /// Low Power Mode and Background App Refresh decide whether iOS relaunches us, so log them.
    private static func environmentSnapshot() -> String {
        let bar: String
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: bar = "on"
        case .denied: bar = "denied"
        case .restricted: bar = "restricted"
        @unknown default: bar = "unknown"
        }
        return "bg_refresh=\(bar);low_power=\(ProcessInfo.processInfo.isLowPowerModeEnabled ? 1 : 0)"
    }
}
