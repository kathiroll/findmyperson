import CoreLocation
import Foundation

/// LocationSystem over Core Location. Create it on the main thread: that is where Core Location
/// then delivers every callback, and where CaptureEngine expects them.
///
/// Three CLLocationManager objects, as in the M0 trial app: continuous and significant-change
/// fixes arrive through the same delegate method, so which manager called is the only way to
/// tell the two sources apart. Visits and the exit region share the third.
final class CoreLocationSystem: NSObject, LocationSystem, CLLocationManagerDelegate {
    weak var events: LocationSystemEvents?

    private let continuous = CLLocationManager()
    private let significant = CLLocationManager()
    private let monitor = CLLocationManager()
    private var servicesEnabled = true

    private static let regionIdentifier = "dev.findmyperson.capture.last-sample"

    override init() {
        super.init()
        for manager in [continuous, significant, monitor] {
            manager.delegate = self
        }
        refreshServicesEnabled()
    }

    // MARK: state

    var authorization: LocationAuthorization {
        switch continuous.authorizationStatus {
        case .notDetermined: return .notDetermined
        case .restricted: return .restricted
        case .denied: return .denied
        case .authorizedWhenInUse: return .whenInUse
        case .authorizedAlways: return .always
        @unknown default: return .denied
        }
    }

    var preciseLocation: Bool { continuous.accuracyAuthorization == .fullAccuracy }

    var locationServicesEnabled: Bool { servicesEnabled }

    var significantChangeAvailable: Bool {
        CLLocationManager.significantLocationChangeMonitoringAvailable()
    }

    var regionMonitoringAvailable: Bool {
        CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self)
    }

    /// `locationServicesEnabled()` can block, and iOS warns when it is called on the main
    /// thread. It is read in the background and the engine is told if the answer changed.
    private func refreshServicesEnabled() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let enabled = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async {
                guard let self, self.servicesEnabled != enabled else { return }
                self.servicesEnabled = enabled
                self.events?.locationAuthorizationChanged()
            }
        }
    }

    // MARK: prompts

    func requestWhenInUseAuthorization() {
        continuous.requestWhenInUseAuthorization()
    }

    func requestAlwaysAuthorization() {
        continuous.requestAlwaysAuthorization()
    }

    // MARK: services

    func startContinuous(accuracy: Accuracy) {
        // 100 m is satisfied from Wi-Fi and cell data without holding the GPS chip on.
        continuous.desiredAccuracy =
            accuracy == .high ? kCLLocationAccuracyBest : kCLLocationAccuracyHundredMeters
        // No distance filter: a phone that is sitting still must keep producing fixes, because
        // stays are built from exactly those. CaptureEngine thins the stream.
        continuous.distanceFilter = kCLDistanceFilterNone
        // iOS pauses updates when it thinks the user stopped moving: the dwell we are here for.
        continuous.pausesLocationUpdatesAutomatically = false
        continuous.activityType = .other
        // Setting this without UIBackgroundModes=location in the app's Info.plist raises an
        // exception. Without it capture runs only while the app is on screen.
        if Self.appDeclaresLocationBackgroundMode {
            continuous.allowsBackgroundLocationUpdates = true
        }
        continuous.startUpdatingLocation()
    }

    func stopContinuous() {
        continuous.stopUpdatingLocation()
    }

    func startSignificantChanges() {
        significant.startMonitoringSignificantLocationChanges()
    }

    func stopSignificantChanges() {
        significant.stopMonitoringSignificantLocationChanges()
    }

    func startVisits() {
        monitor.startMonitoringVisits()
    }

    func stopVisits() {
        monitor.stopMonitoringVisits()
    }

    func monitorExit(from center: Coordinate, radiusM: Double) {
        let region = CLCircularRegion(
            center: CLLocationCoordinate2D(latitude: center.lat, longitude: center.lon),
            radius: min(radiusM, monitor.maximumRegionMonitoringDistance),
            identifier: Self.regionIdentifier)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        // A region with the identifier of one already monitored replaces it.
        monitor.startMonitoring(for: region)
    }

    func stopMonitoringExit() {
        for region in monitor.monitoredRegions where region.identifier == Self.regionIdentifier {
            monitor.stopMonitoring(for: region)
        }
    }

    static var appDeclaresLocationBackgroundMode: Bool {
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String]
        return modes?.contains("location") ?? false
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // All three managers report the same change. One is forwarded.
        guard manager === continuous else { return }
        refreshServicesEnabled()
        events?.locationAuthorizationChanged()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let origin: FixOrigin
        if manager === continuous {
            origin = .continuous
        } else if manager === significant {
            origin = .significantChange
        } else {
            return
        }
        // Usually one. After the app was suspended iOS can hand over several, oldest first.
        for location in locations {
            let fix = Fix(
                coordinate: Coordinate(
                    lat: location.coordinate.latitude, lon: location.coordinate.longitude),
                tsUtc: Int64(location.timestamp.timeIntervalSince1970.rounded(.down)),
                accuracyM: location.horizontalAccuracy)
            events?.locationDelivered(fix, from: origin)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard manager !== monitor else { return }
        let code = (error as NSError).code
        let failure: LocationFailure =
            code == CLError.Code.denied.rawValue ? .denied : .other(code: code)
        events?.locationFailed(failure, from: manager === significant ? .significantChange : .continuous)
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard manager === monitor else { return }
        // iOS uses distantPast for "arrival not seen" and distantFuture for "has not left".
        let arrival = visit.arrivalDate == .distantPast ? nil : Self.seconds(visit.arrivalDate)
        let departure = visit.departureDate == .distantFuture ? nil : Self.seconds(visit.departureDate)
        events?.visitReported(
            Visit(
                coordinate: Coordinate(lat: visit.coordinate.latitude, lon: visit.coordinate.longitude),
                accuracyM: visit.horizontalAccuracy, arrivalTsUtc: arrival, departureTsUtc: departure))
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        // Monitored regions are shared by every manager in the app; take the event once.
        guard manager === monitor, region.identifier == Self.regionIdentifier else { return }
        events?.exitedMonitoredRegion()
    }

    private static func seconds(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970.rounded(.down))
    }
}
