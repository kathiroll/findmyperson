package dev.findmyperson.m0

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * Hourly safety net for both modes. Checks the selected mode is really running and restarts it if not.
 * Deliberately a different job from Mode 1's capture job.
 */
class WatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        val ctx = applicationContext
        val mode = Prefs(ctx).selectedMode ?: return Result.success()
        val rec = Recorder(ctx)
        val running = try {
            CaptureController.isRunningBlocking(ctx, mode)
        } catch (e: Exception) {
            false
        }
        if (running) {
            rec.event("watchdog_ok")
        } else {
            rec.event("watchdog_restart")
            CaptureController.start(ctx, mode, replace = false)
        }
        return Result.success()
    }
}
