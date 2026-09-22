import CoreLocation
import UIKit

/// Chosen capture settings. Change them here to try other trade-offs.
enum CaptureConfig {
    /// Continuous updates at 100 m accuracy: iOS can satisfy this from Wi-Fi and cell data without
    /// spinning up the GPS chip, which is the battery-conscious setting a production app would use.
    static let desiredAccuracy = kCLLocationAccuracyHundredMeters
    /// No distance filter: the trial measures gaps the platform imposes on its own, not how far
    /// the phone physically moved, so a stationary phone must not manufacture an artificial gap
    /// that looks like a platform failure. The app still downsamples to one row per 15-minute
    /// wall-clock slot (see SlotGate), so this does not change how much data we keep.
    static let distanceFilter: CLLocationDistance = kCLDistanceFilterNone
}

/// Owns the three capture sources. We use THREE separate CLLocationManager objects, one per
/// source, because "continuous" and "significant-location-change" both arrive through the same
/// didUpdateLocations callback; with one manager we could not tell which source produced a fix.
/// Checking which manager called us gives the `source` column for free.
final class CaptureController: NSObject, CLLocationManagerDelegate {
    static let shared = CaptureController()
    static let didChange = Notification.Name("fmp.capture.changed")

    private let continuous = CLLocationManager()
    private let slc = CLLocationManager()
    private let visits = CLLocationManager()

    private(set) var continuousActive = false
    private(set) var slcActive = false
    private(set) var visitsActive = false

    /// Set once we called requestAlwaysAuthorization and are waiting to see how the user answered.
    private var alwaysPromptPending = false
    private var sawResignSincePrompt = false

    private override init() {
        super.init()
        for m in [continuous, slc, visits] { m.delegate = self }
    }

    // MARK: permission state

    var status: CLAuthorizationStatus { continuous.authorizationStatus }
    var isApprox: Bool { continuous.accuracyAuthorization == .reducedAccuracy }

    var level: PermissionLevel {
        switch status {
        case .authorizedAlways: return .always
        case .authorizedWhenInUse: return .whenInUse
        default: return .denied   // notDetermined, denied, restricted: no background capture possible
        }
    }

    var permissionString: String { LogFormat.permission(level, approx: isApprox) }

    var statusDescription: String {
        switch status {
        case .notDetermined: return "not asked yet"
        case .restricted: return "restricted (parental controls / MDM)"
        case .denied: return "denied (or Location Services off)"
        case .authorizedWhenInUse: return "When In Use" + (isApprox ? ", APPROXIMATE only" : ", precise")
        case .authorizedAlways: return "Always" + (isApprox ? ", APPROXIMATE only" : ", precise")
        @unknown default: return "unknown"
        }
    }

    // MARK: permission flow (the in-app explanation screens live in StatusViewController)

    enum NextStep { case requestWhenInUse, requestAlways, openSettingsForAlways, openSettingsAfterDenial, openSettingsForPrecise, done }

    var nextStep: NextStep {
        switch status {
        case .notDetermined: return .requestWhenInUse
        case .denied, .restricted: return .openSettingsAfterDenial
        case .authorizedWhenInUse: return Prefs.alwaysPromptShown ? .openSettingsForAlways : .requestAlways
        case .authorizedAlways: return isApprox ? .openSettingsForPrecise : .done
        @unknown default: return .done
        }
    }

    func requestWhenInUse() {
        Recorder.shared.event("perm_fg_prompt_shown")
        continuous.requestWhenInUseAuthorization()
    }

    func requestAlways() {
        Recorder.shared.event("perm_always_prompt_shown")
        Prefs.alwaysPromptShown = true
        alwaysPromptPending = true
        sawResignSincePrompt = false
        continuous.requestAlwaysAuthorization()
    }

    func openSettings(reason: String) {
        Recorder.shared.event("perm_bg_settings_opened:\(reason)")
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    func appWillResignActive() {
        if alwaysPromptPending { sawResignSincePrompt = true }
    }

    /// If the user picks "Keep Only While Using" on the Always prompt, iOS reports NO status
    /// change, so no delegate callback fires. The system prompt does make our app resign and
    /// re-become active, so we detect the refusal there.
    func appDidBecomeActive() {
        if alwaysPromptPending && sawResignSincePrompt {
            alwaysPromptPending = false
            if status == .authorizedWhenInUse { Recorder.shared.event("perm_always_denied") }
        }
        startIfAllowed()
        NotificationCenter.default.post(name: CaptureController.didChange, object: nil)
    }

    // MARK: start / stop

    /// Called on EVERY launch path (user tap, relaunch after significant change or visit, first
    /// launch after reboot) and whenever permission changes. iOS never restarts continuous
    /// updates for us after the process dies, so the app must start them again each time.
    func startIfAllowed() {
        var started: [String] = []
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            if !continuousActive {
                continuous.desiredAccuracy = CaptureConfig.desiredAccuracy
                continuous.distanceFilter = CaptureConfig.distanceFilter
                // Never let iOS auto-pause: it pauses when it thinks the user stopped moving,
                // which is exactly the dwell case we want to capture.
                continuous.pausesLocationUpdatesAutomatically = false
                // Requires UIBackgroundModes=location in Info.plist. Lets updates continue after
                // the app leaves the screen (blue status-bar pill while on WhenInUse).
                continuous.allowsBackgroundLocationUpdates = true
                continuous.activityType = .other
                continuous.startUpdatingLocation()
                continuousActive = true
                started.append("continuous")
            }
            if status == .authorizedAlways {
                // SLC and visits only work with Always. They are the ones that relaunch a killed app.
                if !slcActive && CLLocationManager.significantLocationChangeMonitoringAvailable() {
                    slc.startMonitoringSignificantLocationChanges()
                    slcActive = true
                    started.append("slc")
                }
                if !visitsActive {
                    visits.startMonitoringVisits()
                    visitsActive = true
                    started.append("visit")
                }
            }
        default:
            stopAll()
        }
        if !started.isEmpty { Recorder.shared.event("capture_started:" + started.joined(separator: "+")) }
    }

    func stopAll() {
        var stopped: [String] = []
        if continuousActive { continuous.stopUpdatingLocation(); continuousActive = false; stopped.append("continuous") }
        if slcActive { slc.stopMonitoringSignificantLocationChanges(); slcActive = false; stopped.append("slc") }
        if visitsActive { visits.stopMonitoringVisits(); visitsActive = false; stopped.append("visit") }
        if !stopped.isEmpty { Recorder.shared.event("capture_stopped:" + stopped.joined(separator: "+")) }
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // Each of the three managers reports the same change; the stored last-status makes this run once.
        let raw = Int(status.rawValue)
        let prev = Prefs.lastAuthRaw
        let reduced = isApprox
        let prevReduced = Prefs.lastReducedAccuracy
        Prefs.lastAuthRaw = raw
        Prefs.lastReducedAccuracy = reduced

        if prev != raw {
            logTransition(from: prev.flatMap { CLAuthorizationStatus(rawValue: Int32($0)) }, to: status)
        }
        if prevReduced != reduced && status != .notDetermined {
            Recorder.shared.event("perm_accuracy:" + (reduced ? "reduced" : "full"))
        }
        if status == .authorizedAlways { alwaysPromptPending = false }
        startIfAllowed()
        NotificationCenter.default.post(name: CaptureController.didChange, object: nil)
    }

    private func logTransition(from: CLAuthorizationStatus?, to: CLAuthorizationStatus) {
        let r = Recorder.shared
        switch (from, to) {
        case (nil, .notDetermined): break
        case (.notDetermined?, .authorizedWhenInUse): r.event("perm_fg_granted")
        case (.notDetermined?, .authorizedAlways): r.event("perm_fg_granted"); r.event("perm_always_granted")
        case (.notDetermined?, .denied), (.notDetermined?, .restricted): r.event("perm_fg_denied")
        case (.authorizedWhenInUse?, .authorizedAlways): r.event("perm_always_granted")
        default: r.event("perm_changed:\(name(from))_to_\(name(to))")   // e.g. user changed it in Settings
        }
    }

    private func name(_ s: CLAuthorizationStatus?) -> String {
        switch s {
        case nil: return "unknown"
        case .notDetermined?: return "not_determined"
        case .restricted?: return "restricted"
        case .denied?: return "denied"
        case .authorizedWhenInUse?: return "when_in_use"
        case .authorizedAlways?: return "always"
        default: return "other"
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Only the timestamp and horizontalAccuracy of the fix are read. Coordinates are never touched.
        guard let fix = locations.last else { return }
        let now = Recorder.nowMs()
        if fix.horizontalAccuracy < 0 {   // negative = iOS says the fix is invalid
            logNone(nowMs: now)
            return
        }
        if manager === continuous {
            // Thin the dense stream to one row per 15-minute slot (first fix after the slot opens).
            guard SlotGate.shouldWrite(nowMs: now, lastWrittenSlot: Prefs.lastContinuousSlot) else { return }
            Prefs.lastContinuousSlot = SlotGate.slot(forMs: now)
            Recorder.shared.sample(source: .continuous, fixAt: fix.timestamp,
                                   accuracyM: fix.horizontalAccuracy, permission: permissionString)
        } else if manager === slc {
            // Significant-change events are rare (about every 500 m of movement): log every one.
            Recorder.shared.sample(source: .slc, fixAt: fix.timestamp,
                                   accuracyM: fix.horizontalAccuracy, permission: permissionString)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A failed attempt is a `none` row. kCLErrorLocationUnknown ("try again") is normal indoors.
        logNone(nowMs: Recorder.nowMs())
    }

    /// At most one `none` row per slot so a burst of errors cannot flood the log.
    private func logNone(nowMs: Int64) {
        guard SlotGate.shouldWrite(nowMs: nowMs, lastWrittenSlot: Prefs.lastNoneSlot) else { return }
        Prefs.lastNoneSlot = SlotGate.slot(forMs: nowMs)
        Recorder.shared.sample(source: .none, fixAt: nil, accuracyM: nil, permission: permissionString)
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        // A visit has no "fix time" of its own. We record the arrival or departure time as fix_at,
        // so ran_at - fix_at shows how late iOS reports it (usually minutes). Coordinates are not read.
        // iOS uses distantFuture as "not departed yet" and distantPast as "arrival time unknown".
        if visit.departureDate != Date.distantFuture {
            Recorder.shared.sample(source: .visitDeparture, fixAt: visit.departureDate,
                                   accuracyM: visit.horizontalAccuracy, permission: permissionString)
        } else if visit.arrivalDate != Date.distantPast {
            Recorder.shared.sample(source: .visitArrival, fixAt: visit.arrivalDate,
                                   accuracyM: visit.horizontalAccuracy, permission: permissionString)
        }
    }
}
