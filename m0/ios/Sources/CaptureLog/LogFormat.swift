import Foundation

// Implements "M0 capture log format v1" (m0/docs/log-format.md). Foundation only, so it
// is unit-testable on macOS. There is deliberately NO field anywhere in this file that
// could hold a coordinate, altitude, speed or address: the log cannot contain position.

public enum LogFormat {
    public static let magicLine = "#fmp-capture-log,1"
    public static let header = "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event"
    /// iOS runs all three capture sources at once, so there is only one mode.
    public static let mode = "ios_all"

    /// The format is unquoted CSV, so no field may contain a comma or a line break.
    public static func sanitize(_ text: String) -> String {
        String(text.map { $0 == "," || $0 == "\n" || $0 == "\r" ? "_" : $0 })
    }

    public static func deviceLine(label: String, model: String, os: String,
                                  appBuild: String, utcOffsetMin: Int) -> String {
        "#device,label=\(sanitize(label)),platform=ios,model=\(sanitize(model)),os=\(sanitize(os)),"
            + "app_build=\(sanitize(appBuild)),utc_offset_min=\(utcOffsetMin)"
    }

    /// A complete export file: three header lines, then the stored rows verbatim.
    public static func exportText(deviceLine: String, rows: String) -> String {
        magicLine + "\n" + deviceLine + "\n" + header + "\n" + rows
    }

    public static func epochMs(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    /// `permission` column: denied|when_in_use|always, plus `_approx` for reduced accuracy.
    /// "Not asked yet" and "restricted" are both reported as `denied` (no capture possible).
    public static func permission(_ level: PermissionLevel, approx: Bool) -> String {
        if level == .denied { return level.rawValue }
        return approx ? level.rawValue + "_approx" : level.rawValue
    }
}

public enum PermissionLevel: String {
    case denied
    case whenInUse = "when_in_use"
    case always
}

/// iOS capture sources. `none` = an attempt that produced no usable fix.
public enum Source: String {
    case continuous
    case slc
    case visitArrival = "visit_arrival"
    case visitDeparture = "visit_departure"
    case none
}

public struct SampleRow: Equatable {
    public var ranAtMs: Int64
    public var fixAtMs: Int64?
    public var accuracyM: Double?
    public var source: Source
    public var batteryPct: Int?
    public var charging: Bool
    public var powerSave: Bool
    public var permission: String

    public init(ranAtMs: Int64, fixAtMs: Int64?, accuracyM: Double?, source: Source,
                batteryPct: Int?, charging: Bool, powerSave: Bool, permission: String) {
        self.ranAtMs = ranAtMs; self.fixAtMs = fixAtMs; self.accuracyM = accuracyM
        self.source = source; self.batteryPct = batteryPct; self.charging = charging
        self.powerSave = powerSave; self.permission = permission
    }
}

public enum LogRow: Equatable {
    case sample(SampleRow)
    case event(ranAtMs: Int64, name: String)

    /// One CSV line WITHOUT the trailing newline. Always exactly 11 columns.
    public var csv: String {
        switch self {
        case .sample(let s):
            let cols: [String] = [
                "S",
                String(s.ranAtMs),
                s.fixAtMs.map { String($0) } ?? "",
                s.accuracyM.map { String(format: "%.1f", $0) } ?? "",
                s.source.rawValue,
                s.batteryPct.map { String(min(100, max(0, $0))) } ?? "",
                s.charging ? "1" : "0",
                s.powerSave ? "1" : "0",
                LogFormat.sanitize(s.permission),
                LogFormat.mode,
                "",
            ]
            return cols.joined(separator: ",")
        case .event(let ranAtMs, let name):
            // Sample-only columns stay empty for event rows.
            let cols: [String] = ["E", String(ranAtMs), "", "", "", "", "", "", "", "", LogFormat.sanitize(name)]
            return cols.joined(separator: ",")
        }
    }
}
