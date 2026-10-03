package dev.findmyperson.locationcapture.platform

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import androidx.core.location.LocationListenerCompat
import androidx.core.location.LocationManagerCompat
import androidx.core.location.LocationRequestCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import dev.findmyperson.locationcapture.core.Accuracy
import dev.findmyperson.locationcapture.core.Fix
import dev.findmyperson.locationcapture.core.LocationSource
import dev.findmyperson.locationcapture.core.ServicePlan
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Where fixes come from: one-shot for the periodic job ([LocationSource]) and a stream for the
 * foreground service.
 *
 * Two implementations. [FusedBackend] is Google Play services' fused provider, which the M0
 * trial ran on. [PlatformBackend] is Android's own LocationManager, for phones without Play
 * services (a real population in the leading launch market, plan 12.2): there the fused client
 * fails every call, and capture would starve with a perfectly healthy-looking status. The
 * choice is made once per process by [pick].
 *
 * A `Location` is turned into a [Fix] the moment it arrives and is not kept.
 */
interface LocationBackend : LocationSource {
    /** `fused` or `platform`, for the diagnostics. */
    val name: String

    /**
     * Starts the update stream of mode `fgs`, replacing any earlier one. [onFixes] and
     * [onRefused] run on [executor]. A refusal may also come as an exception from this call.
     */
    fun requestUpdates(plan: ServicePlan, executor: Executor, onFixes: (List<Fix>) -> Unit, onRefused: (String) -> Unit)

    fun removeUpdates()

    companion object {
        fun pick(context: Context): LocationBackend {
            val playServices = try {
                GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
            } catch (e: Exception) {
                false
            }
            return if (playServices) FusedBackend(context) else PlatformBackend(context)
        }

        /**
         * The request of mode `fgs`, shared by both backends.
         *
         *   interval      one fix per `minIntervalSec`, computed for us.
         *   fastest       fixes other apps caused are accepted down to a fifth of the interval
         *                 (never under a minute). They cost nothing, and they are how a phone
         *                 that moved `minDistanceM` gets its early sample; the filter drops the
         *                 rest.
         *   max delay     the OS may batch up to two intervals, which is much cheaper than
         *                 waking for each fix (plan 5.2).
         *   no distance   a minimum distance here would be a hard filter, and a phone sitting
         *                 still would store nothing; stays are built from exactly those samples.
         */
        fun intervalMs(plan: ServicePlan): Long = plan.intervalSec * 1000

        fun fastestMs(plan: ServicePlan): Long = maxOf(intervalMs(plan) / 5, 60_000L)

        fun maxDelayMs(plan: ServicePlan): Long = intervalMs(plan) * 2

        fun reasonOf(error: Throwable): String = error.javaClass.simpleName
    }
}

private fun Location.toFix(): Fix = Fix(
    lat = latitude,
    lon = longitude,
    tsUtc = time / 1000,
    accuracyM = if (hasAccuracy()) accuracy.toDouble() else null,
)

// MissingPermission: without the permission these calls fail, which is reported, not prevented.
@SuppressLint("MissingPermission")
private class FusedBackend(context: Context) : LocationBackend {
    private val client = LocationServices.getFusedLocationProviderClient(context.applicationContext)
    private var callback: LocationCallback? = null

    override val name = "fused"

    private fun priority(accuracy: Accuracy): Int = when (accuracy) {
        Accuracy.BALANCED -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
        Accuracy.HIGH -> Priority.PRIORITY_HIGH_ACCURACY
    }

    override fun currentFix(accuracy: Accuracy, timeoutSec: Long): Fix? = await(timeoutSec + AWAIT_MARGIN_SEC) { cancel ->
        val request = CurrentLocationRequest.Builder()
            .setPriority(priority(accuracy))
            .setDurationMillis(timeoutSec * 1000)
            .build()
        client.getCurrentLocation(request, cancel.token)
    }

    override fun lastKnownFix(): Fix? = await(AWAIT_MARGIN_SEC) { client.lastLocation }

    /** Timeout, missing permission, location off, interruption: all of them are "no fix". */
    private fun await(timeoutSec: Long, start: (CancellationTokenSource) -> Task<Location>): Fix? {
        val cancel = CancellationTokenSource()
        return try {
            Tasks.await(start(cancel), timeoutSec, TimeUnit.SECONDS)?.toFix()
        } catch (e: Exception) {
            cancel.cancel()
            null
        }
    }

    @Synchronized
    override fun requestUpdates(plan: ServicePlan, executor: Executor, onFixes: (List<Fix>) -> Unit, onRefused: (String) -> Unit) {
        removeUpdates()
        val request = LocationRequest.Builder(priority(plan.accuracy), LocationBackend.intervalMs(plan))
            .setMinUpdateIntervalMillis(LocationBackend.fastestMs(plan))
            .setMaxUpdateDelayMillis(LocationBackend.maxDelayMs(plan))
            .build()
        val listener = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                onFixes(result.locations.map { it.toFix() })
            }
        }
        client.requestLocationUpdates(request, executor, listener)
            .addOnFailureListener(executor) { error -> onRefused(LocationBackend.reasonOf(error)) }
        callback = listener
    }

    @Synchronized
    override fun removeUpdates() {
        callback?.let { client.removeLocationUpdates(it) }
        callback = null
    }

    private companion object {
        const val AWAIT_MARGIN_SEC = 15L
    }
}

@SuppressLint("MissingPermission")
private class PlatformBackend(context: Context) : LocationBackend {
    private val manager = context.applicationContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var listener: LocationListenerCompat? = null

    override val name = "platform"

    /** The platform's own fused provider where it exists, else network or GPS by accuracy. */
    private fun provider(accuracy: Accuracy): String? {
        val enabled = try {
            manager.getProviders(true)
        } catch (e: Exception) {
            emptyList()
        }
        val preferred = buildList {
            if (Build.VERSION.SDK_INT >= 31) add(LocationManager.FUSED_PROVIDER)
            if (accuracy == Accuracy.HIGH) {
                add(LocationManager.GPS_PROVIDER)
                add(LocationManager.NETWORK_PROVIDER)
            } else {
                add(LocationManager.NETWORK_PROVIDER)
                add(LocationManager.GPS_PROVIDER)
            }
        }
        return preferred.firstOrNull { it in enabled }
    }

    private fun quality(accuracy: Accuracy): Int = when (accuracy) {
        Accuracy.BALANCED -> LocationRequestCompat.QUALITY_BALANCED_POWER_ACCURACY
        Accuracy.HIGH -> LocationRequestCompat.QUALITY_HIGH_ACCURACY
    }

    override fun currentFix(accuracy: Accuracy, timeoutSec: Long): Fix? {
        val provider = provider(accuracy) ?: return null
        val cancel = CancellationSignal()
        val result = AtomicReference<Location?>()
        val done = CountDownLatch(1)
        return try {
            LocationManagerCompat.getCurrentLocation(manager, provider, cancel, DIRECT) { location ->
                result.set(location)
                done.countDown()
            }
            done.await(timeoutSec, TimeUnit.SECONDS)
            result.get()?.toFix()
        } catch (e: Exception) {
            null
        } finally {
            cancel.cancel()
        }
    }

    override fun lastKnownFix(): Fix? = try {
        val newest = manager.getProviders(true).mapNotNull { manager.getLastKnownLocation(it) }.maxByOrNull { it.time }
        newest?.toFix()
    } catch (e: Exception) {
        null
    }

    @Synchronized
    override fun requestUpdates(plan: ServicePlan, executor: Executor, onFixes: (List<Fix>) -> Unit, onRefused: (String) -> Unit) {
        removeUpdates()
        val provider = provider(plan.accuracy) ?: throw IllegalStateException("NoLocationProvider")
        val request = LocationRequestCompat.Builder(LocationBackend.intervalMs(plan))
            .setQuality(quality(plan.accuracy))
            .setMinUpdateIntervalMillis(LocationBackend.fastestMs(plan))
            .setMaxUpdateDelayMillis(LocationBackend.maxDelayMs(plan))
            .build()
        val updates = object : LocationListenerCompat {
            override fun onLocationChanged(location: Location) {
                onFixes(listOf(location.toFix()))
            }

            override fun onLocationChanged(locations: List<Location>) {
                onFixes(locations.map { it.toFix() })
            }
        }
        LocationManagerCompat.requestLocationUpdates(manager, provider, request, executor, updates)
        listener = updates
    }

    @Synchronized
    override fun removeUpdates() {
        listener?.let { LocationManagerCompat.removeUpdates(manager, it) }
        listener = null
    }

    private companion object {
        /** The callback only stores a value and releases a latch. */
        val DIRECT = Executor { it.run() }
    }
}
