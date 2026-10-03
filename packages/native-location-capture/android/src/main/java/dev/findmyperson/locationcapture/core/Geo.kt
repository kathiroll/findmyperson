package dev.findmyperson.locationcapture.core

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A location fix as the platform delivered it. This and [StoredSample] are the only types in the
 * module that hold a coordinate, and a coordinate leaves them in exactly one direction: into the
 * encrypted store.
 *
 * Deliberately not a data class: the generated `toString` would print the coordinates, and one
 * stray log line would then put a location in logcat.
 */
class Fix(
    val lat: Double,
    val lon: Double,
    /** Time of the fix, Unix seconds. */
    val tsUtc: Long,
    /** Metres, or null when the platform reported none. A fix without it is not stored. */
    val accuracyM: Double?,
) {
    override fun toString(): String = "Fix(tsUtc=$tsUtc, accuracyM=$accuracyM, position redacted)"
}

/** A `location_sample` row about to be written. Parameter order of the insert is in the store. */
class StoredSample(
    val tsUtc: Long,
    val lat: Double,
    val lon: Double,
    val accuracyM: Double,
    /** One of `sampleSources` in packages/shared/contracts/native-writer.json. */
    val source: String,
    /** Res-7 cell of (lat, lon). */
    val h3R7: String,
    /** Res-5 PARENT of [h3R7], not the res-5 cell containing the point. */
    val h3R5: String,
) {
    override fun toString(): String = "StoredSample(tsUtc=$tsUtc, source=$source, position redacted)"
}

object Geo {
    /** Mean Earth radius in metres: EARTH_RADIUS_M of packages/shared/src/geo/distance.ts. */
    const val EARTH_RADIUS_M = 6_371_008.8

    private fun toRadians(degrees: Double): Double = degrees * Math.PI / 180

    /**
     * Great-circle distance in metres. The same sequence of operations as `haversineMeters` in
     * packages/shared/src/geo/distance.ts; GeoTest checks it against contracts/geo-vectors.json.
     */
    fun haversineMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val phi1 = toRadians(lat1)
        val phi2 = toRadians(lat2)
        val sinHalfDPhi = sin((phi2 - phi1) / 2)
        val sinHalfDLambda = sin(toRadians(lon2 - lon1) / 2)
        val h = sinHalfDPhi * sinHalfDPhi + cos(phi1) * cos(phi2) * sinHalfDLambda * sinHalfDLambda
        // Rounding can push h a hair above 1 for antipodal points; clamp so asin stays defined.
        return 2 * EARTH_RADIUS_M * asin(sqrt(min(1.0, h)))
    }

    fun isValidLatLon(lat: Double, lon: Double): Boolean =
        lat.isFinite() && lon.isFinite() && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}
