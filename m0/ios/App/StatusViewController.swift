import UIKit

/// The one and only screen: status, permission button, Export button, last 20 log rows.
final class StatusViewController: UIViewController {
    private let banner = UILabel()
    private let status = UILabel()
    private let permissionButton = UIButton(type: .system)
    private let exportButton = UIButton(type: .system)
    private let tailLabel = UILabel()
    private var timer: Timer?

    private let controller = CaptureController.shared
    private let recorder = Recorder.shared

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let title = UILabel()
        title.text = "FMP M0 - iPhone capture trial"
        title.font = .preferredFont(forTextStyle: .headline)

        banner.numberOfLines = 0
        banner.font = .boldSystemFont(ofSize: 15)

        status.numberOfLines = 0
        status.font = .monospacedSystemFont(ofSize: 13, weight: .regular)

        permissionButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        permissionButton.titleLabel?.numberOfLines = 0
        permissionButton.titleLabel?.textAlignment = .center
        permissionButton.addTarget(self, action: #selector(permissionTapped), for: .touchUpInside)

        exportButton.setTitle("Export log (share sheet)", for: .normal)
        exportButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        exportButton.addTarget(self, action: #selector(exportTapped), for: .touchUpInside)

        let tailTitle = UILabel()
        tailTitle.text = "Last 20 log rows:"
        tailTitle.font = .preferredFont(forTextStyle: .subheadline)

        tailLabel.numberOfLines = 0
        tailLabel.font = .monospacedSystemFont(ofSize: 9, weight: .regular)

        let stack = UIStackView(arrangedSubviews: [title, banner, status, permissionButton, exportButton, tailTitle, tailLabel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
        ])

        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(refresh), name: Recorder.didChange, object: nil)
        nc.addObserver(self, selector: #selector(refresh), name: CaptureController.didChange, object: nil)
        nc.addObserver(self, selector: #selector(refresh), name: .NSProcessInfoPowerStateDidChange, object: nil)
        nc.addObserver(self, selector: #selector(refresh), name: UIDevice.batteryLevelDidChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(refresh), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(refresh), name: UIApplication.backgroundRefreshStatusDidChangeNotification, object: nil)
        refresh()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        timer?.invalidate()
    }

    // MARK: rendering

    @objc private func refresh() {
        let now = Date()
        let clock = DateFormatter()
        clock.dateFormat = "MMM d HH:mm:ss"

        func ago(_ ms: Int64?) -> String {
            guard let ms = ms else { return "never" }
            let d = Date(timeIntervalSince1970: Double(ms) / 1000)
            let mins = Int(now.timeIntervalSince(d) / 60)
            return "\(clock.string(from: d)) (\(mins) min ago)"
        }
        func onOff(_ b: Bool) -> String { b ? "ACTIVE" : "off" }

        let dev = UIDevice.current
        let battery = dev.batteryLevel >= 0 ? "\(Int((dev.batteryLevel * 100).rounded()))%" : "unknown"
        let plug = (dev.batteryState == .charging || dev.batteryState == .full) ? "charging" : "not charging"
        let bar: String
        switch UIApplication.shared.backgroundRefreshStatus {
        case .available: bar = "on"
        case .denied: bar = "OFF (iOS will not relaunch the app after it is killed)"
        case .restricted: bar = "RESTRICTED by system"
        @unknown default: bar = "unknown"
        }

        var lines: [String] = []
        lines.append("Permission:  \(controller.statusDescription)")
        lines.append("Continuous:  \(onOff(controller.continuousActive))")
        lines.append("Sig-change:  \(onOff(controller.slcActive))")
        lines.append("Visits:      \(onOff(controller.visitsActive))")
        lines.append("Rows:        \(recorder.writer.rowCount())" +
                     (recorder.writer.failedWrites > 0 ? " (write failures: \(recorder.writer.failedWrites), queued: \(recorder.writer.pendingCount))" : ""))
        lines.append("Last row:    \(ago(Prefs.lastRowMs))")
        lines.append("Last fix:    \(ago(Prefs.lastFixMs))")
        lines.append("Low Power:   \(ProcessInfo.processInfo.isLowPowerModeEnabled ? "ON" : "off")")
        lines.append("BG refresh:  \(bar)")
        lines.append("Battery:     \(battery), \(plug)")
        status.text = lines.joined(separator: "\n")

        renderTrialBanner(now: now)
        renderPermissionButton()
        tailLabel.text = recorder.writer.tail(20).reversed().joined(separator: "\n")
    }

    /// Free Apple ID builds stop launching 7 days after install. Install day = first launch.
    private func renderTrialBanner(now: Date) {
        let firstMs = Prefs.firstLaunchMs ?? Recorder.nowMs()
        let first = Date(timeIntervalSince1970: Double(firstMs) / 1000)
        let expiry = first.addingTimeInterval(7 * 86400)
        let day = Int(now.timeIntervalSince(first) / 86400) + 1          // day 1 = install day
        let left = expiry.timeIntervalSince(now)
        let leftText: String
        if left <= 0 { leftText = "EXPIRED (assumed)" }
        else { leftText = "\(Int(left / 86400)) d \(Int(left.truncatingRemainder(dividingBy: 86400) / 3600)) h" }
        var text = "Trial day \(day) of 6. Free provisioning expires in \(leftText) (assumed: first launch + 7 days)."
        if day >= 5 {
            text += "\nEXPORT THE LOG NOW: tap Export on day 6 at the latest, before the app stops opening."
            banner.textColor = .systemRed
        } else {
            text += "\nExport the log on day 6."
            banner.textColor = .label
        }
        banner.text = text
    }

    private func renderPermissionButton() {
        let (text, enabled): (String, Bool)
        switch controller.nextStep {
        case .requestWhenInUse: (text, enabled) = ("Step 1 of 2: enable location", true)
        case .requestAlways: (text, enabled) = ("Step 2 of 2: allow location Always", true)
        case .openSettingsForAlways: (text, enabled) = ("Open Settings to choose \"Always\"", true)
        case .openSettingsAfterDenial: (text, enabled) = ("Location is off: open Settings", true)
        case .openSettingsForPrecise: (text, enabled) = ("Approximate location only: open Settings, turn Precise Location on", true)
        case .done: (text, enabled) = ("Permissions complete (Always, precise)", false)
        }
        permissionButton.setTitle(text, for: .normal)
        permissionButton.isEnabled = enabled
    }

    // MARK: actions

    @objc private func permissionTapped() {
        switch controller.nextStep {
        case .requestWhenInUse:
            explain("Step 1 of 2: location while the app is open",
                    "This trial measures how reliably an iPhone can record where it has been, in the background. "
                    + "First iOS asks for location while you use the app. Only the time and accuracy of each fix are "
                    + "logged; coordinates are never stored or sent anywhere.",
                    "Continue to iOS prompt") { self.controller.requestWhenInUse() }
        case .requestAlways:
            explain("Step 2 of 2: keep location on in the background",
                    "Background capture only works if you allow \"Always\". iOS will ask once more; choose "
                    + "\"Change to Always Allow\". If you choose \"Keep Only While Using\" the trial can still run, "
                    + "but will stop soon after the app leaves the screen and will not restart after a force-quit.",
                    "Continue to iOS prompt") { self.controller.requestAlways() }
        case .openSettingsForAlways:
            explain("Choose \"Always\" in Settings",
                    "iOS asks for \"Always\" only once, so the change has to be made in Settings: "
                    + "Location > Always. Come back to this app afterwards.",
                    "Open Settings") { self.controller.openSettings(reason: "always") }
        case .openSettingsAfterDenial:
            explain("Location is turned off for this app",
                    "Turn on Location in Settings (While Using or Always) so the trial can record anything.",
                    "Open Settings") { self.controller.openSettings(reason: "denied") }
        case .openSettingsForPrecise:
            explain("Precise Location is off",
                    "With Approximate location iOS reports fixes 1 to 20 km wide, which is useless for this test. "
                    + "In Settings > Location, turn Precise Location on.",
                    "Open Settings") { self.controller.openSettings(reason: "precise") }
        case .done:
            break
        }
    }

    private func explain(_ title: String, _ body: String, _ go: String, then: @escaping () -> Void) {
        present(ExplainerViewController(title: title, body: body, continueTitle: go, onContinue: then), animated: true)
    }

    @objc private func exportTapped() {
        recorder.event("export_tapped")
        guard let url = recorder.makeExportFile() else {
            banner.text = "Export failed: could not write the temporary export file."
            return
        }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = exportButton
        present(share, animated: true)
    }
}
