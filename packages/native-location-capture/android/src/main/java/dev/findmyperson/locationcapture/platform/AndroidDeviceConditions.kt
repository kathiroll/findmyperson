package dev.findmyperson.locationcapture.platform

import android.Manifest
import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.UserManager
import androidx.core.content.ContextCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import androidx.core.location.LocationManagerCompat
import dev.findmyperson.locationcapture.core.DeviceConditions
import dev.findmyperson.locationcapture.core.DeviceSnapshot
import dev.findmyperson.locationcapture.core.Hibernation
import java.util.concurrent.TimeUnit

/**
 * Reads from Android the facts every health flag is computed from. Each field is one system
 * call; which condition it stands for is on [DeviceSnapshot], and the flag logic is in
 * `CaptureEngine.computeStatus`, where it is unit-tested.
 *
 * No Android version is assumed: every version-dependent branch checks `SDK_INT` at run time.
 */
class AndroidDeviceConditions(private val context: Context) : DeviceConditions {
    @Volatile
    private var lastHibernation = Hibernation.NOT_AVAILABLE

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    override fun snapshot(): DeviceSnapshot {
        val fine = granted(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        // Android 10 introduced the separate background permission. Before it, a foreground
        // grant covered the background too.
        val background = if (Build.VERSION.SDK_INT >= 29) {
            granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } else {
            fine || coarse
        }
        return DeviceSnapshot(
            fineGranted = fine,
            coarseGranted = coarse,
            backgroundGranted = background,
            locationRestricted = locationRestricted(),
            locationServicesOn = locationServicesOn(),
            ignoringBatteryOptimisations = ignoringBatteryOptimisations(),
            backgroundRestricted = backgroundRestricted(),
            hibernation = hibernation(),
            bootTsUtc = (System.currentTimeMillis() - SystemClock.elapsedRealtime()) / 1000,
            standbyBucket = standbyBucket(),
        )
    }

    /** Device policy or parental controls forbid this user from sharing location at all. */
    private fun locationRestricted(): Boolean = try {
        val users = context.getSystemService(Context.USER_SERVICE) as UserManager
        users.hasUserRestriction(UserManager.DISALLOW_SHARE_LOCATION)
    } catch (e: Exception) {
        false
    }

    /** The phone-wide location switch. */
    private fun locationServicesOn(): Boolean = try {
        LocationManagerCompat.isLocationEnabled(context.getSystemService(Context.LOCATION_SERVICE) as LocationManager)
    } catch (e: Exception) {
        true
    }

    /** Battery use "Unrestricted": exempt from Doze deferral and App Standby buckets. */
    private fun ignoringBatteryOptimisations(): Boolean = try {
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName)
    } catch (e: Exception) {
        false
    }

    /** Battery use "Restricted": Android 9+ blocks the app's jobs and background services. */
    private fun backgroundRestricted(): Boolean = try {
        Build.VERSION.SDK_INT >= 28 &&
            (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isBackgroundRestricted
    } catch (e: Exception) {
        false
    }

    /**
     * "Pause app activity if unused". The answer comes from a future; off the main thread it is
     * waited for briefly, on the main thread the last known answer is returned.
     */
    private fun hibernation(): Hibernation {
        if (Looper.myLooper() == Looper.getMainLooper()) return lastHibernation
        val status = try {
            PackageManagerCompat.getUnusedAppRestrictionsStatus(context).get(HIBERNATION_TIMEOUT_SEC, TimeUnit.SECONDS)
        } catch (e: Exception) {
            return lastHibernation
        }
        val result = when (status) {
            UnusedAppRestrictionsConstants.DISABLED -> Hibernation.EXEMPT
            UnusedAppRestrictionsConstants.API_30_BACKPORT,
            UnusedAppRestrictionsConstants.API_30,
            UnusedAppRestrictionsConstants.API_31,
            -> Hibernation.NOT_EXEMPT
            // FEATURE_NOT_AVAILABLE, ERROR
            else -> Hibernation.NOT_AVAILABLE
        }
        lastHibernation = result
        return result
    }

    /** App Standby bucket, for the diagnostics: it decides how often jobs may run. */
    private fun standbyBucket(): String? {
        if (Build.VERSION.SDK_INT < 28) return null
        return try {
            val usage = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
            when (val bucket = usage.appStandbyBucket) {
                UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
                UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working_set"
                UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
                UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
                UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "restricted"
                // 5 is the exempted bucket (not a public constant): no job restrictions.
                else -> if (bucket <= 5) "exempted" else bucket.toString()
            }
        } catch (e: Exception) {
            null
        }
    }

    private companion object {
        const val HIBERNATION_TIMEOUT_SEC = 2L
    }
}
