import Foundation

/// What the module remembers across process deaths, so that a relaunch by iOS restarts the same
/// capture with no JavaScript running. It holds times and settings and never a coordinate: the
/// file is outside the encrypted store.
struct PersistedState: Codable, Equatable {
    /// A stretch of time in which capture was selected. `to` is nil while it still is.
    struct Period: Codable, Equatable {
        var from: Int64
        var to: Int64?
    }

    /// One CLVisit, by its two times.
    struct VisitTimes: Codable, Equatable {
        var arrivalTsUtc: Int64
        var departureTsUtc: Int64
    }

    /// The config of the last `start`, or nil when stopped. This is "the selection" of the spec.
    var selection: CaptureConfig?
    /// Kept after `stop`: `expectedLast24h` still counts the part of the day that was selected.
    var intervalSec: Double?
    var selectedPeriods: [Period] = []

    /// Fix times of the samples stored in the last 24 hours, for `samplesLast24h`.
    var sampleTimestamps: [Int64] = []
    /// Newest fix time ever stored.
    var lastSampleTsUtc: Int64?
    /// Fix time of the sample stored most recently, which the interval rule measures from.
    var lastWrittenTsUtc: Int64?

    /// Arrival time of the visit whose 'visit' stay row is still open.
    var openVisitArrivalTsUtc: Int64?
    /// The visit closed most recently. iOS can report a visit twice across a relaunch.
    var lastClosedVisit: VisitTimes?

    /// iOS shows the Always prompt once per install. After that only Settings can grant it.
    var alwaysPromptShown = false
    var lastAuthorization: String?
    var lastPreciseLocation: Bool?
    var lastBootTimeSec: Double?

    init() {}

    /// Every field is read as optional, so a file written by an older build (one without a
    /// field added later) still decodes. Failing here would forget the selection and silently
    /// stop capture after an app update.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        selection = try values.decodeIfPresent(CaptureConfig.self, forKey: .selection)
        intervalSec = try values.decodeIfPresent(Double.self, forKey: .intervalSec)
        selectedPeriods = try values.decodeIfPresent([Period].self, forKey: .selectedPeriods) ?? []
        sampleTimestamps = try values.decodeIfPresent([Int64].self, forKey: .sampleTimestamps) ?? []
        lastSampleTsUtc = try values.decodeIfPresent(Int64.self, forKey: .lastSampleTsUtc)
        lastWrittenTsUtc = try values.decodeIfPresent(Int64.self, forKey: .lastWrittenTsUtc)
        openVisitArrivalTsUtc = try values.decodeIfPresent(Int64.self, forKey: .openVisitArrivalTsUtc)
        lastClosedVisit = try values.decodeIfPresent(VisitTimes.self, forKey: .lastClosedVisit)
        alwaysPromptShown = try values.decodeIfPresent(Bool.self, forKey: .alwaysPromptShown) ?? false
        lastAuthorization = try values.decodeIfPresent(String.self, forKey: .lastAuthorization)
        lastPreciseLocation = try values.decodeIfPresent(Bool.self, forKey: .lastPreciseLocation)
        lastBootTimeSec = try values.decodeIfPresent(Double.self, forKey: .lastBootTimeSec)
    }
}

/// PersistedState as one JSON file, replaced atomically on every save.
final class FileStateStorage: StateStorage {
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    func load() throws -> PersistedState? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            // The file is there and iOS will not hand it over: data protection, before the
            // first unlock. Treating this as "nothing saved" would forget the selection.
            throw StateStorageError.unreadable("\(error)")
        }
        do {
            return try JSONDecoder().decode(PersistedState.self, from: data)
        } catch {
            throw StateStorageError.corrupt("\(error)")
        }
    }

    func save(_ state: PersistedState) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: .atomic)
    }
}
