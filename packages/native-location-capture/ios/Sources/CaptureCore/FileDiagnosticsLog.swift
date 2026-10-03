import Foundation

/// The local capture-health log: one JSON object per line, appended. It stays on the phone.
///
/// A background launch before the first unlock cannot write the file. Entries that fail to
/// write are held in memory and written with the next entry that succeeds, as the M0 trial app
/// did with its rows; they are lost if the process dies first.
final class FileDiagnosticsLog: DiagnosticsLog {
    /// The file is cut back to this many entries once it holds twice as many.
    static let keptEntries = 2000

    private let url: URL
    private var unwritten: [DiagnosticEntry] = []
    private var appendsSinceTrim = 0

    init(url: URL) {
        self.url = url
    }

    func append(_ entry: DiagnosticEntry) {
        unwritten.append(entry)
        guard write(lines(unwritten), append: true) else {
            // Bounded, so a phone that stays locked for days cannot grow this without limit.
            unwritten = Array(unwritten.suffix(Self.keptEntries))
            return
        }
        appendsSinceTrim += unwritten.count
        unwritten.removeAll()
        if appendsSinceTrim >= Self.keptEntries {
            trim()
        }
    }

    func entries(since sinceTsUtc: Int64) -> [DiagnosticEntry] {
        (stored() + unwritten).filter { $0.tsUtc >= sinceTsUtc }
    }

    private func stored() -> [DiagnosticEntry] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        // A line cut short by a crash mid-append is skipped, not fatal.
        return data.split(separator: UInt8(ascii: "\n")).compactMap {
            try? decoder.decode(DiagnosticEntry.self, from: Data($0))
        }
    }

    private func trim() {
        appendsSinceTrim = 0
        let all = stored()
        guard all.count >= Self.keptEntries * 2 else { return }
        _ = write(lines(Array(all.suffix(Self.keptEntries))), append: false)
    }

    private func lines(_ entries: [DiagnosticEntry]) -> Data {
        let encoder = JSONEncoder()
        var data = Data()
        for entry in entries {
            guard let line = try? encoder.encode(entry) else { continue }
            data.append(line)
            data.append(UInt8(ascii: "\n"))
        }
        return data
    }

    private func write(_ data: Data, append: Bool) -> Bool {
        do {
            let manager = FileManager.default
            try manager.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !append || !manager.fileExists(atPath: url.path) {
                try data.write(to: url, options: .atomic)
                return true
            }
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            return true
        } catch {
            return false
        }
    }
}
