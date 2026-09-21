import Foundation

/// Small persistent state in UserDefaults. Nothing here is a coordinate. UserDefaults uses the
/// same "until first unlock" protection class as our log, so it is readable in background launches.
enum Prefs {
    private static let d = UserDefaults.standard

    /// Install day is assumed to be the first launch. Free-provisioning profiles expire after 7 days.
    static var firstLaunchMs: Int64? {
        get { d.object(forKey: "firstLaunchMs") as? Int64 }
        set { d.set(newValue, forKey: "firstLaunchMs") }
    }
    /// Last 15-minute slot in which a continuous row was written (see SlotGate).
    static var lastContinuousSlot: Int64? {
        get { d.object(forKey: "lastContinuousSlot") as? Int64 }
        set { d.set(newValue, forKey: "lastContinuousSlot") }
    }
    /// Same, for "none" rows, so an error storm cannot flood the log.
    static var lastNoneSlot: Int64? {
        get { d.object(forKey: "lastNoneSlot") as? Int64 }
        set { d.set(newValue, forKey: "lastNoneSlot") }
    }
    static var lastRowMs: Int64? {
        get { d.object(forKey: "lastRowMs") as? Int64 }
        set { d.set(newValue, forKey: "lastRowMs") }
    }
    static var lastFixMs: Int64? {
        get { d.object(forKey: "lastFixMs") as? Int64 }
        set { d.set(newValue, forKey: "lastFixMs") }
    }
    /// Raw CLAuthorizationStatus seen last time, to log permission transitions exactly once.
    static var lastAuthRaw: Int? {
        get { d.object(forKey: "lastAuthRaw") as? Int }
        set { d.set(newValue, forKey: "lastAuthRaw") }
    }
    static var lastReducedAccuracy: Bool? {
        get { d.object(forKey: "lastReducedAccuracy") as? Bool }
        set { d.set(newValue, forKey: "lastReducedAccuracy") }
    }
    /// True once we have shown the "Always" upgrade prompt. iOS shows it only once per install,
    /// after that the only route to Always is Settings.
    static var alwaysPromptShown: Bool {
        get { d.bool(forKey: "alwaysPromptShown") }
        set { d.set(newValue, forKey: "alwaysPromptShown") }
    }
    /// Device boot time (seconds since epoch) at last launch, to notice "first launch after a reboot".
    static var lastBootTimeSec: Double? {
        get { d.object(forKey: "lastBootTimeSec") as? Double }
        set { d.set(newValue, forKey: "lastBootTimeSec") }
    }
}
