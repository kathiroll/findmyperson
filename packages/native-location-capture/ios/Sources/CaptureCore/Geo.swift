import Foundation

#if SWIFT_PACKAGE
import CH3
#endif

/// The geometry the store's rows need, matching packages/shared/src/geo. GeoVectorTests runs
/// both functions over packages/shared/contracts/geo-vectors.json.
enum Geo {
    /// Resolution of every `h3_r7` column (H3_RES_MATCH in packages/shared/src/constants.ts).
    static let matchResolution: Int32 = 7
    /// Resolution of `h3_r5` (H3_RES_SHARD).
    static let shardResolution: Int32 = 5

    static func isValid(_ point: Coordinate) -> Bool {
        point.lat.isFinite && point.lon.isFinite
            && point.lat >= -90 && point.lat <= 90
            && point.lon >= -180 && point.lon <= 180
    }

    /// Great-circle distance in metres: the same operations, in the same order, as
    /// haversineMeters in packages/shared/src/geo/distance.ts.
    static func haversineMeters(_ a: Coordinate, _ b: Coordinate) -> Double {
        let phi1 = radians(a.lat)
        let phi2 = radians(b.lat)
        let sinHalfDPhi = sin((phi2 - phi1) / 2)
        let sinHalfDLambda = sin(radians(b.lon - a.lon) / 2)
        let h = sinHalfDPhi * sinHalfDPhi + cos(phi1) * cos(phi2) * sinHalfDLambda * sinHalfDLambda
        return 2 * GeoContract.earthRadiusM * asin(sqrt(min(1, h)))
    }

    /// The res-7 cell containing a point, as the 15-character lowercase hex id.
    static func matchCell(_ point: Coordinate) -> String? {
        guard isValid(point) else { return nil }
        // Same expression as h3-js's degsToRads, so both sides hand H3 the same radians.
        var latLng = LatLng(lat: radians(point.lat), lng: radians(point.lon))
        var cell: H3Index = 0
        guard latLngToCell(&latLng, matchResolution, &cell) == 0 else { return nil }
        return String(cell, radix: 16)
    }

    /// The two cell columns of a `location_sample` row. `h3r5` is the res-5 PARENT of the res-7
    /// cell, not the res-5 cell containing the point: the two differ near shard edges
    /// (sampleCells in packages/shared/src/geo/h3.ts).
    static func sampleCells(_ point: Coordinate) -> (h3r7: String, h3r5: String)? {
        guard let h3r7 = matchCell(point), let cell = UInt64(h3r7, radix: 16) else { return nil }
        var parent: H3Index = 0
        guard cellToParent(cell, shardResolution, &parent) == 0 else { return nil }
        return (h3r7, String(parent, radix: 16))
    }

    private static func radians(_ degrees: Double) -> Double {
        (degrees * Double.pi) / 180
    }
}
