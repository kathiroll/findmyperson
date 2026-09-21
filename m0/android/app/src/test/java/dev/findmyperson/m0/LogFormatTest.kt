package dev.findmyperson.m0

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class LogFormatTest {
    @Test
    fun sampleRowMatchesSpecExample() {
        // Row 1 of the worked example in m0/docs/log-format.md
        val row = LogFormat.sampleRow(1758000900000, 1758000898500, 18.0f, "current", 81, false, false, "background", "wm")
        assertEquals("S,1758000900000,1758000898500,18.0,current,81,0,0,background,wm,", row)
    }

    @Test
    fun noFixRowLeavesFixAndAccuracyEmpty() {
        val row = LogFormat.sampleRow(1758003600000, null, null, "none", 79, false, true, "background", "wm")
        assertEquals("S,1758003600000,,,none,79,0,1,background,wm,", row)
    }

    @Test
    fun accuracyHasOneDecimalRegardlessOfLocale() {
        assertEquals("22.5", LogFormat.sampleRow(1, 1, 22.46f, "updates", 50, true, false, "foreground", "fgs").split(',')[3])
        assertEquals("35.0", LogFormat.sampleRow(1, 1, 35f, "updates", 50, true, false, "foreground", "fgs").split(',')[3])
    }

    @Test
    fun unknownBatteryIsEmptyAndOutOfRangeIsClamped() {
        assertEquals("", LogFormat.sampleRow(1, null, null, "none", null, false, false, "denied", "wm").split(',')[5])
        assertEquals("100", LogFormat.sampleRow(1, null, null, "none", 140, false, false, "denied", "wm").split(',')[5])
    }

    @Test
    fun sampleRowHasElevenColumns() {
        val row = LogFormat.sampleRow(1, 2, 3f, "current", 4, true, true, "foreground_approx", "fgs")
        assertEquals(11, row.split(',').size)
        assertEquals(LogFormat.COLUMNS.split(',').size, row.split(',').size)
    }

    @Test
    fun eventRowLeavesSampleColumnsEmpty() {
        assertEquals("E,1758000000000,,,,,,,,,app_opened", LogFormat.eventRow(1758000000000, "app_opened"))
        assertEquals("E,5,,,,,,,,,mode_changed:wm", LogFormat.eventRow(5, "mode_changed:wm"))
        assertEquals(11, LogFormat.eventRow(5, "x").split(',').size)
    }

    @Test
    fun eventTextCannotBreakTheCsv() {
        val row = LogFormat.eventRow(5, "a,b\nc")
        assertEquals(11, row.split(',').size)
        assertFalse(row.contains('\n'))
    }

    @Test
    fun headerIsThreeLinesInSpecOrder() {
        val dev = LogFormat.deviceLine("xiaomi,kartik", "Redmi Note 12", "14", 3, 330)
        assertEquals(
            "#fmp-capture-log,1\n" +
                "#device,label=xiaomi_kartik,platform=android,model=Redmi Note 12,os=14,app_build=3,utc_offset_min=330\n" +
                "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event\n",
            LogFormat.header(dev),
        )
    }
}
