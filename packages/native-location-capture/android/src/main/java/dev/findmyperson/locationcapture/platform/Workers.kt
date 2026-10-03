package dev.findmyperson.locationcapture.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.work.Worker
import androidx.work.WorkerParameters
import dev.findmyperson.locationcapture.core.CaptureEngine
import dev.findmyperson.locationcapture.core.DiagnosticEvents

/*
 * The three ways Android wakes this module with no app on screen. Each is a few lines: it finds
 * the engine and tells it what happened. Their class names are stored by WorkManager and named
 * in the manifest, so they must not be renamed (consumer-rules.pro keeps them).
 */

/**
 * The periodic job: all of mode `wm`, and the fallback of mode `fgs`. One run takes one fix.
 * It always reports success: a run that got no fix is a fact for the diagnostics, not a failure
 * WorkManager should retry with back-off.
 */
class CaptureWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val runtime = CaptureRuntime.get(applicationContext)
        try {
            runtime.engine.onWorkWake(runtime.location)
        } catch (t: Throwable) {
            runtime.engine.record(DiagnosticEvents.INTERNAL_ERROR, "capture_worker:${t.javaClass.simpleName}")
        }
        return Result.success()
    }
}

/**
 * The hourly safety net for both modes: restarts the selected mechanism if it is not alive.
 * A separate job from the capture job, so it survives whatever stopped that one. It is itself a
 * WorkManager job, so Doze can delay it too.
 */
class WatchdogWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val runtime = CaptureRuntime.get(applicationContext)
        try {
            runtime.engine.onWatchdog()
        } catch (t: Throwable) {
            runtime.engine.record(DiagnosticEvents.INTERNAL_ERROR, "watchdog_worker:${t.javaClass.simpleName}")
        }
        return Result.success()
    }
}

/**
 * Brings the selected mode back after a reboot, and after the app was replaced by an update
 * (which stops its service).
 *
 * BOOT_COMPLETED and not LOCKED_BOOT_COMPLETED: the store key and the state file are in
 * credential-protected storage, which cannot be read until the phone has been unlocked once
 * after boot, so nothing could be captured before that anyway.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reason = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> CaptureEngine.RestoreReason.BOOT
            Intent.ACTION_MY_PACKAGE_REPLACED -> CaptureEngine.RestoreReason.PACKAGE_REPLACED
            else -> return
        }
        val runtime = CaptureRuntime.get(context)
        // Starting the service can take a moment and must not run on the main thread. goAsync
        // keeps the broadcast open meanwhile, which is also what allows a foreground service to
        // be started from here on Android 12+.
        val pending = goAsync()
        runtime.runAsync("boot_receiver") {
            try {
                runtime.engine.restore(reason)
            } finally {
                pending.finish()
            }
        }
    }
}
