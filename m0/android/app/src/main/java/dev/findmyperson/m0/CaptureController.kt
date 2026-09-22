package dev.findmyperson.m0

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/** Starts, stops and inspects the two capture modes and the watchdog. Only one mode is ever active. */
object CaptureController {
    const val WM_WORK = "fmp_wm_capture"
    const val WATCHDOG_WORK = "fmp_watchdog"

    /** User picked a mode (or stopped). Logs the change and starts or stops capture. */
    fun select(ctx: Context, mode: Mode?) {
        val app = ctx.applicationContext
        val rec = Recorder(app)
        stopAll(app)
        Prefs(app).selectedMode = mode
        rec.event("mode_changed:${Mode.toPref(mode)}")
        if (mode == null) {
            WorkManager.getInstance(app).cancelUniqueWork(WATCHDOG_WORK)
            rec.event("capture_stopped")
        } else {
            start(app, mode, replace = true)
            ensureWatchdog(app)
            rec.event("capture_started")
        }
    }

    /** Start a mode. [replace] restarts an existing WorkManager job; otherwise an already queued job is kept. */
    fun start(ctx: Context, mode: Mode, replace: Boolean) {
        val app = ctx.applicationContext
        when (mode) {
            Mode.WM -> {
                // 15 minutes is WorkManager's minimum period. It is a floor, not a promise: the OS may run the job later.
                // No constraints on purpose (no network or charging needed) and no notification, no foreground service.
                val request = PeriodicWorkRequestBuilder<LocationWorker>(15, TimeUnit.MINUTES).build()
                WorkManager.getInstance(app).enqueueUniquePeriodicWork(
                    WM_WORK,
                    if (replace) ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE else ExistingPeriodicWorkPolicy.KEEP,
                    request,
                )
            }
            Mode.FGS -> try {
                ContextCompat.startForegroundService(app, Intent(app, CaptureService::class.java))
            } catch (t: Throwable) {
                // Android 12+ can refuse a foreground-service start from the background
                // (ForegroundServiceStartNotAllowedException). Record it: it is exactly what this trial must measure.
                Recorder(app).event("fgs_start_failed:${t.javaClass.simpleName}")
            }
        }
    }

    fun stopAll(ctx: Context) {
        val app = ctx.applicationContext
        WorkManager.getInstance(app).cancelUniqueWork(WM_WORK)
        app.stopService(Intent(app, CaptureService::class.java))
    }

    /**
     * The hourly watchdog is a separate WorkManager job from the Mode 1 job, so Mode 1's own schedule
     * stays a clean measurement. It exists in both modes.
     */
    fun ensureWatchdog(ctx: Context) {
        val request = PeriodicWorkRequestBuilder<WatchdogWorker>(1, TimeUnit.HOURS).build()
        WorkManager.getInstance(ctx.applicationContext)
            .enqueueUniquePeriodicWork(WATCHDOG_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Blocking: call from a worker thread, not the UI thread. */
    fun isRunningBlocking(ctx: Context, mode: Mode): Boolean = when (mode) {
        Mode.FGS -> CaptureService.running
        Mode.WM -> {
            val infos = WorkManager.getInstance(ctx.applicationContext).getWorkInfosForUniqueWork(WM_WORK).get()
            infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.BLOCKED }
        }
    }
}
