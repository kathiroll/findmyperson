package dev.findmyperson.m0

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the selected mode back after a reboot (or after `adb install -r` replaces the app).
 * Only BOOT_COMPLETED, not LOCKED_BOOT_COMPLETED: the log lives in credential-protected storage, which is
 * unreadable until the user unlocks the phone once after boot, so nothing can be recorded before that anyway.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        val mode = Prefs(app).selectedMode ?: return
        val rec = Recorder(app)
        rec.event(if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) "boot_restart:package_replaced" else "boot_restart")
        CaptureController.start(app, mode, replace = false)
        CaptureController.ensureWatchdog(app)
    }
}
