package dev.findmyperson.m0

import java.util.Locale

/**
 * Pure text formatting for "M0 capture log format v1" (m0/docs/log-format.md).
 * No Android classes here so it is unit-testable on the JVM.
 *
 * Privacy rule: nothing in this file, or anywhere in the app, accepts a coordinate, altitude,
 * speed or address. The only location facts that reach a row are the fix time and accuracy.
 */
object LogFormat {
    const val LINE1 = "#fmp-capture-log,1"
    const val COLUMNS = "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event"

    const val SOURCE_CURRENT = "current"
    const val SOURCE_UPDATES = "updates"
    const val SOURCE_LAST_KNOWN = "last_known"
    const val SOURCE_NONE = "none"

    /** The format has no quoting, so commas and line breaks must never reach a field. */
    fun sanitize(text: String): String =
        text.replace(',', '_').replace('\n', ' ').replace('\r', ' ').trim()

    fun deviceLine(label: String, model: String, os: String, appBuild: Int, utcOffsetMin: Int): String =
        "#device,label=${sanitize(label)},platform=android,model=${sanitize(model)},os=${sanitize(os)}," +
            "app_build=$appBuild,utc_offset_min=$utcOffsetMin"

    /** Header block written at the top of every export: lines 1 to 3 of the spec. */
    fun header(deviceLine: String): String = "$LINE1\n$deviceLine\n$COLUMNS\n"

    fun sampleRow(
        ranAt: Long,
        fixAt: Long?,
        accuracyM: Float?,
        source: String,
        batteryPct: Int?,
        charging: Boolean,
        powerSave: Boolean,
        permission: String,
        mode: String,
    ): String = listOf(
        "S",
        ranAt.toString(),
        fixAt?.toString() ?: "",
        accuracyM?.let { String.format(Locale.ROOT, "%.1f", it) } ?: "",
        source,
        batteryPct?.coerceIn(0, 100)?.toString() ?: "",
        if (charging) "1" else "0",
        if (powerSave) "1" else "0",
        permission,
        mode,
        "",
    ).joinToString(",")

    fun eventRow(ranAt: Long, event: String): String =
        "E,$ranAt,,,,,,,,,${sanitize(event)}"
}

/** Only these two facts about a fix ever leave the Location object. */
data class Fix(val timeMs: Long, val accuracyM: Float?)

/** Summary numbers for the status screen, computed from stored rows. */
data class LogStats(
    val sampleRows: Int,
    val eventRows: Int,
    val lastRowAt: Long?,
    val lastFixAt: Long?,
) {
    companion object {
        fun from(rows: List<String>): LogStats {
            var samples = 0
            var events = 0
            var lastRow: Long? = null
            var lastFix: Long? = null
            for (row in rows) {
                val f = row.split(',')
                if (f.size < 11) continue
                val ranAt = f[1].toLongOrNull()
                when (f[0]) {
                    "S" -> {
                        samples++
                        if (ranAt != null) lastRow = ranAt
                        f[2].toLongOrNull()?.let { lastFix = it }
                    }
                    "E" -> events++
                }
            }
            return LogStats(samples, events, lastRow, lastFix)
        }
    }
}
