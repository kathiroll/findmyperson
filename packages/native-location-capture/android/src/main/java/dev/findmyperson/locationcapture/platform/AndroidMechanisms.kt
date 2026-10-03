package dev.findmyperson.locationcapture.platform

import android.content.Context
import android.content.Intent
import android.os.Looper
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkInfo
import androidx.work.WorkManager
import dev.findmyperson.locationcapture.core.MechanismRefusedException
import dev.findmyperson.locationcapture.core.Mechanisms
import dev.findmyperson.locationcapture.core.ServicePlan
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * [Mechanisms] on WorkManager and [CaptureService].
 *
 * The two unique work names are part of what is stored on the phone: WorkManager keeps them in
 * its database across restarts and app updates. Do not rename them without cancelling the old
 * names in the same release.
 */
class AndroidMechanisms(private val context: Context) : Mechanisms {
    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    // ---- the periodic job ----

    override fun startWork(periodSec: Long) {
        try {
            // No constraints on purpose (no network or charging needed), and no notification.
            // The period is a floor, not a promise: Doze and App Standby run the job later.
            val request = PeriodicWorkRequest.Builder(CaptureWorker::class.java, periodSec, TimeUnit.SECONDS).build()
            workManager
                .enqueueUniquePeriodicWork(CAPTURE_WORK, ExistingPeriodicWorkPolicy.CANCEL_AND_REENQUEUE, request)
                .result.get(WORK_MANAGER_TIMEOUT_SEC, TimeUnit.SECONDS)
        } catch (t: Throwable) {
            throw MechanismRefusedException(LocationBackend.reasonOf(t))
        }
    }

    override fun stopWork() {
        try {
            workManager.cancelUniqueWork(CAPTURE_WORK).result.get(WORK_MANAGER_TIMEOUT_SEC, TimeUnit.SECONDS)
        } catch (e: Exception) {
            // The cancellation is queued either way; only the wait for it gave up.
        }
    }

    override fun isWorkScheduled(): Boolean = try {
        workManager.getWorkInfosForUniqueWork(CAPTURE_WORK).get(WORK_MANAGER_TIMEOUT_SEC, TimeUnit.SECONDS).any {
            it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING || it.state == WorkInfo.State.BLOCKED
        }
    } catch (e: Exception) {
        false
    }

    // ---- the watchdog ----

    override fun startWatchdog() {
        // KEEP: an existing schedule is left alone, so calling this on every launch is harmless.
        val request = PeriodicWorkRequest.Builder(WatchdogWorker::class.java, WATCHDOG_PERIOD_HOURS, TimeUnit.HOURS).build()
        workManager.enqueueUniquePeriodicWork(WATCHDOG_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    override fun stopWatchdog() {
        workManager.cancelUniqueWork(WATCHDOG_WORK)
    }

    // ---- the foreground service ----

    /**
     * Asks Android for the service and waits until the service itself reports that it is in the
     * foreground and listening, or why it is not. Android can refuse in two places: this call
     * (a start from the background, Android 12+) and the service's own `startForeground`
     * (location permission not usable from where the app is, Android 14+).
     */
    override fun startService(plan: ServicePlan) {
        val attempt = ServiceControl.expectStart()
        try {
            ContextCompat.startForegroundService(context, Intent(context, CaptureService::class.java))
        } catch (t: Throwable) {
            ServiceControl.abandon(attempt)
            throw MechanismRefusedException(LocationBackend.reasonOf(t))
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            // The service starts on this very thread, so it cannot be waited for here. It
            // reports a failure to the engine by itself. (The engine is not meant to be called
            // from the main thread; this only keeps a mistake from becoming a deadlock.)
            ServiceControl.abandon(attempt)
            return
        }
        val outcome = attempt.await(SERVICE_START_TIMEOUT_SEC)
        ServiceControl.abandon(attempt)
        when {
            outcome == null -> throw MechanismRefusedException("ServiceStartTimeout")
            outcome.isNotEmpty() -> throw MechanismRefusedException(outcome)
        }
    }

    override fun stopService() {
        // First make it deliver nothing more, then let Android take it down.
        ServiceControl.running()?.shutDown()
        context.stopService(Intent(context, CaptureService::class.java))
    }

    override fun isServiceAlive(): Boolean = ServiceControl.running() != null

    companion object {
        const val CAPTURE_WORK = "fmp_capture"
        const val WATCHDOG_WORK = "fmp_capture_watchdog"
        const val WATCHDOG_PERIOD_HOURS = 1L

        private const val WORK_MANAGER_TIMEOUT_SEC = 10L

        /** Under the ten seconds a broadcast receiver has, since the boot receiver waits on this. */
        private const val SERVICE_START_TIMEOUT_SEC = 8L
    }
}

/**
 * What the service and the code that starts it tell each other. The service lives on the main
 * thread and the engine does not, so this is the only state they share, and all of it is atomic.
 */
internal object ServiceControl {
    /** One start that somebody is waiting for. [outcome] is "" for started, else the refusal. */
    class StartAttempt {
        private val done = CountDownLatch(1)

        @Volatile
        private var outcome: String? = null

        fun complete(result: String) {
            outcome = result
            done.countDown()
        }

        /** The outcome, or null if the service has not reported within the timeout. */
        fun await(timeoutSec: Long): String? = if (done.await(timeoutSec, TimeUnit.SECONDS)) outcome else null
    }

    private val service = AtomicReference<CaptureService?>()
    private val waiting = AtomicReference<StartAttempt?>()

    /** The service, while it is in the foreground and listening. Alive in this process only. */
    fun running(): CaptureService? = service.get()

    fun setRunning(instance: CaptureService) = service.set(instance)

    fun clearRunning(instance: CaptureService) = service.compareAndSet(instance, null)

    fun expectStart(): StartAttempt = StartAttempt().also(waiting::set)

    fun abandon(attempt: StartAttempt) = waiting.compareAndSet(attempt, null)

    /**
     * The service reports how its start went. Returns false when nobody was waiting, which
     * means Android started the service by itself and the engine has to be told another way.
     */
    fun report(outcome: String): Boolean {
        val attempt = waiting.getAndSet(null) ?: return false
        attempt.complete(outcome)
        return true
    }
}
