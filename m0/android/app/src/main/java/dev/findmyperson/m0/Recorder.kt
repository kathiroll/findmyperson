package dev.findmyperson.m0

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import java.io.File
import java.util.TimeZone

/**
 * The single place that writes log rows. Everything (UI, workers, service, boot receiver) goes through here
 * so each row carries the same battery, power-save and permission columns.
 */
class Recorder(context: Context) {
    private val ctx = context.applicationContext
    val writer = LogWriter(File(ctx.filesDir, "capture-rows.csv"))

    fun event(name: String) {
        writer.append(LogFormat.eventRow(System.currentTimeMillis(), name))
    }

    /** One capture attempt. [fix] is null for `none`. Only time and accuracy of the fix are kept. */
    fun sample(ranAt: Long, fix: Fix?, source: String, mode: Mode) {
        val battery = readBattery(ctx)
        writer.append(
            LogFormat.sampleRow(
                ranAt = ranAt,
                fixAt = fix?.timeMs,
                accuracyM = fix?.accuracyM,
                source = source,
                batteryPct = battery.first,
                charging = battery.second,
                powerSave = isPowerSave(ctx),
                permission = permissionColumn(ctx),
                mode = mode.column,
            )
        )
    }

    fun deviceLine(): String = LogFormat.deviceLine(
        label = Prefs(ctx).label,
        model = Build.MODEL,
        os = Build.VERSION.RELEASE,
        appBuild = BuildConfigInfo.versionCode(ctx),
        utcOffsetMin = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000,
    )

    companion object {
        fun granted(ctx: Context, permission: String): Boolean =
            ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

        fun fineGranted(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
        fun coarseGranted(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
        fun fgGranted(ctx: Context) = fineGranted(ctx) || coarseGranted(ctx)

        /**
         * Before Android 10 (API 29) there is no separate background permission: holding foreground location
         * is enough. From API 29 it is its own permission.
         */
        fun bgGranted(ctx: Context): Boolean =
            if (Build.VERSION.SDK_INT >= 29) granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            else fgGranted(ctx)

        fun permissionColumn(ctx: Context): String =
            PermissionColumn.of(fineGranted(ctx), coarseGranted(ctx), bgGranted(ctx))

        /** Pair of (percent or null if unknown, charging). Uses the sticky battery broadcast, no receiver needed. */
        fun readBattery(ctx: Context): Pair<Int?, Boolean> {
            val i: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = i?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val pct = if (level >= 0 && scale > 0) level * 100 / scale else null
            val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
            return pct to charging
        }

        fun isPowerSave(ctx: Context): Boolean =
            (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode
    }
}

object BuildConfigInfo {
    @Suppress("DEPRECATION")
    fun versionCode(ctx: Context): Int = try {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
    } catch (e: Exception) {
        0
    }
}
