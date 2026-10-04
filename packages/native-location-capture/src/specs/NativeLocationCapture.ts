/**
 * Turbo Native Module spec for background location capture (plan 5.5). CODEGEN INPUT.
 *
 * React Native's codegen reads this one file and emits the interface the Kotlin module and the
 * Swift/ObjC++ module must each implement (`codegenConfig` in ../../package.json). Committed
 * copies of that output live in ../../contracts/ and codegen.test.ts keeps them in step, so a
 * change here shows up as a diff in what both platforms have to implement.
 *
 * Codegen parses this file on its own and cannot follow imports, so every type used in `Spec`
 * is declared here and nothing is imported from @findmyperson/shared. Where a value is defined
 * by the shared contracts it is typed as a plain string or number and the comment names the
 * shared definition; ../fake.ts and the tests import those definitions directly.
 *
 * Two rules shape the interface:
 *
 *   1. Coordinates never cross the bridge on the capture path. The native module writes each
 *      fix into the encrypted store itself, with the statements in
 *      packages/shared/contracts/native-writer.json. JavaScript learns only that a sample was
 *      written. No return value and no event here carries a latitude or longitude, and
 *      codegen.test.ts fails if one is added. The single exception is the debug-only
 *      `debugInjectSample`, where JavaScript supplies a synthetic fix.
 *   2. The module is a state machine with observable health. Every way the platform can degrade
 *      capture is a `HealthFlag`, readable through `getStatus`, so the app can say so honestly.
 *
 * Retention is the module's too, where JavaScript cannot do it: on a capture wake both native
 * modules delete the fixes and stays that are past retention, with the purge statements of
 * native-writer.json, so a phone on which the app is never opened still keeps 30 days and no
 * more. Nothing in this interface starts or reports that; it shows only in the diagnostics.
 *
 * What a rejected promise carries is fixed in ../constants.ts (CAPTURE_ERROR_CODES).
 */
import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export type Accuracy = 'balanced' | 'high';

export type PermissionState =
  /** Never asked. */
  | 'undetermined'
  | 'denied'
  /** "While using the app". Capture runs but is throttled in the background. */
  | 'foreground_only'
  /** "Allow all the time" / Always. */
  | 'always'
  /** The user cannot change it (parental controls, device policy). */
  | 'restricted';

/** Permission is asked for in two trips; Android 11+ has no single prompt for both. */
export type PermissionStep = 'foreground' | 'background';

export type SettingsTarget =
  /** The app's own page in system settings. */
  | 'app'
  /** Android: battery optimisation, or the phone maker's autostart page where one is known. */
  | 'battery'
  /** Android: the "pause app activity if unused" exemption. */
  | 'hibernation';

/**
 * The capture mechanism selected by the last `start`, or `stopped`.
 *
 *   wm    Android, WorkManager periodic job, no notification. The default (captain decision,
 *         plan addendum 2026-10-02).
 *   fgs   Android, foreground service of type `location`, with a permanent notification.
 *   ios   iOS: continuous updates while the process lives, with significant-change, visit and
 *         region monitoring to relaunch it (plan 5.3).
 */
export type CaptureMode = 'wm' | 'fgs' | 'ios' | 'stopped';

/**
 * What capture is actually delivering right now.
 *
 *   periodic_work        mode `wm`, healthy
 *   foreground_service   mode `fgs`, healthy
 *   background_updates   mode `ios`, healthy
 *   throttled            a mode is running without the background permission, so the platform
 *                        delivers fixes only occasionally
 *   stopped              nothing is capturing: not started, no permission at all, or the selected
 *                        mechanism is not alive (see `service_not_running`)
 */
export type CaptureTier =
  'periodic_work' | 'foreground_service' | 'background_updates' | 'throttled' | 'stopped';

export type HealthFlag =
  // Both platforms.
  | 'background_permission_missing'
  | 'precise_location_off'
  | 'location_services_off'
  /** A mode is selected but its mechanism is not alive. */
  | 'service_not_running'
  /**
   * The store cannot be opened with the pinned cipher parameters, or its schema version is not
   * the one this build was made for. Nothing is written while this is set.
   */
  | 'store_unusable'
  // iOS.
  | 'background_refresh_off'
  | 'low_power_mode'
  // Android.
  | 'battery_optimisation_active'
  | 'hibernation_not_exempt'
  /** Heuristic, from capture wakes that did not happen. */
  | 'oem_restriction_suspected';

export type CaptureConfig = {
  /**
   * The cadence, in seconds: the module aims to store one sample per interval whether or not
   * the device has moved. Stay derivation needs samples from a phone that is sitting still, and
   * `expectedLast24h` counts one per interval. 900 in production.
   */
  minIntervalSec: number;
  /**
   * Metres. A fix that arrives sooner than `minIntervalSec` after the last stored sample is
   * stored only if it is at least this far from that sample, and is dropped otherwise. So a fix
   * is stored when enough time has passed OR the device has moved enough. 100 in production.
   */
  minDistanceM: number;
  accuracy: Accuracy;
  /**
   * Android: false selects mode `wm`, true selects mode `fgs`. This is a runtime setting the
   * user can change, not a build choice: see `start`. Ignored on iOS.
   */
  useForegroundService: boolean;
  /**
   * Android, mode `fgs`: the text of the permanent notification. The title must not be empty.
   * Both are ignored in every other mode.
   */
  notificationTitle: string;
  notificationBody: string;
};

export type CaptureStatus = {
  /** True while the mechanism of the selected mode is alive. */
  running: boolean;
  mode: CaptureMode;
  tier: CaptureTier;
  permission: PermissionState;
  /**
   * Every problem that currently applies, without duplicates, in `HealthFlag` order. Flags
   * describe the device, so all but `service_not_running` are reported whether or not capture
   * has been started. `background_permission_missing` is set whenever permission is not `always`.
   */
  health: HealthFlag[];
  /** Time of the newest stored sample, Unix seconds, or null if there is none. */
  lastSampleTsUtc: number | null;
  /** Samples stored with a fix time in the last 24 hours. */
  samplesLast24h: number;
  /**
   * How many samples a healthy device would have stored in the last 24 hours: one per
   * `minIntervalSec` for the part of that period in which a mode was selected. The ratio
   * samplesLast24h / expectedLast24h is the capture-rate health metric.
   */
  expectedLast24h: number;
};

/**
 * Whether now is a good moment to rewrite the store file: `DeviceConditions` of
 * @findmyperson/shared (retention/maintenance.ts), which vacuums only when both are true.
 */
export type DeviceConditions = {
  /** The phone is on external power: charging, or plugged in and full. */
  charging: boolean;
  /** Nobody is using the app: it is not on screen, or the screen is off. */
  idle: boolean;
};

/** Sent after a sample is committed to the store. Deliberately has no coordinates. */
export type SampleWrittenEvent = {
  /** Time of the fix, Unix seconds: the row's `ts_utc`. */
  tsUtc: number;
  accuracyM: number;
  /** The row's `source`: one of SAMPLE_SOURCES in @findmyperson/shared. */
  source: string;
};

/** One line of the local capture-health log. Never transmitted, and never holds a coordinate. */
export type DiagnosticEntry = {
  tsUtc: number;
  /**
   * What happened. DIAGNOSTIC_EVENTS in ../constants.ts lists the names both platforms use for
   * the same thing; a platform may log others, so a reader must tolerate a name it does not know.
   */
  event: string;
  /** Free text qualifying the event, for example the new mode. Empty if there is none. */
  detail: string;
};

export interface Spec extends TurboModule {
  /**
   * Returns the 32-byte store key as 64 hex characters, creating and persisting it on first
   * call (Keychain AfterFirstUnlockThisDeviceOnly on iOS, a Keystore-wrapped key on Android).
   * The native module reads the same key itself on every background wake; JavaScript needs it
   * only because op-sqlite takes the key as a string. It is a secret: never log or store it.
   */
  getOrCreateStoreKeyHex(): Promise<string>;

  /**
   * Absolute path of the app-private, backup-excluded directory that holds the store. The file
   * inside it is always STORE_FILE_NAME from @findmyperson/shared, on both sides.
   */
  getStoreDirectory(): Promise<string>;

  /**
   * Opens the store natively and checks that it is usable: SQLCipher with the pinned parameters
   * of packages/shared/contracts/cipher-params.json (each one read back, as in m0/store-proof),
   * WAL, and a schema version equal to `schemaVersion` in native-writer.json. Call it after the
   * TypeScript side has migrated the store. Idempotent. Rejects with `store_unusable`, the
   * message naming the failed step; `store_unusable` is then also set in the status until a
   * later check passes. The module repeats this check by itself on every background wake.
   */
  initStore(): Promise<void>;

  /**
   * Selects a capture mode and starts it. The selection is stored natively, so a reboot, an app
   * update or a relaunch by the OS restarts the same mode with the same config and no
   * JavaScript running.
   *
   * It is also how the mode is switched at runtime. Calling it while capture runs:
   *   - with the same config: does nothing, and does not reset any schedule;
   *   - with a different config: stops the active mechanism completely, then starts the new
   *     one. On Android this is how the user's setting moves between `wm` and `fgs`. There is
   *     never a moment with both mechanisms alive.
   *
   * Rejects, changing nothing and leaving any running mode running, with `invalid_argument`,
   * `permission_denied` (permission is not `foreground_only` or `always`) or `store_unusable`
   * (the check `initStore` makes, which `start` repeats).
   * Rejects with `start_failed` if the OS refuses the mechanism itself (Android can refuse a
   * foreground service started from the background): the selection is then kept, the status
   * shows `service_not_running`, and the module's own watchdog retries.
   */
  start(config: CaptureConfig): Promise<void>;

  /** Stops capture and clears the selection, so nothing restarts it. Idempotent. */
  stop(): Promise<void>;

  getStatus(): Promise<CaptureStatus>;

  /**
   * Shows the system prompt for one step, or where the platform has no prompt for it (background
   * on Android 11+) opens the settings page that grants it. Resolves with the state after the
   * user has answered or come back. It resolves with the unchanged state, showing nothing, when
   * the step is already granted, when `background` is asked before `foreground` is granted, and
   * when the platform will not ask again (`denied`, `restricted`): from there only
   * `openSystemSettings('app')` leads anywhere.
   */
  requestPermission(step: PermissionStep): Promise<PermissionState>;

  /** Opens a system settings page. Resolves false if this platform has no such page. */
  openSystemSettings(target: SettingsTarget): Promise<boolean>;

  /** Entries of the local capture-health log with tsUtc >= sinceTsUtc, oldest first. */
  getDiagnostics(sinceTsUtc: number): Promise<DiagnosticEntry[]>;

  /**
   * Whether the phone is on external power and whether anybody is using the app, read at the
   * moment of the call. It is the `deviceConditions` source of the retention maintenance in
   * @findmyperson/shared, which asks only when the weekly VACUUM is due. Never rejects: a fact
   * the platform will not give counts as false, which makes the vacuum wait. Works whether or
   * not capture is started.
   */
  getDeviceConditions(): Promise<DeviceConditions>;

  /**
   * Debug builds only: stores a synthetic fix with source `manual` exactly as a real one is
   * stored, skipping the interval and distance filter, and emits `onSampleWritten`. Works
   * whether or not capture is started. Rejects with `not_available` in a release build.
   */
  debugInjectSample(lat: number, lon: number, tsUtc: number, accuracyM: number): Promise<void>;

  /** A sample was committed to the store. */
  readonly onSampleWritten: CodegenTypes.EventEmitter<SampleWrittenEvent>;

  /** Any field of the status changed. Carries the whole new status. */
  readonly onStatusChanged: CodegenTypes.EventEmitter<CaptureStatus>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('NativeLocationCapture');
