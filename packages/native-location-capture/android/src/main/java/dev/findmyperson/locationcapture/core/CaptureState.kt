package dev.findmyperson.locationcapture.core

import java.io.File
import java.io.StringReader
import java.io.StringWriter
import java.util.Properties

/** A stretch of time in which a mode was selected. [to] is null while it still is. */
data class Period(val from: Long, val to: Long?)

/**
 * Everything the module remembers between processes. It is written to a plain file, so by
 * construction it holds no coordinate: only the selection, and times.
 *
 * The times are a ledger the status is computed from. The store contract
 * (packages/shared/contracts/native-writer.json) gives a native module an insert statement and
 * no query, so "how many samples in the last 24 hours" cannot be asked of the store and is
 * counted here instead, from what this module itself wrote.
 */
data class CaptureState(
    /** The config of the last successful `start`, or null when stopped. */
    val selection: CaptureConfig? = null,
    /** `minIntervalSec` of the last selection. Kept after `stop`, for `expectedLast24h`. */
    val intervalSec: Double? = null,
    val periods: List<Period> = emptyList(),
    /** Fix times of the samples stored in the last 24 hours. */
    val sampleTimes: List<Long> = emptyList(),
    /** Fix time of the newest sample ever stored: `lastSampleTsUtc`. */
    val newestSampleTsUtc: Long? = null,
    /** Fix time of the sample stored most recently, which the interval rule counts from. */
    val lastStoredTsUtc: Long? = null,
    /** Times this process was woken to capture, at most one per [WAKE_SPACING_SEC]. */
    val wakes: List<Long> = emptyList(),
    /** The foreground permission prompt has been shown once. Android does not record this. */
    val askedForeground: Boolean = false,
    /** Why the store failed its last check, or null if it passed. */
    val storeFailure: String? = null,
    /** The health flags, permission and standby bucket last written to the diagnostics. */
    val loggedHealth: String? = null,
    val loggedPermission: String? = null,
    val loggedStandbyBucket: String? = null,
    /** Set by [StateStore.load] when the file could not be read. Not persisted. */
    val loadProblem: String? = null,
) {
    /** Seconds within the 24 hours before [now] in which a mode was selected. */
    fun selectedSecondsLast24h(now: Long): Long {
        val dayAgo = now - DAY_SEC
        return periods.sumOf { period -> maxOf(0L, (period.to ?: now) - maxOf(period.from, dayAgo)) }
    }

    /** `expectedLast24h`: one sample per interval for the time a mode was selected. */
    fun expectedLast24h(now: Long): Int {
        val interval = intervalSec ?: return 0
        return Math.floor(selectedSecondsLast24h(now) / interval).toInt()
    }

    fun samplesLast24h(now: Long): Int = sampleTimes.count { it >= now - DAY_SEC }

    /** Start of the open period: since when a mode has been selected without a break. */
    fun selectedSince(): Long? = periods.lastOrNull()?.takeIf { it.to == null }?.from

    fun withSample(tsUtc: Long, now: Long): CaptureState = copy(
        sampleTimes = (sampleTimes + tsUtc).filter { it >= now - DAY_SEC }.takeLast(MAX_LEDGER_ENTRIES),
        newestSampleTsUtc = maxOf(newestSampleTsUtc ?: tsUtc, tsUtc),
        lastStoredTsUtc = tsUtc,
    )

    /** Records a capture wake, unless one was recorded less than [WAKE_SPACING_SEC] ago. */
    fun withWake(now: Long): CaptureState {
        val last = wakes.lastOrNull()
        if (last != null && now - last in 0 until WAKE_SPACING_SEC) return this
        return copy(wakes = (wakes + now).filter { it >= now - DAY_SEC }.takeLast(MAX_LEDGER_ENTRIES))
    }

    /** Drops what has left the 24-hour window. */
    fun pruned(now: Long): CaptureState = copy(
        periods = periods.filter { it.to == null || it.to >= now - DAY_SEC },
        sampleTimes = sampleTimes.filter { it >= now - DAY_SEC },
        wakes = wakes.filter { it >= now - DAY_SEC },
    )

    companion object {
        const val DAY_SEC = 86_400L
        const val WAKE_SPACING_SEC = 300L

        /** Bounds the file even if a debug build injects samples in a loop. */
        const val MAX_LEDGER_ENTRIES = 2_000
    }
}

/**
 * [StateStore] in one small file of the app's private, backup-excluded directory.
 *
 * The file is replaced by rename, so a process killed in the middle of a save leaves the old
 * state, never half of a new one. A file that cannot be read is treated as "nothing selected"
 * and reported through [CaptureState.loadProblem].
 */
class FileStateStore(private val directory: File) : StateStore {
    private val file = File(directory, FILE_NAME)

    override fun load(): CaptureState {
        if (!file.exists()) return CaptureState()
        return try {
            val p = Properties()
            StringReader(file.readText(Charsets.UTF_8)).use(p::load)
            decode(p)
        } catch (e: Exception) {
            CaptureState(loadProblem = e.javaClass.simpleName)
        }
    }

    override fun save(state: CaptureState) {
        directory.mkdirs()
        val text = StringWriter().also { encode(state).store(it, null) }.toString()
        val temp = File(directory, "$FILE_NAME.tmp")
        temp.writeText(text, Charsets.UTF_8)
        if (!temp.renameTo(file)) {
            // Some filesystems will not rename over an existing file.
            file.delete()
            check(temp.renameTo(file)) { "could not replace $FILE_NAME" }
        }
    }

    private fun encode(state: CaptureState): Properties = Properties().apply {
        setProperty("version", FORMAT_VERSION)
        state.selection?.let { config ->
            setProperty("selection.minIntervalSec", config.minIntervalSec.toString())
            setProperty("selection.minDistanceM", config.minDistanceM.toString())
            setProperty("selection.accuracy", config.accuracy.wire)
            setProperty("selection.useForegroundService", config.useForegroundService.toString())
            setProperty("selection.notificationTitle", config.notificationTitle)
            setProperty("selection.notificationBody", config.notificationBody)
        }
        state.intervalSec?.let { setProperty("intervalSec", it.toString()) }
        setProperty("periods", state.periods.joinToString(",") { "${it.from}:${it.to ?: ""}" })
        setProperty("sampleTimes", state.sampleTimes.joinToString(","))
        state.newestSampleTsUtc?.let { setProperty("newestSampleTsUtc", it.toString()) }
        state.lastStoredTsUtc?.let { setProperty("lastStoredTsUtc", it.toString()) }
        setProperty("wakes", state.wakes.joinToString(","))
        setProperty("askedForeground", state.askedForeground.toString())
        state.storeFailure?.let { setProperty("storeFailure", it) }
        state.loggedHealth?.let { setProperty("loggedHealth", it) }
        state.loggedPermission?.let { setProperty("loggedPermission", it) }
        state.loggedStandbyBucket?.let { setProperty("loggedStandbyBucket", it) }
    }

    private fun decode(p: Properties): CaptureState {
        check(p.getProperty("version") == FORMAT_VERSION) { "unknown state format" }
        fun longs(key: String): List<Long> =
            p.getProperty(key).orEmpty().split(",").filter { it.isNotEmpty() }.map { it.toLong() }

        val selection = p.getProperty("selection.minIntervalSec")?.let { interval ->
            CaptureConfig.validate(
                RawConfig(
                    minIntervalSec = interval.toDouble(),
                    minDistanceM = p.getProperty("selection.minDistanceM").toDouble(),
                    accuracy = p.getProperty("selection.accuracy"),
                    useForegroundService = p.getProperty("selection.useForegroundService").toBoolean(),
                    notificationTitle = p.getProperty("selection.notificationTitle"),
                    notificationBody = p.getProperty("selection.notificationBody"),
                ),
            )
        }
        return CaptureState(
            selection = selection,
            intervalSec = p.getProperty("intervalSec")?.toDouble(),
            periods = p.getProperty("periods").orEmpty().split(",").filter { it.isNotEmpty() }.map { text ->
                val (from, to) = text.split(":")
                Period(from.toLong(), to.takeIf { it.isNotEmpty() }?.toLong())
            },
            sampleTimes = longs("sampleTimes"),
            newestSampleTsUtc = p.getProperty("newestSampleTsUtc")?.toLong(),
            lastStoredTsUtc = p.getProperty("lastStoredTsUtc")?.toLong(),
            wakes = longs("wakes"),
            askedForeground = p.getProperty("askedForeground").toBoolean(),
            storeFailure = p.getProperty("storeFailure"),
            loggedHealth = p.getProperty("loggedHealth"),
            loggedPermission = p.getProperty("loggedPermission"),
            loggedStandbyBucket = p.getProperty("loggedStandbyBucket"),
        )
    }

    private companion object {
        const val FILE_NAME = "capture-state.properties"
        const val FORMAT_VERSION = "1"
    }
}
