package dev.findmyperson.m0

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

/** Mode 1. One run = exactly one sample row: `current`, else `last_known`, else `none`. */
class LocationWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    // MissingPermission: without the permission the Play services call throws; fixOrNull turns that into "no fix",
    // which is logged as source=none with the permission column saying why.
    @SuppressLint("MissingPermission")
    override fun doWork(): Result {
        val ctx = applicationContext
        val ranAt = System.currentTimeMillis()
        val rec = Recorder(ctx)
        // A stale run after the user switched mode must not pollute the other mode's measurement.
        if (Prefs(ctx).selectedMode != Mode.WM) return Result.success()

        val client = LocationServices.getFusedLocationProviderClient(ctx)

        var fix = fixOrNull { cts ->
            val request = CurrentLocationRequest.Builder()
                .setPriority(Priority.PRIORITY_BALANCED_POWER_ACCURACY)
                .setDurationMillis(30_000)
                .build()
            client.getCurrentLocation(request, cts.token)
        }
        var source = LogFormat.SOURCE_CURRENT

        if (fix == null) {
            // The cache can be hours old. The fix time is logged as is, and the analyser calls it stale by comparing
            // it with ran_at, so a stale cache hit is never counted as capture.
            fix = fixOrNull { client.lastLocation }
            source = LogFormat.SOURCE_LAST_KNOWN
        }
        if (fix == null) source = LogFormat.SOURCE_NONE

        rec.sample(ranAt, fix, source, Mode.WM)
        return Result.success()
    }

    /**
     * Runs a location task and immediately reduces the Location to its time and accuracy.
     * The Location object (which holds the coordinates) never leaves this function.
     */
    private fun fixOrNull(block: (CancellationTokenSource) -> Task<Location?>): Fix? {
        val cts = CancellationTokenSource()
        return try {
            val loc = Tasks.await(block(cts), 45, TimeUnit.SECONDS) ?: return null
            Fix(loc.time, if (loc.hasAccuracy()) loc.accuracy else null)
        } catch (e: Exception) {
            // Timeout, missing permission (SecurityException wrapped in ExecutionException), interruption: no fix.
            cts.cancel()
            null
        }
    }
}
