package dev.findmyperson.locationcapture.core

import dev.findmyperson.locationcapture.Contracts
import dev.findmyperson.locationcapture.Contracts.objects
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Rule 1 of the contract: coordinates never cross the bridge on the capture path. A position
 * goes into the encrypted store and nowhere else: not into an event, not into the status, not
 * into the diagnostics, not into the plain files the module keeps beside the store.
 *
 * The test drives every path that handles a fix, with coordinates whose digits occur nowhere
 * else, then searches everything the module emitted or wrote outside the store for them. The
 * cell ids are searched for too: a res-7 cell is a place a few kilometres across.
 */
class PrivacyTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val secrets: List<String> by lazy {
        val home = H3.sampleCells(HOME_LAT, HOME_LON)
        val far = H3.sampleCells(FAR_LAT, HOME_LON)
        listOf(
            "12.97", "12.98", "77.59", "1297", "1298", "7759",
            home.h3R7, home.h3R5, far.h3R7, far.h3R5,
        )
    }

    /** The engine on the real file-backed state and diagnostics, as on a phone. */
    private fun harness(): Harness {
        val directory = temp.newFolder("fmp-capture")
        return Harness(stateStore = FileStateStore(directory), diagnostics = FileDiagnosticsLog(directory))
    }

    /** Every path a fix can take through the engine. */
    private fun exerciseEveryPath(h: Harness) {
        h.engine.start(h.config())
        h.runWork()
        h.advance(60)
        h.location.position = NEAR_HOME_LAT to HOME_LON
        h.runWork()
        h.advance(900)
        h.location.position = null
        h.location.cached = h.location.fixAt(lat = FAR_LAT, tsUtc = h.clock.now - 60)
        h.runWork()

        h.engine.start(h.config(useForegroundService = true))
        h.advance(900)
        h.deliverToService(h.location.fixAt(), h.location.fixAt(lat = FAR_LAT, tsUtc = h.clock.now + 5))
        h.deliverToService(h.location.fixAt(accuracyM = null), h.location.fixAt(lat = 912.97))
        h.engine.debugInjectSample(FAR_LAT, HOME_LON, (h.clock.now + 10).toDouble(), 30.0)

        h.store.failure = "store did not decrypt with the pinned parameters"
        h.advance(900)
        h.deliverToService(h.location.fixAt())
        runCatching { h.engine.debugInjectSample(HOME_LAT, HOME_LON, h.clock.now.toDouble(), 5.0) }
        h.store.failure = null

        h.mechanisms.killService()
        h.mechanisms.refuseService = "ForegroundServiceStartNotAllowedException"
        h.engine.onWatchdog()
        h.location.position = HOME_LAT to HOME_LON
        h.advance(900)
        h.runWork()
        h.engine.stop()
    }

    @Test
    fun `no coordinate and no cell reaches an event, the status, the diagnostics or a file`() {
        val h = harness()
        exerciseEveryPath(h)
        assertTrue("the paths must actually store fixes", h.store.samples.size >= 6)
        assertTrue(h.listener.written.size >= 6)

        val emitted = buildList {
            addAll(h.listener.written.map { it.toWire().toString() })
            addAll(h.listener.statuses.map { it.toWire().toString() })
            add(h.engine.status().toWire().toString())
            addAll(h.engine.diagnosticsSince(0.0).map { it.toWire().toString() })
        }
        val files = temp.root.walkTopDown().filter { it.isFile }.toList()
        assertTrue("state and diagnostics are written to files", files.size >= 2)
        val written = files.map { it.readText(Charsets.UTF_8) }

        for (text in emitted + written) {
            for (secret in secrets) {
                assertFalse("found \"$secret\" in: $text", text.contains(secret))
            }
            assertFalse(text, Regex("\\b(lat|lon|lng|latitude|longitude|h3_r7|h3_r5)\\b").containsMatchIn(text))
        }
    }

    @Test
    fun `the events carry exactly the fields the spec generates, none of which is a position`() {
        val schema = Contracts.json(Contracts.module("schema.json"))
            .getJSONObject("modules").getJSONObject("NativeLocationCapture").getJSONObject("aliasMap")
        fun fields(type: String): Set<String> =
            schema.getJSONObject(type).getJSONArray("properties").objects().map { it.getString("name") }.toSet()

        val h = harness()
        exerciseEveryPath(h)
        for (event in h.listener.written) {
            assertEquals(fields("SampleWrittenEvent"), event.toWire().keys)
        }
        for (status in h.listener.statuses + h.engine.status()) {
            assertEquals(fields("CaptureStatus"), status.toWire().keys)
        }
        for (entry in h.engine.diagnosticsSince(0.0)) {
            assertEquals(fields("DiagnosticEntry"), entry.toWire().keys)
        }
        assertEquals(setOf("tsUtc", "accuracyM", "source"), fields("SampleWrittenEvent"))
    }

    @Test
    fun `a fix does not print its position, so a stray log line cannot leak one`() {
        val fix = Fix(HOME_LAT, HOME_LON, T0, 20.0)
        val cells = H3.sampleCells(HOME_LAT, HOME_LON)
        val sample = StoredSample(T0, HOME_LAT, HOME_LON, 20.0, "wm", cells.h3R7, cells.h3R5)
        for (text in listOf(fix.toString(), sample.toString(), "$fix $sample", listOf(fix, sample).toString())) {
            for (secret in secrets) {
                assertFalse(text, text.contains(secret))
            }
        }
    }

    @Test
    fun `an error the store raises is reported by its reason, never with the row`() {
        val h = harness()
        h.engine.start(h.config())
        h.store.failure = "disk I/O error"
        h.runWork()
        val text = h.engine.diagnosticsSince(0.0).joinToString("\n") { it.toWire().toString() }
        assertTrue(text.contains("store_unusable"))
        for (secret in secrets) {
            assertFalse(text.contains(secret))
        }
    }
}
