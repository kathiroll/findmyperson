package dev.findmyperson.locationcapture.core

import com.uber.h3core.H3Core
import dev.findmyperson.locationcapture.Contracts
import dev.findmyperson.locationcapture.Contracts.objects
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * The geometry this module shares with TypeScript and Swift: packages/shared/contracts/
 * geo-vectors.json must be reproduced, cells exactly and distances within its tolerance.
 *
 * The cells come from a Kotlin port of H3 (core/H3.kt), so beyond the golden vectors the port
 * is compared with the reference library itself (h3-java, a test-only dependency) on random
 * points and on the awkward parts of the grid.
 */
class GeoContractTest {
    private val vectors = Contracts.json(Contracts.shared("geo-vectors.json"))
    private val reference: H3Core = H3Core.newInstance()

    @Test
    fun `haversine matches the golden distances`() {
        assertEquals(vectors.getDouble("earth_radius_m"), Geo.EARTH_RADIUS_M, 0.0)
        val tolerance = vectors.getDouble("distance_tolerance_m")
        val distances = vectors.getJSONArray("distances").objects()
        assertTrue(distances.isNotEmpty())
        for (vector in distances) {
            val from = vector.getJSONObject("from")
            val to = vector.getJSONObject("to")
            val meters = Geo.haversineMeters(
                from.getDouble("lat"), from.getDouble("lon"), to.getDouble("lat"), to.getDouble("lon"),
            )
            assertEquals(vector.getString("name"), vector.getDouble("meters"), meters, tolerance)
        }
    }

    @Test
    fun `sample cells match the golden points, the parent included`() {
        val points = vectors.getJSONArray("points").objects()
        assertTrue(points.isNotEmpty())
        for (point in points) {
            val cells = H3.sampleCells(point.getDouble("lat"), point.getDouble("lon"))
            assertEquals(point.getString("name"), point.getString("h3_r7"), cells.h3R7)
            assertEquals(point.getString("name"), point.getString("h3_r5"), cells.h3R5)
        }
    }

    @Test
    fun `h3_r5 is the parent of the res-7 cell, not the res-5 cell containing the point`() {
        // The vectors include points where the two differ; writing the wrong one would file a
        // sample under a neighbouring shard.
        val differing = vectors.getJSONArray("points").objects()
            .filter { it.getString("h3_r5") != it.getString("h3_r5_containing") }
        assertTrue("the vectors must keep a point where parent and containing cell differ", differing.isNotEmpty())
        for (point in differing) {
            val lat = point.getDouble("lat")
            val lon = point.getDouble("lon")
            assertEquals(point.getString("h3_r5"), H3.sampleCells(lat, lon).h3R5)
            assertEquals(point.getString("h3_r5_containing"), H3.toString(H3.latLngToCell(lat, lon, 5)))
            assertNotEquals(H3.sampleCells(lat, lon).h3R5, H3.toString(H3.latLngToCell(lat, lon, 5)))
        }
    }

    @Test
    fun `the port agrees with the reference library on random points`() {
        val random = Random(20261003)
        repeat(60_000) {
            // Uniform on the sphere, so the poles are not over-sampled.
            val lat = Math.toDegrees(Math.asin(2 * random.nextDouble() - 1))
            val lon = random.nextDouble() * 360 - 180
            assertAgrees(lat, lon)
        }
    }

    @Test
    fun `the port agrees with the reference library at every resolution`() {
        val random = Random(7)
        repeat(2_000) {
            val lat = Math.toDegrees(Math.asin(2 * random.nextDouble() - 1))
            val lon = random.nextDouble() * 360 - 180
            for (res in 0..15) {
                assertEquals(
                    "res $res",
                    reference.latLngToCellAddress(lat, lon, res),
                    H3.toString(H3.latLngToCell(lat, lon, res)),
                )
            }
        }
    }

    @Test
    fun `the port agrees with the reference library around all twelve pentagons`() {
        // Pentagons are where the index rotations in the port are exercised.
        val random = Random(12)
        for (res in listOf(0, 1, 2, 5, 7)) {
            val pentagons = reference.getPentagonAddresses(res)
            assertEquals(12, pentagons.size)
            for (pentagon in pentagons) {
                val center = reference.cellToLatLng(pentagon)
                assertAgrees(center.lat, center.lng)
                // Spread wide enough to cross into every neighbouring base cell and face.
                for (spreadDeg in listOf(0.001, 0.05, 1.0, 12.0)) {
                    repeat(400) {
                        val lat = (center.lat + (random.nextDouble() - 0.5) * 2 * spreadDeg).coerceIn(-90.0, 90.0)
                        val lon = center.lng + (random.nextDouble() - 0.5) * 2 * spreadDeg
                        assertAgrees(lat, wrapLongitude(lon))
                    }
                }
            }
        }
    }

    @Test
    fun `the port agrees with the reference library at the poles, the equator and the antimeridian`() {
        val edges = listOf(-180.0, -179.9999999, -90.0, -0.0000001, 0.0, 0.0000001, 90.0, 179.9999999, 180.0)
        for (lat in listOf(-90.0, -89.9999999, -45.0, -0.0000001, 0.0, 0.0000001, 45.0, 89.9999999, 90.0)) {
            for (lon in edges) {
                assertAgrees(lat, lon)
            }
        }
    }

    @Test
    fun `cells are fifteen lowercase hex characters`() {
        val cells = H3.sampleCells(12.9716, 77.5946)
        for (cell in listOf(cells.h3R7, cells.h3R5)) {
            assertTrue(cell, Regex("^[0-9a-f]{15}$").matches(cell))
        }
    }

    private fun assertAgrees(lat: Double, lon: Double) {
        val expectedR7 = reference.latLngToCellAddress(lat, lon, H3.RES_MATCH)
        val cells = H3.sampleCells(lat, lon)
        assertEquals("res 7", expectedR7, cells.h3R7)
        assertEquals("res-5 parent", reference.cellToParentAddress(expectedR7, H3.RES_SHARD), cells.h3R5)
    }

    private fun wrapLongitude(lon: Double): Double = when {
        lon > 180 -> lon - 360
        lon < -180 -> lon + 360
        else -> lon
    }
}
