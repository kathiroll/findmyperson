import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { H3_RES_PUSH, H3_RES_SHARD, RETENTION_SEC, SUBSCRIPTION_RES5_CAP } from '../constants';
import type { LatLon } from '../geo/distance';
import { matchCellAt, pushCellOf, ringCells, sampleCells, shardCellOf } from '../geo/h3';
import { purgeExpired } from '../retention/purge';
import { runRetention } from '../retention/maintenance';
import { deriveStays } from '../stay/derive';
import type { SqlDatabase, SqlExecutor } from '../store/driver';
import { migrate } from '../store/migrations';
import { listSamplesAfterId } from '../store/tables/locationSample';
import {
  listSubscriptions,
  listWatchedShards,
  putSubscription,
} from '../store/tables/subscription';
import { openMemoryDb } from '../testing/memoryDb';
import { allStays, writeSamples, writeVisit } from '../testing/stayVectors';
import { syncSubscriptions } from './sync';
import { computeWatchSet, watchSetForCells } from './watchSet';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const DAY = 86_400;
const NOW = 1_791_000_000;
const NOTHING = { added: [], removed: [], changed: [] };

const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9916, lon: 77.6146 };
const mysuru = { lat: 12.2958, lon: 76.6394 };
const HOME = sampleCells(home).h3_r5;
const MYSURU = sampleCells(mysuru).h3_r5;

function line(from: LatLon, to: LatLon, steps: number): LatLon[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    lat: from.lat + ((to.lat - from.lat) * i) / steps,
    lon: from.lon + ((to.lon - from.lon) * i) / steps,
  }));
}

/** A fix every 15 minutes from `fromTs` to `toTs`: home at night, the office from 09:00 to 17:00. */
function commute(fromTs: number, toTs: number) {
  const fixes = [];
  for (let ts = fromTs; ts <= toTs; ts += 900) {
    const hour = Math.floor((ts % DAY) / 3600);
    fixes.push({ ts_utc: ts, ...(hour >= 9 && hour < 17 ? office : home) });
  }
  return fixes;
}

/** The same store, with every transaction and every statement that is not a SELECT counted. */
function counting(inner: SqlDatabase) {
  const seen = { transactions: 0, writes: 0 };
  const counted = (executor: SqlExecutor): SqlExecutor['execute'] => {
    return async (sql, params) => {
      if (!/^\s*SELECT\b/i.test(sql)) {
        seen.writes += 1;
      }
      return executor.execute(sql, params);
    };
  };
  const store: SqlDatabase = {
    execute: counted(inner),
    transaction: (work) => {
      seen.transactions += 1;
      return inner.transaction((tx) => work({ execute: counted(tx) }));
    },
  };
  return { store, seen };
}

/** The table as the pure function would have it, from every row the store holds. */
async function expectedFromRows(nowTs: number) {
  return computeWatchSet(
    { stays: await allStays(db), samples: await listSamplesAfterId(db, 0) },
    nowTs,
  );
}

const stored = async () =>
  (await listSubscriptions(db)).map(({ topic, res, reason }) => ({ topic, res, reason }));

describe('syncSubscriptions', () => {
  test('an empty history gives an empty table, and nothing is written', async () => {
    const { store, seen } = counting(db);
    expect(await syncSubscriptions(store, NOW)).toEqual({ ...NOTHING, total: 0 });
    expect(await listSubscriptions(db)).toEqual([]);
    expect(seen).toEqual({ transactions: 0, writes: 0 });
  });

  test('a 30-day commuter: the table is the watch set of the rows, in one transaction', async () => {
    await writeSamples(db, commute(NOW - 30 * DAY, NOW));
    await deriveStays(db);
    expect((await allStays(db)).length).toBeGreaterThan(50);

    const { store, seen } = counting(db);
    const run = await syncSubscriptions(store, NOW);
    const expected = await expectedFromRows(NOW);
    expect(await stored()).toEqual(expected);
    expect(run).toEqual({ added: expected, removed: [], changed: [], total: expected.length });
    expect(seen).toEqual({ transactions: 1, writes: expected.length });

    const rows = await listSubscriptions(db);
    expect(rows.filter((row) => row.res === H3_RES_SHARD).length).toBeLessThanOrEqual(
      SUBSCRIPTION_RES5_CAP,
    );
    expect(rows.filter((row) => row.reason === 'visited').map((row) => row.topic)).toEqual(
      [HOME, sampleCells(office).h3_r5].sort(),
    );
    expect(rows.every((row) => row.added_at === NOW && row.refreshed_at === NOW)).toBe(true);
  });

  test('a second run with unchanged history writes nothing', async () => {
    await writeSamples(db, commute(NOW - 30 * DAY, NOW));
    await deriveStays(db);
    const first = await syncSubscriptions(db, NOW);
    const before = await listSubscriptions(db);

    const { store, seen } = counting(db);
    expect(await syncSubscriptions(store, NOW)).toEqual({ ...NOTHING, total: first.total });
    // Nor does a later one, while the same places are inside the 30 days: an hour on, a day on.
    expect(await syncSubscriptions(store, NOW + 3600)).toEqual({ ...NOTHING, total: first.total });
    expect(await syncSubscriptions(store, NOW + DAY)).toEqual({ ...NOTHING, total: first.total });
    expect(seen).toEqual({ transactions: 0, writes: 0 });
    // The rows are the same rows, times included.
    expect(await listSubscriptions(db)).toEqual(before);
  });

  test('more fixes in places already followed write nothing', async () => {
    await writeSamples(db, commute(NOW - 30 * DAY, NOW));
    await syncSubscriptions(db, NOW);
    await writeSamples(db, commute(NOW + 900, NOW + DAY));
    await deriveStays(db);

    const { store, seen } = counting(db);
    expect(await syncSubscriptions(store, NOW + DAY)).toMatchObject(NOTHING);
    expect(seen).toEqual({ transactions: 0, writes: 0 });
  });

  test('a new place adds only what it brings, and leaves the other rows as they were', async () => {
    await writeSamples(db, commute(NOW - 10 * DAY, NOW));
    await syncSubscriptions(db, NOW);
    const before = await listSubscriptions(db);

    const later = NOW + 3600;
    await writeSamples(db, [{ ts_utc: later, ...mysuru }]);
    const { store, seen } = counting(db);
    const run = await syncSubscriptions(store, later);

    expect(run.removed).toEqual([]);
    expect(run.changed).toEqual([]);
    expect(run.added).toContainEqual({ topic: MYSURU, res: H3_RES_SHARD, reason: 'visited' });
    expect(run.added).toContainEqual({
      topic: pushCellOf(MYSURU),
      res: H3_RES_PUSH,
      reason: 'ancestor',
    });
    expect(seen).toEqual({ transactions: 1, writes: run.added.length });
    expect(await stored()).toEqual(await expectedFromRows(later));
    expect(run.total).toBe(before.length + run.added.length);

    const after = await listSubscriptions(db);
    expect(after.filter((row) => row.added_at === NOW)).toEqual(before);
    expect(after.filter((row) => row.added_at === later).map((row) => row.topic)).toEqual(
      run.added.map((topic) => topic.topic),
    );
  });

  test('a neighbour the device then enters changes its reason, and keeps when it was added', async () => {
    await writeSamples(db, [{ ts_utc: NOW, ...home }]);
    await syncSubscriptions(db, NOW);
    // A point in a neighbouring shard: the centre of one of its res-7 cells would do, so walk
    // east until the shard changes.
    const next = line(home, { lat: home.lat, lon: home.lon + 0.5 }, 200).find(
      (point) => sampleCells(point).h3_r5 !== HOME,
    ) as LatLon;
    const neighbour = sampleCells(next).h3_r5;
    expect(ringCells(HOME)).toContain(neighbour);

    const later = NOW + 600;
    await writeSamples(db, [{ ts_utc: later, ...next }]);
    const run = await syncSubscriptions(db, later);
    expect(run.changed).toEqual([{ topic: neighbour, res: H3_RES_SHARD, reason: 'visited' }]);
    expect(run.added.every((topic) => topic.reason !== 'visited')).toBe(true);
    expect((await listSubscriptions(db)).find((row) => row.topic === neighbour)).toEqual({
      topic: neighbour,
      res: H3_RES_SHARD,
      reason: 'visited',
      added_at: NOW,
      refreshed_at: later,
    });
    expect(await stored()).toEqual(await expectedFromRows(later));
  });

  test('a place only an iOS visit records is followed', async () => {
    await writeVisit(db, {
      start_ts: NOW - 3600,
      end_ts: NOW - 1800,
      ...mysuru,
      radius_m: 65,
      closed: true,
    });
    const run = await syncSubscriptions(db, NOW);
    expect(run.added).toContainEqual({
      topic: shardCellOf(matchCellAt(mysuru)),
      res: H3_RES_SHARD,
      reason: 'visited',
    });
    expect(await stored()).toEqual(await expectedFromRows(NOW));
  });

  test('the set shrinks when the purge removes old history', async () => {
    // A trip to Mysuru 20 days ago, in a month of commuting.
    await writeSamples(db, commute(NOW - 30 * DAY, NOW - 20 * DAY - 7200));
    await writeSamples(db, commute(NOW - 20 * DAY - 3600, NOW - 20 * DAY).map(awayAt(mysuru)));
    await writeSamples(db, commute(NOW - 20 * DAY + 3600, NOW));
    await deriveStays(db);
    await syncSubscriptions(db, NOW);
    const withTrip = await listSubscriptions(db);
    expect(withTrip.map((row) => row.topic)).toContain(MYSURU);

    // Fifteen days on, with the commute going on: the trip is past retention.
    const later = NOW + 15 * DAY;
    await writeSamples(db, commute(NOW + 900, later));
    await deriveStays(db);
    expect((await purgeExpired(db, later)).samples).toBeGreaterThan(0);

    const { store, seen } = counting(db);
    const run = await syncSubscriptions(store, later);
    // What goes is what only the trip brought: its cell, its ring and their res-3 parents.
    const commuteOnly = watchSetForCells([HOME, sampleCells(office).h3_r5]);
    const kept = new Set(commuteOnly.map((topic) => topic.topic));
    const tripOnly = watchSetForCells([HOME, sampleCells(office).h3_r5, MYSURU]).filter(
      (topic) => !kept.has(topic.topic),
    );
    expect(tripOnly.length).toBeGreaterThanOrEqual(8);
    expect(run).toMatchObject({ added: [], changed: [], removed: tripOnly });
    expect(run.removed).toContainEqual({ topic: MYSURU, res: H3_RES_SHARD, reason: 'visited' });
    expect(seen).toEqual({ transactions: 1, writes: run.removed.length });
    expect(run.total).toBe(withTrip.length - run.removed.length);

    expect(await stored()).toEqual(await expectedFromRows(later));
    expect(await stored()).toEqual(commuteOnly);
    // The rows that stayed were not rewritten.
    expect((await listSubscriptions(db)).every((row) => row.refreshed_at === NOW)).toBe(true);
  });

  test('it shrinks by the dates even where the purge has not run', async () => {
    await writeSamples(db, [
      { ts_utc: NOW - 20 * DAY, ...mysuru },
      { ts_utc: NOW, ...home },
    ]);
    await syncSubscriptions(db, NOW);
    expect(await listWatchedShards(db)).toContain(MYSURU);

    const run = await syncSubscriptions(db, NOW + 15 * DAY);
    expect(run.removed.map((topic) => topic.topic)).toContain(MYSURU);
    expect(await stored()).toEqual(watchSetForCells([HOME]));
    // The old fix is still there; it is the purge's to delete.
    expect(await listSamplesAfterId(db, 0)).toHaveLength(2);
  });

  test('a phone whose whole history is past retention follows nothing', async () => {
    await writeSamples(db, commute(NOW - 10 * DAY, NOW));
    await syncSubscriptions(db, NOW);
    const later = NOW + RETENTION_SEC + 1;

    await runRetention(db, later);
    const run = await syncSubscriptions(db, later);
    expect(run).toMatchObject({ added: [], changed: [], total: 0 });
    expect(run.removed.length).toBeGreaterThan(0);
    expect(await listSubscriptions(db)).toEqual([]);
  });

  test('a row that no history accounts for is removed', async () => {
    await putSubscription(db, MYSURU, 'visited', NOW - DAY);
    await writeSamples(db, [{ ts_utc: NOW, ...home }]);
    const run = await syncSubscriptions(db, NOW);
    expect(run.removed).toEqual([{ topic: MYSURU, res: H3_RES_SHARD, reason: 'visited' }]);
    expect(await stored()).toEqual(watchSetForCells([HOME]));
  });

  test('a heavy traveller is stored coarsened, and the fetcher is given shards that cover the route', async () => {
    const route = [
      ...line(home, { lat: 19.076, lon: 72.8777 }, 700),
      ...line({ lat: 19.076, lon: 72.8777 }, { lat: 28.6139, lon: 77.209 }, 700),
      ...line({ lat: 28.6139, lon: 77.209 }, { lat: 22.5726, lon: 88.3639 }, 700),
    ];
    await db.transaction((tx) =>
      writeSamples(
        tx,
        route.map((point, i) => ({ ts_utc: NOW - 29 * DAY + i * 600, ...point })),
      ),
    );
    const run = await syncSubscriptions(db, NOW);
    expect(await stored()).toEqual(await expectedFromRows(NOW));

    const rows = await listSubscriptions(db);
    const res5 = rows.filter((row) => row.res === H3_RES_SHARD);
    const coarsened = rows.filter((row) => row.reason === 'coarsened');
    expect(res5.length).toBeLessThanOrEqual(SUBSCRIPTION_RES5_CAP);
    expect(coarsened.length).toBeGreaterThan(0);
    expect(coarsened.every((row) => row.res === H3_RES_PUSH)).toBe(true);
    expect(run.total).toBe(rows.length);

    // The fetcher's list: the res-5 rows and the coarsened regions, and no push-only ancestor.
    const watched = await listWatchedShards(db);
    expect(watched).toEqual(
      rows.filter((row) => row.reason !== 'ancestor').map((row) => row.topic),
    );
    expect(rows.some((row) => row.reason === 'ancestor')).toBe(true);
    const followed = new Set(watched);
    const visited = [...new Set(route.map((point) => sampleCells(point).h3_r5))];
    expect(visited.length).toBeGreaterThan(SUBSCRIPTION_RES5_CAP);
    expect(
      visited.filter((cell) => !followed.has(cell) && !followed.has(pushCellOf(cell))),
    ).toEqual([]);
  });

  test('the difference is one transaction: a write that fails leaves the table as it was', async () => {
    await writeSamples(db, [{ ts_utc: NOW - 20 * DAY, ...mysuru }]);
    await syncSubscriptions(db, NOW);
    const before = await listSubscriptions(db);

    // Fifteen days on the trip is out and home is in: deletes, then inserts, the third of
    // which fails.
    await writeSamples(db, [{ ts_utc: NOW + 15 * DAY, ...home }]);
    let inserts = 0;
    const failing: SqlDatabase = {
      execute: db.execute,
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            execute: async (sql, params) => {
              if (/^\s*INSERT/i.test(sql) && ++inserts === 3) {
                throw new Error('disk I/O error');
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    await expect(syncSubscriptions(failing, NOW + 15 * DAY)).rejects.toThrow('disk I/O error');
    expect(await listSubscriptions(db)).toEqual(before);

    // The next run does the whole of it.
    await syncSubscriptions(db, NOW + 15 * DAY);
    expect(await stored()).toEqual(watchSetForCells([HOME]));
  });

  test('a time in milliseconds is refused, and the table is not emptied', async () => {
    await writeSamples(db, [{ ts_utc: NOW, ...home }]);
    await syncSubscriptions(db, NOW);
    const before = await listSubscriptions(db);
    await expect(syncSubscriptions(db, NOW * 1000)).rejects.toThrow(RangeError);
    await expect(syncSubscriptions(db, NOW + 0.5)).rejects.toThrow(RangeError);
    expect(await listSubscriptions(db)).toEqual(before);
  });

  test('the cap can be given, and a lower one coarsens what is stored', async () => {
    await writeSamples(db, [{ ts_utc: NOW, ...home }]);
    await syncSubscriptions(db, NOW);
    const run = await syncSubscriptions(db, NOW, { res5Cap: 0 });
    expect(run.added).toEqual([]);
    expect(run.removed.every((topic) => topic.res === H3_RES_SHARD)).toBe(true);
    expect(run.removed).toHaveLength(7);
    expect(run.changed.every((topic) => topic.reason === 'coarsened')).toBe(true);
    expect(await stored()).toEqual(watchSetForCells([HOME], { res5Cap: 0 }));
    // What was a push topic only is now fetched as a shard.
    expect(await listWatchedShards(db)).toEqual(run.changed.map((topic) => topic.topic));
  });
});

/** The same fixes, taken somewhere else. */
function awayAt(place: LatLon) {
  return (sample: { ts_utc: number }) => ({ ts_utc: sample.ts_utc, ...place });
}
