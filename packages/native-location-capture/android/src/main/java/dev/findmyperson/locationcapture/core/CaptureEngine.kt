package dev.findmyperson.locationcapture.core

import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.abs

/**
 * The capture state machine: the behaviour src/specs/NativeLocationCapture.ts writes on each
 * method, plus what Android does to a capture mechanism behind the app's back.
 *
 * It decides; it does not touch Android. Every effect goes through a port (Ports.kt), so the
 * unit tests run this exact class against fakes that refuse a start, kill a mechanism, revoke a
 * permission or fail the store.
 *
 * WHO CALLS IT
 *   The Turbo Module    start, stop, status, initStore, diagnosticsSince, debugInjectSample,
 *                       deviceConditions, networkConditions, the permission calls
 *   The periodic job    onWorkWake
 *   The service         servicePlan, onServiceFixes, onServiceHeartbeat, and the three
 *                       onService… reports of what the OS did to it
 *   The watchdog job    onWatchdog
 *   Boot, app launch    restore
 *
 * THE TWO MECHANISMS, AND THE FALLBACK
 *   Mode `wm` is a periodic job. Mode `fgs` is a foreground service. `start` with a different
 *   config stops whatever is alive and only then starts the other, so the two are never alive
 *   together.
 *   Android can refuse a foreground service (started from the background on Android 12+, or
 *   without the permission on Android 14+) and can kill it. When mode `fgs` is selected and its
 *   service is not alive, the engine schedules the periodic job as a fallback rather than
 *   capture nothing, keeps retrying the service from the watchdog and on app launch, and
 *   cancels the fallback the moment the service is back. The status stays honest about it: the
 *   selected mechanism is not alive, so `running` is false, `tier` is `stopped` and
 *   `service_not_running` is raised, exactly as the spec defines them. Samples from the
 *   fallback carry source `wm`, which is how they were obtained.
 *   There is no fallback in the other direction: mode `wm` never starts a foreground service,
 *   because that would show a notification the user chose not to have.
 *
 * RETENTION
 *   The full purge is TypeScript and runs when the app does. A phone on which the app is never
 *   opened is only ever woken here, so the wakes that capture also purge: [purgeIfDue], from
 *   the periodic job, the service's deliveries and the watchdog.
 *
 * LOCKS
 *   `operations` makes the calls that change which mechanism is alive run one at a time, for
 *   their whole length, including the wait for the service to come up.
 *   `stateLock` guards the persisted state and the filter's memory, and is held briefly.
 *   Fix delivery takes only `stateLock`. Nothing may call the engine from the main thread
 *   except [servicePlan], which takes no lock.
 */
class CaptureEngine(
    private val clock: Clock,
    private val stateStore: StateStore,
    private val diagnostics: DiagnosticsLog,
    private val mechanisms: Mechanisms,
    private val device: DeviceConditions,
    private val store: SampleStore,
    /** `debugInjectSample` exists only in a debuggable build. */
    private val debugBuild: Boolean,
) {
    private val operations = ReentrantLock()
    private val stateLock = Any()

    @Volatile
    private var state: CaptureState

    /**
     * The position of the last stored sample, for the distance rule. Memory only: a position is
     * never written anywhere but the encrypted store (see [SampleFilter.judge]).
     */
    private var lastStoredFix: Fix? = null

    /** When this process last purged. Memory only: a new process purges on its first wake. */
    private var lastPurgeAt: Long? = null

    /** The status last sent to listeners. Null until the first call computes a baseline. */
    private var lastEmitted: CaptureStatus? = null
    private val listeners = CopyOnWriteArraySet<CaptureListener>()

    init {
        val loaded = stateStore.load()
        state = loaded.copy(loadProblem = null)
        if (loaded.loadProblem != null) {
            record(DiagnosticEvents.STATE_RESET, loaded.loadProblem)
        }
    }

    fun addListener(listener: CaptureListener) {
        listeners.add(listener)
    }

    fun removeListener(listener: CaptureListener) {
        listeners.remove(listener)
    }

    // ---- the spec's methods ----

    /** `start`. Throws [CaptureException] with the code the spec names for each rejection. */
    fun start(raw: RawConfig): Unit = operation {
        val config = CaptureConfig.validate(raw)
        val permission = permissionState()
        if (!permission.hasLocation) {
            throw CaptureException(ErrorCode.PERMISSION_DENIED, "location permission is ${permission.wire}")
        }
        checkStore()?.let { throw CaptureException(ErrorCode.STORE_UNUSABLE, it) }

        val current = state.selection
        if (current != null && mechanismAlive(current.mode) && current.sameCaptureAs(config)) {
            return@operation
        }
        // Stop first, then start: the two mechanisms are never alive together.
        if (current != null) {
            stopMechanisms(current.mode)
        }
        val now = clock.nowUtcSec()
        update { saved ->
            saved.copy(
                selection = config,
                intervalSec = config.minIntervalSec,
                periods = if (current == null) saved.periods + Period(now, null) else saved.periods,
            )
        }
        if (current?.mode != config.mode) {
            record(DiagnosticEvents.MODE_CHANGED, config.mode.wire)
        }

        val refusal = bringUp(config)
        notifyStatus()
        if (refusal != null) {
            // The selection is kept: the watchdog retries, and for `fgs` the fallback captures.
            throw CaptureException(ErrorCode.START_FAILED, refusal)
        }
    }

    /** `stop`. Idempotent. */
    fun stop(): Unit = operation {
        val current = state.selection ?: return@operation
        stopMechanisms(current.mode)
        quietly { mechanisms.stopWatchdog() }
        val now = clock.nowUtcSec()
        update { saved ->
            saved.copy(
                selection = null,
                periods = saved.periods.map { if (it.to == null) it.copy(to = now) else it },
            )
        }
        record(DiagnosticEvents.MODE_CHANGED, CaptureMode.STOPPED)
        notifyStatus()
    }

    /** `getStatus`. */
    fun status(): CaptureStatus = synchronized(stateLock) { computeStatus(device.snapshot()) }

    /** `initStore`. Throws `store_unusable`, the message naming the failed step. */
    fun initStore(): Unit = operation {
        checkStore()?.let { throw CaptureException(ErrorCode.STORE_UNUSABLE, it) }
    }

    /** `getDiagnostics`. */
    fun diagnosticsSince(sinceTsUtc: Double): List<DiagnosticEntry> =
        diagnostics.since(if (sinceTsUtc.isFinite()) Math.ceil(sinceTsUtc).toLong() else Long.MIN_VALUE)

    /**
     * `getDeviceConditions`: on external power, and nobody using the app. Never throws; what
     * Android will not say counts as false, which makes the vacuum wait.
     */
    fun deviceConditions(): MaintenanceConditions = try {
        MaintenanceRules.conditions(device.power())
    } catch (e: Exception) {
        MaintenanceRules.UNKNOWN
    }

    /**
     * `getNetworkConditions`: whether the active connection is metered. Never throws; what
     * Android will not say counts as metered, which makes the bundle fetcher wait.
     */
    fun networkConditions(): NetworkConditions = try {
        NetworkRules.conditions(device.network())
    } catch (e: Exception) {
        NetworkRules.UNKNOWN
    }

    /** `debugInjectSample`: stores a synthetic fix past the filter, whether or not started. */
    fun debugInjectSample(lat: Double, lon: Double, tsUtc: Double, accuracyM: Double) {
        if (!debugBuild) {
            throw CaptureException(ErrorCode.NOT_AVAILABLE, "debugInjectSample exists only in debug builds")
        }
        if (!Geo.isValidLatLon(lat, lon) || !tsUtc.isFinite() || !accuracyM.isFinite() || accuracyM < 0) {
            throw CaptureException(ErrorCode.INVALID_ARGUMENT, "debugInjectSample: a value is out of range")
        }
        prime()
        val failure = write(Fix(lat, lon, tsUtc.toLong(), accuracyM), SOURCE_MANUAL)
        notifyStatus()
        failure?.let { throw CaptureException(ErrorCode.STORE_UNUSABLE, it) }
    }

    // ---- permission ----

    fun permissionState(): PermissionState = PermissionRules.state(device.snapshot(), state.askedForeground)

    /** What `requestPermission(step)` should show right now. */
    fun permissionAction(step: PermissionStep, sdkInt: Int): PermissionRules.Action =
        PermissionRules.action(step, permissionState(), sdkInt)

    /** The module is about to show the prompt (or the settings page) for [step]. */
    fun onPermissionPromptShown(step: PermissionStep) {
        if (step == PermissionStep.FOREGROUND) {
            update { it.copy(askedForeground = true) }
        }
        record(DiagnosticEvents.PERMISSION_PROMPT, step.wire)
    }

    /**
     * The user answered a prompt or came back from settings. A permission that arrives after
     * capture was selected may be what its mechanism was refused for, so the mechanism is
     * started again if it is not alive (the M0 trial app did the same on every grant).
     */
    fun onPermissionAnswered(): PermissionState = operation {
        state.selection?.let { ensureRunning(it) }
        notifyStatus()
        permissionState()
    }

    // ---- what the OS and the mechanisms report ----

    enum class RestoreReason(val detail: String) {
        BOOT(""),
        PACKAGE_REPLACED("package_replaced"),
        APP_LAUNCH("app_launch"),
    }

    /**
     * Brings the selected mode back with no JavaScript running: after a reboot, after the app
     * was replaced by an update, and on every app launch. Does nothing when nothing is selected.
     */
    fun restore(reason: RestoreReason): Unit = operation {
        val current = state.selection ?: return@operation
        if (reason != RestoreReason.APP_LAUNCH) {
            record(DiagnosticEvents.BOOT_RESTART, reason.detail)
        }
        ensureRunning(current)
        notifyStatus()
    }

    /** The hourly watchdog: restarts the selected mechanism if it is not alive. */
    fun onWatchdog(): Unit = operation {
        val current = state.selection
        if (current == null) {
            // A leftover schedule with nothing selected (the state file was lost): remove it.
            quietly { mechanisms.stopWatchdog() }
            return@operation
        }
        update { it.withWake(clock.nowUtcSec()) }
        if (mechanismAlive(current.mode)) {
            record(DiagnosticEvents.WATCHDOG_OK, current.mode.wire)
            if (current.mode == CaptureMode.FGS) stopFallback()
        } else {
            record(DiagnosticEvents.WATCHDOG_RESTART, current.mode.wire)
            ensureRunning(current)
        }
        // The wake that still comes when the capture job or the service does not run at all.
        purgeIfDue()
        notifyStatus()
    }

    enum class WakeOutcome { SKIPPED, STORED, FILTERED, NO_FIX, INVALID_FIX, STORE_UNUSABLE, NOT_CAPTURING }

    /**
     * One run of the periodic job: the whole of mode `wm`, and the fallback of mode `fgs`.
     * Takes one fresh fix, or failing that the platform's cached fix if it is recent and newer
     * than the last stored sample, and puts it through the filter. Blocks for as long as
     * [source] does; no lock is held while it waits.
     */
    fun onWorkWake(source: LocationSource): WakeOutcome {
        val config = operation {
            val current = state.selection
            when {
                current == null -> {
                    quietly { mechanisms.stopWork() }
                    null
                }
                current.mode == CaptureMode.FGS && mechanisms.isServiceAlive() -> {
                    // The service came back: the fallback has nothing left to do.
                    stopFallback()
                    null
                }
                else -> {
                    update { it.withWake(clock.nowUtcSec()) }
                    current
                }
            }
        } ?: return WakeOutcome.SKIPPED
        val label = if (config.mode == CaptureMode.WM) CaptureMode.WM.wire else LABEL_FALLBACK

        var origin = ORIGIN_CURRENT
        var fix = source.currentFix(config.accuracy, CURRENT_FIX_TIMEOUT_SEC)
        if (fix == null) {
            origin = ORIGIN_LAST_KNOWN
            fix = source.lastKnownFix()?.takeIf { isUsableCachedFix(it, config) }
        }
        val outcome = if (fix == null) {
            WakeOutcome.NO_FIX
        } else {
            submit(listOf(fix), SOURCE_WM, config).asOutcome()
        }
        val detail = if (fix == null) "$label:no_fix" else "$label:${outcome.name.lowercase()}:$origin"
        record(DiagnosticEvents.CAPTURE_WAKE, detail)
        purgeIfDue()
        notifyStatus()
        return outcome
    }

    /** What the foreground service should run, or null if mode `fgs` is not selected. Lock-free. */
    fun servicePlan(): ServicePlan? = state.selection?.takeIf { it.mode == CaptureMode.FGS }?.let(::servicePlanOf)

    /** The service was handed fixes; batched delivery can hand over several at once. */
    fun onServiceFixes(fixes: List<Fix>) {
        val config = state.selection?.takeIf { it.mode == CaptureMode.FGS } ?: return
        prime()
        update { it.withWake(clock.nowUtcSec()) }
        val result = submit(fixes, SOURCE_FGS, config)
        record(DiagnosticEvents.CAPTURE_WAKE, "${CaptureMode.FGS.wire}:${result.describe()}")
        purgeIfDue()
        notifyStatus()
    }

    /** The service is alive and the process is running: evidence for [WakeHeuristic]. */
    fun onServiceHeartbeat() {
        if (state.selection?.mode != CaptureMode.FGS) return
        prime()
        update { it.withWake(clock.nowUtcSec()) }
        notifyStatus()
    }

    /** The OS recreated the service by itself (it is sticky) and it is listening again. */
    fun onServiceRevived(): Unit = operation {
        if (state.selection?.mode != CaptureMode.FGS) return@operation
        record(DiagnosticEvents.CAPTURE_STARTED, CaptureMode.FGS.wire)
        stopFallback()
        notifyStatus()
    }

    /** The service could not go to the foreground or was refused location updates. */
    fun onServiceFailed(reason: String): Unit = operation {
        val current = state.selection?.takeIf { it.mode == CaptureMode.FGS } ?: return@operation
        record(DiagnosticEvents.START_FAILED, reason)
        startFallback(current)
        notifyStatus()
    }

    /** The service was destroyed and the engine had not asked for it. The watchdog will retry. */
    fun onServiceDestroyed(): Unit = operation {
        if (state.selection?.mode != CaptureMode.FGS) return@operation
        record(DiagnosticEvents.SERVICE_DESTROYED)
        notifyStatus()
    }

    /** Recomputes the status and tells listeners if it changed: on app resume, for instance. */
    fun refresh() {
        prime()
        notifyStatus()
    }

    /** Appends an entry to the diagnostics. For the platform layer's own events. */
    fun record(event: String, detail: String = "") {
        diagnostics.append(DiagnosticEntry(clock.nowUtcSec(), event, detail))
    }

    // ---- mechanisms ----

    private fun mechanismAlive(mode: CaptureMode): Boolean = when (mode) {
        CaptureMode.WM -> mechanisms.isWorkScheduled()
        CaptureMode.FGS -> mechanisms.isServiceAlive()
    }

    /**
     * Starts the mechanism of [config] and the watchdog. Returns null, or on a refusal the
     * reason, after logging `start_failed` and starting the fallback where there is one.
     */
    private fun bringUp(config: CaptureConfig): String? {
        quietly { mechanisms.startWatchdog() }
        // The fallback job must be gone before the service comes up. It is put back below if
        // the service is refused again, and only a real change is written to the diagnostics.
        val hadFallback = config.mode == CaptureMode.FGS && mechanisms.isWorkScheduled()
        if (hadFallback) mechanisms.stopWork()
        return try {
            when (config.mode) {
                CaptureMode.WM -> {
                    val period = WakeHeuristic.wakePeriodSec(config)
                    if (period > config.minIntervalSec) {
                        record(DiagnosticEvents.INTERVAL_CLAMPED, period.toString())
                    }
                    mechanisms.startWork(period)
                }
                CaptureMode.FGS -> mechanisms.startService(servicePlanOf(config))
            }
            if (hadFallback) record(DiagnosticEvents.FALLBACK_STOPPED)
            record(DiagnosticEvents.CAPTURE_STARTED, config.mode.wire)
            null
        } catch (refused: MechanismRefusedException) {
            record(DiagnosticEvents.START_FAILED, refused.reason)
            startFallback(config, announce = !hadFallback)
            refused.reason
        }
    }

    private fun ensureRunning(config: CaptureConfig) {
        if (mechanismAlive(config.mode)) {
            quietly { mechanisms.startWatchdog() }
            if (config.mode == CaptureMode.FGS) stopFallback()
        } else {
            bringUp(config)
        }
    }

    /** Stops whatever is alive, and says in the diagnostics what it was. */
    private fun stopMechanisms(selected: CaptureMode) {
        if (mechanisms.isServiceAlive()) {
            mechanisms.stopService()
            record(DiagnosticEvents.CAPTURE_STOPPED, CaptureMode.FGS.wire)
        }
        if (mechanisms.isWorkScheduled()) {
            mechanisms.stopWork()
            if (selected == CaptureMode.WM) {
                record(DiagnosticEvents.CAPTURE_STOPPED, CaptureMode.WM.wire)
            } else {
                record(DiagnosticEvents.FALLBACK_STOPPED)
            }
        }
    }

    /** Mode `fgs` only: the periodic job stands in while the service is not alive. */
    private fun startFallback(config: CaptureConfig, announce: Boolean = true) {
        if (config.mode != CaptureMode.FGS || mechanisms.isServiceAlive() || mechanisms.isWorkScheduled()) return
        try {
            mechanisms.startWork(maxOf(Math.ceil(config.minIntervalSec).toLong(), WakeHeuristic.MIN_WORK_PERIOD_SEC))
            if (announce) record(DiagnosticEvents.FALLBACK_STARTED)
        } catch (refused: MechanismRefusedException) {
            record(DiagnosticEvents.START_FAILED, "$LABEL_FALLBACK:${refused.reason}")
        }
    }

    private fun stopFallback() {
        if (mechanisms.isWorkScheduled()) {
            mechanisms.stopWork()
            record(DiagnosticEvents.FALLBACK_STOPPED)
        }
    }

    private fun servicePlanOf(config: CaptureConfig) = ServicePlan(
        notificationTitle = config.notificationTitle,
        notificationBody = config.notificationBody,
        intervalSec = Math.ceil(config.minIntervalSec).toLong(),
        accuracy = config.accuracy,
    )

    // ---- the capture path ----

    private class SubmitResult(val stored: Int, val filtered: Int, val invalid: Int, val failure: String?, val capturing: Boolean) {
        fun describe(): String = when {
            !capturing -> "not_capturing"
            failure != null -> "store_unusable"
            else -> "stored=$stored,filtered=$filtered" + if (invalid > 0) ",invalid=$invalid" else ""
        }

        fun asOutcome(): WakeOutcome = when {
            !capturing -> WakeOutcome.NOT_CAPTURING
            failure != null -> WakeOutcome.STORE_UNUSABLE
            stored > 0 -> WakeOutcome.STORED
            filtered > 0 -> WakeOutcome.FILTERED
            else -> WakeOutcome.INVALID_FIX
        }
    }

    /** Puts fixes through the filter, oldest first, and stores the ones that pass. */
    private fun submit(fixes: List<Fix>, source: String, expected: CaptureConfig): SubmitResult {
        synchronized(stateLock) {
            baseline()
            // The selection changed while the fix was on its way (a switch, a stop): drop it.
            if (state.selection !== expected) {
                return SubmitResult(0, 0, 0, null, capturing = false)
            }
            var stored = 0
            var filtered = 0
            var invalid = 0
            for (fix in fixes.sortedBy { it.tsUtc }) {
                when (SampleFilter.judge(fix, state.lastStoredTsUtc, lastStoredFix, expected)) {
                    SampleFilter.Verdict.FILTERED -> filtered++
                    SampleFilter.Verdict.INVALID -> invalid++
                    SampleFilter.Verdict.STORE -> {
                        val failure = write(fix, source)
                        if (failure != null) {
                            return SubmitResult(stored, filtered, invalid, failure, capturing = true)
                        }
                        stored++
                    }
                }
            }
            return SubmitResult(stored, filtered, invalid, null, capturing = true)
        }
    }

    /**
     * Stores one sample and tells listeners. Returns why it could not, or null. This is the
     * only place a coordinate goes anywhere, and it goes into the store.
     */
    private fun write(fix: Fix, source: String): String? {
        synchronized(stateLock) {
            val cells = H3.sampleCells(fix.lat, fix.lon)
            val accuracy = requireNotNull(fix.accuracyM)
            val failure = try {
                store.insert(StoredSample(fix.tsUtc, fix.lat, fix.lon, accuracy, source, cells.h3R7, cells.h3R5))
                null
            } catch (e: StoreUnusableException) {
                e.reason
            } catch (e: Exception) {
                e.javaClass.simpleName
            }
            noteStoreResult(failure)
            if (failure != null) return failure

            lastStoredFix = fix
            update { it.withSample(fix.tsUtc, clock.nowUtcSec()) }
            val event = SampleWrittenEvent(fix.tsUtc, accuracy, source)
            for (listener in listeners) quietly { listener.onSampleWritten(event) }
            return null
        }
    }

    /** A cached fix is used only if it is news: newer than the last sample and not stale. */
    private fun isUsableCachedFix(fix: Fix, config: CaptureConfig): Boolean {
        val newerThanStored = state.lastStoredTsUtc?.let { fix.tsUtc > it } ?: true
        return newerThanStored && clock.nowUtcSec() - fix.tsUtc <= config.minIntervalSec
    }

    // ---- retention ----

    /**
     * The retention purge of a wake with no JavaScript: fixes and stays that are past retention
     * are deleted from the store, by the statements of native-writer.json. Nothing is derived
     * and nothing is vacuumed here; both are TypeScript's (packages/shared, retention/).
     *
     * At most once per [PURGE_INTERVAL_SEC] in a process, since the service can be handed fixes
     * every few minutes. The time of the last purge is not kept between processes and never
     * decides what is deleted: the cutoff is computed from the clock on every run, so a purge
     * after a long gap, or after the clock was changed, deletes exactly what one at that moment
     * should. The gap is measured both ways, so a clock set back does not put the purge off.
     *
     * A purge that fails changes nothing (it is one transaction), is written to the
     * diagnostics, and is tried again at the next wake. It does not raise `store_unusable`: a
     * store that is unusable is reported by the write path, and is not purged at all.
     */
    private fun purgeIfDue() = synchronized(stateLock) {
        val now = clock.nowUtcSec()
        val last = lastPurgeAt
        if (last != null && abs(now - last) < PURGE_INTERVAL_SEC) return@synchronized
        if (state.storeFailure != null) return@synchronized
        try {
            val purged = store.purgeExpired(now)
            lastPurgeAt = now
            if (!purged.nothing) {
                record(
                    DiagnosticEvents.RETENTION_PURGE,
                    "samples=${purged.samples},stays=${purged.stays},trimmed=${purged.staysTrimmed}",
                )
            }
        } catch (e: StoreUnusableException) {
            record(DiagnosticEvents.RETENTION_PURGE_FAILED, e.reason)
        } catch (e: Exception) {
            record(DiagnosticEvents.RETENTION_PURGE_FAILED, e.javaClass.simpleName)
        }
    }

    // ---- store health ----

    /** The check `initStore` makes. Returns why the store is unusable, or null. */
    private fun checkStore(): String? {
        val failure = try {
            store.check()
        } catch (e: Exception) {
            e.javaClass.simpleName
        }
        noteStoreResult(failure)
        notifyStatus()
        return failure
    }

    private fun noteStoreResult(failure: String?) = synchronized(stateLock) {
        val before = state.storeFailure
        if (failure != null && before == null) record(DiagnosticEvents.STORE_UNUSABLE, failure)
        if (failure == null && before != null) record(DiagnosticEvents.STORE_USABLE)
        if (failure != before) update { it.copy(storeFailure = failure) }
    }

    // ---- status ----

    private fun computeStatus(snapshot: DeviceSnapshot): CaptureStatus {
        val now = clock.nowUtcSec()
        val current = state
        val selection = current.selection
        val permission = PermissionRules.state(snapshot, current.askedForeground)
        val running = selection != null && mechanismAlive(selection.mode)

        val health = buildList {
            if (permission != PermissionState.ALWAYS) add(HealthFlag.BACKGROUND_PERMISSION_MISSING)
            // Android 12+ lets the user grant approximate location only.
            if (snapshot.coarseGranted && !snapshot.fineGranted) add(HealthFlag.PRECISE_LOCATION_OFF)
            if (!snapshot.locationServicesOn) add(HealthFlag.LOCATION_SERVICES_OFF)
            if (selection != null && !running) add(HealthFlag.SERVICE_NOT_RUNNING)
            if (current.storeFailure != null) add(HealthFlag.STORE_UNUSABLE)
            if (!snapshot.ignoringBatteryOptimisations || snapshot.backgroundRestricted) {
                add(HealthFlag.BATTERY_OPTIMISATION_ACTIVE)
            }
            if (snapshot.hibernation == Hibernation.NOT_EXEMPT) add(HealthFlag.HIBERNATION_NOT_EXEMPT)
            if (selection != null &&
                WakeHeuristic.suspected(
                    now = now,
                    selectedSince = current.selectedSince(),
                    bootTsUtc = snapshot.bootTsUtc,
                    wakePeriodSec = WakeHeuristic.wakePeriodSec(selection),
                    wakes = current.wakes,
                )
            ) {
                add(HealthFlag.OEM_RESTRICTION_SUSPECTED)
            }
        }

        val tier = when {
            selection == null || !running || !permission.hasLocation -> CaptureTier.STOPPED
            permission == PermissionState.ALWAYS -> selection.mode.healthyTier
            else -> CaptureTier.THROTTLED
        }

        return CaptureStatus(
            running = running,
            mode = selection?.mode,
            tier = tier,
            permission = permission,
            health = health,
            lastSampleTsUtc = current.newestSampleTsUtc,
            samplesLast24h = current.samplesLast24h(now),
            expectedLast24h = current.expectedLast24h(now),
        )
    }

    /** The status before the first change of this process, so that change is seen as one. */
    private fun baseline() {
        if (lastEmitted == null) {
            lastEmitted = computeStatus(device.snapshot())
        }
    }

    /**
     * Sends `onStatusChanged` if the status differs from the one last sent, and writes a
     * diagnostics entry when the health flags, the permission or the standby bucket changed.
     * Those entries are what make a silently starved phone explainable afterwards.
     */
    private fun notifyStatus() = synchronized(stateLock) {
        val snapshot = device.snapshot()
        val status = computeStatus(snapshot)

        val health = status.health.joinToString(",") { it.wire }
        if (health != state.loggedHealth) {
            record(DiagnosticEvents.HEALTH_CHANGED, health)
            update { it.copy(loggedHealth = health) }
        }
        if (status.permission.wire != state.loggedPermission) {
            record(DiagnosticEvents.PERMISSION_CHANGED, status.permission.wire)
            update { it.copy(loggedPermission = status.permission.wire) }
        }
        if (snapshot.standbyBucket != null && snapshot.standbyBucket != state.loggedStandbyBucket) {
            record(DiagnosticEvents.STANDBY_BUCKET, snapshot.standbyBucket)
            update { it.copy(loggedStandbyBucket = snapshot.standbyBucket) }
        }

        if (lastEmitted != null && status != lastEmitted) {
            for (listener in listeners) quietly { listener.onStatusChanged(status) }
        }
        lastEmitted = status
    }

    // ---- plumbing ----

    /** One mechanism-changing call at a time, with a baseline status to compare against. */
    private inline fun <T> operation(block: () -> T): T = operations.withLock {
        prime()
        block()
    }

    private fun prime() = synchronized(stateLock) { baseline() }

    private fun update(transform: (CaptureState) -> CaptureState) = synchronized(stateLock) {
        val next = transform(state).pruned(clock.nowUtcSec())
        state = next
        stateStore.save(next)
    }

    /** For calls whose failure must not stop the operation they are part of. */
    private inline fun quietly(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
        }
    }

    companion object {
        /** `source` of a stored sample: values of `sampleSources` in native-writer.json. */
        const val SOURCE_WM = "wm"
        const val SOURCE_FGS = "fgs"
        const val SOURCE_MANUAL = "manual"

        /** How long the periodic job waits for a fresh fix. The M0 trial used the same. */
        const val CURRENT_FIX_TIMEOUT_SEC = 30L

        /** A process purges at most this often. An hour past 30 days is still "30 days". */
        const val PURGE_INTERVAL_SEC = 3_600L

        private const val LABEL_FALLBACK = "fallback"
        private const val ORIGIN_CURRENT = "current"
        private const val ORIGIN_LAST_KNOWN = "last_known"
    }
}
