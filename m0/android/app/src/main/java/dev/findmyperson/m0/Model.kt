package dev.findmyperson.m0

/** The two capture modes under test. [column] is the value written to the `mode` CSV column. */
enum class Mode(val column: String) {
    WM("wm"),
    FGS("fgs");

    companion object {
        /** Preference value for "nothing selected". */
        const val STOPPED = "stopped"

        fun fromPref(value: String?): Mode? = entries.firstOrNull { it.column == value }
        fun toPref(mode: Mode?): String = mode?.column ?: STOPPED
    }
}

object PermissionColumn {
    /**
     * Maps granted permissions to the log's `permission` column.
     * `_approx` is appended when only coarse (approximate) location is granted.
     * [background] must already account for OS version: below Android 10 there is no separate
     * background permission, so the caller passes the foreground result.
     */
    fun of(fine: Boolean, coarse: Boolean, background: Boolean): String {
        if (!fine && !coarse) return "denied"
        val base = if (background) "background" else "foreground"
        return if (fine) base else base + "_approx"
    }
}

/** The staged onboarding, in order. */
enum class Step { FOREGROUND, BACKGROUND, NOTIFICATIONS, HIBERNATION, BATTERY, DONE }

data class SetupState(
    val fgGranted: Boolean,
    val bgGranted: Boolean,
    val bgNeedsSettings: Boolean,
    val notifGranted: Boolean,
    val notifRequired: Boolean,
    val hibernationOk: Boolean,
    val batteryOk: Boolean,
    val skipped: Set<Step>,
)

object SetupFlow {
    /**
     * First step that still needs doing. Order matters: Android refuses a background-location grant until
     * foreground location is granted, so foreground always comes first.
     */
    fun nextStep(s: SetupState): Step = when {
        !s.fgGranted -> Step.FOREGROUND
        s.bgNeedsSettings && !s.bgGranted -> Step.BACKGROUND
        s.notifRequired && !s.notifGranted && Step.NOTIFICATIONS !in s.skipped -> Step.NOTIFICATIONS
        !s.hibernationOk && Step.HIBERNATION !in s.skipped -> Step.HIBERNATION
        !s.batteryOk && Step.BATTERY !in s.skipped -> Step.BATTERY
        else -> Step.DONE
    }
}

enum class Brand { XIAOMI, ONEPLUS, SAMSUNG, OTHER }

object BrandDetector {
    /** Build.MANUFACTURER is "Xiaomi" for Redmi and POCO too, and "OnePlus" for OnePlus. */
    fun detect(manufacturer: String?): Brand {
        val m = manufacturer?.lowercase()?.trim() ?: return Brand.OTHER
        return when {
            m.contains("xiaomi") || m.contains("redmi") || m.contains("poco") -> Brand.XIAOMI
            m.contains("oneplus") -> Brand.ONEPLUS
            m.contains("samsung") -> Brand.SAMSUNG
            else -> Brand.OTHER
        }
    }
}
