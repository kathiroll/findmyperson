import UIKit

/// Builds log rows (battery, Low Power Mode etc. filled in at the moment of the callback) and
/// writes them with the CaptureLog writer. Never receives a coordinate: the only inputs are a
/// fix TIMESTAMP and a horizontal ACCURACY in metres.
final class Recorder {
    static let shared = Recorder()
    static let didChange = Notification.Name("fmp.log.changed")

    let writer: LogFileWriter

    private init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        writer = LogFileWriter(url: docs.appendingPathComponent("capture-rows.csv"))
    }

    static func nowMs() -> Int64 { LogFormat.epochMs(Date()) }

    func event(_ name: String) {
        let now = Recorder.nowMs()
        writer.append(.event(ranAtMs: now, name: name))
        noteWritten(now)
    }

    func sample(source: Source, fixAt: Date?, accuracyM: Double?, permission: String) {
        let now = Recorder.nowMs()
        let device = UIDevice.current
        // batteryLevel is -1 when unknown; we log that as an empty cell.
        let pct: Int? = device.batteryLevel >= 0 ? Int((device.batteryLevel * 100).rounded()) : nil
        let charging = device.batteryState == .charging || device.batteryState == .full
        let row = SampleRow(ranAtMs: now,
                            fixAtMs: fixAt.map(LogFormat.epochMs),
                            accuracyM: accuracyM,
                            source: source,
                            batteryPct: pct,
                            charging: charging,
                            powerSave: ProcessInfo.processInfo.isLowPowerModeEnabled,
                            permission: permission)
        writer.append(.sample(row))
        noteWritten(now)
        if let fixAt = fixAt { Prefs.lastFixMs = LogFormat.epochMs(fixAt) }
    }

    private func noteWritten(_ nowMs: Int64) {
        Prefs.lastRowMs = nowMs
        NotificationCenter.default.post(name: Recorder.didChange, object: nil)
    }

    // MARK: export

    /// Writes header lines + all rows to a temp file and returns it for the share sheet.
    func makeExportFile() -> URL? {
        let device = UIDevice.current
        var sys = utsname(); uname(&sys)
        let model = withUnsafeBytes(of: &sys.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        let offsetMin = TimeZone.current.secondsFromGMT() / 60
        // Label defaults to the model name. We do not use device.name: it usually contains the owner's name.
        let deviceLine = LogFormat.deviceLine(label: device.model, model: model, os: device.systemVersion,
                                              appBuild: build, utcOffsetMin: offsetMin)
        let text = LogFormat.exportText(deviceLine: deviceLine, rows: writer.rowsText())

        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd-HHmm"
        let dir = FileManager.default.temporaryDirectory
        if let old = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
            for u in old where u.lastPathComponent.hasPrefix("fmp-capture-ios-") { try? FileManager.default.removeItem(at: u) }
        }
        let url = dir.appendingPathComponent("fmp-capture-ios-\(LogFormat.sanitize(model))-\(f.string(from: Date())).csv")
        do { try text.write(to: url, atomically: true, encoding: .utf8); return url } catch { return nil }
    }
}
