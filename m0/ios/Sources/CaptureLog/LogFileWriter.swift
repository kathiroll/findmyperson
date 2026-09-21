import Foundation

/// Append-only row store. Each append opens the file, writes one line, closes it: nothing is
/// held open, so a background relaunch (or a kill mid-way) cannot corrupt earlier rows.
///
/// Data protection: rows are written with NSFileProtectionCompleteUntilFirstUserAuthentication.
/// The iOS default for app files is the same class, but we set it explicitly because it is the
/// load-bearing choice: after a reboot the phone is locked until the first unlock, and a
/// stricter class (CompleteProtection) would make every background write fail while the
/// phone is locked in a pocket. Before the very first unlock after boot even this class
/// cannot be written, so failed rows wait in memory and are flushed on the next append.
///
/// The file is also excluded from iCloud/iTunes backup: the log must stay on the phone.
public final class LogFileWriter {
    public let url: URL
    private let lock = NSLock()
    private var pending: [String] = []
    private let maxPending = 500
    public private(set) var failedWrites = 0

    public init(url: URL) {
        self.url = url
    }

    /// Returns true if the row is on disk, false if it is queued in memory for a retry.
    @discardableResult
    public func append(_ row: LogRow) -> Bool {
        lock.lock(); defer { lock.unlock() }
        pending.append(row.csv + "\n")
        if pending.count > maxPending { pending.removeFirst(pending.count - maxPending) }
        while let next = pending.first {
            do { try appendLocked(next) } catch {
                failedWrites += 1
                return false
            }
            pending.removeFirst()
        }
        return true
    }

    public var pendingCount: Int { lock.lock(); defer { lock.unlock() }; return pending.count }

    private func appendLocked(_ text: String) throws {
        let data = Data(text.utf8)
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            var attrs: [FileAttributeKey: Any] = [:]
            #if os(iOS)
            attrs[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
            #endif
            guard fm.createFile(atPath: url.path, contents: data, attributes: attrs) else {
                throw CocoaError(.fileWriteUnknown)
            }
            var u = url
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? u.setResourceValues(values)
            return
        }
        let handle = try FileHandle(forWritingTo: url)
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            try? handle.close()
            throw error
        }
    }

    // MARK: reading (status screen and export)

    public func allLines() -> [String] {
        lock.lock(); defer { lock.unlock() }
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    }

    public func rowCount() -> Int { allLines().count }

    public func tail(_ n: Int) -> [String] { Array(allLines().suffix(n)) }

    /// The raw stored rows (no header lines) exactly as written.
    public func rowsText() -> String {
        lock.lock(); defer { lock.unlock() }
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }
}
