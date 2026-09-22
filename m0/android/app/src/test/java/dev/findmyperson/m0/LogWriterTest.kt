package dev.findmyperson.m0

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class LogWriterTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun writer(): Pair<LogWriter, File> {
        val f = File(tmp.root, "sub/capture-rows.csv") // parent directory does not exist yet
        return LogWriter(f) to f
    }

    @Test
    fun appendsOneLinePerRowAndKeepsOrder() {
        val (w, f) = writer()
        w.append("E,1,,,,,,,,,app_opened")
        w.append("S,2,3,4.0,current,80,0,0,background,wm,")
        assertEquals("E,1,,,,,,,,,app_opened\nS,2,3,4.0,current,80,0,0,background,wm,\n", f.readText())
        assertEquals(2, w.readRows().size)
    }

    @Test
    fun aSecondWriterInstanceAppendsToTheSameFile() {
        // Simulates the process being killed and restarted: earlier rows survive.
        val (w, f) = writer()
        w.append("E,1,,,,,,,,,a")
        LogWriter(f).append("E,2,,,,,,,,,b")
        assertEquals(listOf("E,1,,,,,,,,,a", "E,2,,,,,,,,,b"), w.readRows())
    }

    @Test
    fun missingFileReadsAsEmpty() {
        val (w, _) = writer()
        assertEquals(emptyList<String>(), w.readRows())
    }

    @Test
    fun tailReturnsLastRowsOldestFirst() {
        val (w, _) = writer()
        for (i in 1..30) w.append("E,$i,,,,,,,,,x")
        val t = w.tail(20)
        assertEquals(20, t.size)
        assertEquals("E,11,,,,,,,,,x", t.first())
        assertEquals("E,30,,,,,,,,,x", t.last())
    }

    @Test
    fun exportIsHeaderThenRowsWithLfEndings() {
        val (w, _) = writer()
        w.append("E,1,,,,,,,,,app_opened")
        val dev = LogFormat.deviceLine("t", "m", "14", 1, 330)
        val lines = w.buildExport(dev).split("\n")
        assertEquals("#fmp-capture-log,1", lines[0])
        assertEquals(dev, lines[1])
        assertEquals(LogFormat.COLUMNS, lines[2])
        assertEquals("E,1,,,,,,,,,app_opened", lines[3])
        assertEquals("", lines[4]) // trailing newline
        assertEquals(false, w.buildExport(dev).contains('\r'))
    }

    @Test
    fun statsCountRowsAndFindLastTimes() {
        val rows = listOf(
            "E,1,,,,,,,,,app_opened",
            "S,100,90,10.0,current,80,0,0,background,wm,",
            "S,200,,,none,79,0,0,background,wm,",
            "E,250,,,,,,,,,watchdog_ok",
        )
        val s = LogStats.from(rows)
        assertEquals(2, s.sampleRows)
        assertEquals(2, s.eventRows)
        assertEquals(200L, s.lastRowAt)
        assertEquals(90L, s.lastFixAt)
    }

    @Test
    fun statsOfEmptyLog() {
        val s = LogStats.from(emptyList())
        assertEquals(0, s.sampleRows)
        assertNull(s.lastRowAt)
        assertNull(s.lastFixAt)
    }
}
