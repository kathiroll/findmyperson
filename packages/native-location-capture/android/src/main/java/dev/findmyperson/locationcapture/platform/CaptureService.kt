package dev.findmyperson.locationcapture.platform

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import dev.findmyperson.locationcapture.R
import dev.findmyperson.locationcapture.core.CaptureState
import dev.findmyperson.locationcapture.core.ServicePlan

/**
 * Mode `fgs`: a foreground service of type location. Android lets such a service keep running
 * and keep receiving location in the background, in exchange for a permanent notification.
 *
 * The service decides nothing. On every start it asks the engine what to run
 * ([dev.findmyperson.locationcapture.core.CaptureEngine.servicePlan]), goes to the foreground,
 * subscribes to location updates and hands each batch to the engine. It reports how its start
 * went through [ServiceControl], because Android can refuse it here as well as at the call that
 * started it.
 *
 * Restart on crash: the service is sticky, so after the process is killed Android creates it
 * again with a null intent. It then reads the selection from disk through the engine and
 * carries on with no JavaScript running. The hourly watchdog and the boot receiver are the
 * second and third nets.
 */
class CaptureService : Service() {
    private val mainThread = Handler(Looper.getMainLooper())
    private var heartbeat: Runnable? = null

    /** Set when the engine stopped the service, so that `onDestroy` is not reported as a death. */
    @Volatile
    private var stoppedByEngine = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = CaptureRuntime.get(this)
        val plan = runtime.engine.servicePlan()

        // startForeground must follow startForegroundService within seconds, whatever happens
        // next, or Android kills the app.
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                buildNotification(this, plan),
                // Service types exist from Android 10; before it there is nothing to declare.
                if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
            )
        } catch (t: Throwable) {
            // Android 14+ throws SecurityException here when the location permission cannot be
            // used from where the app is; Android 12+ can throw ForegroundServiceStartNotAllowed.
            fail(runtime, LocationBackend.reasonOf(t))
            return START_NOT_STICKY
        }

        if (plan == null) {
            // Mode `fgs` is not selected (a stale start after a switch or a stop): leave again.
            fail(runtime, "NotSelected")
            return START_NOT_STICKY
        }

        if (ServiceControl.running() !== this) {
            try {
                runtime.location.requestUpdates(
                    plan,
                    runtime.executor,
                    onFixes = { fixes -> runtime.engine.onServiceFixes(fixes) },
                    onRefused = { reason -> mainThread.post { fail(runtime, reason) } },
                )
            } catch (t: Throwable) {
                fail(runtime, LocationBackend.reasonOf(t))
                return START_NOT_STICKY
            }
            ServiceControl.setRunning(this)
            startHeartbeat(runtime, plan)
        }

        if (!ServiceControl.report(STARTED)) {
            // Nobody asked for this start: Android recreated the service.
            runtime.runAsync("service_revived") { runtime.engine.onServiceRevived() }
        }
        return START_STICKY
    }

    /**
     * A wake for the missed-wake heuristic that does not depend on a fix arriving: location
     * can be off while the process is perfectly alive.
     */
    private fun startHeartbeat(runtime: CaptureRuntime, plan: ServicePlan) {
        val periodMs = maxOf(plan.intervalSec, CaptureState.WAKE_SPACING_SEC) * 1000
        val beat = object : Runnable {
            override fun run() {
                runtime.runAsync("heartbeat") { runtime.engine.onServiceHeartbeat() }
                mainThread.postDelayed(this, periodMs)
            }
        }
        heartbeat = beat
        mainThread.post(beat)
    }

    private fun fail(runtime: CaptureRuntime, reason: String) {
        val wasRunning = ServiceControl.running() === this
        shutDown()
        if (!ServiceControl.report(reason) && (wasRunning || reason != "NotSelected")) {
            runtime.runAsync("service_failed") { runtime.engine.onServiceFailed(reason) }
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * Stops delivering, at once and from any thread. After this returns the service counts as
     * not alive, even though Android destroys it a moment later.
     */
    fun shutDown() {
        stoppedByEngine = true
        // Only the instance that is running owns the update stream: a newer instance may
        // already have taken over by the time an old one is destroyed.
        if (ServiceControl.clearRunning(this)) {
            CaptureRuntime.get(this).location.removeUpdates()
        }
        heartbeat?.let(mainThread::removeCallbacks)
        heartbeat = null
    }

    override fun onDestroy() {
        val unexpected = !stoppedByEngine
        shutDown()
        if (unexpected) {
            val runtime = CaptureRuntime.get(this)
            runtime.runAsync("service_destroyed") { runtime.engine.onServiceDestroyed() }
        }
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "fmp_capture"
        private const val NOTIFICATION_ID = 0x464d50 // "FMP"
        private const val STARTED = ""

        /**
         * The permanent notification of mode `fgs`. Its title and body are the app's own words,
         * from the config (they are stored with the selection, so they are there after a reboot
         * too). The channel is named by this module's string resources, which the app may
         * override and translate.
         */
        private fun buildNotification(context: Context, plan: ServicePlan?): Notification {
            if (Build.VERSION.SDK_INT >= 26) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.fmp_capture_channel_name),
                    // LOW: no sound, no heads-up. It still cannot be swiped away.
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = context.getString(R.string.fmp_capture_channel_description)
                    setShowBadge(false)
                }
                (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                    .createNotificationChannel(channel)
            }
            val title = plan?.notificationTitle ?: context.getString(R.string.fmp_capture_channel_name)
            val body = plan?.notificationBody.orEmpty()
            val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.fmp_ic_capture)
                .setContentTitle(title)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                // Android 12+ would otherwise hold the notification back for ten seconds.
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            if (body.isNotEmpty()) {
                builder.setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            }
            // Tapping it opens the app, where the mode can be changed.
            context.packageManager.getLaunchIntentForPackage(context.packageName)?.let { launch ->
                builder.setContentIntent(
                    PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
                )
            }
            return builder.build()
        }
    }
}
