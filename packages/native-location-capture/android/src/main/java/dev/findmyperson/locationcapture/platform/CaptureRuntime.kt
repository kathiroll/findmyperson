package dev.findmyperson.locationcapture.platform

import android.content.Context
import android.content.pm.ApplicationInfo
import dev.findmyperson.locationcapture.core.CaptureEngine
import dev.findmyperson.locationcapture.core.DiagnosticEvents
import dev.findmyperson.locationcapture.core.FileDiagnosticsLog
import dev.findmyperson.locationcapture.core.FileStateStore
import dev.findmyperson.locationcapture.store.KeystoreStoreKey
import dev.findmyperson.locationcapture.store.SqlCipherSampleStore
import java.io.File
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * The engine wired to Android, once per process.
 *
 * Android starts this process in several ways, and most of them have no React Native in them:
 * the periodic job, the watchdog job, the boot receiver, the OS recreating the sticky service.
 * Each of those entry points, and the Turbo Module when the app is open, asks for the same
 * instance here, so there is one engine and one view of the state whoever woke the process.
 */
class CaptureRuntime private constructor(context: Context) {
    val appContext: Context = context.applicationContext

    /** Beside the store's own directory; both are in `noBackupFilesDir`, which is never backed up. */
    private val directory = File(appContext.noBackupFilesDir, "fmp-capture")

    val storeKey = KeystoreStoreKey(appContext)
    val location: LocationBackend = LocationBackend.pick(appContext)
    val mechanisms = AndroidMechanisms(appContext)
    val device = AndroidDeviceConditions(appContext)

    val engine = CaptureEngine(
        clock = { System.currentTimeMillis() / 1000 },
        stateStore = FileStateStore(directory),
        diagnostics = FileDiagnosticsLog(directory),
        mechanisms = mechanisms,
        device = device,
        store = SqlCipherSampleStore(appContext, storeKey),
        debugBuild = (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
    )

    private val thread = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "fmp-capture") }

    /**
     * The one background thread of the module. The engine must not be called from the main
     * thread (it waits on WorkManager, the store and the service), so everything that arrives
     * on the main thread, and every call from JavaScript, is handed over here. Fix delivery to
     * the service uses it too, which keeps fixes in order.
     */
    val executor: Executor = Executor { task -> runAsync("task", task::run) }

    /** Runs [block] on the module's thread. A failure is written to the diagnostics, not thrown. */
    fun runAsync(what: String, block: () -> Unit) {
        thread.execute {
            try {
                block()
            } catch (t: Throwable) {
                try {
                    engine.record(DiagnosticEvents.INTERNAL_ERROR, "$what:${t.javaClass.simpleName}")
                } catch (_: Throwable) {
                }
            }
        }
    }

    companion object {
        @Volatile
        private var instance: CaptureRuntime? = null

        fun get(context: Context): CaptureRuntime =
            instance ?: synchronized(this) {
                instance ?: CaptureRuntime(context).also { runtime ->
                    instance = runtime
                    // How often Android recreates the process is itself a capture-health fact.
                    runtime.runAsync("process_started") {
                        runtime.engine.record(DiagnosticEvents.PROCESS_STARTED, "location=${runtime.location.name}")
                    }
                }
            }
    }
}
