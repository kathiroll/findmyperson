package dev.findmyperson.m0

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.content.PackageManagerCompat
import androidx.core.content.UnusedAppRestrictionsConstants
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The one screen. Plain framework views built in code (no XML layouts, no Compose) so the build has
 * nothing to fetch beyond androidx.core, WorkManager and Play services location.
 */
class MainActivity : Activity() {

    private lateinit var rec: Recorder
    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())

    private lateinit var modeGroup: RadioGroup
    private lateinit var modeWm: RadioButton
    private lateinit var modeFgs: RadioButton
    private lateinit var modeStopped: RadioButton
    private lateinit var stepTitle: TextView
    private lateinit var stepBody: TextView
    private lateinit var stepPrimary: Button
    private lateinit var stepSkip: Button
    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private lateinit var labelInput: EditText
    private lateinit var oemBox: LinearLayout

    private var suppressModeEvents = false
    private var hibernationStatus: Int? = null
    private var wmQueued: Boolean? = null
    private var currentStep = Step.FOREGROUND
    private val brand = BrandDetector.detect(Build.MANUFACTURER)

    private val ticker = object : Runnable {
        override fun run() {
            refresh()
            handler.postDelayed(this, 5000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rec = Recorder(this)
        prefs = Prefs(this)
        buildUi()
        if (savedInstanceState == null) rec.event("app_opened")
    }

    override fun onResume() {
        super.onResume()
        // Coming back from a system screen we sent the user to: log what they did there.
        if (prefs.pendingBg) {
            prefs.pendingBg = false
            if (Recorder.bgGranted(this)) {
                rec.event("perm_bg_granted")
                restartSelectedMode()
            } else {
                rec.event("perm_bg_denied")
            }
        }
        if (prefs.pendingBattery) {
            prefs.pendingBattery = false
            rec.event(if (isIgnoringBatteryOpt()) "battery_opt_exempted" else "battery_opt_declined")
        }
        refreshHibernation()
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    // ---- permission results ----

    @Deprecated("Framework callback kept to avoid the androidx.activity dependency")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        @Suppress("DEPRECATION")
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        when (requestCode) {
            REQ_FG -> {
                if (Recorder.fgGranted(this)) {
                    rec.event("perm_fg_granted")
                    // The user chose "approximate" only (Android 12+ lets them): samples will say foreground_approx.
                    if (!Recorder.fineGranted(this)) rec.event("perm_fg_approx_only")
                    restartSelectedMode()
                } else {
                    rec.event("perm_fg_denied")
                }
            }
            REQ_NOTIF -> rec.event(if (Recorder.granted(this, Manifest.permission.POST_NOTIFICATIONS)) "perm_notif_granted" else "perm_notif_denied")
        }
        refresh()
    }

    @Deprecated("Framework callback kept to avoid the androidx.activity dependency")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_HIB) refreshHibernation()
    }

    /** A permission arrived after capture was already started (and may have failed): start the mode again. */
    private fun restartSelectedMode() {
        prefs.selectedMode?.let { CaptureController.start(this, it, replace = false) }
    }

    // ---- setup steps ----

    private fun setupState(): SetupState = SetupState(
        fgGranted = Recorder.fgGranted(this),
        bgGranted = Recorder.bgGranted(this),
        bgNeedsSettings = Build.VERSION.SDK_INT >= 29,
        notifGranted = Build.VERSION.SDK_INT < 33 || Recorder.granted(this, Manifest.permission.POST_NOTIFICATIONS),
        notifRequired = Build.VERSION.SDK_INT >= 33 && prefs.selectedMode == Mode.FGS,
        hibernationOk = hibernationStatus.let { it == null || it == UnusedAppRestrictionsConstants.DISABLED ||
            it == UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE || it == UnusedAppRestrictionsConstants.ERROR },
        batteryOk = isIgnoringBatteryOpt(),
        skipped = Step.entries.filter { prefs.isSkipped(it) }.toSet(),
    )

    @SuppressLint("BatteryLife") // sideloaded trial only; Google Play restricts this request
    private fun onPrimaryClicked() {
        when (currentStep) {
            Step.FOREGROUND -> {
                rec.event("perm_fg_prompt_shown")
                ActivityCompat.requestPermissions(
                    this,
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                    REQ_FG,
                )
            }
            Step.BACKGROUND -> {
                // Android 11+ has no dialog for "Allow all the time"; the only route is the app's Settings page.
                rec.event("perm_bg_settings_opened")
                prefs.pendingBg = true
                OemSettings.openAppDetails(this)
            }
            Step.NOTIFICATIONS -> {
                rec.event("perm_notif_prompt_shown")
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
            }
            Step.HIBERNATION -> {
                rec.event("hibernation_prompt_shown")
                prefs.pendingHibernation = true
                val intent = IntentCompat.createManageUnusedAppRestrictionsIntent(this, packageName)
                @Suppress("DEPRECATION")
                startActivityForResult(intent, REQ_HIB)
            }
            Step.BATTERY -> {
                rec.event("battery_opt_prompt_shown")
                prefs.pendingBattery = true
                try {
                    // Sideloaded trial only: Google Play restricts apps that request this exemption.
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
            Step.DONE -> {}
        }
    }

    private fun onSkipClicked() {
        when (currentStep) {
            Step.NOTIFICATIONS -> { rec.event("perm_notif_denied:skipped"); prefs.setSkipped(Step.NOTIFICATIONS) }
            Step.HIBERNATION -> { rec.event("hibernation_declined:skipped"); prefs.setSkipped(Step.HIBERNATION) }
            Step.BATTERY -> { rec.event("battery_opt_declined:skipped"); prefs.setSkipped(Step.BATTERY) }
            else -> {}
        }
        refresh()
    }

    private fun refreshHibernation() {
        val future = PackageManagerCompat.getUnusedAppRestrictionsStatus(this)
        future.addListener({
            val status = try { future.get() } catch (e: Exception) { UnusedAppRestrictionsConstants.ERROR }
            hibernationStatus = status
            if (prefs.pendingHibernation) {
                prefs.pendingHibernation = false
                rec.event(if (status == UnusedAppRestrictionsConstants.DISABLED) "hibernation_exempted" else "hibernation_declined")
            }
            refresh()
        }, ContextCompat.getMainExecutor(this))
    }

    private fun isIgnoringBatteryOpt(): Boolean =
        (getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

    // ---- rendering ----

    private fun refresh() {
        val wmFuture = WorkManager.getInstance(this).getWorkInfosForUniqueWork(CaptureController.WM_WORK)
        wmFuture.addListener({
            wmQueued = try {
                wmFuture.get().any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING }
            } catch (e: Exception) { null }
            render()
        }, ContextCompat.getMainExecutor(this))
        render()
    }

    private fun render() {
        val mode = prefs.selectedMode
        suppressModeEvents = true
        when (mode) {
            Mode.WM -> modeWm.isChecked = true
            Mode.FGS -> modeFgs.isChecked = true
            null -> modeStopped.isChecked = true
        }
        suppressModeEvents = false

        renderStep()
        renderStatus(mode)
        val rows = rec.writer.tail(20)
        logText.text = if (rows.isEmpty()) "(no rows yet)" else rows.reversed().joinToString("\n")
    }

    private fun renderStep() {
        currentStep = SetupFlow.nextStep(setupState())
        stepSkip.visibility = if (currentStep in listOf(Step.NOTIFICATIONS, Step.HIBERNATION, Step.BATTERY)) View.VISIBLE else View.GONE
        stepPrimary.visibility = if (currentStep == Step.DONE) View.GONE else View.VISIBLE
        val (title, body, button) = when (currentStep) {
            Step.FOREGROUND -> Triple(
                "Step 1: location while the app is open",
                "The trial measures whether your phone gets a location fix in the background. To do that it first needs ordinary location access. " +
                    "Next, Android shows its own dialog. Choose Precise if offered, and \"While using the app\". Approximate also works but is logged as approximate.",
                "Continue to the Android dialog",
            )
            Step.BACKGROUND -> Triple(
                "Step 2: location all the time",
                "Background capture needs \"Allow all the time\". On Android 11 and later Android does not show a dialog for this. " +
                    "The button opens the app's Settings page: tap Permissions, then Location, then \"Allow all the time\", then come back here.",
                "Open Settings",
            )
            Step.NOTIFICATIONS -> Triple(
                "Step 3: notifications (Mode 2 only)",
                "Mode 2 runs a foreground service, which must show a permanent notification. On Android 13 and later you must allow notifications, or the notification is hidden (the service still runs).",
                "Continue to the Android dialog",
            )
            Step.HIBERNATION -> Triple(
                "Step 4: do not pause this app",
                "Android can automatically pause apps you do not open for a few months, which stops all background work and resets permissions. " +
                    "The button opens the exemption page: turn off \"Pause app activity if unused\" (or allow it to \"Remove permissions\" never) and come back.",
                "Open the exemption page",
            )
            Step.BATTERY -> Triple(
                "Step 5 (optional): battery optimisation",
                "Android may delay a battery-optimised app's background work. Excluding this test app helps it run on time. " +
                    "This is only for the sideloaded trial: Google Play restricts apps that ask for it.",
                "Ask Android to exempt this app",
            )
            Step.DONE -> Triple("Setup complete", "All steps are done. You can leave the app; capture continues in the background.", "")
        }
        stepTitle.text = title
        stepBody.text = body
        stepPrimary.text = button
    }

    private fun renderStatus(mode: Mode?) {
        val stats = LogStats.from(rec.writer.readRows())
        val (pct, charging) = Recorder.readBattery(this)
        val now = System.currentTimeMillis()
        val running = when (mode) {
            null -> "no (stopped)"
            Mode.FGS -> if (CaptureService.running) "yes (service alive)" else "NO (service not running)"
            Mode.WM -> when (wmQueued) {
                true -> "yes (job queued)"
                false -> "NO (no job queued)"
                null -> "unknown"
            }
        }
        val hib = when (hibernationStatus) {
            null -> "checking"
            UnusedAppRestrictionsConstants.DISABLED -> "exempt (good)"
            UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE -> "not available on this phone"
            UnusedAppRestrictionsConstants.ERROR -> "check failed"
            else -> "NOT exempt (code ${hibernationStatus})"
        }
        statusText.text = listOf(
            "Active mode: " + when (mode) { Mode.WM -> "Mode 1 (wm)"; Mode.FGS -> "Mode 2 (fgs)"; null -> "stopped" },
            "Capture running: $running",
            "Permission: ${Recorder.permissionColumn(this)}  (fine=${Recorder.fineGranted(this)} coarse=${Recorder.coarseGranted(this)} bg=${Recorder.bgGranted(this)})",
            "Rows written: ${stats.sampleRows} samples, ${stats.eventRows} events",
            "Last row: ${ago(stats.lastRowAt, now)}",
            "Last fix: ${ago(stats.lastFixAt, now)}",
            "Battery: ${pct ?: "?"}% ${if (charging) "(charging)" else "(not charging)"}",
            "Power save: ${if (Recorder.isPowerSave(this)) "ON" else "off"}",
            "Hibernation: $hib",
            "Battery optimisation: ${if (isIgnoringBatteryOpt()) "exempt (good)" else "optimised (may delay work)"}",
        ).joinToString("\n")
    }

    private fun ago(t: Long?, now: Long): String {
        if (t == null) return "never"
        val min = (now - t) / 60000
        val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(Date(t))
        return "$stamp (${if (min < 120) "$min min" else "${min / 60} h"} ago)"
    }

    // ---- export ----

    private fun export() {
        rec.event("export_tapped")
        // App-specific external folder: readable with `adb pull` and shareable through the FileProvider.
        val dir = (getExternalFilesDir("exports") ?: File(cacheDir, "exports")).also { it.mkdirs() }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.ROOT).format(Date())
        val model = Build.MODEL.replace(Regex("[^A-Za-z0-9]"), "_")
        val file = File(dir, "fmp-capture-android-$model-$stamp.csv")
        file.writeText(rec.writer.buildExport(rec.deviceLine()), Charsets.UTF_8)
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/csv")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        startActivity(Intent.createChooser(send, "Export capture log"))
        Toast.makeText(this, "Also saved at ${file.absolutePath}", Toast.LENGTH_LONG).show()
    }

    // ---- view construction ----

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    private fun text(s: String, sizeSp: Float = 14f, mono: Boolean = false, bold: Boolean = false) = TextView(this).apply {
        text = s
        textSize = sizeSp
        if (mono) typeface = android.graphics.Typeface.MONOSPACE
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(32))
        }
        val scroll = ScrollView(this).apply { addView(root) }
        // targetSdk 35 draws under the system bars; pad the scroll view by their size.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            val top: Int
            val bottom: Int
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                top = bars.top
                bottom = bars.bottom
            } else {
                @Suppress("DEPRECATION")
                top = insets.systemWindowInsetTop
                @Suppress("DEPRECATION")
                bottom = insets.systemWindowInsetBottom
            }
            v.setPadding(0, top, 0, bottom)
            insets
        }
        setContentView(scroll)

        root.addView(text("findmyperson M0 capture trial", 20f, bold = true))
        root.addView(text("Measures whether background location capture works. The log has times, accuracy and phone state only, never coordinates."))

        root.addView(text("Phone label (goes into the export)", bold = true))
        labelInput = EditText(this).apply {
            setText(prefs.label)
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine()
        }
        root.addView(labelInput)
        root.addView(button("Save label") {
            prefs.label = LogFormat.sanitize(labelInput.text.toString())
            Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show()
        })

        root.addView(text("Capture mode (one at a time)", bold = true))
        modeGroup = RadioGroup(this)
        modeWm = RadioButton(this).apply { text = "Mode 1: WorkManager every 15 min, no notification"; id = View.generateViewId() }
        modeFgs = RadioButton(this).apply { text = "Mode 2: foreground service, permanent notification"; id = View.generateViewId() }
        modeStopped = RadioButton(this).apply { text = "Stopped"; id = View.generateViewId() }
        listOf(modeWm, modeFgs, modeStopped).forEach { modeGroup.addView(it) }
        modeGroup.setOnCheckedChangeListener { _, checkedId ->
            if (suppressModeEvents) return@setOnCheckedChangeListener
            val selected = when (checkedId) { modeWm.id -> Mode.WM; modeFgs.id -> Mode.FGS; else -> null }
            if (selected != prefs.selectedMode) CaptureController.select(this, selected)
            refresh()
        }
        root.addView(modeGroup)

        stepTitle = text("", 16f, bold = true)
        stepBody = text("")
        stepPrimary = button("") { onPrimaryClicked() }
        stepSkip = button("Skip this step") { onSkipClicked() }
        root.addView(stepTitle)
        root.addView(stepBody)
        root.addView(stepPrimary)
        root.addView(stepSkip)
        root.addView(button("Open this app's system settings") { OemSettings.openAppDetails(this) })

        oemBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        oemBox.addView(text("Phone maker shortcuts (${Build.MANUFACTURER})", bold = true))
        oemBox.addView(text("Xiaomi, OnePlus and Samsung add their own background-kill rules. Set this app to autostart / no restrictions."))
        if (brand == Brand.XIAOMI || brand == Brand.ONEPLUS) {
            oemBox.addView(button("Open autostart settings") { openOem(OemSettings.Kind.AUTOSTART) })
        }
        oemBox.addView(button(if (brand == Brand.OTHER) "Open battery settings" else "Open battery settings (${brand.name.lowercase()})") {
            openOem(OemSettings.Kind.BATTERY)
        })
        root.addView(oemBox)

        root.addView(text("Status", 16f, bold = true))
        statusText = text("", 13f, mono = true)
        root.addView(statusText)
        root.addView(button("Export log") { export() })

        root.addView(text("Last 20 rows (newest first)", bold = true))
        logText = text("", 11f, mono = true)
        root.addView(logText)
    }

    private fun openOem(kind: OemSettings.Kind) {
        val opened = OemSettings.open(this, brand, kind)
        rec.event("oem_settings_opened:$opened")
    }

    private companion object {
        const val REQ_FG = 1
        const val REQ_NOTIF = 2
        const val REQ_HIB = 3
    }
}
