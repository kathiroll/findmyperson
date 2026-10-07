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
  listMatches,
  listSamplesAfterId,
  listStaysOverlapping,
  listSubscriptions,
  listWatchedShards,
  RETENTION_SEC,
  sampleCells,
  StoreRowError,
  upsertCachedReport,
  watchSetForCells,
  type SqlDatabase,
} from '@findmyperson/shared';
import { verifiedQueryWith } from '@findmyperson/shared/src/testing/fixtures';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { appStateLog } from '../design-system/__tests__/stubs/react-native';
import { AppNavigator } from '../navigation';
import { ANDROID_VACUUM_ENABLED, createDataStore, retentionOptions } from './index';

vi.mock(
  '@react-navigation/native-stack',
  async () => await import('../navigation/__tests__/stubs'),
);
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

/** The database of a store with no history: every read comes back empty. */
const noRows: SqlDatabase = {
  execute: async () => [],
  transaction: (work) => work({ execute: async () => [] }),
};
/** What a run that changed nothing in the watch list reports. */
const UNCHANGED = { added: [], removed: [], changed: [], total: 0 };

/** A store that only records when its maintenance was asked for. */
function recordingStore() {
  const runs: number[] = [];
  const store = {
    db: noRows,
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

    expect(await dataStore.runMaintenance()).toEqual({
      ran: true,
      subscriptions: UNCHANGED,
      matches: [],
    });
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

    expect(await dataStore.runMaintenance()).toMatchObject({ ran: true });
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
    expect(await dataStore.runMaintenance()).toEqual({
      ran: true,
      subscriptions: UNCHANGED,
      matches: [],
    });
    expect(runs).toEqual([T0]);
  });

  test('a run that fails is reported and leaves the store open for the next one', async () => {
    let fail = true;
    const runs: number[] = [];
    const store = {
      db: noRows,
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
    expect(await dataStore.runMaintenance()).toEqual({
      ran: true,
      subscriptions: UNCHANGED,
      matches: [],
    });
    expect(runs).toEqual([T0]);
  });

  test('triggers that arrive while a run is in progress join it', async () => {
    let release!: () => void;
    const started: number[] = [];
    const store = {
      db: noRows,
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
    expect(await first).toMatchObject({ ran: true });

    // Once it has finished, the next trigger is a run of its own.
    const third = dataStore.runMaintenance();
    expect(third).not.toBe(first);
    await underWay();
    release();
    expect(await third).toMatchObject({ ran: true });
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
    // The fix went with the old store, so the new one follows nothing.
    expect(await maintained).toEqual({ ran: true, subscriptions: UNCHANGED, matches: [] });

    expect(current.store).not.toBe(before);
    expect(await sampleTimes(current.store!.db)).toEqual([]);
    expect(await kvGet(current.store!.db, KV_KEYS.purgeLastRunAt)).toBe(String(T0));
  });
});

describe('the watch list', () => {
  const HOME_SHARD = sampleCells(HOME).h3_r5;
  const AWAY = { lat: 12.2958, lon: 76.6394 };
  const AWAY_SHARD = sampleCells(AWAY).h3_r5;

  function realDataStore(clock: { now: number }) {
    const real = realStoreOptions(createFakeLocationCapture(), 'ios');
    const current: { store: EncryptedStore | null } = { store: null };
    cleanups.push(() => current.store?.close());
    return { current, dataStore: createDataStore(real.options, current, () => clock.now) };
  }
  const fixAt = (db: SqlDatabase, ts: number, place = HOME) =>
    insertLocationSample(db, { ts_utc: ts, ...place, accuracy_m: 20, source: 'wm' });
  const rows = async (db: SqlDatabase) =>
    (await listSubscriptions(db)).map(({ topic, res, reason }) => ({ topic, res, reason }));

  test('is brought up to date by every maintenance run, and most runs change nothing', async () => {
    const clock = { now: T0 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;

    // The capture module stores a fix, and the wake that follows runs maintenance.
    await fixAt(db, T0);
    const first = await dataStore.runMaintenance();
    const wanted = watchSetForCells([HOME_SHARD]);
    expect(first).toEqual({
      ran: true,
      subscriptions: { added: wanted, removed: [], changed: [], total: wanted.length },
      matches: [],
    });
    expect(await rows(db)).toEqual(wanted);
    // What the fetcher is given: the shard the phone is in and its ring, at res 5, and not
    // the res-3 cells above them.
    expect(await listWatchedShards(db)).toEqual(
      wanted.filter((topic) => topic.res === 5).map((topic) => topic.topic),
    );
    expect(await listWatchedShards(db)).toContain(HOME_SHARD);

    const stored = await listSubscriptions(db);
    for (const later of [T0 + 900, T0 + DAY]) {
      clock.now = later;
      await fixAt(db, later);
      expect(await dataStore.runMaintenance()).toEqual({
        ran: true,
        subscriptions: { added: [], removed: [], changed: [], total: wanted.length },
        matches: [],
      });
    }
    expect(await listSubscriptions(db)).toEqual(stored);
  });

  test('follows a new place at once, and lets go of an old one when the purge does', async () => {
    const clock = { now: T0 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await fixAt(db, T0, AWAY);
    await dataStore.runMaintenance();
    expect(await listWatchedShards(db)).toContain(AWAY_SHARD);

    clock.now = T0 + 20 * DAY;
    await fixAt(db, clock.now);
    const arrived = await dataStore.runMaintenance();
    expect(arrived).toMatchObject({ ran: true, subscriptions: { removed: [] } });
    expect(await listWatchedShards(db)).toEqual(expect.arrayContaining([HOME_SHARD, AWAY_SHARD]));

    // Eleven days on, the purge deletes the fix taken away, and the same run drops its shards.
    clock.now = T0 + 31 * DAY;
    const purged = await dataStore.runMaintenance();
    expect(await sampleTimes(db)).toEqual([T0 + 20 * DAY]);
    expect(purged).toMatchObject({ ran: true, subscriptions: { added: [] } });
    expect(purged.subscriptions?.removed).toContainEqual({
      topic: AWAY_SHARD,
      res: 5,
      reason: 'visited',
    });
    expect(await rows(db)).toEqual(watchSetForCells([HOME_SHARD]));

    // And with nothing left inside 30 days, nothing is followed.
    clock.now = T0 + 60 * DAY;
    expect(await dataStore.runMaintenance()).toMatchObject({ subscriptions: { total: 0 } });
    expect(await listSubscriptions(db)).toEqual([]);
  });

  test('is still updated when derivation fails, and the failure is still the result', async () => {
    const clock = { now: T0 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await fixAt(db, T0);
    // A stay row derivation cannot read.
    await db.execute(
      `INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source)
       VALUES (?, ?, 'not a number', 0, 0, ?, 0, 1, 'derived')`,
      [T0 - 60, T0, sampleCells(HOME).h3_r7],
    );

    const result = await dataStore.runMaintenance();
    expect(result.ran).toBe(false);
    expect(result).toMatchObject({ error: expect.any(StoreRowError) });
    expect(result.subscriptions?.added).toEqual(watchSetForCells([HOME_SHARD]));
    expect(await listWatchedShards(db)).toContain(HOME_SHARD);
  });

  test('a watch list that cannot be updated is the result, not a crash', async () => {
    const runs: number[] = [];
    const store = {
      db: {
        execute: async () => {
          throw new Error('database is locked');
        },
      },
      runMaintenance: async (nowTs: number) => void runs.push(nowTs),
    } as unknown as EncryptedStore;
    const dataStore = createDataStore(neverOpens, { store }, () => T0);
    const result = await dataStore.runMaintenance();
    expect(result).toMatchObject({ ran: false, error: { message: 'database is locked' } });
    expect(result.subscriptions).toBeUndefined();
    // The purge was not held up by it.
    expect(runs).toEqual([T0]);
  });
});

describe('the match runner', () => {
  function realDataStore(clock: { now: number }) {
    const real = realStoreOptions(createFakeLocationCapture(), 'ios');
    const current: { store: EncryptedStore | null } = { store: null };
    cleanups.push(() => current.store?.close());
    return { current, dataStore: createDataStore(real.options, current, () => clock.now) };
  }
  const fixAt = (db: SqlDatabase, ts: number, place = HOME) =>
    insertLocationSample(db, { ts_utc: ts, ...place, accuracy_m: 20, source: 'wm' });
  /** Somebody last seen within 150 m of HOME in the half hour from T0, as the fetcher stores it. */
  const cacheReport = async (db: SqlDatabase, receivedAt: number) =>
    upsertCachedReport(
      db,
      await verifiedQueryWith({
        issued_at: T0,
        expires_at: T0 + 20 * DAY,
        center: HOME,
        radius_m: 150,
        window: { from: T0, to: T0 + 1_800 },
      }),
      receivedAt,
    );

  test('runs last in the pass: a report is matched by the stay the same run derived', async () => {
    const clock = { now: T0 + 1_260 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await cacheReport(db, clock.now);
    // Twenty minutes at the place, stored by the capture module and not yet looked at.
    for (const after of [0, 300, 600, 900, 1_200]) {
      await fixAt(db, T0 + after);
    }

    const result = await dataStore.runMaintenance();
    const stays = await listStaysOverlapping(db, T0, T0 + 1_200);
    expect(stays).toHaveLength(1);
    expect(result).toMatchObject({
      ran: true,
      matches: [
        {
          stay_id: stays[0]!.id,
          sample_id: null,
          revision: 1,
          state: 'new',
          created_at: clock.now,
        },
      ],
    });
    expect(await listMatches(db)).toEqual(result.matches);
  });

  test('a report that got there first is matched on the wake that stores the fix, and never again', async () => {
    const clock = { now: T0 + 300 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await cacheReport(db, clock.now);
    expect(await dataStore.runMaintenance()).toMatchObject({ ran: true, matches: [] });

    const sampleId = await fixAt(db, T0 + 600);
    clock.now = T0 + 660;
    const arrived = await dataStore.runMaintenance();
    expect(arrived).toMatchObject({ ran: true, matches: [{ sample_id: sampleId, stay_id: null }] });

    for (const later of [T0 + 900, T0 + 1_200, T0 + DAY]) {
      await fixAt(db, later);
      clock.now = later + 60;
      expect(await dataStore.runMaintenance()).toMatchObject({ ran: true, matches: [] });
    }
    expect(await listMatches(db)).toEqual(arrived.matches);
  });

  test('history the purge removes in the same run is not matched', async () => {
    const clock = { now: T0 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await fixAt(db, T0 + 600);
    clock.now = T0 + RETENTION_SEC + DAY;
    await upsertCachedReport(
      db,
      await verifiedQueryWith({
        issued_at: T0 + 10 * DAY,
        expires_at: T0 + 40 * DAY,
        center: HOME,
        radius_m: 150,
        window: { from: T0, to: T0 + 10 * DAY },
      }),
      clock.now,
    );

    expect(await dataStore.runMaintenance()).toMatchObject({ ran: true, matches: [] });
    expect(await sampleTimes(db)).toEqual([]);
    expect(await listMatches(db)).toEqual([]);
  });

  test('reports that cannot be matched are the result, not a crash, and hold nothing else up', async () => {
    const clock = { now: T0 };
    const { current, dataStore } = realDataStore(clock);
    await dataStore.runMaintenance();
    const db = current.store!.db;
    await fixAt(db, T0);
    // A cursor the runner cannot read.
    await db.execute(
      `INSERT INTO report_cache
         (query_id, payload_json, version, received_at, expires_at, revision, last_matched_at)
       VALUES ('01JB3Z6Q7W8X9Y0ZABCDEFGHJQ', '{}', 1, ?, ?, 1, 'soon')`,
      [T0, T0 + DAY],
    );

    const result = await dataStore.runMaintenance();
    expect(result).toMatchObject({ ran: false, error: expect.any(StoreRowError) });
    expect(result.matches).toBeUndefined();
    expect(result.subscriptions?.added).toEqual(watchSetForCells([sampleCells(HOME).h3_r5]));
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(T0));
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

    expect(await dataStore.runMaintenance()).toMatchObject({ ran: true });
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
