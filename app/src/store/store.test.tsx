import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StoreError,
  type EncryptedStore,
  type OpenStoreOptions,
} from '@findmyperson/encrypted-store';
import { createTestVault, nodeSqlcipherDriver } from '@findmyperson/encrypted-store/testing';
import { CAPTURE_DEFAULTS } from '@findmyperson/native-location-capture';
import {
  createFakeLocationCapture,
  type FakeLocationCapture,
} from '@findmyperson/native-location-capture/fake';
import {
  createRetentionMaintenance,
  insertLocationSample,
  insertStay,
  KV_KEYS,
  kvGet,
  listSamplesAfterId,
  listStaysOverlapping,
  RETENTION_SEC,
  type SqlDatabase,
} from '@findmyperson/shared';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { appStateLog } from '../design-system/__tests__/stubs/react-native';
import { AppNavigator } from '../navigation';
import { ANDROID_VACUUM_ENABLED, createDataStore, retentionOptions } from './index';

vi.mock(
  '@react-navigation/native-stack',
  async () => await import('../navigation/__tests__/stubs'),
);
vi.mock('@react-navigation/bottom-tabs', async () => await import('../navigation/__tests__/stubs'));
vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 86_400;
const T0 = 1_791_000_000;
const HOME = { lat: 12.9716, lon: 77.5946 };
const config = { ...CAPTURE_DEFAULTS, notificationTitle: 't', notificationBody: 'b' };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A store that only records when its maintenance was asked for. */
function recordingStore() {
  const runs: number[] = [];
  const store = {
    runMaintenance: async (nowTs: number) => void runs.push(nowTs),
  } as unknown as EncryptedStore;
  return { store, runs };
}

const neverOpens = (): OpenStoreOptions => {
  throw new Error('the store is already open; nothing should ask for its options');
};

/** A real SQLCipher store on a temporary directory, opened the way the app opens it. */
function realStoreOptions(
  capture: FakeLocationCapture,
  platform: 'android' | 'ios',
): { options: () => OpenStoreOptions; opens: () => number } {
  const directory = mkdtempSync(join(tmpdir(), 'fmp-app-store-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const vault = createTestVault(directory);
  const driver = nodeSqlcipherDriver();
  let opens = 0;
  return {
    opens: () => opens,
    options: () => ({
      vault,
      driver: (target) => {
        opens += 1;
        return driver(target);
      },
      maintenance: createRetentionMaintenance(retentionOptions(capture, platform)),
    }),
  };
}

async function sampleTimes(db: SqlDatabase): Promise<number[]> {
  return (await listSamplesAfterId(db, 0)).map((sample) => sample.ts_utc);
}

const foreground = () =>
  act(async () => {
    for (const listener of appStateLog.listeners) listener('active');
  });
const background = () =>
  act(async () => {
    for (const listener of appStateLog.listeners) listener('background');
  });

describe('the app runs store maintenance', () => {
  async function mountApp(capture: FakeLocationCapture, clock: { now: number }) {
    const { store, runs } = recordingStore();
    const dataStore = createDataStore(neverOpens, { store }, () => clock.now);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<AppNavigator capture={capture} dataStore={dataStore} />);
    });
    cleanups.push(() => act(async () => renderer.unmount()));
    return { renderer, runs };
  }

  test('when it starts, and every time it returns to the foreground', async () => {
    const clock = { now: T0 };
    const { runs } = await mountApp(createFakeLocationCapture(), clock);
    expect(runs).toEqual([T0]);

    // Leaving the screen is not a reason; coming back is, every time.
    clock.now = T0 + 600;
    await background();
    expect(runs).toEqual([T0]);
    await foreground();
    expect(runs).toEqual([T0, T0 + 600]);

    clock.now = T0 + 3 * DAY;
    await background();
    await foreground();
    expect(runs).toEqual([T0, T0 + 600, T0 + 3 * DAY]);
  });

  test('on every capture wake that reaches JavaScript', async () => {
    const clock = { now: T0 };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => clock.now });
    await capture.start(config);
    const { runs } = await mountApp(capture, clock);
    expect(runs).toEqual([T0]);

    clock.now = T0 + 900;
    await act(async () => {
      await capture.controls.deliverFix(HOME);
    });
    expect(runs).toEqual([T0, T0 + 900]);

    // A fix the module drops wakes nobody.
    clock.now = T0 + 960;
    await act(async () => {
      expect(await capture.controls.deliverFix(HOME)).toBe('filtered');
    });
    expect(runs).toEqual([T0, T0 + 900]);
  });

  test('and stops when the app is torn down', async () => {
    const clock = { now: T0 };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => clock.now });
    await capture.start(config);
    const { renderer, runs } = await mountApp(capture, clock);
    await act(async () => renderer.unmount());

    await foreground();
    await capture.controls.deliverFix(HOME);
    expect(runs).toEqual([T0]);
  });

  test('the time it passes is Unix seconds, which is what the purge requires', async () => {
    const { store, runs } = recordingStore();
    await createDataStore(neverOpens, { store }).runMaintenance();
    expect(runs).toHaveLength(1);
    expect(Number.isInteger(runs[0])).toBe(true);
    expect(Math.abs((runs[0] ?? 0) - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('the maintenance run', () => {
  test('opens the store once, at the first run, and purges what is past retention', async () => {
    const clock = { now: T0 };
    const capture = createFakeLocationCapture();
    const real = realStoreOptions(capture, 'ios');
    const current: { store: EncryptedStore | null } = { store: null };
    const dataStore = createDataStore(real.options, current, () => clock.now);
    cleanups.push(() => current.store?.close());

    expect(await dataStore.runMaintenance()).toEqual({ ran: true });
    expect(real.opens()).toBe(1);
    const db = current.store!.db;
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(T0));

    // The app is closed for forty days while capture keeps writing. (On a phone the native
    // purge would already have removed the old rows; here nothing has.)
    for (const ts of [T0, T0 + 5 * DAY, T0 + 39 * DAY]) {
      await insertLocationSample(db, { ts_utc: ts, ...HOME, accuracy_m: 20, source: 'wm' });
    }
    await insertStay(db, {
      start_ts: T0,
      end_ts: T0 + 3600,
      ...HOME,
      radius_m: 50,
      sample_count: 4,
      closed: true,
      source: 'derived',
    });
    clock.now = T0 + 40 * DAY;

    expect(await dataStore.runMaintenance()).toEqual({ ran: true });
    expect(real.opens()).toBe(1);
    expect(await sampleTimes(db)).toEqual([T0 + 39 * DAY]);
    expect(await listStaysOverlapping(db, 0, clock.now - RETENTION_SEC - 1)).toEqual([]);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(clock.now));
  });

  test('a store that cannot be opened is the result, not a crash, and the next run tries again', async () => {
    let attempts = 0;
    const { store, runs } = recordingStore();
    const failing = (): OpenStoreOptions => {
      attempts += 1;
      throw new StoreError('OPEN_FAILED', 'the phone has not been unlocked since it restarted');
    };
    const current: { store: EncryptedStore | null } = { store: null };
    const dataStore = createDataStore(failing, current, () => T0);

    const first = await dataStore.runMaintenance();
    expect(first).toMatchObject({ ran: false, error: { code: 'OPEN_FAILED' } });
    expect(await dataStore.runMaintenance()).toMatchObject({ ran: false });
    expect(attempts).toBe(2);

    // The phone is unlocked and the store opens.
    current.store = store;
    expect(await dataStore.runMaintenance()).toEqual({ ran: true });
    expect(runs).toEqual([T0]);
  });

  test('a run that fails is reported and leaves the store open for the next one', async () => {
    let fail = true;
    const runs: number[] = [];
    const store = {
      runMaintenance: async (nowTs: number) => {
        if (fail) throw new Error('database is locked');
        runs.push(nowTs);
      },
    } as unknown as EncryptedStore;
    const dataStore = createDataStore(neverOpens, { store }, () => T0);

    expect(await dataStore.runMaintenance()).toMatchObject({
      ran: false,
      error: { message: 'database is locked' },
    });
    fail = false;
    expect(await dataStore.runMaintenance()).toEqual({ ran: true });
    expect(runs).toEqual([T0]);
  });

  test('triggers that arrive while a run is in progress join it', async () => {
    let release!: () => void;
    const started: number[] = [];
    const store = {
      runMaintenance: (nowTs: number) => {
        started.push(nowTs);
        return new Promise<void>((resolve) => (release = resolve));
      },
    } as unknown as EncryptedStore;
    const clock = { now: T0 };
    const dataStore = createDataStore(neverOpens, { store }, () => clock.now);
    const underWay = () => new Promise((resolve) => setTimeout(resolve, 0));

    const first = dataStore.runMaintenance();
    await underWay();
    clock.now = T0 + 1;
    const second = dataStore.runMaintenance();
    expect(second).toBe(first);
    await underWay();
    expect(started).toEqual([T0]);
    release();
    expect(await first).toEqual({ ran: true });

    // Once it has finished, the next trigger is a run of its own.
    const third = dataStore.runMaintenance();
    expect(third).not.toBe(first);
    await underWay();
    release();
    expect(await third).toEqual({ ran: true });
    expect(started).toEqual([T0, T0 + 1]);
  });

  test('after "delete all my data", maintenance runs on the new store, and never during the delete', async () => {
    const capture = createFakeLocationCapture();
    const real = realStoreOptions(capture, 'ios');
    const current: { store: EncryptedStore | null } = { store: null };
    const dataStore = createDataStore(real.options, current, () => T0);
    cleanups.push(() => current.store?.close());

    await dataStore.runMaintenance();
    const before = current.store!;
    await insertLocationSample(before.db, { ts_utc: T0, ...HOME, accuracy_m: 20, source: 'wm' });

    // Asked for in the same breath: the delete goes first and the run waits for it.
    const deleted = dataStore.deleteAll();
    const maintained = dataStore.runMaintenance();
    expect(await deleted).toEqual({ emptyStoreConfirmed: true });
    expect(await maintained).toEqual({ ran: true });

    expect(current.store).not.toBe(before);
    expect(await sampleTimes(current.store!.db)).toEqual([]);
    expect(await kvGet(current.store!.db, KV_KEYS.purgeLastRunAt)).toBe(String(T0));
  });
});

describe('the weekly VACUUM', () => {
  async function runOn(
    platform: 'android' | 'ios',
    conditions: { charging: boolean; idle: boolean },
  ) {
    const capture = createFakeLocationCapture({ platform });
    capture.controls.setDeviceConditions(conditions);
    const asked = vi.spyOn(capture, 'getDeviceConditions');
    const real = realStoreOptions(capture, platform);
    const current: { store: EncryptedStore | null } = { store: null };
    const dataStore = createDataStore(real.options, current, () => T0);
    cleanups.push(() => current.store?.close());

    expect(await dataStore.runMaintenance()).toEqual({ ran: true });
    const db = current.store!.db;
    return {
      asked,
      purgedAt: await kvGet(db, KV_KEYS.purgeLastRunAt),
      vacuumedAt: await kvGet(db, KV_KEYS.vacuumLastRunAt),
    };
  }

  test('iOS: runs once the capture module says the phone is charging and idle', async () => {
    const waiting = await runOn('ios', { charging: true, idle: false });
    expect(waiting.asked).toHaveBeenCalledOnce();
    expect(waiting).toMatchObject({ purgedAt: String(T0), vacuumedAt: null });

    const onBattery = await runOn('ios', { charging: false, idle: true });
    expect(onBattery).toMatchObject({ purgedAt: String(T0), vacuumedAt: null });

    const overnight = await runOn('ios', { charging: true, idle: true });
    expect(overnight.asked).toHaveBeenCalledOnce();
    expect(overnight).toMatchObject({ purgedAt: String(T0), vacuumedAt: String(T0) });
  });

  test('Android: switched off by ANDROID_VACUUM_ENABLED, whatever the phone is doing; the purge still runs', async () => {
    // The flag waits for the one-SQLite-library link to be verified on a phone
    // (fmp-android-sqlite-contention). Turning it on is deliberate, and this test then changes
    // with it.
    expect(ANDROID_VACUUM_ENABLED).toBe(false);
    const capture = createFakeLocationCapture();
    expect(retentionOptions(capture, 'android').vacuum).toBe('disabled');
    expect(retentionOptions(capture, 'ios').vacuum).toBe('enabled');

    const overnight = await runOn('android', { charging: true, idle: true });
    expect(overnight).toMatchObject({ purgedAt: String(T0), vacuumedAt: null });
    // Not even asked: the gate is closed before the conditions matter.
    expect(overnight.asked).not.toHaveBeenCalled();
  });

  test('the conditions are the capture module’s answer at the moment they are asked for', async () => {
    const capture = createFakeLocationCapture();
    const options = retentionOptions(capture, 'ios');
    expect(await options.deviceConditions?.()).toEqual({ charging: false, idle: false });
    capture.controls.setDeviceConditions({ charging: true, idle: true });
    expect(await options.deviceConditions?.()).toEqual({ charging: true, idle: true });
  });
});
