package dev.findmyperson.m0

import android.content.Context
import android.os.Build

/** Small persistent settings. SharedPreferences survive app restarts and reboots (credential storage, after first unlock). */
class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("m0", Context.MODE_PRIVATE)

    var selectedMode: Mode?
        get() = Mode.fromPref(sp.getString("mode", Mode.STOPPED))
        set(v) { sp.edit().putString("mode", Mode.toPref(v)).commit() }

    var label: String
        get() = sp.getString("label", null)?.takeIf { it.isNotBlank() } ?: Build.MODEL
        set(v) { sp.edit().putString("label", v).apply() }

    // "Pending" flags remember that we sent the user to a system screen, so onResume can log the outcome.
    var pendingBg: Boolean
        get() = sp.getBoolean("pending_bg", false)
        set(v) { sp.edit().putBoolean("pending_bg", v).apply() }

    var pendingHibernation: Boolean
        get() = sp.getBoolean("pending_hib", false)
        set(v) { sp.edit().putBoolean("pending_hib", v).apply() }

    var pendingBattery: Boolean
        get() = sp.getBoolean("pending_batt", false)
        set(v) { sp.edit().putBoolean("pending_batt", v).apply() }

    fun isSkipped(step: Step): Boolean = sp.getBoolean("skip_${step.name}", false)
    fun setSkipped(step: Step) { sp.edit().putBoolean("skip_${step.name}", true).apply() }
}
