package dev.findmyperson.locationcapture.core

import java.io.File

/**
 * [DiagnosticsLog] as text files in the app's private, backup-excluded directory: one entry per
 * line, `tsUtc<TAB>event<TAB>detail`.
 *
 * A line is written with one open-append-close, so a process killed mid-write can damage at
 * most the last line and never an earlier one (the M0 trial's log writer worked the same way).
 * A line that does not parse is skipped when reading.
 *
 * Size is bounded by rotation: when the current file reaches [maxEntriesPerFile] lines it
 * becomes the previous file, replacing the one before it. So between one and two files' worth
 * of history is kept: at the default, at least 3000 entries, which is several weeks of capture.
 */
class FileDiagnosticsLog(
    private val directory: File,
    private val maxEntriesPerFile: Int = 3_000,
) : DiagnosticsLog {
    private val current = File(directory, "diagnostics.log")
    private val previous = File(directory, "diagnostics.previous.log")
    private var currentLines = -1

    @Synchronized
    override fun append(entry: DiagnosticEntry) {
        directory.mkdirs()
        if (currentLines < 0) {
            currentLines = if (current.exists()) current.useLines { it.count() } else 0
        }
        if (currentLines >= maxEntriesPerFile) {
            previous.delete()
            current.renameTo(previous)
            currentLines = 0
        }
        current.appendText("${entry.tsUtc}\t${clean(entry.event)}\t${clean(entry.detail)}\n", Charsets.UTF_8)
        currentLines++
    }

    @Synchronized
    override fun since(sinceTsUtc: Long): List<DiagnosticEntry> =
        (read(previous) + read(current)).filter { it.tsUtc >= sinceTsUtc }

    private fun read(file: File): List<DiagnosticEntry> {
        if (!file.exists()) return emptyList()
        return file.readLines(Charsets.UTF_8).mapNotNull { line ->
            val parts = line.split("\t")
            val ts = parts.getOrNull(0)?.toLongOrNull()
            if (parts.size != 3 || ts == null) null else DiagnosticEntry(ts, parts[1], parts[2])
        }
    }

    /** Keeps an entry on one line with exactly two separators, whatever the text holds. */
    private fun clean(text: String): String = text.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')
}
