package dev.findmyperson.m0

import java.io.File
import java.io.FileOutputStream

/**
 * Append-only row store. Each row is opened, appended and closed on its own, so a process the OS kills
 * mid-run can lose at most the row being written and never corrupts earlier rows.
 *
 * The file holds rows only (no header). The three header lines are added when an export is built, because
 * the device line (label, UTC offset) can change between rows.
 */
class LogWriter(private val file: File) {

    fun append(row: String) {
        synchronized(LOCK) {
            file.parentFile?.mkdirs()
            FileOutputStream(file, true).use { it.write((row + "\n").toByteArray(Charsets.UTF_8)) }
        }
    }

    fun readRows(): List<String> = synchronized(LOCK) {
        if (!file.exists()) emptyList() else file.readLines(Charsets.UTF_8).filter { it.isNotBlank() }
    }

    /** The last [n] rows, oldest first. */
    fun tail(n: Int): List<String> = readRows().takeLast(n)

    /** Full export text: the three header lines followed by every stored row. */
    fun buildExport(deviceLine: String): String {
        val sb = StringBuilder(LogFormat.header(deviceLine))
        for (row in readRows()) sb.append(row).append('\n')
        return sb.toString()
    }

    private companion object {
        // One process writes from the UI, WorkManager threads, the service and the boot receiver; serialise them.
        val LOCK = Any()
    }
}
