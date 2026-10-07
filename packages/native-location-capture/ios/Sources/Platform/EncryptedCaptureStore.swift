import Foundation
import FindMyPersonEncryptedStore

/// Thin port adapters. The encrypted-store package owns every key, path and live connection.
/// In particular, delete-all closes this writer before removing the file and rotating its key.
final class EncryptedStoreKeySource: StoreKeySource {
    private let store: EncryptedStore
    init(store: EncryptedStore = .shared) { self.store = store }
    func getOrCreateKeyHex() throws -> String { try store.keyHex() }
}

final class EncryptedCaptureStore: CaptureStore {
    private let store: EncryptedStore

    init(store: EncryptedStore = .shared) { self.store = store }

    private func checked<T>(_ work: () throws -> T) throws -> T {
        do { return try work() }
        catch let error as StoreError {
            throw StoreFailure(step: error.code.rawValue.lowercased(), message: error.message)
        }
    }

    func check() throws { try checked { try store.check() } }

    func insertSample(_ row: SampleRow) throws {
        try checked {
            _ = try store.insertLocationSample(LocationSampleRow(
                tsUtc: row.tsUtc, lat: row.coordinate.lat, lon: row.coordinate.lon,
                accuracyM: row.accuracyM, source: row.source, h3R7: row.h3r7, h3R5: row.h3r5))
        }
    }

    func insertVisitStay(_ row: VisitStayRow) throws {
        try checked {
            _ = try store.insertVisitStay(FindMyPersonEncryptedStore.VisitStayRow(
                startTs: row.startTs, endTs: row.endTs,
                lat: row.coordinate.lat, lon: row.coordinate.lon, radiusM: row.radiusM,
                h3R7: row.h3r7, closed: row.closed))
        }
    }

    func closeVisitStay(endTs: Int64, startTs: Int64) throws -> Bool {
        try checked { try store.closeVisitStay(startTs: startTs, endTs: endTs) }
    }

    func purgeExpired(nowTsUtc: Int64) throws -> PurgeCounts {
        try checked {
            let counts = try store.purgeExpired(nowTsUtc: nowTsUtc)
            return PurgeCounts(samples: counts.samples, stays: counts.stays,
                               staysTrimmed: counts.staysTrimmed)
        }
    }
}
