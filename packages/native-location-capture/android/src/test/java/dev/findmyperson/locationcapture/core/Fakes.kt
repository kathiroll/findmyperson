package dev.findmyperson.locationcapture.core

import dev.findmyperson.locationcapture.Contracts

/*
 * The operating system, played by hand. Each fake implements one port of Ports.kt and adds the
 * controls a test needs: refuse a start, kill a mechanism, revoke a permission, fail the store.
 * The engine under test is the production class, unchanged.
 */

const val T0 = 1_780_000_000L

/** Distinctive digits, so a leak of either coordinate is findable in any output. */
const val HOME_LAT = 12.971634
const val HOME_LON = 77.594612

/** About 55 m north of HOME: inside the 100 m distance filter. */
const val NEAR_HOME_LAT = 12.972134

/** About 1.1 km north of HOME. */
const val FAR_LAT = 12.981634

class FakeClock(var now: Long = T0) : Clock {
    override fun nowUtcSec(): Long = now
}

class MemoryStateStore : StateStore {
    var saved = CaptureState()

    override fun load(): CaptureState = saved

    override fun save(state: CaptureState) {
        saved = state
    }
}

class MemoryDiagnostics : DiagnosticsLog {
    val entries = mutableListOf<DiagnosticEntry>()

    override fun append(entry: DiagnosticEntry) {
        entries += entry
    }

    override fun since(sinceTsUtc: Long): List<DiagnosticEntry> = entries.filter { it.tsUtc >= sinceTsUtc }

    /** `event:detail` of every entry with one of the given event names, in order. */
    fun lines(vararg events: String): List<String> =
        entries.filter { events.isEmpty() || it.event in events }.map { "${it.event}:${it.detail}" }
}

/**
 * WorkManager and the foreground service. `transitions` is the log the spec's fake keeps:
 * every start, stop and kill of a mechanism, in order.
 */
class FakeMechanisms : Mechanisms {
    val transitions = mutableListOf<String>()
    var workScheduled = false
    var workPeriodSec: Long? = null
    var serviceAlive = false
    var servicePlan: ServicePlan? = null
    var watchdogScheduled = false

    /** While set, every service start is refused with this reason, as Android 12+ does. */
    var refuseService: String? = null

    /** Refuses only the next service start. */
    var refuseNextService: String? = null
    var refuseWork: String? = null

    /** The most mechanisms that were ever alive at once. Must stay at one. */
    var peakAlive = 0

    private fun noteAlive() {
        peakAlive = maxOf(peakAlive, (if (workScheduled) 1 else 0) + (if (serviceAlive) 1 else 0))
    }

    override fun startWork(periodSec: Long) {
        refuseWork?.let { throw MechanismRefusedException(it) }
        workScheduled = true
        workPeriodSec = periodSec
        transitions += "start:wm"
        noteAlive()
    }

    override fun stopWork() {
        if (workScheduled) transitions += "stop:wm"
        workScheduled = false
    }

    override fun isWorkScheduled(): Boolean = workScheduled

    override fun startService(plan: ServicePlan) {
        val refusal = refuseNextService ?: refuseService
        refuseNextService = null
        refusal?.let { throw MechanismRefusedException(it) }
        serviceAlive = true
        servicePlan = plan
        transitions += "start:fgs"
        noteAlive()
    }

    override fun stopService() {
        if (serviceAlive) transitions += "stop:fgs"
        serviceAlive = false
    }

    override fun isServiceAlive(): Boolean = serviceAlive

    override fun startWatchdog() {
        watchdogScheduled = true
    }

    override fun stopWatchdog() {
        watchdogScheduled = false
    }

    /** The OS killed the process: the service is gone, WorkManager's schedule survives. */
    fun killService() {
        if (serviceAlive) transitions += "killed:fgs"
        serviceAlive = false
    }

    /** WorkManager lost the job (a force stop cancels every job of the app). */
    fun loseWork() {
        if (workScheduled) transitions += "killed:wm"
        workScheduled = false
    }
}

/** A healthy, fully set-up phone unless a test says otherwise. */
class FakeDevice : DeviceConditions {
    var fine = true
    var coarse = true
    var background = true
    var restricted = false
    var locationServicesOn = true
    var ignoringBatteryOptimisations = true
    var backgroundRestricted = false
    var hibernation = Hibernation.EXEMPT
    var bootTsUtc = T0 - 30 * 86_400L
    var standbyBucket: String? = null

    /** In a pocket's opposite: on battery, screen on, the app on screen. */
    var onExternalPower = false
    var screenOn = true
    var appInForeground = true

    /** While set, Android throws instead of answering [power]. */
    var powerUnreadable = false

    override fun snapshot() = DeviceSnapshot(
        fineGranted = fine,
        coarseGranted = coarse,
        backgroundGranted = background && (fine || coarse),
        locationRestricted = restricted,
        locationServicesOn = locationServicesOn,
        ignoringBatteryOptimisations = ignoringBatteryOptimisations,
        backgroundRestricted = backgroundRestricted,
        hibernation = hibernation,
        bootTsUtc = bootTsUtc,
        standbyBucket = standbyBucket,
    )

    /** On mobile data, which is also what Android says with no network at all. */
    var activeNetworkMetered = true

    /** While set, Android throws instead of answering [network]: the permission is missing. */
    var networkUnreadable = false

    override fun power(): PowerSnapshot {
        if (powerUnreadable) throw SecurityException("no access to the power state")
        return PowerSnapshot(onExternalPower = onExternalPower, screenOn = screenOn, appInForeground = appInForeground)
    }

    override fun network(): NetworkSnapshot {
        if (networkUnreadable) throw SecurityException("ACCESS_NETWORK_STATE is not granted")
        return NetworkSnapshot(activeNetworkMetered = activeNetworkMetered)
    }

    fun grantNothing() {
        fine = false
        coarse = false
        background = false
    }

    fun grantForegroundOnly() {
        fine = true
        coarse = true
        background = false
    }
}

/** `retentionSec` of native-writer.json: how far behind the clock the purge's cutoff is. */
val RETENTION_SEC: Long = Contracts.json(Contracts.shared("native-writer.json")).getLong("retentionSec")

/** The store, in memory. The purge here is the contract's rule for fixes; StoreContractTest runs the SQL. */
class FakeStore : SampleStore {
    val samples = mutableListOf<StoredSample>()
    var failure: String? = null

    /** While set, a purge fails with it although the check passes (the store is busy). */
    var purgeFailure: String? = null

    /** The time each purge was given, in order. */
    val purges = mutableListOf<Long>()

    override fun check(): String? = failure

    override fun insert(sample: StoredSample) {
        failure?.let { throw StoreUnusableException(it) }
        samples += sample
    }

    override fun purgeExpired(nowTsUtc: Long): PurgeCounts {
        (failure ?: purgeFailure)?.let { throw StoreUnusableException(it) }
        purges += nowTsUtc
        val before = samples.size
        samples.removeAll { it.tsUtc < nowTsUtc - RETENTION_SEC }
        return PurgeCounts(samples = before - samples.size, stays = 0, staysTrimmed = 0)
    }
}

/**
 * The location provider. A test sets where the phone is; the periodic job asks for it through
 * [LocationSource], and [fixAt] builds what the service's update callback would be handed.
 */
class FakeLocationProvider(private val clock: FakeClock) : LocationSource {
    /** Where the phone is, or null when the platform will not produce a fresh fix. */
    var position: Pair<Double, Double>? = HOME_LAT to HOME_LON
    var accuracyM: Double? = 20.0

    /** The platform's cached fix, which may be old. */
    var cached: Fix? = null
    val requests = mutableListOf<String>()

    override fun currentFix(accuracy: Accuracy, timeoutSec: Long): Fix? {
        requests += "current:${accuracy.wire}:$timeoutSec"
        return position?.let { (lat, lon) -> Fix(lat, lon, clock.now, accuracyM) }
    }

    override fun lastKnownFix(): Fix? {
        requests += "last_known"
        return cached
    }

    fun fixAt(lat: Double = HOME_LAT, lon: Double = HOME_LON, tsUtc: Long = clock.now, accuracyM: Double? = 20.0) =
        Fix(lat, lon, tsUtc, accuracyM)
}

class RecordingListener : CaptureListener {
    val written = mutableListOf<SampleWrittenEvent>()
    val statuses = mutableListOf<CaptureStatus>()

    override fun onSampleWritten(event: SampleWrittenEvent) {
        written += event
    }

    override fun onStatusChanged(status: CaptureStatus) {
        statuses += status
    }
}

/** The engine with every port faked, and the moves a test makes most often. */
class Harness(
    val clock: FakeClock = FakeClock(),
    val stateStore: StateStore = MemoryStateStore(),
    val diagnostics: DiagnosticsLog = MemoryDiagnostics(),
    val mechanisms: FakeMechanisms = FakeMechanisms(),
    val device: FakeDevice = FakeDevice(),
    val store: FakeStore = FakeStore(),
    private val debugBuild: Boolean = true,
) {
    val location = FakeLocationProvider(clock)
    var listener = RecordingListener()
        private set
    var engine = newEngine()
        private set

    private fun newEngine() = CaptureEngine(clock, stateStore, diagnostics, mechanisms, device, store, debugBuild)
        .also { it.addListener(listener) }

    val log: MemoryDiagnostics get() = diagnostics as MemoryDiagnostics

    fun config(
        minIntervalSec: Double = 900.0,
        minDistanceM: Double = 100.0,
        accuracy: String? = "balanced",
        useForegroundService: Boolean = false,
        notificationTitle: String? = "findmyperson",
        notificationBody: String? = "Recording where this phone has been, on this phone only",
    ) = RawConfig(minIntervalSec, minDistanceM, accuracy, useForegroundService, notificationTitle, notificationBody)

    fun advance(seconds: Long) {
        clock.now += seconds
    }

    /** One run of the periodic job, if WorkManager has it scheduled. */
    fun runWork(): CaptureEngine.WakeOutcome? =
        if (mechanisms.workScheduled) engine.onWorkWake(location) else null

    /** The service's update callback, if the service is alive. */
    fun deliverToService(vararg fixes: Fix) {
        if (mechanisms.serviceAlive) engine.onServiceFixes(fixes.toList())
    }

    /**
     * The process died and a new one started: everything the engine held in memory is gone,
     * the foreground service with it. The state file and WorkManager's schedule survive.
     */
    fun restartProcess() {
        mechanisms.killService()
        listener = RecordingListener()
        engine = newEngine()
    }

    /** A reboot: a new process, a new boot time, and the boot receiver. */
    fun reboot() {
        restartProcess()
        device.bootTsUtc = clock.now
        engine.restore(CaptureEngine.RestoreReason.BOOT)
    }
}

fun codeOf(block: () -> Unit): ErrorCode? = try {
    block()
    null
} catch (e: CaptureException) {
    e.code
}
