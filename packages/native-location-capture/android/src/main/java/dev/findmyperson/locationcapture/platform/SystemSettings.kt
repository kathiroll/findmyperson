package dev.findmyperson.locationcapture.platform

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.IntentCompat
import dev.findmyperson.locationcapture.core.DeviceSnapshot
import dev.findmyperson.locationcapture.core.Hibernation
import dev.findmyperson.locationcapture.core.SettingsTarget

/** The phone makers the M0 trial app had settings shortcuts for. */
enum class Brand {
    XIAOMI,
    ONEPLUS,
    SAMSUNG,
    OTHER;

    companion object {
        /** `Build.MANUFACTURER` is "Xiaomi" for Redmi and POCO too. */
        fun detect(manufacturer: String?): Brand {
            val name = manufacturer?.lowercase()?.trim() ?: return OTHER
            return when {
                "xiaomi" in name || "redmi" in name || "poco" in name -> XIAOMI
                "oneplus" in name -> ONEPLUS
                "samsung" in name -> SAMSUNG
                else -> OTHER
            }
        }
    }
}

/**
 * Which pages `openSystemSettings('battery')` tries, in order. The first that opens wins.
 *
 * The spec gives one target for two problems: "battery optimisation, or the phone maker's
 * autostart page where one is known". So the page is chosen by what is wrong right now:
 *   - while the app is battery-optimised (the `battery_optimisation_active` flag), Android's
 *     own page, which fixes that flag and exists on every phone;
 *   - once it is not, the phone maker's page, which is where `oem_restriction_suspected` is
 *     fixed and which no Android API describes.
 * Pure, so the order is unit-tested without a phone.
 */
object BatteryPages {
    const val BATTERY_OPTIMISATION = "battery_optimisation"
    const val APP_DETAILS = "app_details"

    private val VENDOR = mapOf(
        Brand.XIAOMI to listOf("miui_autostart", "miui_battery_app", "miui_battery_list"),
        Brand.ONEPLUS to listOf("oneplus_autolaunch", "oplus_startup", "coloros_startup", "oplus_battery", "coloros_battery"),
        Brand.SAMSUNG to listOf("samsung_battery", "samsung_battery_old", "samsung_battery_cn"),
        Brand.OTHER to emptyList(),
    )

    fun order(batteryOptimised: Boolean, brand: Brand): List<String> =
        if (batteryOptimised) {
            listOf(BATTERY_OPTIMISATION, APP_DETAILS)
        } else {
            VENDOR.getValue(brand) + listOf(BATTERY_OPTIMISATION, APP_DETAILS)
        }
}

/**
 * Opens the settings pages of `openSystemSettings`. Returns the name of the page that opened,
 * for the diagnostics, or null if none did.
 *
 * The vendor pages are opened by internal component names that are not public API. From the M0
 * field trial: `samsung_battery` opened the real screen on a Galaxy S24 Ultra (One UI, Android
 * 16); every OnePlus name failed on a Nord (Android 12) and fell through to the fallback; the
 * Xiaomi names have not been tried on a phone. A name that does not resolve costs nothing: the
 * next one is tried.
 *
 * This module never asks for the battery-optimisation exemption directly
 * (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS): Google Play restricts apps that do. It opens
 * the list page and the user makes the change.
 */
object SystemSettings {
    /** [device] is read by the caller, off the main thread; the page is opened on it. */
    fun open(target: SettingsTarget, context: Context, activity: Activity?, device: DeviceSnapshot): String? =
        when (target) {
            SettingsTarget.APP -> if (openAppDetails(context, activity)) BatteryPages.APP_DETAILS else null
            SettingsTarget.BATTERY -> {
                val optimised = !device.ignoringBatteryOptimisations || device.backgroundRestricted
                BatteryPages.order(optimised, Brand.detect(Build.MANUFACTURER))
                    .firstOrNull { name -> batteryIntent(name, context)?.let { start(it, context, activity) } == true }
            }
            SettingsTarget.HIBERNATION -> openHibernation(context, activity, device)
        }

    /** The app's own page in system settings: where a refused permission can still be granted. */
    fun openAppDetails(context: Context, activity: Activity?): Boolean = start(appDetails(context), context, activity)

    private fun appDetails(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

    private fun start(intent: Intent, context: Context, activity: Activity?): Boolean = try {
        if (activity != null) {
            activity.startActivity(intent)
        } else {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        true
    } catch (e: Exception) {
        // Not on this phone, or not exported.
        false
    }

    /**
     * The "Pause app activity if unused" page. The platform's intent for it must be started
     * for a result, so it needs an activity; and a phone without hibernation has no such page.
     */
    private fun openHibernation(context: Context, activity: Activity?, device: DeviceSnapshot): String? {
        if (device.hibernation == Hibernation.NOT_AVAILABLE || activity == null) return null
        return try {
            activity.startActivityForResult(
                IntentCompat.createManageUnusedAppRestrictionsIntent(context, context.packageName),
                HIBERNATION_REQUEST_CODE,
            )
            "hibernation"
        } catch (e: Exception) {
            null
        }
    }

    private fun component(packageName: String, className: String) =
        Intent().setComponent(ComponentName(packageName, className))

    private fun batteryIntent(name: String, context: Context): Intent? = when (name) {
        BatteryPages.BATTERY_OPTIMISATION -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        BatteryPages.APP_DETAILS -> appDetails(context)
        "miui_autostart" ->
            component("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
        "miui_battery_app" ->
            component("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
                .putExtra("package_name", context.packageName)
                .putExtra("package_label", context.applicationInfo.loadLabel(context.packageManager).toString())
        "miui_battery_list" ->
            Intent("miui.intent.action.POWER_HIDE_MODE_APP_LIST").addCategory(Intent.CATEGORY_DEFAULT)
        "oneplus_autolaunch" ->
            component("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")
        "oplus_startup" -> component("com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity")
        "coloros_startup" ->
            component("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")
        "oplus_battery" -> component("com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity")
        "coloros_battery" ->
            component("com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity")
        "samsung_battery" -> component("com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity")
        "samsung_battery_old" -> component("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity")
        "samsung_battery_cn" -> component("com.samsung.android.sm_cn", "com.samsung.android.sm.ui.battery.BatteryActivity")
        else -> null
    }

    private const val HIBERNATION_REQUEST_CODE = 0x464d
}
