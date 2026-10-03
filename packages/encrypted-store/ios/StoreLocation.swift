import Foundation

/// Where the store lives on iOS (plan 4.5): `<Application Support>/findmyperson-store`, a directory
/// that holds nothing but the store and is excluded from backup.
///
/// iOS backs up the whole app container to iCloud and to a computer, except Library/Caches,
/// tmp and anything flagged isExcludedFromBackup. Caches and tmp are outside backups by
/// location, but the system may empty them when storage runs low, and 30 days of history must
/// not vanish that way. So the store is in Application Support and its directory carries the
/// exclusion flag. Flagging the directory, not the file, covers the -wal and -shm files that
/// SQLite recreates and the database file that "delete all data" recreates.
///
/// The flag is not assumed: `prepare` sets it, reads it back, and throws if it is not set, and
/// every open goes through `prepare`. A store that would be backed up is never opened.
///
/// Never Documents (visible in Files and iTunes file sharing), never an app-group container.
/// src/policy.test.ts fails if this file names any other base directory.
struct StoreLocation {
    let directory: URL

    /// `applicationSupport` is the app's Application Support directory.
    init(applicationSupport: URL) {
        directory = applicationSupport.appendingPathComponent(StoreContract.storeDirectoryName, isDirectory: true)
    }

    static func standard() throws -> StoreLocation {
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw StoreError(.openFailed, "the app has no Application Support directory")
        }
        return StoreLocation(applicationSupport: base)
    }

    var database: URL { directory.appendingPathComponent(StoreContract.storeFileName, isDirectory: false) }

    /// The database with its -wal and -shm files: everything "delete all data" must remove.
    var databaseFiles: [URL] {
        StoreContract.storeFileSuffixes.map { URL(fileURLWithPath: database.path + $0) }
    }

    /// Creates the directory if absent, excludes it from backup and checks that it is.
    func prepare() throws {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw StoreError(.openFailed, "could not create the store directory: \(error.localizedDescription)")
        }
        #if os(iOS)
        // Readable while locked once the phone has been unlocked after boot, like the key.
        // Files created in the directory inherit the class.
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
        #endif
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try url.setResourceValues(values)
        } catch {
            throw StoreError(.backupNotExcluded, "could not exclude the store directory from backup: \(error.localizedDescription)")
        }
        try requireExcludedFromBackup()
    }

    /// Throws unless the directory exists and carries the backup-exclusion flag right now.
    func requireExcludedFromBackup() throws {
        // A fresh URL: resource values are cached on the URL they were read through.
        let fresh = URL(fileURLWithPath: directory.path, isDirectory: true)
        let excluded = (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]))?.isExcludedFromBackup
        guard excluded == true else {
            throw StoreError(.backupNotExcluded, "the store directory is not excluded from backup")
        }
    }
}
