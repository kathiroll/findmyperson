package dev.findmyperson.locationcapture

import android.Manifest
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import dev.findmyperson.locationcapture.core.CaptureEngine
import dev.findmyperson.locationcapture.core.CaptureException
import dev.findmyperson.locationcapture.core.CaptureListener
import dev.findmyperson.locationcapture.core.CaptureStatus
import dev.findmyperson.locationcapture.core.DiagnosticEvents
import dev.findmyperson.locationcapture.core.ErrorCode
import dev.findmyperson.locationcapture.core.PermissionRules
import dev.findmyperson.locationcapture.core.PermissionStep
import dev.findmyperson.locationcapture.core.RawConfig
import dev.findmyperson.locationcapture.core.SampleWrittenEvent
import dev.findmyperson.locationcapture.core.SettingsTarget
import dev.findmyperson.locationcapture.platform.CaptureRuntime
import dev.findmyperson.locationcapture.platform.SystemSettings
import dev.findmyperson.locationcapture.store.StoreLocation

/**
 * The Turbo Module: src/specs/NativeLocationCapture.ts, as React Native's codegen generated it
 * (NativeLocationCaptureSpec), implemented by forwarding to the engine.
 *
 * It holds no capture logic. It converts arguments and results, hands every call to the
 * module's own thread (a `start` can wait several seconds for the foreground service, and the
 * engine must not run on the main thread), and does the two things that need an Activity:
 * asking for a permission and opening a settings page.
 *
 * Capture does not depend on this class existing. With the app closed there is no React
 * Native; the workers, the service and the boot receiver reach the same engine through
 * [CaptureRuntime].
 */
class NativeLocationCaptureModule(reactContext: ReactApplicationContext) :
    NativeLocationCaptureSpec(reactContext), CaptureListener, LifecycleEventListener {

    private val runtime = CaptureRuntime.get(reactContext)
    private val engine: CaptureEngine get() = runtime.engine

    /** The `requestPermission` that is waiting for the user, if any. One at a time. */
    @Volatile
    private var waitingForUser: Promise? = null

    /** True while that request sent the user to a settings page and waits for them to return. */
    @Volatile
    private var waitingForReturn = false

    @Volatile
    private var leftTheApp = false

    override fun initialize() {
        super.initialize()
        engine.addListener(this)
        reactApplicationContext.addLifecycleEventListener(this)
        // Every app launch repairs the selected mode. The app is in the foreground now, which
        // is the one moment Android always allows a foreground service to start.
        runtime.runAsync("app_launch") { engine.restore(CaptureEngine.RestoreReason.APP_LAUNCH) }
    }

    override fun invalidate() {
        engine.removeListener(this)
        reactApplicationContext.removeLifecycleEventListener(this)
        super.invalidate()
    }

    // ---- the store ----

    override fun getOrCreateStoreKeyHex(promise: Promise) = answer(promise, "getOrCreateStoreKeyHex") {
        try {
            runtime.storeKey.getOrCreateKeyHex()
        } catch (e: Exception) {
            throw CaptureException(ErrorCode.STORE_UNUSABLE, "the store key could not be read (${e.javaClass.simpleName})")
        }
    }

    override fun getStoreDirectory(promise: Promise) = answer(promise, "getStoreDirectory") {
        StoreLocation.directory(reactApplicationContext).also { it.mkdirs() }.absolutePath
    }

    override fun initStore(promise: Promise) = answer(promise, "initStore") {
        engine.initStore()
        null
    }

    // ---- capture ----

    override fun start(config: ReadableMap, promise: Promise) = answer(promise, "start") {
        engine.start(rawConfig(config))
        null
    }

    override fun stop(promise: Promise) = answer(promise, "stop") {
        engine.stop()
        null
    }

    override fun getStatus(promise: Promise) = answer(promise, "getStatus") {
        toMap(engine.status().toWire())
    }

    override fun getDiagnostics(sinceTsUtc: Double, promise: Promise) = answer(promise, "getDiagnostics") {
        val entries: WritableArray = Arguments.createArray()
        for (entry in engine.diagnosticsSince(sinceTsUtc)) {
            entries.pushMap(toMap(entry.toWire()))
        }
        entries
    }

    override fun debugInjectSample(lat: Double, lon: Double, tsUtc: Double, accuracyM: Double, promise: Promise) =
        answer(promise, "debugInjectSample") {
            engine.debugInjectSample(lat, lon, tsUtc, accuracyM)
            null
        }

    // ---- permission ----

    override fun requestPermission(step: String, promise: Promise) {
        val parsed = PermissionStep.fromWire(step)
        if (parsed == null) {
            promise.reject(ErrorCode.INVALID_ARGUMENT.wire, "step must be foreground or background")
            return
        }
        runtime.runAsync("requestPermission") {
            val action = if (waitingForUser != null) PermissionRules.Action.NONE else engine.permissionAction(parsed, Build.VERSION.SDK_INT)
            when (action) {
                PermissionRules.Action.NONE -> promise.resolve(engine.permissionState().wire)
                PermissionRules.Action.FOREGROUND_DIALOG -> showDialog(
                    parsed,
                    arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION),
                    promise,
                )
                // Only ever chosen on Android 10, the one version with a dialog for it.
                PermissionRules.Action.BACKGROUND_DIALOG -> showDialog(parsed, arrayOf(BACKGROUND_LOCATION), promise)
                PermissionRules.Action.BACKGROUND_SETTINGS -> sendToSettings(parsed, promise)
            }
        }
    }

    /** The system permission dialog. Resolves when the user has answered it. */
    private fun showDialog(step: PermissionStep, permissions: Array<String>, promise: Promise) {
        val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            // Nothing can be shown without an activity; the state is unchanged.
            promise.resolve(engine.permissionState().wire)
            return
        }
        waitingForUser = promise
        engine.onPermissionPromptShown(step)
        val listener = PermissionListener { requestCode, _, _ ->
            if (requestCode == PERMISSION_REQUEST_CODE) {
                userAnswered()
                true
            } else {
                false
            }
        }
        UiThreadUtil.runOnUiThread {
            try {
                activity.requestPermissions(permissions, PERMISSION_REQUEST_CODE, listener)
            } catch (e: Exception) {
                userAnswered()
            }
        }
    }

    /**
     * Android 11 and later: "Allow all the time" has no dialog, only the app's page in system
     * settings. Opens it and resolves when the user comes back to the app (the M0 trial app's
     * flow; a tester's Samsung needed a second pass through it, which this allows).
     */
    private fun sendToSettings(step: PermissionStep, promise: Promise) {
        waitingForUser = promise
        waitingForReturn = true
        leftTheApp = false
        engine.onPermissionPromptShown(step)
        UiThreadUtil.runOnUiThread {
            if (!SystemSettings.openAppDetails(reactApplicationContext, reactApplicationContext.currentActivity)) {
                userAnswered()
            }
        }
    }

    /** Resolves the waiting request with the state the user left the permission in. */
    private fun userAnswered() {
        runtime.runAsync("permission_answered") {
            val promise = waitingForUser ?: return@runAsync
            waitingForUser = null
            waitingForReturn = false
            promise.resolve(engine.onPermissionAnswered().wire)
        }
    }

    // ---- settings ----

    override fun openSystemSettings(target: String, promise: Promise) {
        val parsed = SettingsTarget.fromWire(target)
        if (parsed == null) {
            promise.reject(ErrorCode.INVALID_ARGUMENT.wire, "target must be app, battery or hibernation")
            return
        }
        // Which page to open depends on the device state, which is read off the main thread;
        // the page itself is opened on it.
        runtime.runAsync("openSystemSettings") {
            val device = runtime.device.snapshot()
            UiThreadUtil.runOnUiThread {
                val opened = try {
                    SystemSettings.open(parsed, reactApplicationContext, reactApplicationContext.currentActivity, device)
                } catch (e: Exception) {
                    null
                }
                runtime.runAsync("openSystemSettings") {
                    if (opened != null) engine.record(DiagnosticEvents.SETTINGS_OPENED, "${parsed.wire}:$opened")
                    promise.resolve(opened != null)
                }
            }
        }
    }

    // ---- lifecycle ----

    override fun onHostResume() {
        if (waitingForReturn && leftTheApp) {
            userAnswered()
        } else {
            // The user may have changed a permission or a battery setting while away.
            runtime.runAsync("resume") { engine.refresh() }
        }
    }

    override fun onHostPause() {
        leftTheApp = true
    }

    override fun onHostDestroy() {}

    // ---- events ----

    override fun onSampleWritten(event: SampleWrittenEvent) = emit { emitOnSampleWritten(toMap(event.toWire())) }

    override fun onStatusChanged(status: CaptureStatus) = emit { emitOnStatusChanged(toMap(status.toWire())) }

    /** Until JavaScript has subscribed there is nobody to tell, and the emitter is not set up. */
    private inline fun emit(send: () -> Unit) {
        try {
            if (mEventEmitterCallback != null) send()
        } catch (_: Exception) {
        }
    }

    // ---- conversion ----

    /**
     * Runs [block] on the module's thread and settles the promise: a [CaptureException] becomes
     * a rejection carrying its code, as src/constants.ts defines them.
     */
    private fun answer(promise: Promise, what: String, block: () -> Any?) {
        runtime.runAsync(what) {
            try {
                promise.resolve(block())
            } catch (e: CaptureException) {
                promise.reject(e.code.wire, e.message, e)
            } catch (e: Exception) {
                promise.reject("unexpected", "$what failed: ${e.javaClass.simpleName}", e)
            }
        }
    }

    private fun rawConfig(config: ReadableMap): RawConfig {
        fun number(key: String): Double =
            if (config.hasKey(key) && config.getType(key) == ReadableType.Number) config.getDouble(key) else Double.NaN

        fun text(key: String): String? =
            if (config.hasKey(key) && config.getType(key) == ReadableType.String) config.getString(key) else null

        return RawConfig(
            minIntervalSec = number("minIntervalSec"),
            minDistanceM = number("minDistanceM"),
            accuracy = text("accuracy"),
            useForegroundService = config.hasKey("useForegroundService") &&
                config.getType("useForegroundService") == ReadableType.Boolean &&
                config.getBoolean("useForegroundService"),
            notificationTitle = text("notificationTitle"),
            notificationBody = text("notificationBody"),
        )
    }

    /** The wire maps of core/Model.kt hold only these value types. */
    private fun toMap(wire: Map<String, Any?>): WritableMap {
        val map = Arguments.createMap()
        for ((key, value) in wire) {
            when (value) {
                null -> map.putNull(key)
                is Boolean -> map.putBoolean(key, value)
                is Int -> map.putInt(key, value)
                is Double -> map.putDouble(key, value)
                is String -> map.putString(key, value)
                is List<*> -> map.putArray(key, Arguments.createArray().also { array -> value.forEach { array.pushString(it as String) } })
                else -> throw IllegalArgumentException("$key has a value the bridge cannot carry")
            }
        }
        return map
    }

    private companion object {
        const val PERMISSION_REQUEST_CODE = 0x464d

        /** Manifest.permission.ACCESS_BACKGROUND_LOCATION, which exists from Android 10. */
        const val BACKGROUND_LOCATION = "android.permission.ACCESS_BACKGROUND_LOCATION"
    }
}
