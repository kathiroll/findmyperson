import {
  CIPHER_KEY_VECTOR,
  haversineMeters,
  insertLocationSample,
  isValidLatLon,
  NATIVE_WRITER_CONTRACT,
  readSchemaVersion,
  sampleCells,
  type LocationSample,
  type NewLocationSample,
  type SampleSource,
  type SqlExecutor,
} from '@findmyperson/shared';
import {
  DIAGNOSTIC_EVENTS,
  HEALTH_FLAG_PLATFORMS,
  HEALTH_FLAGS,
  type CaptureErrorCode,
  type CapturePlatform,
} from './constants';
import type {
  CaptureConfig,
  CaptureMode,
  CaptureStatus,
  CaptureTier,
  DeviceConditions,
  DiagnosticEntry,
  HealthFlag,
  NetworkConditions,
  PermissionState,
  PermissionStep,
  SampleWrittenEvent,
  SettingsTarget,
  Spec,
} from './specs/NativeLocationCapture';

/**
 * An in-memory implementation of the capture module, for every task that has to call the module
 * with no phone attached. It implements `Spec`, the same interface the Kotlin and Swift modules
 * implement, and follows the rules written in the spec's comments; fake.test.ts is the
 * executable form of those rules.
 *
 * `controls` is the part a real module does not have: it plays the user, the operating system
 * and the passage of time, and lets a test look at what the module did.
 *
 * It imports nothing from react-native at runtime, so it runs under Node.
 */

type ActiveMode = Exclude<CaptureMode, 'stopped'>;

/** Health flags a test switches directly. The other three follow from the fake's own state. */
export type ConditionFlag = Exclude<
  HealthFlag,
  'background_permission_missing' | 'service_not_running' | 'store_unusable'
>;

/** A fix as the platform hands it to the module. Coordinates are required, the rest defaults. */
export type FakeFix = Pick<NewLocationSample, 'lat' | 'lon'> &
  Partial<Pick<NewLocationSample, 'ts_utc' | 'accuracy_m' | 'source'>>;

/**
 * What the module did with a delivered fix.
 *
 *   stored          written to the store, and `onSampleWritten` emitted
 *   filtered        dropped by the interval and distance rule of `CaptureConfig`
 *   not_capturing   capture is not selected, its mechanism is dead, or there is no permission
 *   store_unusable  the store failed its check, so nothing was written
 */
export type FixOutcome = 'stored' | 'filtered' | 'not_capturing' | 'store_unusable';

/** One change to a capture mechanism, in the order they happened. `killed` is the OS's doing. */
export type MechanismTransition = `${'start' | 'stop' | 'killed'}:${ActiveMode}`;

export interface FakeLocationCaptureOptions {
  /** Which platform's behaviour to imitate. Default `android`. */
  platform?: CapturePlatform;
  /** The clock, Unix seconds. Default: the system clock. */
  now?: () => number;
  /**
   * A store to write into. When given, samples are inserted into its `location_sample` table
   * the way the native module inserts them, and its schema version is checked the way the
   * native module checks it. When omitted, samples are kept in memory only.
   */
  db?: SqlExecutor;
  /** Location permission at the start. Default `undetermined`. */
  permission?: PermissionState;
  /** False imitates a release build, where `debugInjectSample` is not available. Default true. */
  debugBuild?: boolean;
}

export interface FakeControls {
  /**
   * What the user will answer when `step` is next asked. Defaults: `foreground_only` for
   * foreground, `always` for background.
   */
  answerPermission(step: PermissionStep, state: PermissionState): void;
  /** The user changed the permission in system settings. */
  setPermission(state: PermissionState): void;
  /** Turns a device condition on or off. Throws for a flag the platform cannot raise. */
  setCondition(flag: ConditionFlag, on: boolean): void;
  /**
   * The phone was plugged in or unplugged, the app left the screen or came back to it. What
   * `getDeviceConditions` answers; at the start the phone is on battery and in use.
   */
  setDeviceConditions(conditions: Partial<DeviceConditions>): void;
  /**
   * The phone joined Wi-Fi, went back to mobile data or lost its connection. What
   * `getNetworkConditions` answers; at the start the connection is metered, which is also what
   * a real module answers when the platform will not say.
   */
  setNetworkConditions(conditions: NetworkConditions): void;
  /** The platform hands the module a fix. This is the capture path, filter included. */
  deliverFix(fix: FakeFix): Promise<FixOutcome>;
  /** The OS will refuse the next `start` that has to start a mechanism. */
  refuseNextStart(reason: string): void;
  /** Makes the store fail its check with this reason; null makes it usable again. */
  setStoreFailure(reason: string | null): void;
  /** The OS killed the capture mechanism. The selection stays. */
  killMechanism(): void;
  /** The module's watchdog, a reboot or an OS relaunch brings the selected mode back. */
  restartMechanism(): void;

  /** Every stored sample, coordinates included: what a reader of the store would see. */
  samples(): readonly LocationSample[];
  transitions(): readonly MechanismTransition[];
  /** The config of the current selection, or null when stopped. */
  selectedConfig(): CaptureConfig | null;
  /** Settings pages that were opened, in order. */
  openedSettings(): readonly SettingsTarget[];
  /** Permission prompts that were actually shown, in order. */
  shownPermissionPrompts(): readonly PermissionStep[];
}

export interface FakeLocationCapture extends Spec {
  readonly controls: FakeControls;
}

const DAY_SEC = 86_400;
const DEFAULT_ACCURACY_M = 20;
/** Where the fake says the store lives. Nothing is ever opened there. */
const FAKE_STORE_DIRECTORY = '/fake/app-private/store';

const HEALTHY_TIER: Record<ActiveMode, CaptureTier> = {
  wm: 'periodic_work',
  fgs: 'foreground_service',
  ios: 'background_updates',
};

const DEFAULT_SOURCE: Record<ActiveMode, SampleSource> = {
  wm: 'wm',
  fgs: 'fgs',
  ios: 'continuous',
};

interface Selection {
  mode: ActiveMode;
  config: CaptureConfig;
}

type Handler<T> = (event: T) => void | Promise<void>;

/** Handlers run synchronously, in subscription order, before the triggering call resolves. */
function createEmitter<T>() {
  const subscriptions = new Set<{ handler: Handler<T> }>();
  return {
    subscribe(handler: Handler<T>) {
      const subscription = { handler };
      subscriptions.add(subscription);
      return { remove: () => void subscriptions.delete(subscription) };
    },
    emit(event: T) {
      for (const { handler } of [...subscriptions]) {
        void handler(event);
      }
    },
  };
}

/** Rejections look like a native module's: an Error carrying `code`. */
function fail(code: CaptureErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function configProblem(config: CaptureConfig, mode: ActiveMode): string | null {
  if (!(Number.isFinite(config.minIntervalSec) && config.minIntervalSec > 0)) {
    return 'minIntervalSec must be greater than 0';
  }
  if (!(Number.isFinite(config.minDistanceM) && config.minDistanceM >= 0)) {
    return 'minDistanceM must be 0 or more';
  }
  if (config.accuracy !== 'balanced' && config.accuracy !== 'high') {
    return 'accuracy must be balanced or high';
  }
  if (mode === 'fgs' && config.notificationTitle.trim() === '') {
    return 'notificationTitle must not be empty when useForegroundService is true';
  }
  return null;
}

/** Two configs are the same if every field the mode actually uses is the same. */
function sameCapture(a: Selection, b: Selection): boolean {
  const used = ({ mode, config }: Selection) => [
    mode,
    config.minIntervalSec,
    config.minDistanceM,
    config.accuracy,
    ...(mode === 'fgs' ? [config.notificationTitle, config.notificationBody] : []),
  ];
  return JSON.stringify(used(a)) === JSON.stringify(used(b));
}

export function createFakeLocationCapture(
  options: FakeLocationCaptureOptions = {},
): FakeLocationCapture {
  const platform = options.platform ?? 'android';
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const db = options.db;
  const debugBuild = options.debugBuild ?? true;

  let permission: PermissionState = options.permission ?? 'undetermined';
  const answers: Record<PermissionStep, PermissionState> = {
    foreground: 'foreground_only',
    background: 'always',
  };
  const conditions = new Set<ConditionFlag>();
  const deviceConditions: DeviceConditions = { charging: false, idle: false };
  const networkConditions: NetworkConditions = { metered: true };

  let selection: Selection | null = null;
  let mechanismAlive = false;
  let startRefusal: string | null = null;
  /** Periods in which a mode was selected, for expectedLast24h. `to` is null while selected. */
  const selectedPeriods: Array<{ from: number; to: number | null }> = [];
  let intervalSec: number | null = null;

  let forcedStoreFailure: string | null = null;
  let storeUnusable = false;

  const samples: LocationSample[] = [];
  let nextSampleId = 1;
  const diagnostics: DiagnosticEntry[] = [];
  const transitions: MechanismTransition[] = [];
  const openedSettings: SettingsTarget[] = [];
  const shownPrompts: PermissionStep[] = [];
  // iOS shows the Always upgrade once; later requests do nothing, as in the real engine.
  let iosUpgradePromptSpent = false;

  const sampleWritten = createEmitter<SampleWrittenEvent>();
  const statusChanged = createEmitter<CaptureStatus>();

  const hasLocationPermission = () => permission === 'always' || permission === 'foreground_only';

  function log(event: string, detail = ''): void {
    diagnostics.push({ tsUtc: now(), event, detail });
  }

  function computeStatus(): CaptureStatus {
    const at = now();
    const dayAgo = at - DAY_SEC;
    const running = selection !== null && mechanismAlive;

    const raised = new Set<HealthFlag>(conditions);
    if (permission !== 'always') {
      raised.add('background_permission_missing');
    }
    if (selection !== null && !mechanismAlive) {
      raised.add('service_not_running');
    }
    if (storeUnusable) {
      raised.add('store_unusable');
    }

    let tier: CaptureTier = 'stopped';
    if (selection !== null && running && hasLocationPermission()) {
      tier = permission === 'always' ? HEALTHY_TIER[selection.mode] : 'throttled';
    }

    let selectedSec = 0;
    for (const period of selectedPeriods) {
      selectedSec += Math.max(0, (period.to ?? at) - Math.max(period.from, dayAgo));
    }

    return {
      running,
      mode: selection?.mode ?? 'stopped',
      tier,
      permission,
      health: HEALTH_FLAGS.filter((flag) => raised.has(flag)),
      lastSampleTsUtc: samples.reduce<number | null>(
        (latest, sample) => (latest === null ? sample.ts_utc : Math.max(latest, sample.ts_utc)),
        null,
      ),
      samplesLast24h: samples.filter((sample) => sample.ts_utc >= dayAgo).length,
      expectedLast24h: intervalSec === null ? 0 : Math.floor(selectedSec / intervalSec),
    };
  }

  let lastEmitted = JSON.stringify(computeStatus());

  /** Emits onStatusChanged if the status differs from the one last emitted. */
  function notify(): void {
    const status = computeStatus();
    const serialised = JSON.stringify(status);
    if (serialised !== lastEmitted) {
      lastEmitted = serialised;
      statusChanged.emit(status);
    }
  }

  /** The check initStore makes. Returns why the store is unusable, or null if it is usable. */
  async function checkStore(): Promise<string | null> {
    let failure = forcedStoreFailure;
    if (failure === null && db !== undefined) {
      const found = await readSchemaVersion(db);
      if (found !== NATIVE_WRITER_CONTRACT.schemaVersion) {
        failure = `store schema is version ${found}, this module writes version ${NATIVE_WRITER_CONTRACT.schemaVersion}`;
      }
    }
    if (failure !== null && !storeUnusable) {
      log(DIAGNOSTIC_EVENTS.storeUnusable, failure);
    }
    storeUnusable = failure !== null;
    notify();
    return failure;
  }

  /** Stores one sample the way the native writer does. Returns why it could not, or null. */
  async function write(sample: NewLocationSample): Promise<string | null> {
    const failure = await checkStore();
    if (failure !== null) {
      return failure;
    }
    const id = db === undefined ? nextSampleId++ : await insertLocationSample(db, sample);
    samples.push({ id, ...sample, ...sampleCells(sample) });
    await purge();
    sampleWritten.emit({
      tsUtc: sample.ts_utc,
      accuracyM: sample.accuracy_m,
      source: sample.source,
    });
    notify();
    return null;
  }

  /**
   * The retention purge a native module runs on a capture wake, with the contract's statements:
   * fixes and stays past retention go, whether or not JavaScript ever runs the full purge.
   */
  async function purge(): Promise<void> {
    const cutoff = now() - NATIVE_WRITER_CONTRACT.retentionSec;
    for (let index = samples.length - 1; index >= 0; index--) {
      if ((samples[index]?.ts_utc ?? cutoff) < cutoff) {
        samples.splice(index, 1);
      }
    }
    if (db !== undefined) {
      await db.execute(NATIVE_WRITER_CONTRACT.deleteSamplesBeforeSql, [cutoff]);
      await db.execute(NATIVE_WRITER_CONTRACT.deleteStaysEndedBeforeSql, [cutoff]);
      await db.execute(NATIVE_WRITER_CONTRACT.trimStaysStartedBeforeSql, [cutoff, cutoff, cutoff]);
      await db.execute(NATIVE_WRITER_CONTRACT.rewindStayCursorSql);
    }
  }

  function startMechanism(mode: ActiveMode): void {
    mechanismAlive = true;
    transitions.push(`start:${mode}`);
    log(DIAGNOSTIC_EVENTS.captureStarted, mode);
  }

  function stopMechanism(mode: ActiveMode): void {
    mechanismAlive = false;
    transitions.push(`stop:${mode}`);
    log(DIAGNOSTIC_EVENTS.captureStopped, mode);
  }

  // A native module handles one call at a time. Without this, two overlapping start() calls
  // could each stop the old mechanism and both start a new one.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }

  const controls: FakeControls = {
    answerPermission(step, state) {
      answers[step] = state;
    },
    setPermission(state) {
      permission = state;
      notify();
    },
    setCondition(flag, on) {
      if (!(HEALTH_FLAG_PLATFORMS[flag] as readonly CapturePlatform[]).includes(platform)) {
        throw new Error(`${flag} cannot be raised on ${platform}`);
      }
      if (on) {
        conditions.add(flag);
      } else {
        conditions.delete(flag);
      }
      notify();
    },
    setDeviceConditions(next) {
      Object.assign(deviceConditions, next);
    },
    setNetworkConditions(next) {
      networkConditions.metered = next.metered;
    },
    deliverFix: (fix) =>
      serial(async () => {
        if (selection === null || !mechanismAlive || !hasLocationPermission()) {
          return 'not_capturing';
        }
        const sample: NewLocationSample = {
          ts_utc: fix.ts_utc ?? now(),
          lat: fix.lat,
          lon: fix.lon,
          accuracy_m: fix.accuracy_m ?? DEFAULT_ACCURACY_M,
          source: fix.source ?? DEFAULT_SOURCE[selection.mode],
        };
        if (!isValidLatLon(sample)) {
          throw new Error('deliverFix: lat or lon is out of range');
        }
        const last = samples.at(-1);
        if (
          last !== undefined &&
          sample.ts_utc - last.ts_utc < selection.config.minIntervalSec &&
          haversineMeters(last, sample) < selection.config.minDistanceM
        ) {
          return 'filtered';
        }
        return (await write(sample)) === null ? 'stored' : 'store_unusable';
      }),
    refuseNextStart(reason) {
      startRefusal = reason;
    },
    setStoreFailure(reason) {
      forcedStoreFailure = reason;
    },
    killMechanism() {
      if (selection !== null && mechanismAlive) {
        mechanismAlive = false;
        transitions.push(`killed:${selection.mode}`);
        notify();
      }
    },
    restartMechanism() {
      if (selection !== null && !mechanismAlive) {
        startMechanism(selection.mode);
        notify();
      }
    },
    samples: () => samples.map((sample) => ({ ...sample })),
    transitions: () => [...transitions],
    selectedConfig: () => (selection === null ? null : { ...selection.config }),
    openedSettings: () => [...openedSettings],
    shownPermissionPrompts: () => [...shownPrompts],
  };

  return {
    controls,

    getOrCreateStoreKeyHex: () => serial(async () => CIPHER_KEY_VECTOR.hex),

    getStoreDirectory: () => serial(async () => FAKE_STORE_DIRECTORY),

    initStore: () =>
      serial(async () => {
        const failure = await checkStore();
        if (failure !== null) {
          fail('store_unusable', failure);
        }
      }),

    start: (config) =>
      serial(async () => {
        const mode: ActiveMode =
          platform === 'ios' ? 'ios' : config.useForegroundService ? 'fgs' : 'wm';
        const problem = configProblem(config, mode);
        if (problem !== null) {
          fail('invalid_argument', problem);
        }
        if (!hasLocationPermission()) {
          fail('permission_denied', `location permission is ${permission}`);
        }
        const storeFailure = await checkStore();
        if (storeFailure !== null) {
          fail('store_unusable', storeFailure);
        }

        const next: Selection = { mode, config: { ...config } };
        if (selection !== null && mechanismAlive && sameCapture(selection, next)) {
          return;
        }
        // Stop first, then start: the two mechanisms are never alive together.
        if (selection !== null && mechanismAlive) {
          stopMechanism(selection.mode);
        }
        if (selection === null) {
          selectedPeriods.push({ from: now(), to: null });
        }
        if (selection?.mode !== mode) {
          log(DIAGNOSTIC_EVENTS.modeChanged, mode);
        }
        selection = next;
        intervalSec = config.minIntervalSec;

        if (startRefusal !== null) {
          const reason = startRefusal;
          startRefusal = null;
          log(DIAGNOSTIC_EVENTS.startFailed, reason);
          notify();
          fail('start_failed', reason);
        }
        startMechanism(mode);
        notify();
      }),

    stop: () =>
      serial(async () => {
        if (selection === null) {
          return;
        }
        if (mechanismAlive) {
          stopMechanism(selection.mode);
        }
        selection = null;
        const period = selectedPeriods.at(-1);
        if (period !== undefined) {
          period.to = now();
        }
        log(DIAGNOSTIC_EVENTS.modeChanged, 'stopped');
        notify();
      }),

    getStatus: () => serial(async () => computeStatus()),

    requestPermission: (step) =>
      serial(async () => {
        const askable =
          step === 'foreground'
            ? permission === 'undetermined'
            : permission === 'foreground_only' && !iosUpgradePromptSpent;
        if (askable) {
          if (step === 'background' && platform === 'ios') iosUpgradePromptSpent = true;
          shownPrompts.push(step);
          permission = answers[step];
          notify();
        }
        return permission;
      }),

    openSystemSettings: (target) =>
      serial(async () => {
        // iOS has one settings page per app and nothing for battery or hibernation.
        const exists = platform === 'android' || target === 'app';
        if (exists) {
          openedSettings.push(target);
        }
        return exists;
      }),

    getDiagnostics: (sinceTsUtc) =>
      serial(async () =>
        diagnostics.filter((entry) => entry.tsUtc >= sinceTsUtc).map((entry) => ({ ...entry })),
      ),

    getDeviceConditions: () => serial(async () => ({ ...deviceConditions })),

    getNetworkConditions: () => serial(async () => ({ ...networkConditions })),

    debugInjectSample: (lat, lon, tsUtc, accuracyM) =>
      serial(async () => {
        if (!debugBuild) {
          fail('not_available', 'debugInjectSample exists only in debug builds');
        }
        if (!isValidLatLon({ lat, lon }) || !Number.isFinite(tsUtc) || !(accuracyM >= 0)) {
          fail('invalid_argument', 'debugInjectSample: a value is out of range');
        }
        const failure = await write({
          ts_utc: tsUtc,
          lat,
          lon,
          accuracy_m: accuracyM,
          source: 'manual',
        });
        if (failure !== null) {
          fail('store_unusable', failure);
        }
      }),

    onSampleWritten: sampleWritten.subscribe,
    onStatusChanged: statusChanged.subscribe,
  };
}
