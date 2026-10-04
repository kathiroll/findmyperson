import {
  CIPHER_KEY_VECTOR,
  countSamplesSince,
  keyLiteral,
  listSamplesBetween,
  migrate,
  NATIVE_WRITER_CONTRACT,
  RETENTION_SEC,
  SAMPLE_SOURCES,
  sampleCells,
} from '@findmyperson/shared';
// Shared's in-memory SQLite is test support and deliberately not exported from the package
// root, so it is imported by path. It is the same database every table module is tested on.
import { openMemoryDb } from '@findmyperson/shared/src/testing/memoryDb';
import { describe, expect, test } from 'vitest';
import { createFakeLocationCapture, type FakeLocationCaptureOptions } from './fake';
import {
  CAPTURE_DEFAULTS,
  captureErrorCode,
  DIAGNOSTIC_EVENTS,
  type CaptureConfig,
  type CaptureStatus,
  type LocationCapture,
  type SampleWrittenEvent,
} from './index';

const T0 = 1_780_000_000;
const HOME = { lat: 12.9716, lon: 77.5946 };
/** About 55 m north of HOME: inside the 100 m distance filter. */
const NEAR_HOME = { lat: 12.9721, lon: 77.5946 };
/** About 1.1 km north of HOME. */
const FAR_FROM_HOME = { lat: 12.9816, lon: 77.5946 };

function config(overrides: Partial<CaptureConfig> = {}): CaptureConfig {
  return {
    ...CAPTURE_DEFAULTS,
    notificationTitle: 'findmyperson',
    notificationBody: 'Recording where this phone has been, on this phone only',
    ...overrides,
  };
}

/** A fake with a clock the test moves by hand, and permission already granted. */
function setup(options: FakeLocationCaptureOptions = {}) {
  let clock = T0;
  const capture = createFakeLocationCapture({
    now: () => clock,
    permission: 'always',
    ...options,
  });
  const statuses: CaptureStatus[] = [];
  const written: SampleWrittenEvent[] = [];
  capture.onStatusChanged((status) => void statuses.push(status));
  capture.onSampleWritten((event) => void written.push(event));
  return {
    capture,
    controls: capture.controls,
    statuses,
    written,
    advance(seconds: number) {
      clock += seconds;
    },
  };
}

/** The most mechanisms alive at once over a transition log. Must never exceed one. */
function peakAlive(transitions: readonly string[]): number {
  let alive = 0;
  let peak = 0;
  for (const transition of transitions) {
    alive += transition.startsWith('start:') ? 1 : -1;
    peak = Math.max(peak, alive);
  }
  return peak;
}

async function rejectionCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return captureErrorCode(error);
  }
  throw new Error('expected the call to reject');
}

test('the fake implements the interface the native modules implement', () => {
  const capture: LocationCapture = createFakeLocationCapture();
  expect(typeof capture.start).toBe('function');
});

test('before anything is asked or started, the status says so', async () => {
  const capture = createFakeLocationCapture({ now: () => T0 });
  expect(await capture.getStatus()).toEqual({
    running: false,
    mode: 'stopped',
    tier: 'stopped',
    permission: 'undetermined',
    health: ['background_permission_missing'],
    lastSampleTsUtc: null,
    samplesLast24h: 0,
    expectedLast24h: 0,
  });
});

describe('permission', () => {
  test('is granted in two steps, foreground first', async () => {
    const { capture, controls } = setup({ permission: 'undetermined' });
    expect(await capture.requestPermission('background')).toBe('undetermined');
    expect(controls.shownPermissionPrompts()).toEqual([]);

    expect(await capture.requestPermission('foreground')).toBe('foreground_only');
    expect(await capture.requestPermission('background')).toBe('always');
    expect(controls.shownPermissionPrompts()).toEqual(['foreground', 'background']);

    // Asking for what is already granted shows nothing and takes nothing away.
    expect(await capture.requestPermission('foreground')).toBe('always');
    expect(await capture.requestPermission('background')).toBe('always');
    expect(controls.shownPermissionPrompts()).toEqual(['foreground', 'background']);
  });

  test('a refusal is not asked again; only system settings changes it', async () => {
    const { capture, controls } = setup({ permission: 'undetermined' });
    controls.answerPermission('foreground', 'denied');
    expect(await capture.requestPermission('foreground')).toBe('denied');

    controls.answerPermission('foreground', 'foreground_only');
    expect(await capture.requestPermission('foreground')).toBe('denied');
    expect(controls.shownPermissionPrompts()).toEqual(['foreground']);

    expect(await capture.openSystemSettings('app')).toBe(true);
    controls.setPermission('always');
    expect((await capture.getStatus()).permission).toBe('always');
  });

  test('the user may decline the background step and stay at foreground only', async () => {
    const { capture, controls } = setup({ permission: 'foreground_only' });
    controls.answerPermission('background', 'foreground_only');
    expect(await capture.requestPermission('background')).toBe('foreground_only');
    expect((await capture.getStatus()).health).toContain('background_permission_missing');
  });
});

describe('start', () => {
  test('the default Android mode is WorkManager, with no foreground service', async () => {
    const { capture, controls } = setup();
    expect(CAPTURE_DEFAULTS.useForegroundService).toBe(false);
    await capture.start(config());
    expect(await capture.getStatus()).toMatchObject({
      running: true,
      mode: 'wm',
      tier: 'periodic_work',
      health: [],
    });
    expect(controls.transitions()).toEqual(['start:wm']);
  });

  test('needs at least foreground permission', async () => {
    for (const permission of ['undetermined', 'denied', 'restricted'] as const) {
      const { capture, controls } = setup({ permission });
      expect(await rejectionCode(capture.start(config()))).toBe('permission_denied');
      expect(controls.transitions()).toEqual([]);
      expect((await capture.getStatus()).mode).toBe('stopped');
    }
  });

  test('with foreground permission only, capture runs throttled and says why', async () => {
    const { capture } = setup({ permission: 'foreground_only' });
    await capture.start(config());
    expect(await capture.getStatus()).toMatchObject({
      running: true,
      mode: 'wm',
      tier: 'throttled',
      health: ['background_permission_missing'],
    });
  });

  test.each([
    ['a zero interval', { minIntervalSec: 0 }],
    ['an interval that is not a number', { minIntervalSec: Number.NaN }],
    ['a negative distance', { minDistanceM: -1 }],
    ['an unknown accuracy', { accuracy: 'best' as CaptureConfig['accuracy'] }],
    ['a foreground service with no title', { useForegroundService: true, notificationTitle: ' ' }],
  ])('rejects %s and leaves the running mode alone', async (_label, overrides) => {
    const { capture, controls } = setup();
    await capture.start(config());
    expect(await rejectionCode(capture.start(config(overrides)))).toBe('invalid_argument');
    expect(controls.transitions()).toEqual(['start:wm']);
    expect(await capture.getStatus()).toMatchObject({ running: true, mode: 'wm' });
  });

  test('with the same config again does nothing', async () => {
    const { capture, controls, statuses } = setup();
    await capture.start(config());
    const eventsSoFar = statuses.length;
    await capture.start(config());
    // The notification text is not used in mode wm, so changing it is not a change.
    await capture.start(config({ notificationTitle: 'another title' }));
    expect(controls.transitions()).toEqual(['start:wm']);
    expect(statuses).toHaveLength(eventsSoFar);
  });

  test('with a changed cadence restarts the same mode', async () => {
    const { capture, controls } = setup();
    await capture.start(config());
    await capture.start(config({ minIntervalSec: 1800 }));
    expect(controls.transitions()).toEqual(['start:wm', 'stop:wm', 'start:wm']);
    expect(controls.selectedConfig()?.minIntervalSec).toBe(1800);
  });
});

describe('switching the Android mode at runtime', () => {
  test('stops the active mode, then starts the other, in both directions', async () => {
    const { capture, controls } = setup();
    await capture.start(config({ useForegroundService: false }));
    await capture.start(config({ useForegroundService: true }));
    expect(await capture.getStatus()).toMatchObject({
      running: true,
      mode: 'fgs',
      tier: 'foreground_service',
    });
    await capture.start(config({ useForegroundService: false }));
    expect(await capture.getStatus()).toMatchObject({
      running: true,
      mode: 'wm',
      tier: 'periodic_work',
    });

    expect(controls.transitions()).toEqual([
      'start:wm',
      'stop:wm',
      'start:fgs',
      'stop:fgs',
      'start:wm',
    ]);
    expect(peakAlive(controls.transitions())).toBe(1);
  });

  test('is recorded in the diagnostics the way the M0 trial apps log it', async () => {
    const { capture } = setup();
    await capture.start(config());
    await capture.start(config({ useForegroundService: true }));
    await capture.stop();
    const entries = await capture.getDiagnostics(0);
    expect(entries.map((entry) => `${entry.event}:${entry.detail}`)).toEqual([
      'mode_changed:wm',
      'capture_started:wm',
      'capture_stopped:wm',
      'mode_changed:fgs',
      'capture_started:fgs',
      'capture_stopped:fgs',
      'mode_changed:stopped',
    ]);
  });

  test('tells listeners the new mode', async () => {
    const { capture, statuses } = setup();
    await capture.start(config());
    await capture.start(config({ useForegroundService: true }));
    expect(statuses.map((status) => status.mode)).toEqual(['wm', 'fgs']);
    expect(statuses.every((status) => status.running)).toBe(true);
  });

  test('never has both mechanisms alive, even when calls overlap', async () => {
    const { capture, controls } = setup();
    await Promise.all([
      capture.start(config({ useForegroundService: false })),
      capture.start(config({ useForegroundService: true })),
      capture.start(config({ useForegroundService: false })),
      capture.start(config({ useForegroundService: true })),
    ]);
    expect(peakAlive(controls.transitions())).toBe(1);
    expect(controls.transitions().at(-1)).toBe('start:fgs');
    expect((await capture.getStatus()).mode).toBe('fgs');
  });

  test('changing the notification text restarts the foreground service', async () => {
    const { capture, controls } = setup();
    await capture.start(config({ useForegroundService: true }));
    await capture.start(config({ useForegroundService: true, notificationBody: 'new text' }));
    expect(controls.transitions()).toEqual(['start:fgs', 'stop:fgs', 'start:fgs']);
  });

  test('when the OS refuses the new mode, the selection is kept and the status says so', async () => {
    const { capture, controls } = setup();
    await capture.start(config());
    controls.refuseNextStart('ForegroundServiceStartNotAllowedException');
    const switching = capture.start(config({ useForegroundService: true }));
    expect(await rejectionCode(switching)).toBe('start_failed');

    expect(controls.transitions()).toEqual(['start:wm', 'stop:wm']);
    expect(await capture.getStatus()).toMatchObject({
      running: false,
      mode: 'fgs',
      tier: 'stopped',
      health: ['service_not_running'],
    });
    const failures = (await capture.getDiagnostics(0)).filter(
      (entry) => entry.event === DIAGNOSTIC_EVENTS.startFailed,
    );
    expect(failures).toEqual([
      { tsUtc: T0, event: 'start_failed', detail: 'ForegroundServiceStartNotAllowedException' },
    ]);

    // The module's own watchdog retries without JavaScript.
    controls.restartMechanism();
    expect(await capture.getStatus()).toMatchObject({ running: true, mode: 'fgs', health: [] });
  });
});

describe('iOS', () => {
  test('has one mode and ignores useForegroundService', async () => {
    const { capture, controls } = setup({ platform: 'ios' });
    await capture.start(config({ useForegroundService: false }));
    await capture.start(config({ useForegroundService: true, notificationTitle: '' }));
    expect(controls.transitions()).toEqual(['start:ios']);
    expect(await capture.getStatus()).toMatchObject({
      running: true,
      mode: 'ios',
      tier: 'background_updates',
    });
  });

  test('has an app settings page and no battery or hibernation page', async () => {
    const { capture, controls } = setup({ platform: 'ios' });
    expect(await capture.openSystemSettings('app')).toBe(true);
    expect(await capture.openSystemSettings('battery')).toBe(false);
    expect(await capture.openSystemSettings('hibernation')).toBe(false);
    expect(controls.openedSettings()).toEqual(['app']);
  });

  test('samples from the continuous stream are labelled as such', async () => {
    const { capture, controls, written } = setup({ platform: 'ios' });
    await capture.start(config());
    await controls.deliverFix(HOME);
    await controls.deliverFix({ ...FAR_FROM_HOME, source: 'visit' });
    expect(written.map((event) => event.source)).toEqual(['continuous', 'visit']);
  });
});

test('Android opens all three settings pages', async () => {
  const { capture, controls } = setup();
  for (const target of ['app', 'battery', 'hibernation'] as const) {
    expect(await capture.openSystemSettings(target)).toBe(true);
  }
  expect(controls.openedSettings()).toEqual(['app', 'battery', 'hibernation']);
});

describe('stop', () => {
  test('stops the mechanism and clears the selection', async () => {
    const { capture, controls } = setup();
    await capture.start(config({ useForegroundService: true }));
    await capture.stop();
    expect(await capture.getStatus()).toMatchObject({
      running: false,
      mode: 'stopped',
      tier: 'stopped',
      health: [],
    });
    expect(controls.selectedConfig()).toBeNull();
    expect(controls.transitions()).toEqual(['start:fgs', 'stop:fgs']);

    // Nothing restarts it, and stopping again is harmless.
    controls.restartMechanism();
    await capture.stop();
    expect(controls.transitions()).toEqual(['start:fgs', 'stop:fgs']);
    expect(await controls.deliverFix(HOME)).toBe('not_capturing');
  });
});

describe('health', () => {
  test('a killed mechanism is reported until something restarts it', async () => {
    const { capture, controls, statuses } = setup();
    await capture.start(config());
    controls.killMechanism();
    expect(statuses.at(-1)).toMatchObject({
      running: false,
      mode: 'wm',
      tier: 'stopped',
      health: ['service_not_running'],
    });
    expect(await controls.deliverFix(HOME)).toBe('not_capturing');

    controls.restartMechanism();
    expect(statuses.at(-1)).toMatchObject({ running: true, tier: 'periodic_work', health: [] });
    expect(controls.transitions()).toEqual(['start:wm', 'killed:wm', 'start:wm']);
    expect(peakAlive(controls.transitions())).toBe(1);
  });

  test('losing the permission while running shows in the status', async () => {
    const { capture, controls, statuses } = setup();
    await capture.start(config());
    controls.setPermission('denied');
    expect(statuses.at(-1)).toMatchObject({
      running: true,
      tier: 'stopped',
      permission: 'denied',
      health: ['background_permission_missing'],
    });
    expect(await controls.deliverFix(HOME)).toBe('not_capturing');
  });

  test('device conditions are flags, in a fixed order, and clear again', async () => {
    const { capture, controls, statuses } = setup();
    controls.setCondition('oem_restriction_suspected', true);
    controls.setCondition('battery_optimisation_active', true);
    controls.setCondition('location_services_off', true);
    expect((await capture.getStatus()).health).toEqual([
      'location_services_off',
      'battery_optimisation_active',
      'oem_restriction_suspected',
    ]);
    expect(statuses).toHaveLength(3);

    controls.setCondition('battery_optimisation_active', false);
    controls.setCondition('battery_optimisation_active', false);
    expect(statuses).toHaveLength(4);
    expect((await capture.getStatus()).health).toEqual([
      'location_services_off',
      'oem_restriction_suspected',
    ]);
  });

  test('a flag belongs to its platform', () => {
    const android = setup().controls;
    const ios = setup({ platform: 'ios' }).controls;
    expect(() => android.setCondition('low_power_mode', true)).toThrow(/android/);
    expect(() => ios.setCondition('hibernation_not_exempt', true)).toThrow(/ios/);
    ios.setCondition('low_power_mode', true);
    ios.setCondition('background_refresh_off', true);
  });
});

describe('the capture path', () => {
  test('stores a fix and tells JavaScript only that it happened', async () => {
    const { capture, controls, written } = setup();
    await capture.start(config());
    expect(await controls.deliverFix({ ...HOME, accuracy_m: 12 })).toBe('stored');

    expect(written).toEqual([{ tsUtc: T0, accuracyM: 12, source: 'wm' }]);
    expect(await capture.getStatus()).toMatchObject({ lastSampleTsUtc: T0, samplesLast24h: 1 });
    expect(controls.samples()).toEqual([
      { id: 1, ts_utc: T0, ...HOME, accuracy_m: 12, source: 'wm', ...sampleCells(HOME) },
    ]);
  });

  test('labels each sample with the mode that captured it', async () => {
    const { capture, controls, written, advance } = setup();
    await capture.start(config());
    await controls.deliverFix(HOME);
    await capture.start(config({ useForegroundService: true }));
    advance(900);
    await controls.deliverFix(HOME);
    expect(written.map((event) => event.source)).toEqual(['wm', 'fgs']);
    for (const event of written) {
      expect(SAMPLE_SOURCES).toContain(event.source);
    }
  });

  test('keeps a fix when enough time has passed or the phone has moved enough', async () => {
    const { capture, controls, advance } = setup();
    await capture.start(config({ minIntervalSec: 900, minDistanceM: 100 }));
    expect(await controls.deliverFix(HOME)).toBe('stored');

    advance(60);
    expect(await controls.deliverFix(NEAR_HOME)).toBe('filtered');
    expect(await controls.deliverFix(FAR_FROM_HOME)).toBe('stored');

    // A phone sitting still is still sampled once per interval: stays are built from these.
    advance(899);
    expect(await controls.deliverFix(FAR_FROM_HOME)).toBe('filtered');
    advance(1);
    expect(await controls.deliverFix(FAR_FROM_HOME)).toBe('stored');
    expect(controls.samples()).toHaveLength(3);
  });

  test('no coordinate reaches anything JavaScript can read', async () => {
    const { capture, controls, statuses, written } = setup();
    await capture.start(config());
    await controls.deliverFix(HOME);
    await capture.debugInjectSample(FAR_FROM_HOME.lat, FAR_FROM_HOME.lon, T0 + 5, 30);

    const visible = JSON.stringify([
      statuses,
      written,
      await capture.getStatus(),
      await capture.getDiagnostics(0),
    ]);
    for (const coordinate of [HOME.lat, HOME.lon, FAR_FROM_HOME.lat]) {
      expect(visible).not.toContain(String(coordinate));
    }
    expect(visible).not.toMatch(/"(lat|lon|lng|latitude|longitude)"/);
    for (const event of written) {
      expect(Object.keys(event).sort()).toEqual(['accuracyM', 'source', 'tsUtc']);
    }
  });

  test('a removed listener hears nothing more', async () => {
    const { capture, controls } = setup();
    const heard: number[] = [];
    const subscription = capture.onSampleWritten((event) => void heard.push(event.tsUtc));
    await capture.start(config());
    await controls.deliverFix(HOME);
    subscription.remove();
    await controls.deliverFix(FAR_FROM_HOME);
    expect(heard).toEqual([T0]);
  });

  test('rejects a fix that is not a place', async () => {
    const { capture, controls } = setup();
    await capture.start(config());
    await expect(controls.deliverFix({ lat: 91, lon: 0 })).rejects.toThrow(/out of range/);
  });
});

describe('the capture-rate numbers', () => {
  test('expect one sample per interval while a mode is selected, over the last 24 hours', async () => {
    const { capture, advance } = setup();
    await capture.start(config({ minIntervalSec: 900 }));
    advance(2 * 3600);
    expect((await capture.getStatus()).expectedLast24h).toBe(8);

    await capture.stop();
    advance(3600);
    expect((await capture.getStatus()).expectedLast24h).toBe(8);

    // 23 hours later the two selected hours begin to leave the window; an hour on, they are gone.
    advance(22 * 3600);
    expect((await capture.getStatus()).expectedLast24h).toBe(4);
    advance(3600);
    expect((await capture.getStatus()).expectedLast24h).toBe(0);
  });

  test('count only samples from the last 24 hours', async () => {
    const { capture, controls, advance } = setup();
    await capture.start(config());
    await controls.deliverFix(HOME);
    advance(86_400 - 900);
    await controls.deliverFix(HOME);
    expect(await capture.getStatus()).toMatchObject({
      samplesLast24h: 2,
      lastSampleTsUtc: T0 + 86_400 - 900,
    });
    advance(901);
    expect(await capture.getStatus()).toMatchObject({
      samplesLast24h: 1,
      expectedLast24h: 96,
    });
  });
});

describe('debugInjectSample', () => {
  test('stores a manual sample, past the filter and without capture running', async () => {
    const { capture, controls, written } = setup();
    await capture.debugInjectSample(HOME.lat, HOME.lon, T0 - 100, 5);
    await capture.debugInjectSample(HOME.lat, HOME.lon, T0 - 99, 5);
    expect(written).toEqual([
      { tsUtc: T0 - 100, accuracyM: 5, source: 'manual' },
      { tsUtc: T0 - 99, accuracyM: 5, source: 'manual' },
    ]);
    expect(controls.samples().map((sample) => sample.source)).toEqual(['manual', 'manual']);
  });

  test('does not exist in a release build', async () => {
    const { capture, controls } = setup({ debugBuild: false });
    const injecting = capture.debugInjectSample(HOME.lat, HOME.lon, T0, 5);
    expect(await rejectionCode(injecting)).toBe('not_available');
    expect(controls.samples()).toEqual([]);
  });

  test('rejects values that are out of range', async () => {
    const { capture } = setup();
    expect(await rejectionCode(capture.debugInjectSample(0, 181, T0, 5))).toBe('invalid_argument');
    expect(await rejectionCode(capture.debugInjectSample(0, 0, T0, -1))).toBe('invalid_argument');
  });
});

describe('with a real store', () => {
  async function migratedStore() {
    const db = openMemoryDb();
    await migrate(db);
    return db;
  }

  test('writes the rows the shared table module reads back', async () => {
    const db = await migratedStore();
    const { capture, controls } = setup({ db });
    await capture.initStore();
    await capture.start(config());
    await controls.deliverFix({ ...HOME, accuracy_m: 15 });
    await capture.debugInjectSample(FAR_FROM_HOME.lat, FAR_FROM_HOME.lon, T0 + 60, 8);

    const rows = await listSamplesBetween(db, 0, T0 + 1000);
    expect(rows).toEqual([
      { id: 1, ts_utc: T0, ...HOME, accuracy_m: 15, source: 'wm', ...sampleCells(HOME) },
      {
        id: 2,
        ts_utc: T0 + 60,
        ...FAR_FROM_HOME,
        accuracy_m: 8,
        source: 'manual',
        ...sampleCells(FAR_FROM_HOME),
      },
    ]);
    expect(controls.samples()).toEqual(rows);
    expect(await countSamplesSince(db, 0)).toBe((await capture.getStatus()).samplesLast24h);
    db.close();
  });

  test('refuses a store that has not been migrated, and recovers once it has', async () => {
    const db = openMemoryDb();
    const { capture, controls } = setup({ db });
    expect(await rejectionCode(capture.initStore())).toBe('store_unusable');
    expect(await rejectionCode(capture.start(config()))).toBe('store_unusable');
    expect(await rejectionCode(capture.debugInjectSample(0, 0, T0, 5))).toBe('store_unusable');
    expect(await capture.getStatus()).toMatchObject({
      mode: 'stopped',
      health: ['store_unusable'],
    });
    expect(controls.samples()).toEqual([]);
    // Logged once, when the store became unusable, not on every failed check.
    expect(await capture.getDiagnostics(0)).toEqual([
      {
        tsUtc: T0,
        event: 'store_unusable',
        detail: 'store schema is version 0, this module writes version 1',
      },
    ]);

    await migrate(db);
    await capture.initStore();
    await capture.start(config());
    expect(await capture.getStatus()).toMatchObject({ running: true, health: [] });
    db.close();
  });

  test('drops fixes, loudly, while the store cannot be opened', async () => {
    const db = await migratedStore();
    const { capture, controls, statuses } = setup({ db });
    await capture.start(config());

    controls.setStoreFailure('PARAM_MISMATCH: kdf_iter');
    expect(await controls.deliverFix(HOME)).toBe('store_unusable');
    expect(statuses.at(-1)?.health).toEqual(['store_unusable']);
    expect(await countSamplesSince(db, 0)).toBe(0);

    controls.setStoreFailure(null);
    expect(await controls.deliverFix(HOME)).toBe('stored');
    expect(statuses.at(-1)?.health).toEqual([]);
    expect(await countSamplesSince(db, 0)).toBe(1);
    db.close();
  });
});

describe('retention on a capture wake', () => {
  const DAY = 86_400;

  test('a stored fix purges the fixes and stays that are past retention', async () => {
    const db = openMemoryDb();
    await migrate(db);
    const { capture, controls, advance } = setup({ db });
    await capture.start(config());
    await controls.deliverFix(HOME);
    // A visit that ended that day, and one still running when the next fix is stored.
    const visit = [HOME.lat, HOME.lon, 50, sampleCells(HOME).h3_r7];
    await db.execute(NATIVE_WRITER_CONTRACT.insertVisitStaySql, [T0, T0 + 3600, ...visit, 1]);
    await db.execute(NATIVE_WRITER_CONTRACT.insertVisitStaySql, [
      T0 + DAY,
      T0 + 40 * DAY,
      ...visit,
      0,
    ]);

    advance(29 * DAY);
    await controls.deliverFix(HOME);
    expect(controls.samples().map((sample) => sample.ts_utc)).toEqual([T0, T0 + 29 * DAY]);

    advance(2 * DAY);
    await controls.deliverFix(HOME);
    const cutoff = T0 + 31 * DAY - RETENTION_SEC;
    expect(controls.samples().map((sample) => sample.ts_utc)).toEqual([
      T0 + 29 * DAY,
      T0 + 31 * DAY,
    ]);
    expect(await listSamplesBetween(db, 0, T0 + 100 * DAY)).toEqual(controls.samples());
    expect(await db.execute('SELECT start_ts, end_ts FROM stay')).toEqual([
      { start_ts: cutoff, end_ts: T0 + 40 * DAY },
    ]);
    db.close();
  });

  test('without a store the fake forgets old samples the same way', async () => {
    const { capture, controls, advance } = setup();
    await capture.start(config());
    await controls.deliverFix(HOME);
    advance(RETENTION_SEC + 1);
    await controls.deliverFix(HOME);
    expect(controls.samples().map((sample) => sample.ts_utc)).toEqual([T0 + RETENTION_SEC + 1]);
  });
});

describe('getDeviceConditions', () => {
  test('answers what the phone is doing now: on battery and in use until told otherwise', async () => {
    const { capture, controls } = setup();
    expect(await capture.getDeviceConditions()).toEqual({ charging: false, idle: false });

    controls.setDeviceConditions({ charging: true });
    expect(await capture.getDeviceConditions()).toEqual({ charging: true, idle: false });
    controls.setDeviceConditions({ idle: true });
    expect(await capture.getDeviceConditions()).toEqual({ charging: true, idle: true });
    controls.setDeviceConditions({ charging: false, idle: false });
    expect(await capture.getDeviceConditions()).toEqual({ charging: false, idle: false });
  });

  test('works with capture stopped and no permission, and is not part of the status', async () => {
    const { capture, controls, statuses } = setup({ permission: 'denied' });
    controls.setDeviceConditions({ charging: true, idle: true });
    expect(await capture.getDeviceConditions()).toEqual({ charging: true, idle: true });
    expect(statuses).toEqual([]);
  });
});

describe('getNetworkConditions', () => {
  test('answers what the connection is now: metered until told otherwise', async () => {
    const { capture, controls } = setup();
    // What a real module says when the platform gives no answer, and what the fetcher assumes.
    expect(await capture.getNetworkConditions()).toEqual({ metered: true });

    controls.setNetworkConditions({ metered: false });
    expect(await capture.getNetworkConditions()).toEqual({ metered: false });
    controls.setNetworkConditions({ metered: true });
    expect(await capture.getNetworkConditions()).toEqual({ metered: true });
  });

  test('works with capture stopped and no permission, and is not part of the status', async () => {
    const { capture, controls, statuses } = setup({ permission: 'denied' });
    controls.setNetworkConditions({ metered: false });
    expect(await capture.getNetworkConditions()).toEqual({ metered: false });
    expect(statuses).toEqual([]);
  });
});

test('the store key and directory have the shape the real ones have', async () => {
  const { capture } = setup();
  const key = await capture.getOrCreateStoreKeyHex();
  expect(key).toBe(await capture.getOrCreateStoreKeyHex());
  // keyLiteral throws unless the key is exactly the pinned number of bytes.
  expect(keyLiteral(key)).toBe(CIPHER_KEY_VECTOR.literal);
  expect(await capture.getStoreDirectory()).toMatch(/^\/.+[^/]$/);
});

test('getDiagnostics returns entries from a given time on, oldest first', async () => {
  const { capture, advance } = setup();
  await capture.start(config());
  advance(100);
  await capture.stop();
  expect((await capture.getDiagnostics(0)).map((entry) => entry.tsUtc)).toEqual([
    T0,
    T0,
    T0 + 100,
    T0 + 100,
  ]);
  expect((await capture.getDiagnostics(T0 + 100)).map((entry) => entry.event)).toEqual([
    'capture_stopped',
    'mode_changed',
  ]);
  expect(await capture.getDiagnostics(T0 + 101)).toEqual([]);
});

test('captureErrorCode reads the code of a rejection and nothing else', () => {
  expect(captureErrorCode(Object.assign(new Error('x'), { code: 'start_failed' }))).toBe(
    'start_failed',
  );
  expect(captureErrorCode(Object.assign(new Error('x'), { code: 'EUNSPECIFIED' }))).toBeNull();
  expect(captureErrorCode(new Error('x'))).toBeNull();
  expect(captureErrorCode(null)).toBeNull();
});
