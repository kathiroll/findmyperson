package dev.findmyperson.m0

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/**
 * Vendor "autostart" and "battery" screens. Android phone makers add their own app-killing rules on top of
 * stock Android, and each keeps its own settings screen with no public API. These component names are the
 * ones commonly reported for each vendor and are UNVERIFIED on the real phones: the first that opens wins,
 * and if none does we fall back to the app's own system settings page.
 */
object OemSettings {
    enum class Kind { AUTOSTART, BATTERY }

    class Target(val name: String, val intent: Intent)

    private fun component(name: String, pkg: String, cls: String) =
        Target(name, Intent().setComponent(ComponentName(pkg, cls)))

    fun candidates(brand: Brand, kind: Kind, ctx: Context): List<Target> = when (brand) {
        Brand.XIAOMI -> when (kind) {
            Kind.AUTOSTART -> listOf(
                component("miui_autostart", "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            )
            Kind.BATTERY -> listOf(
                Target(
                    "miui_battery_app",
                    Intent().setComponent(ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
                        .putExtra("package_name", ctx.packageName)
                        .putExtra("package_label", ctx.applicationInfo.loadLabel(ctx.packageManager).toString()),
                ),
                Target("miui_battery_list", Intent("miui.intent.action.POWER_HIDE_MODE_APP_LIST").addCategory(Intent.CATEGORY_DEFAULT)),
            )
        }
        Brand.ONEPLUS -> when (kind) {
            Kind.AUTOSTART -> listOf(
                component("oneplus_autolaunch", "com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"),
                component("oplus_startup", "com.oplus.battery", "com.oplus.startupapp.view.StartupAppListActivity"),
                component("coloros_startup", "com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"),
            )
            Kind.BATTERY -> listOf(
                component("oplus_battery", "com.oplus.battery", "com.oplus.powermanager.fuelgaue.PowerUsageModelActivity"),
                component("coloros_battery", "com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"),
            )
        }
        Brand.SAMSUNG -> when (kind) {
            // Samsung has no separate autostart page; "Never sleeping apps" lives in the battery screen.
            Kind.AUTOSTART, Kind.BATTERY -> listOf(
                component("samsung_battery", "com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"),
                component("samsung_battery_old", "com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                component("samsung_battery_cn", "com.samsung.android.sm_cn", "com.samsung.android.sm.ui.battery.BatteryActivity"),
            )
        }
        Brand.OTHER -> emptyList()
    }

    /** Tries each vendor screen, then the app's settings page. Returns the name of what opened. */
    fun open(ctx: Context, brand: Brand, kind: Kind): String {
        // We cannot ask "does this resolve?" on Android 11+ without package-visibility permissions, so just try to start it.
        for (t in candidates(brand, kind, ctx)) {
            try {
                ctx.startActivity(t.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                return t.name
            } catch (e: Exception) {
                // Not on this phone / not exported: try the next one.
            }
        }
        openAppDetails(ctx)
        return "fallback_app_details"
    }

    fun openAppDetails(ctx: Context) {
        ctx.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
