import Foundation

/// Every failure of the native store. Never swallowed: a caller either gets a working store or
/// this, and the capture module turns it into the `store_unusable` health flag.
///
/// The first four codes are the ones TypeScript's StoreError uses for the same condition.
public struct StoreError: Error, CustomStringConvertible {
    public enum Code: String {
        case notSqlcipher = "NOT_SQLCIPHER"
        case paramMismatch = "PARAM_MISMATCH"
        case badKeyOrParams = "BAD_KEY_OR_PARAMS"
        case openFailed = "OPEN_FAILED"
        /// The schema is not the version this build writes. TypeScript has not migrated yet, or is newer.
        case schemaMismatch = "SCHEMA_MISMATCH"
        /// The key exists but cannot be read. Never answered by making a new key.
        case keyUnavailable = "KEY_UNAVAILABLE"
        /// The store directory is not excluded from backup, so the store refuses to exist.
        case backupNotExcluded = "BACKUP_NOT_EXCLUDED"
        /// "Delete all data" could not remove a file or the key.
        case deleteFailed = "DELETE_FAILED"
        case invalidKey = "INVALID_KEY"
    }

    public let code: Code
    public let message: String

    public init(_ code: Code, _ message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code.rawValue): \(message)" }
}
