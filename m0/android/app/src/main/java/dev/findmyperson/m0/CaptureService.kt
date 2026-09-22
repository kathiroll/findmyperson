package dev.findmyperson.m0

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Mode 2: a foreground service of type location. Android lets such a service keep running and receive location
 * in the background in exchange for a permanent notification the user can see.
 */
class CaptureService : Service() {

    private var callback: LocationCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForeground must be called within seconds of startForegroundService, even if we stop right after.
        try {
            ServiceCompat.startForeground(
                this, NOTIFICATION_ID, buildNotification(this),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } catch (t: Throwable) {
            // Android 14+ throws SecurityException when the location permission is missing at this moment.
            Recorder(this).event("fgs_start_failed:${t.javaClass.simpleName}")
            stopSelf()
            return START_NOT_STICKY
        }
        running = true

        if (Prefs(this).selectedMode != Mode.FGS) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (callback == null) requestUpdates()
        // STICKY: if the OS kills the process, it recreates the service later (the watchdog is the second net).
        return START_STICKY
    }

    private fun requestUpdates() {
        val rec = Recorder(this)
        // No minimum distance: the trial measures platform-imposed gaps (Doze, standby, throttling), not how
        // far the phone physically moved, so a distance filter would confound the two. A fresh fix is wanted
        // every 15 minutes even on a phone sitting still.
        val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 15 * 60_000L)
            .setMaxUpdateDelayMillis(30 * 60_000L)
            .build()
        val cb = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val ranAt = System.currentTimeMillis()
                // Batched delivery (maxUpdateDelay) can hand over several fixes at once; one row each.
                // Only time and accuracy are read; the Location objects are dropped immediately.
                for (loc in result.locations) {
                    val fix = Fix(loc.time, if (loc.hasAccuracy()) loc.accuracy else null)
                    rec.sample(ranAt, fix, LogFormat.SOURCE_UPDATES, Mode.FGS)
                }
            }
        }
        try {
            LocationServices.getFusedLocationProviderClient(this)
                .requestLocationUpdates(request, cb, Looper.getMainLooper())
            callback = cb
        } catch (t: SecurityException) {
            rec.event("fgs_updates_failed:SecurityException")
        }
    }

    override fun onDestroy() {
        callback?.let { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(it) }
        callback = null
        running = false
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_ID = "capture"
        private const val NOTIFICATION_ID = 1

        /** True while the service is alive in this process. The process dying also kills the service, so this is honest. */
        @Volatile
        var running = false

        private fun buildNotification(ctx: Context): Notification {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            // Channels exist from Android 8 (our minSdk). LOW importance: no sound, still permanent.
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Capture test", NotificationManager.IMPORTANCE_LOW)
            )
            val open = PendingIntent.getActivity(
                ctx, 0, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
            )
            return NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("findmyperson test: recording capture health")
                .setContentText("Logs when a location arrived, never where you are.")
                .setOngoing(true)
                .setContentIntent(open)
                .build()
        }
    }
}
