import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { RETENTION_SEC } from '../constants';
import type { SqlDatabase } from '../store/driver';
import { migrate } from '../store/migrations';
import { KV_KEYS, kvGet, kvSet } from '../store/tables/kv';
import { deleteSamplesBefore, listSamplesAfterId } from '../store/tables/locationSample';
import {
  CLOSE_VISIT_STAY_SQL,
  deleteStaysEndedBefore,
  insertStay,
  type NewStay,
} from '../store/tables/stay';
import { openMemoryDb } from '../testing/memoryDb';
import {
  allStays,
  derivedStays,
  expectStays,
  seededRandom,
  stayVectors,
  syntheticTrace,
  visitStays,
  withoutStoreColumns,
  writeSamples,
  writeVisit,
  type StayVector,
} from '../testing/stayVectors';
import type { StaySample } from './cluster';
import { deriveStays } from './derive';
import { extractStays, overlapsVisit } from './extract';

/**
 * deriveStays keeps nothing in memory between calls: everything it knows is read back from the
 * store at the start of each call. So "the app was killed and relaunched" is, for these tests,
 * exactly "deriveStays was called again on the same store".
 */

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9816, lon: 77.5946 };
const minutes = (count: number) => 1_791_000_000 + count * 60;
const fix = (minute: number, at = home): StaySample => ({ ts_utc: minutes(minute), ...at });
const visit = (from: number, to: number, at = home, closed = true) => ({
  start_ts: minutes(from),
  end_ts: minutes(to),
  ...at,
  radius_m: 65,
  closed,
});
const cursor = async () => Number(await kvGet(db, KV_KEYS.stayDerivationLastSampleId));

/** Stores the fixes in batches of the given sizes and runs derivation after each batch. */
async function deriveInRuns(samples: readonly StaySample[], cuts: readonly number[]) {
  let done = 0;
  for (const cut of [...cuts, samples.length]) {
    await writeSamples(db, samples.slice(done, cut));
    await deriveStays(db);
    done = cut;
  }
}

/** What must hold after every run, whatever was in the store. */
async function expectSoundStore() {
  const derived = await derivedStays(db);
  const visits = await visitStays(db);
  expect(derived.filter((stay) => !stay.closed).length).toBeLessThanOrEqual(1);
  for (const stay of derived) {
    expect(stay.start_ts).toBeLessThanOrEqual(stay.end_ts);
    expect(overlapsVisit(stay, visits)).toBe(false);
  }
}

describe('golden vectors', () => {
  const eachVector = test.each(stayVectors);

  async function writeVisits(vector: StayVector) {
    for (const row of vector.visits) {
      await writeVisit(db, row);
    }
  }

  eachVector('$name: in one run', async (vector) => {
    await writeVisits(vector);
    const visits = await visitStays(db);
    await deriveInRuns(vector.samples, []);
    expectStays(await derivedStays(db), vector.expect);
    expect(await visitStays(db)).toEqual(visits);
    await expectSoundStore();
  });

  eachVector('$name: with the restarts the vector names', async (vector) => {
    await writeVisits(vector);
    await deriveInRuns(vector.samples, vector.restart_after);
    expectStays(await derivedStays(db), vector.expect);
    await expectSoundStore();
  });

  eachVector('$name: with a restart after every fix', async (vector) => {
    await writeVisits(vector);
    for (const sample of vector.samples) {
      await writeSamples(db, [sample]);
      await deriveStays(db);
      await expectSoundStore();
    }
    expectStays(await derivedStays(db), vector.expect);
  });

  eachVector('$name: with the visit rows written at any later point', async (vector) => {
    // iOS reports a visit minutes to hours after the fact, usually after the same dwell has
    // been derived from fixes. Wherever in the stream the rows land, the end state is the same.
    for (let before = 0; before <= vector.samples.length; before++) {
      db.close();
      db = openMemoryDb();
      await migrate(db);
      await deriveInRuns(vector.samples.slice(0, before), []);
      await writeVisits(vector);
      const visits = await visitStays(db);
      await writeSamples(db, vector.samples.slice(before));
      await deriveStays(db);
      expectStays(await derivedStays(db), vector.expect);
      expect(await visitStays(db)).toEqual(visits);
      await expectSoundStore();
    }
  });
});

describe('across restarts', () => {
  test('a stay in progress is one row from the moment it opens until it closes', async () => {
    await writeSamples(db, [fix(0), fix(15)]);
    const opened = await deriveStays(db);
    expect(opened.inserted).toHaveLength(1);
    const id = opened.inserted[0];
    expect(opened).toEqual({ inserted: [id], updated: [], deleted: [], openStayId: id });

    await writeSamples(db, [fix(30), fix(45)]);
    expect(await deriveStays(db)).toEqual({
      inserted: [],
      updated: [id],
      deleted: [],
      openStayId: id,
    });

    // Killed for a day; the device has not moved.
    await writeSamples(db, [fix(24 * 60)]);
    expect((await deriveStays(db)).openStayId).toBe(id);

    await writeSamples(db, [fix(24 * 60 + 15, office)]);
    expect(await deriveStays(db)).toEqual({
      inserted: [],
      updated: [id],
      deleted: [],
      openStayId: null,
    });
    expect(await allStays(db)).toMatchObject([
      {
        id,
        start_ts: minutes(0),
        end_ts: minutes(24 * 60),
        sample_count: 5,
        closed: true,
        source: 'derived',
      },
    ]);
  });

  test('a run with nothing new writes nothing', async () => {
    await writeSamples(db, [fix(0), fix(15), fix(30)]);
    await deriveStays(db);
    const before = { stays: await allStays(db), cursor: await cursor() };
    const writes: string[] = [];
    const watched: SqlDatabase = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            execute: (sql, params) => {
              if (!/^\s*SELECT/i.test(sql)) {
                writes.push(sql);
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const result = await deriveStays(watched);
    expect(result).toMatchObject({ inserted: [], updated: [], deleted: [] });
    expect(writes).toEqual([]);
    expect({ stays: await allStays(db), cursor: await cursor() }).toEqual(before);
  });

  test('the cursor waits before a dwell too short to be a stay, and moves once it is one', async () => {
    await writeSamples(db, [fix(0, office), fix(5), fix(12)]);
    await deriveStays(db);
    // The office fix is finished with; the two home fixes are a dwell of 7 minutes.
    expect(await cursor()).toBe(1);
    expect(await allStays(db)).toEqual([]);

    await writeSamples(db, [fix(20)]);
    await deriveStays(db);
    expect(await cursor()).toBe(4);
    expect(await derivedStays(db)).toMatchObject([
      { start_ts: minutes(5), end_ts: minutes(20), sample_count: 3, closed: false },
    ]);

    // Extending the open stay consumes each fix once: none is read, or counted, again.
    await writeSamples(db, [fix(35)]);
    await deriveStays(db);
    await deriveStays(db);
    expect(await cursor()).toBe(5);
    expect(await derivedStays(db)).toMatchObject([{ sample_count: 4, end_ts: minutes(35) }]);
  });

  test('a run that dies before it commits leaves no trace, and the next run does it all', async () => {
    await writeSamples(db, [fix(0), fix(15)]);
    await deriveStays(db);
    await writeSamples(db, [fix(30), fix(45, office), fix(60, office)]);
    const before = { stays: await allStays(db), cursor: await cursor() };

    const dying: SqlDatabase = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            execute: (sql, params) => {
              // The stay rows have been written by now; the cursor has not.
              if (/INSERT INTO kv/.test(sql)) {
                throw new Error('killed');
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    await expect(deriveStays(dying)).rejects.toThrow('killed');
    expect({ stays: await allStays(db), cursor: await cursor() }).toEqual(before);

    await deriveStays(db);
    expect((await derivedStays(db)).map(withoutStoreColumns)).toEqual(
      extractStays([fix(0), fix(15), fix(30), fix(45, office), fix(60, office)]),
    );
  });

  test('an open stay closes on the first fix elsewhere, however long the app was dead', async () => {
    await writeSamples(db, [fix(0), fix(15)]);
    await deriveStays(db);
    await writeSamples(db, [fix(20 * 24 * 60, office)]);
    await deriveStays(db);
    expect(await derivedStays(db)).toMatchObject([{ end_ts: minutes(15), closed: true }]);
  });
});

describe('a store that is not as derivation left it', () => {
  const open = (start: number, end: number, at = home): NewStay => ({
    start_ts: minutes(start),
    end_ts: minutes(end),
    ...at,
    radius_m: 0,
    sample_count: 2,
    closed: false,
    source: 'derived',
  });

  test('two open derived rows: the newer continues and the other is closed where it stands', async () => {
    const stale = await insertStay(db, open(-600, -500, office));
    const current = await insertStay(db, open(0, 15));
    await writeSamples(db, [fix(30)]);
    const result = await deriveStays(db);
    expect(result.openStayId).toBe(current);
    expect(await derivedStays(db)).toMatchObject([
      { id: stale, end_ts: minutes(-500), closed: true },
      { id: current, end_ts: minutes(30), sample_count: 3, closed: false },
    ]);
    await expectSoundStore();
  });

  test('the open row was purged while capture was off: the next dwell starts a new row', async () => {
    await writeSamples(db, [fix(0), fix(15)]);
    await deriveStays(db);
    await deleteStaysEndedBefore(db, minutes(15) + RETENTION_SEC);
    expect(await allStays(db)).toEqual([]);

    const later = 40 * 24 * 60;
    await writeSamples(db, [fix(later), fix(later + 15), fix(later + 30, office)]);
    await deriveStays(db);
    expect(await derivedStays(db)).toMatchObject([
      { start_ts: minutes(later), end_ts: minutes(later + 15), sample_count: 2, closed: true },
    ]);
  });

  test('the sample table was emptied and its ids began again', async () => {
    await writeSamples(db, [fix(0, office), fix(10, office), fix(20), fix(35)]);
    await deriveStays(db);
    expect(await cursor()).toBe(4);
    const [stale] = await derivedStays(db);
    expect(stale).toMatchObject({ closed: false });

    // Capture is off for longer than retention; the purge deletes every sample but the stay,
    // being open, is still there when capture starts again somewhere else.
    await deleteSamplesBefore(db, Number.MAX_SAFE_INTEGER);
    const later = 40 * 24 * 60;
    await writeSamples(db, [fix(later, office), fix(later + 15, office)]);
    expect((await listSamplesAfterId(db, 0)).map((sample) => sample.id)).toEqual([1, 2]);

    await deriveStays(db);
    expect(await cursor()).toBe(2);
    expect(await derivedStays(db)).toMatchObject([
      { id: stale?.id, end_ts: minutes(35), closed: true },
      { start_ts: minutes(later), end_ts: minutes(later + 15), ...office, closed: false },
    ]);
  });

  test('a cursor that is not a number is treated as no cursor', async () => {
    await kvSet(db, KV_KEYS.stayDerivationLastSampleId, 'not a number');
    await writeSamples(db, [fix(0), fix(15)]);
    await deriveStays(db);
    expect(await derivedStays(db)).toHaveLength(1);
    expect(await cursor()).toBe(2);
  });

  test('fixes derived a second time are merged into the rows they made, not duplicated', async () => {
    const samples = [fix(0), fix(15), fix(30), fix(45, office), fix(60, office), fix(75)];
    await writeSamples(db, samples);
    await deriveStays(db);
    const before = await derivedStays(db);
    expect(before).toHaveLength(2);

    await kvSet(db, KV_KEYS.stayDerivationLastSampleId, '0');
    await deriveStays(db);
    const after = await derivedStays(db);
    expect(after.map((stay) => [stay.id, stay.start_ts, stay.end_ts])).toEqual(
      before.map((stay) => [stay.id, stay.start_ts, stay.end_ts]),
    );
    await expectSoundStore();
  });
});

describe('reconciliation with visit rows', () => {
  test('a visit written after the stay was derived removes the derived row', async () => {
    await writeSamples(db, [fix(5), fix(20), fix(35), fix(50, office)]);
    const first = await deriveStays(db);
    expect(first.inserted).toHaveLength(1);

    await writeVisit(db, visit(0, 40));
    const visits = await visitStays(db);
    const second = await deriveStays(db);
    expect(second).toEqual({
      inserted: [],
      updated: [],
      deleted: first.inserted,
      openStayId: null,
    });
    expect(await allStays(db)).toEqual(visits);
  });

  test('a visit that closes over the stay in progress replaces it, and later fixes build nothing', async () => {
    await writeVisit(db, visit(0, 0, home, false));
    await writeSamples(db, [fix(5), fix(20)]);
    const opened = await deriveStays(db);
    // The arrival alone covers nothing: both rows are open, one per source.
    expect(opened.openStayId).not.toBeNull();
    expect((await allStays(db)).map((stay) => [stay.source, stay.closed])).toEqual([
      ['visit', false],
      ['derived', false],
    ]);

    // The departure is reported while fixes are still arriving from the same place.
    await writeSamples(db, [fix(35)]);
    await db.execute(CLOSE_VISIT_STAY_SQL, [minutes(40), minutes(0)]);
    const closed = await deriveStays(db);
    expect(closed.deleted).toEqual([opened.openStayId]);
    expect(closed.openStayId).toBeNull();
    expect(await derivedStays(db)).toEqual([]);

    // Still there after the departure iOS reported: that part is derived, and does not overlap.
    await writeSamples(db, [fix(50), fix(65)]);
    await deriveStays(db);
    expect(await derivedStays(db)).toMatchObject([
      { start_ts: minutes(50), end_ts: minutes(65), sample_count: 2, closed: false },
    ]);
    await expectSoundStore();
  });

  test('the part of a derived stay before the arrival keeps its row and its id', async () => {
    await writeSamples(db, [fix(-30), fix(-15), fix(5), fix(20), fix(35, office)]);
    const first = await deriveStays(db);
    const [id] = first.inserted;

    await writeVisit(db, visit(0, 30));
    const second = await deriveStays(db);
    expect(second).toEqual({ inserted: [], updated: [id], deleted: [], openStayId: null });
    expect(await derivedStays(db)).toMatchObject([
      { id, start_ts: minutes(-30), end_ts: minutes(-15), sample_count: 2, closed: true },
    ]);
  });

  test('a visit in the middle of a derived stay leaves the parts on either side', async () => {
    const samples = [-30, -15, 5, 20, 35, 50, 65].map((minute) => fix(minute));
    await writeSamples(db, [...samples, fix(80, office)]);
    await deriveStays(db);
    await writeVisit(db, visit(0, 25));
    await deriveStays(db);
    expect(await derivedStays(db)).toMatchObject([
      { start_ts: minutes(-30), end_ts: minutes(-15), sample_count: 2, closed: true },
      { start_ts: minutes(35), end_ts: minutes(65), sample_count: 3, closed: true },
    ]);
    await expectSoundStore();
  });

  test('fixes inside a visit are finished with: the cursor moves past them', async () => {
    await writeVisit(db, visit(0, 60));
    await writeSamples(db, [fix(5), fix(20), fix(35)]);
    await deriveStays(db);
    expect(await cursor()).toBe(3);
    expect(await derivedStays(db)).toEqual([]);
  });

  test('several open visit rows, as iOS leaves them, change nothing', async () => {
    await writeVisit(db, visit(-900, -900, home, false));
    await writeVisit(db, visit(-300, -300, office, false));
    await writeVisit(db, visit(2, 2, home, false));
    const visits = await visitStays(db);
    const samples = [fix(0), fix(15), fix(30), fix(45, office)];
    await deriveInRuns(samples, [2]);
    expect((await derivedStays(db)).map(withoutStoreColumns)).toEqual(extractStays(samples));
    expect(await visitStays(db)).toEqual(visits);
  });

  test('a closed row from a writer this version does not know covers its window too', async () => {
    await db.execute(
      `INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source)
       VALUES (?, ?, ?, ?, 30, '8760145b4ffffff', 0, 1, 'some-future-source')`,
      [minutes(0), minutes(60), home.lat, home.lon],
    );
    await writeSamples(db, [fix(5), fix(20), fix(35)]);
    await deriveStays(db);
    expect(await derivedStays(db)).toEqual([]);
  });

  test('with no visit rows, as on Android, every stay is derived', async () => {
    const { samples } = syntheticTrace(11);
    await deriveInRuns(samples, [10, 25, 26, 60]);
    const derived = await derivedStays(db);
    expect(derived.length).toBeGreaterThan(3);
    expect(derived.map(withoutStoreColumns)).toEqual(extractStays(samples));
    expect(await allStays(db)).toEqual(derived);
  });
});

describe('over synthetic traces', () => {
  const seeds = Array.from({ length: 40 }, (_, index) => index + 1);

  /** Up to five cut points, anywhere in the trace. */
  function cutsFor(seed: number, length: number): number[] {
    const random = seededRandom(seed * 7919);
    const cuts = Array.from({ length: 1 + Math.floor(random() * 5) }, () =>
      Math.floor(random() * (length + 1)),
    );
    return [...new Set(cuts)].sort((a, b) => a - b);
  }

  test.each(seeds)(
    'seed %i: runs split anywhere leave the rows a single pass would',
    async (seed) => {
      const { samples, visits } = syntheticTrace(seed);
      for (const row of visits) {
        await writeVisit(db, row);
      }
      await deriveInRuns(samples, cutsFor(seed, samples.length));
      // Bit for bit: a restart may not change even the last digit of a centroid.
      expect((await derivedStays(db)).map(withoutStoreColumns)).toEqual(
        extractStays(samples, visits),
      );
      await expectSoundStore();
    },
  );

  test.each(seeds)('seed %i: visits written late never leave a duplicate', async (seed) => {
    const { samples, visits } = syntheticTrace(seed);
    const cuts = cutsFor(seed, samples.length);
    const random = seededRandom(seed * 104729);
    let done = 0;
    let written = 0;
    for (const cut of [...cuts, samples.length]) {
      await writeSamples(db, samples.slice(done, cut));
      done = cut;
      // Any number of the visits that have ended by now may be reported before this run.
      const last = samples[cut - 1]?.ts_utc ?? 0;
      while (written < visits.length && random() < 0.7) {
        const row = visits[written];
        if (row === undefined || row.end_ts > last) {
          break;
        }
        await writeVisit(db, row);
        written++;
      }
      await deriveStays(db);
      await expectSoundStore();
    }
    for (const row of visits.slice(written)) {
      await writeVisit(db, row);
    }
    const stored = await visitStays(db);
    await deriveStays(db);
    await expectSoundStore();
    expect(await visitStays(db)).toEqual(stored);
    // A second run finds nothing left to reconcile.
    expect(await deriveStays(db)).toMatchObject({ inserted: [], updated: [], deleted: [] });
  });
});
