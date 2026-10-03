import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { RETENTION_SEC, VACUUM_INTERVAL_SEC } from '../constants';
import { StoreRowError, type SqlDatabase } from '../store/driver';
import { migrate } from '../store/migrations';
import { KV_KEYS, kvGet, kvSet } from '../store/tables/kv';
import { listSamplesAfterId } from '../store/tables/locationSample';
import { openMemoryDb } from '../testing/memoryDb';
import { DAY, seedHistory } from '../testing/retentionSeed';
import { derivedStays, writeSamples } from '../testing/stayVectors';
import {
  createRetentionMaintenance,
  runRetention,
  vacuumIfDue,
  type DeviceConditions,
} from './maintenance';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const NOW = 1_791_000_000;
const CUTOFF = NOW - RETENTION_SEC;
const home = { lat: 12.9716, lon: 77.5946 };
const conditions = (charging: boolean, idle: boolean) => async (): Promise<DeviceConditions> => ({
  charging,
  idle,
});
const chargingAndIdle = conditions(true, true);
const lastVacuum = () => kvGet(db, KV_KEYS.vacuumLastRunAt);
const pragma = async (name: string) =>
  Number(Object.values((await db.execute(`PRAGMA ${name}`))[0] ?? {})[0]);

/** The same store, with every VACUUM recorded and optionally refused. */
function watchingVacuum(fail = false): SqlDatabase & { vacuums: number } {
  const watched = {
    vacuums: 0,
    execute: async (sql: string, params?: Parameters<SqlDatabase['execute']>[1]) => {
      if (sql === 'VACUUM') {
        watched.vacuums += 1;
        if (fail) {
          throw new Error('database is locked');
        }
      }
      return db.execute(sql, params);
    },
    transaction: db.transaction.bind(db),
  };
  return watched;
}

describe('runRetention', () => {
  test('derives stays from fixes not yet looked at, then purges', async () => {
    const fixes = [];
    for (let ts = CUTOFF - DAY; ts <= CUTOFF + DAY; ts += 900) {
      fixes.push({ ts_utc: ts, ...home });
    }
    await writeSamples(db, fixes);

    const run = await runRetention(db, NOW);
    expect(run.derived.inserted).toHaveLength(1);
    expect(run.purge).toMatchObject({ cutoffTs: CUTOFF, samples: 96, stays: 0, staysTrimmed: 1 });
    expect(run.vacuum).toBe('waiting');
    expect(await derivedStays(db)).toMatchObject([
      { id: run.derived.openStayId, start_ts: CUTOFF, end_ts: CUTOFF + DAY, closed: false },
    ]);
  });

  test('a failure in derivation does not keep history past its time', async () => {
    await writeSamples(db, [
      { ts_utc: CUTOFF - DAY, ...home },
      { ts_utc: NOW, ...home },
    ]);
    // A row derivation cannot read.
    await db.execute(
      `INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source)
       VALUES (?, ?, 'not a number', 0, 0, 'x', 0, 1, 'derived')`,
      [NOW - 60, NOW],
    );
    await expect(runRetention(db, NOW)).rejects.toThrow(StoreRowError);
    expect((await listSamplesAfterId(db, 0)).map((sample) => sample.ts_utc)).toEqual([NOW]);
  });

  test('calls made while a run is in progress join it', async () => {
    const deviceConditions = vi.fn(chargingAndIdle);
    const first = runRetention(db, NOW, { deviceConditions });
    const second = runRetention(db, NOW + 1, { deviceConditions });
    expect(second).toBe(first);
    expect((await first).vacuum).toBe('done');
    expect(deviceConditions).toHaveBeenCalledTimes(1);

    // Once it has finished the next call is a run of its own.
    expect((await runRetention(db, NOW + 2, { deviceConditions })).vacuum).toBe('not_due');
  });

  test('createRetentionMaintenance is the hook: (db, nowTs), resolving to nothing', async () => {
    await writeSamples(db, [
      { ts_utc: CUTOFF - 1, ...home },
      { ts_utc: NOW, ...home },
    ]);
    const maintenance = createRetentionMaintenance({ deviceConditions: chargingAndIdle });
    await expect(maintenance(db, NOW)).resolves.toBeUndefined();
    expect(await listSamplesAfterId(db, 0)).toHaveLength(1);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(NOW));
    expect(await lastVacuum()).toBe(String(NOW));
  });
});

describe('the weekly VACUUM', () => {
  test.each([
    ['on battery, in use', conditions(false, false)],
    ['on battery, idle', conditions(false, true)],
    ['charging, but in use', conditions(true, false)],
  ])('%s: it waits', async (_label, deviceConditions) => {
    const store = watchingVacuum();
    expect(await vacuumIfDue(store, NOW, { deviceConditions })).toBe('waiting');
    expect(store.vacuums).toBe(0);
    expect(await lastVacuum()).toBeNull();
  });

  test('charging and idle: it runs, and records when', async () => {
    const store = watchingVacuum();
    expect(await vacuumIfDue(store, NOW, { deviceConditions: chargingAndIdle })).toBe('done');
    expect(store.vacuums).toBe(1);
    expect(await lastVacuum()).toBe(String(NOW));
  });

  test('with nobody to ask, or no answer, the device counts as not charging', async () => {
    const store = watchingVacuum();
    expect(await vacuumIfDue(store, NOW)).toBe('waiting');
    const unavailable = async (): Promise<DeviceConditions> => {
      throw new Error('no native module');
    };
    expect(await vacuumIfDue(store, NOW, { deviceConditions: unavailable })).toBe('waiting');
    expect(store.vacuums).toBe(0);
  });

  test('at most once a week, and the device is not asked in between', async () => {
    const store = watchingVacuum();
    const deviceConditions = vi.fn(chargingAndIdle);
    await vacuumIfDue(store, NOW, { deviceConditions });

    const almost = NOW + VACUUM_INTERVAL_SEC - 1;
    expect(await vacuumIfDue(store, almost, { deviceConditions })).toBe('not_due');
    expect(deviceConditions).toHaveBeenCalledTimes(1);

    expect(await vacuumIfDue(store, almost + 1, { deviceConditions })).toBe('done');
    expect(store.vacuums).toBe(2);
    expect(await lastVacuum()).toBe(String(almost + 1));
  });

  test('a vacuum that came due on battery runs on the first run that finds the device charging', async () => {
    const store = watchingVacuum();
    await vacuumIfDue(store, NOW, { deviceConditions: chargingAndIdle });
    const due = NOW + VACUUM_INTERVAL_SEC;
    expect(await vacuumIfDue(store, due, { deviceConditions: conditions(false, true) })).toBe(
      'waiting',
    );
    expect(await vacuumIfDue(store, due + 900, { deviceConditions: chargingAndIdle })).toBe('done');
  });

  test.each([
    ['in the future, the clock having been set back since', String(NOW + 365 * DAY)],
    ['unreadable', 'last tuesday'],
  ])('a recorded time that is %s does not put it off', async (_label, stored) => {
    await kvSet(db, KV_KEYS.vacuumLastRunAt, stored);
    expect(await vacuumIfDue(db, NOW, { deviceConditions: chargingAndIdle })).toBe('done');
    expect(await lastVacuum()).toBe(String(NOW));
  });

  test('a VACUUM that fails is not recorded, and is tried again on the next run', async () => {
    const options = { deviceConditions: chargingAndIdle };
    expect(await vacuumIfDue(watchingVacuum(true), NOW, options)).toBe('failed');
    expect(await lastVacuum()).toBeNull();
    expect(await vacuumIfDue(watchingVacuum(), NOW + 900, options)).toBe('done');
  });

  test('the purge frees pages and the VACUUM gives them back', async () => {
    await seedHistory(db, NOW);
    const seeded = await pragma('page_count');

    expect((await runRetention(db, NOW)).vacuum).toBe('waiting');
    expect(await pragma('page_count')).toBe(seeded);
    const free = await pragma('freelist_count');
    expect(free).toBeGreaterThan(seeded / 4);

    expect((await runRetention(db, NOW, { deviceConditions: chargingAndIdle })).vacuum).toBe(
      'done',
    );
    expect(await pragma('freelist_count')).toBe(0);
    expect(await pragma('page_count')).toBeLessThanOrEqual(seeded - free);
  });
});
