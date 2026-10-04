import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MATCH_SAMPLE_LATE_SEC, RETENTION_SEC } from '../constants';
import { EARTH_RADIUS_M, type LatLon } from '../geo/distance';
import { matchCellAt } from '../geo/h3';
import { purgeExpired } from '../retention/purge';
import { deriveStays } from '../stay/derive';
import type { SqlExecutor } from '../store/driver';
import { migrate } from '../store/migrations';
import { insertLocationSample } from '../store/tables/locationSample';
import { getMatchByQueryId, insertMatchIfAbsent, listMatches } from '../store/tables/match';
import {
  getCachedReport,
  listReportsAwaitingRetrospective,
  upsertCachedReport,
} from '../store/tables/reportCache';
import { CLOSE_VISIT_STAY_SQL, INSERT_VISIT_STAY_SQL } from '../store/tables/stay';
import { verifiedQueryWith } from '../testing/fixtures';
import { openMemoryDb } from '../testing/memoryDb';
import { queryIdOf } from '../testing/shardCdn';
import { allStays, writeSamples } from '../testing/stayVectors';
import { runMatchPass } from './runner';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const HOUR = 3_600;
const DAY = 86_400;
/** On a 30-minute mark, so the reports below are read on the grid exactly as written. */
const T0 = 1_791_000_000;
/** Where the person was last seen. */
const PLACE: LatLon = { lat: 12.9716, lon: 77.5946 };
/** Another city. */
const ELSEWHERE: LatLon = { lat: 12.2958, lon: 76.6394 };
const NOTHING = { matches: [], retrospective: 0, prospective: 0, unreadable: 0 };

/** The point this many metres due north of PLACE. */
function north(meters: number): LatLon {
  return { lat: PLACE.lat + (meters / EARTH_RADIUS_M) * (180 / Math.PI), lon: PLACE.lon };
}

/**
 * Report `n`, as the fetcher stores it: somebody last seen within 150 m of PLACE in the half
 * hour from T0. Its bounds are 300 m around PLACE, from T0 - 30 min to T0 + 60 min.
 */
async function cacheReport(n: number, receivedAt: number, changes: Record<string, unknown> = {}) {
  const entry = await verifiedQueryWith({
    query_id: queryIdOf(n),
    issued_at: T0 + HOUR,
    expires_at: T0 + 20 * DAY,
    center: PLACE,
    radius_m: 150,
    window: { from: T0, to: T0 + 1_800 },
    ...changes,
  });
  return upsertCachedReport(db, entry, receivedAt);
}

/** A fix, stored as the capture module stores it. Returns its id. */
const fix = (ts: number, place: LatLon = PLACE) =>
  insertLocationSample(db, { ts_utc: ts, ...place, accuracy_m: 20, source: 'wm' });

const cursorOf = async (n: number) => (await getCachedReport(db, queryIdOf(n)))?.last_matched_at;

/** The same store, with every statement recorded. */
function recording(inner: SqlExecutor) {
  const statements: string[] = [];
  const store: SqlExecutor = {
    execute: (sql, params) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return inner.execute(sql, params);
    },
  };
  return {
    store,
    statements,
    take: () => statements.splice(0),
    writes: () => statements.filter((sql) => !/^SELECT\b/i.test(sql)),
    reading: (table: string) => statements.filter((sql) => sql.includes(`FROM ${table}`)),
  };
}

describe('the retrospective pass', () => {
  test('a report that reaches the phone after the bystander was there matches', async () => {
    const sampleId = await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    expect(await cursorOf(1)).toBeNull();

    const run = await runMatchPass(db, T0 + 2 * HOUR);
    expect(run).toEqual({
      matches: [
        {
          id: expect.any(Number),
          query_id: queryIdOf(1),
          revision: 1,
          stay_id: null,
          sample_id: sampleId,
          distance_m: 0,
          dt_sec: 0,
          state: 'new',
          created_at: T0 + 2 * HOUR,
        },
      ],
      retrospective: 1,
      prospective: 0,
      unreadable: 0,
    });
    expect(await listMatches(db)).toEqual(run.matches);
    // The debt is paid: the cursor is the time of the pass.
    expect(await cursorOf(1)).toBe(T0 + 2 * HOUR);
    expect(await listReportsAwaitingRetrospective(db, T0 + 2 * HOUR)).toEqual([]);
  });

  test('a stay is the evidence when there is one', async () => {
    await writeSamples(
      db,
      [0, 300, 600, 900, 1_200].map((after) => ({ ts_utc: T0 + after, ...PLACE })),
    );
    await deriveStays(db);
    const [stay] = await allStays(db);
    expect(stay).toMatchObject({ start_ts: T0, end_ts: T0 + 1_200 });
    await cacheReport(1, T0 + 2 * HOUR);

    const { matches } = await runMatchPass(db, T0 + 2 * HOUR);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ stay_id: stay!.id, sample_id: null, dt_sec: 0 });
  });

  test('history somewhere else, or at another time, is not evidence, and the debt is still paid', async () => {
    await fix(T0 + 600, ELSEWHERE);
    await fix(T0 + 600, north(400));
    await fix(T0 - 2 * HOUR);
    await fix(T0 + 2 * HOUR);
    await cacheReport(1, T0 + 3 * HOUR);

    expect(await runMatchPass(db, T0 + 3 * HOUR)).toEqual({ ...NOTHING, retrospective: 1 });
    expect(await listMatches(db)).toEqual([]);
    expect(await cursorOf(1)).toBe(T0 + 3 * HOUR);
  });

  test('every report that owes a pass gets it in one run, each with its own evidence', async () => {
    const here = await fix(T0 + 600);
    const there = await fix(T0 + 900, ELSEWHERE);
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1, { center: ELSEWHERE });
    await cacheReport(3, T0 + 2 * HOUR + 2, { center: north(5_000) });

    const run = await runMatchPass(db, T0 + 3 * HOUR);
    expect(run).toMatchObject({ retrospective: 3, prospective: 0 });
    // Oldest received first.
    expect(run.matches.map((match) => [match.query_id, match.sample_id])).toEqual([
      [queryIdOf(1), here],
      [queryIdOf(2), there],
    ]);
    expect(await listReportsAwaitingRetrospective(db, T0 + 3 * HOUR)).toEqual([]);
  });

  test('the fixes are read only when no stay is evidence, and then only in the report’s own cells', async () => {
    await writeSamples(
      db,
      [0, 300, 600, 900, 1_200].map((after) => ({ ts_utc: T0 + after, ...PLACE })),
    );
    await deriveStays(db);
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1, { center: ELSEWHERE });
    const seen = recording(db);

    const run = await runMatchPass(seen.store, T0 + 2 * HOUR);
    expect(run.matches.map((match) => match.query_id)).toEqual([queryIdOf(1)]);
    // One read of fixes: for the report no stay answered, by cell and by time.
    const reads = seen.reading('location_sample');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('h3_r7 IN');
    expect(reads[0]).toContain('ts_utc BETWEEN');
  });
});

describe('the prospective pass', () => {
  /** Last seen in the two hours from T0; the report reaches the phone ten minutes after that. */
  const ARRIVED = T0 + 2 * HOUR + 600;
  const stillSearching = { window: { from: T0, to: T0 + 2 * HOUR }, issued_at: T0 + 2 * HOUR };

  test('a bystander who arrives after the report matches', async () => {
    await cacheReport(1, ARRIVED, stillSearching);
    expect(await runMatchPass(db, ARRIVED)).toEqual({ ...NOTHING, retrospective: 1 });

    // Ten minutes later the phone is carried past the place, and the wake that follows runs.
    const sampleId = await fix(ARRIVED + 600);
    const run = await runMatchPass(db, ARRIVED + 660);
    expect(run).toMatchObject({ retrospective: 0, prospective: 1 });
    expect(run.matches).toEqual([
      expect.objectContaining({
        query_id: queryIdOf(1),
        revision: 1,
        sample_id: sampleId,
        // Twenty minutes after the window closed, inside the half hour the rule allows.
        dt_sec: 1_200,
        state: 'new',
        created_at: ARRIVED + 660,
      }),
    ]);
  });

  test('a dwell that becomes a stay after the report matches by the stay', async () => {
    await cacheReport(1, ARRIVED, stillSearching);
    await runMatchPass(db, ARRIVED);

    // Somewhere just outside the reach of a single fix's own time: the dwell begins late.
    await writeSamples(
      db,
      [600, 900, 1_200, 1_500].map((after) => ({ ts_utc: ARRIVED + after, ...north(100) })),
    );
    await deriveStays(db);
    const [stay] = await allStays(db);
    const { matches } = await runMatchPass(db, ARRIVED + 1_560);
    expect(matches).toEqual([expect.objectContaining({ stay_id: stay!.id, sample_id: null })]);
  });

  test('a visit written hours after the fact matches when it comes to cover the report', async () => {
    const cell = matchCellAt(PLACE);
    // iOS reports the arrival, four hours before anybody was reported missing there.
    await db.execute(INSERT_VISIT_STAY_SQL, [
      T0 - 4 * HOUR,
      T0 - 4 * HOUR,
      PLACE.lat,
      PLACE.lon,
      50,
      cell,
      0,
    ]);
    await cacheReport(1, T0 + 2 * HOUR);
    // An open visit is the instant of its arrival, which is hours before the window.
    expect(await runMatchPass(db, T0 + 2 * HOUR)).toEqual({ ...NOTHING, retrospective: 1 });
    expect(await runMatchPass(db, T0 + 6 * HOUR)).toMatchObject({ matches: [] });

    // The departure is written a day later, long after any cursor on fixes has moved on.
    await db.execute(CLOSE_VISIT_STAY_SQL, [T0 + 20 * HOUR, T0 - 4 * HOUR]);
    const [visit] = await allStays(db);
    const { matches } = await runMatchPass(db, T0 + DAY);
    expect(matches).toEqual([
      expect.objectContaining({ stay_id: visit!.id, sample_id: null, dt_sec: 0 }),
    ]);
  });

  test('a fix stored up to MATCH_SAMPLE_LATE_SEC after it was taken is still found', async () => {
    await cacheReport(1, T0 + HOUR, { window: { from: T0, to: T0 + 6 * HOUR } });
    await runMatchPass(db, T0 + HOUR);
    await runMatchPass(db, T0 + 3 * HOUR);
    expect(await cursorOf(1)).toBe(T0 + 3 * HOUR);

    // Taken half an hour before the last run, handed over by the OS only now.
    const late = await fix(T0 + 3 * HOUR - 1_800);
    const { matches } = await runMatchPass(db, T0 + 3 * HOUR + 60);
    expect(matches).toEqual([expect.objectContaining({ sample_id: late })]);
  });

  test('a fix stored later than that is not found until the report owes a pass again', async () => {
    const window = { from: T0, to: T0 + 6 * HOUR };
    await cacheReport(1, T0 + HOUR, { window });
    await runMatchPass(db, T0 + HOUR);
    await runMatchPass(db, T0 + 3 * HOUR);

    const tooLate = await fix(T0 + 3 * HOUR - MATCH_SAMPLE_LATE_SEC - 600);
    expect(await runMatchPass(db, T0 + 3 * HOUR + 60)).toEqual({ ...NOTHING, prospective: 1 });

    // The limit is the cursor's, not the rule's: a retrospective pass reads everything.
    await cacheReport(1, T0 + 4 * HOUR, { window, revision: 2, radius_m: 300 });
    const { matches } = await runMatchPass(db, T0 + 4 * HOUR);
    expect(matches).toEqual([expect.objectContaining({ sample_id: tooLate, revision: 2 })]);
  });

  test('fixes are read from the cursor on, and not at all for a report whose time has passed', async () => {
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1, { window: { from: T0, to: T0 + 12 * HOUR } });
    const seen = recording(db);
    await runMatchPass(seen.store, T0 + 2 * HOUR);
    seen.take();

    // Report 1 could take a fix up to T0 + 1 h, and everything up to T0 + 2 h has been read.
    const spy: Array<readonly unknown[]> = [];
    const spied: SqlExecutor = {
      execute: (sql, params) => {
        if (sql.includes('FROM location_sample')) spy.push(params ?? []);
        return seen.store.execute(sql, params);
      },
    };
    expect((await runMatchPass(spied, T0 + 2 * HOUR + 600)).matches).toEqual([]);
    const laterFix = await fix(T0 + 3 * HOUR - 60);
    const run = await runMatchPass(spied, T0 + 3 * HOUR);
    expect(run.matches).toEqual([
      expect.objectContaining({ query_id: queryIdOf(2), sample_id: laterFix }),
    ]);
    // One read per run, for report 2 alone: from the cursor less the allowance to the end of
    // its range.
    expect(spy).toEqual([
      [T0 + 2 * HOUR - MATCH_SAMPLE_LATE_SEC, T0 + 12 * HOUR + 1_800],
      [T0 + 2 * HOUR - MATCH_SAMPLE_LATE_SEC, T0 + 12 * HOUR + 1_800],
    ]);

    // With report 2 matched, and report 1's cursor moved up past the end of its range, nothing
    // is left that a new fix could be evidence for.
    await fix(T0 + 3 * HOUR + 60);
    await runMatchPass(seen.store, T0 + 3 * HOUR + 120);
    expect(await cursorOf(1)).toBe(T0 + 3 * HOUR + 120);
    seen.take();
    expect(await runMatchPass(seen.store, T0 + 3 * HOUR + 180)).toEqual({
      ...NOTHING,
      prospective: 1,
    });
    expect(seen.reading('location_sample')).toEqual([]);
    expect(seen.reading('stay')).toHaveLength(1);
  });
});

describe('one match per report', () => {
  test('no report notifies twice, however often the runner runs and whatever arrives', async () => {
    await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR, { window: { from: T0, to: T0 + 5 * DAY } });
    const first = await runMatchPass(db, T0 + 2 * HOUR);
    expect(first.matches).toHaveLength(1);

    for (const later of [T0 + 2 * HOUR, T0 + 3 * HOUR, T0 + DAY, T0 + 4 * DAY]) {
      // The phone is at the place again each time: more evidence, and no second match.
      await fix(later - 60);
      await deriveStays(db);
      expect((await runMatchPass(db, later)).matches).toEqual([]);
    }
    expect(await listMatches(db)).toEqual(first.matches);
  });

  test('a revised report is matched again only when its criteria changed', async () => {
    // 400 m from the pin: outside the 300 m the first revision reaches.
    const sampleId = await fix(T0 + 600, north(400));
    await cacheReport(1, T0 + 2 * HOUR);
    expect(await runMatchPass(db, T0 + 2 * HOUR)).toEqual({ ...NOTHING, retrospective: 1 });

    // Revision 2 edits the description. Nobody who did not match can match now.
    expect(
      await cacheReport(1, T0 + 3 * HOUR, {
        revision: 2,
        person: { name: 'Alex Rivera', description: 'Now wearing a red cap.' },
      }),
    ).toEqual({ outcome: 'revised', rematch: false });
    expect(await runMatchPass(db, T0 + 3 * HOUR)).toEqual({ ...NOTHING, prospective: 1 });

    // Revision 3 widens the search to 450 m, and the fix taken before any of this is inside it.
    expect(await cacheReport(1, T0 + 4 * HOUR, { revision: 3, radius_m: 450 })).toEqual({
      outcome: 'revised',
      rematch: true,
    });
    const widened = await runMatchPass(db, T0 + 4 * HOUR);
    expect(widened).toMatchObject({ retrospective: 1, prospective: 0 });
    expect(widened.matches).toEqual([
      expect.objectContaining({ query_id: queryIdOf(1), revision: 3, sample_id: sampleId }),
    ]);

    // Revision 4 widens it again. The device has its match: no second one, and no debt left.
    await cacheReport(1, T0 + 5 * HOUR, { revision: 4, radius_m: 900 });
    expect(await listReportsAwaitingRetrospective(db, T0 + 5 * HOUR)).toHaveLength(1);
    expect(await runMatchPass(db, T0 + 5 * HOUR)).toEqual(NOTHING);
    expect(await listReportsAwaitingRetrospective(db, T0 + 5 * HOUR)).toEqual([]);
    expect(await listMatches(db)).toEqual(widened.matches);
    expect((await getMatchByQueryId(db, queryIdOf(1)))?.revision).toBe(3);
  });

  test('a match row that is already there is left as it is, and is not returned', async () => {
    const sampleId = await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    const earlier = await insertMatchIfAbsent(db, {
      query_id: queryIdOf(1),
      revision: 1,
      stay_id: null,
      sample_id: sampleId,
      distance_m: 12,
      dt_sec: 0,
      created_at: T0 + HOUR,
    });

    expect(await runMatchPass(db, T0 + 2 * HOUR)).toEqual(NOTHING);
    expect(await listMatches(db)).toEqual([earlier]);
    expect(await cursorOf(1)).toBe(T0 + 2 * HOUR);
  });

  test('a report revised while a run was reading it keeps its debt', async () => {
    await fix(T0 + 600, north(400));
    await cacheReport(1, T0 + 2 * HOUR);
    const widened = await verifiedQueryWith({
      query_id: queryIdOf(1),
      issued_at: T0 + HOUR,
      expires_at: T0 + 20 * DAY,
      center: PLACE,
      radius_m: 450,
      window: { from: T0, to: T0 + 1_800 },
      revision: 2,
    });
    // The fetcher stores revision 2 after the run has matched revision 1 and before it writes.
    let revised = false;
    const racing: SqlExecutor = {
      async execute(sql, params) {
        if (!revised && /^\s*UPDATE report_cache/.test(sql)) {
          revised = true;
          await upsertCachedReport(db, widened, T0 + 2 * HOUR);
        }
        return db.execute(sql, params);
      },
    };

    expect((await runMatchPass(racing, T0 + 2 * HOUR)).matches).toEqual([]);
    expect(revised).toBe(true);
    expect(await cursorOf(1)).toBeNull();
    const { matches } = await runMatchPass(racing, T0 + 2 * HOUR + 60);
    expect(matches).toEqual([expect.objectContaining({ revision: 2 })]);
  });
});

describe('reports that cannot match', () => {
  test('an expired report matches nothing', async () => {
    await fix(T0 + 600);
    const expiry = T0 + 2 * DAY;
    await cacheReport(1, T0 + 2 * HOUR, { expires_at: expiry });
    await cacheReport(2, T0 + 2 * HOUR + 1);

    // At its expiry, to the second: the same history, and only the live report matches.
    const run = await runMatchPass(db, expiry);
    expect(run.matches.map((match) => match.query_id)).toEqual([queryIdOf(2)]);
    expect(run.retrospective).toBe(1);
    expect(await getMatchByQueryId(db, queryIdOf(1))).toBeNull();
    expect(await cursorOf(1)).toBeNull();
  });

  test('a report past its expiry is not matched even if the purge has not run', async () => {
    await cacheReport(1, T0 + 2 * HOUR, { expires_at: T0 + 2 * DAY });
    await runMatchPass(db, T0 + 2 * HOUR);
    await fix(T0 + 600);
    await cacheReport(1, T0 + 3 * DAY, { expires_at: T0 + 2 * DAY, revision: 2, radius_m: 300 });
    expect(await runMatchPass(db, T0 + 3 * DAY)).toEqual(NOTHING);
    expect(await listMatches(db)).toEqual([]);
  });

  test('history past retention is not evidence, purged or not', async () => {
    await fix(T0 + 600);
    const now = T0 + RETENTION_SEC + 2 * HOUR;
    await cacheReport(1, now, { issued_at: T0 + 20 * DAY, expires_at: T0 + 45 * DAY });
    await cacheReport(2, now + 1, {
      issued_at: T0 + 20 * DAY,
      expires_at: T0 + 45 * DAY,
      window: { from: T0, to: T0 + 10 * DAY },
    });

    // Report 1's whole range is past retention; report 2's is not, but the fix inside it is.
    expect(await runMatchPass(db, now)).toEqual({ ...NOTHING, retrospective: 2 });
    expect(await listReportsAwaitingRetrospective(db, now)).toEqual([]);

    await purgeExpired(db, now);
    expect(await runMatchPass(db, now + 60)).toEqual({ ...NOTHING, prospective: 1 });
  });

  test('a payload this build cannot read is skipped, and the other reports are still matched', async () => {
    await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1);
    await db.execute('UPDATE report_cache SET payload_json = ? WHERE query_id = ?', [
      JSON.stringify({ v: 99 }),
      queryIdOf(1),
    ]);

    const seen = recording(db);
    const run = await runMatchPass(seen.store, T0 + 2 * HOUR);
    expect(run).toMatchObject({ retrospective: 1, unreadable: 1 });
    expect(run.matches.map((match) => match.query_id)).toEqual([queryIdOf(2)]);
    expect(await cursorOf(2)).toBe(T0 + 2 * HOUR);
    const debt = await db.execute('SELECT last_matched_at FROM report_cache WHERE query_id = ?', [
      queryIdOf(1),
    ]);
    expect(debt).toEqual([{ last_matched_at: null }]);

    // It is not parsed again on every wake either.
    seen.take();
    expect(await runMatchPass(seen.store, T0 + 2 * HOUR + 60)).toMatchObject({ unreadable: 1 });
    expect(seen.statements.filter((sql) => sql.includes('payload_json'))).toEqual([]);
  });
});

describe('cover shards', () => {
  test('a report is matched whichever shard it came from: the watch list is never read', async () => {
    // Nothing is subscribed, so by the watch list every cached report is a cover report.
    expect(await db.execute('SELECT topic FROM subscription')).toEqual([]);
    await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1, { center: ELSEWHERE });

    const seen = recording(db);
    const run = await runMatchPass(seen.store, T0 + 2 * HOUR);
    // The history decides, and only the history: the report it crossed, and not the other.
    expect(run.matches.map((match) => match.query_id)).toEqual([queryIdOf(1)]);
    expect(seen.statements.filter((sql) => sql.includes('subscription'))).toEqual([]);
    // A match says the history crossed the report. Nothing in it says where the report is.
    expect(Object.keys(run.matches[0]!).sort()).toEqual([
      'created_at',
      'distance_m',
      'dt_sec',
      'id',
      'query_id',
      'revision',
      'sample_id',
      'state',
      'stay_id',
    ]);
  });
});

describe('a run with nothing new', () => {
  test('running twice with no new data is a no-op', async () => {
    await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    await cacheReport(2, T0 + 2 * HOUR + 1, { center: ELSEWHERE });
    const seen = recording(db);
    expect((await runMatchPass(seen.store, T0 + 2 * HOUR)).matches).toHaveLength(1);
    const before = await db.execute('SELECT * FROM report_cache ORDER BY query_id');
    const matches = await listMatches(db);

    for (const again of [T0 + 2 * HOUR, T0 + 2 * HOUR + 60]) {
      seen.take();
      expect(await runMatchPass(seen.store, again)).toEqual({ ...NOTHING, prospective: 1 });
      expect(seen.writes()).toEqual([]);
    }
    expect(await db.execute('SELECT * FROM report_cache ORDER BY query_id')).toEqual(before);
    expect(await listMatches(db)).toEqual(matches);
  });

  test('a report is parsed once per revision, not on every wake', async () => {
    await cacheReport(1, T0 + 2 * HOUR);
    const seen = recording(db);
    const payloadReads = () => seen.take().filter((sql) => sql.includes('payload_json')).length;

    await runMatchPass(seen.store, T0 + 2 * HOUR);
    expect(payloadReads()).toBe(1);
    await runMatchPass(seen.store, T0 + 2 * HOUR + 60);
    await runMatchPass(seen.store, T0 + 2 * HOUR + 120);
    expect(payloadReads()).toBe(0);

    await cacheReport(1, T0 + 3 * HOUR, { revision: 2, radius_m: 300 });
    await runMatchPass(seen.store, T0 + 3 * HOUR);
    // The fetcher's own read and write of the row, and one read by the runner.
    expect(seen.statements.filter((sql) => sql.includes('payload_json'))).toHaveLength(1);
  });

  test('the cursor is written once it is MATCH_SAMPLE_LATE_SEC behind, and not before', async () => {
    await cacheReport(1, T0 + 2 * HOUR);
    const seen = recording(db);
    await runMatchPass(seen.store, T0 + 2 * HOUR);

    seen.take();
    await runMatchPass(seen.store, T0 + 2 * HOUR + MATCH_SAMPLE_LATE_SEC);
    expect(seen.writes()).toEqual([]);
    expect(await cursorOf(1)).toBe(T0 + 2 * HOUR);

    await runMatchPass(seen.store, T0 + 2 * HOUR + MATCH_SAMPLE_LATE_SEC + 1);
    expect(seen.writes()).toHaveLength(1);
    expect(await cursorOf(1)).toBe(T0 + 2 * HOUR + MATCH_SAMPLE_LATE_SEC + 1);
  });

  test('a cursor ahead of the clock, left by a clock since set back, is brought back', async () => {
    await cacheReport(1, T0 + 2 * HOUR, { window: { from: T0, to: T0 + 5 * DAY } });
    await runMatchPass(db, T0 + 3 * DAY);
    expect(await cursorOf(1)).toBe(T0 + 3 * DAY);

    // The clock is a day back. A fix taken now is still found.
    const sampleId = await fix(T0 + 2 * DAY - 60);
    const { matches } = await runMatchPass(db, T0 + 2 * DAY);
    expect(matches).toEqual([expect.objectContaining({ sample_id: sampleId })]);

    await cacheReport(2, T0 + 2 * DAY, { center: ELSEWHERE });
    await runMatchPass(db, T0 + 3 * DAY);
    await runMatchPass(db, T0 + 2 * DAY);
    expect(await cursorOf(2)).toBe(T0 + 2 * DAY);
  });

  test('a store with no reports is one read', async () => {
    await fix(T0 + 600);
    const seen = recording(db);
    expect(await runMatchPass(seen.store, T0 + HOUR)).toEqual(NOTHING);
    expect(seen.statements).toHaveLength(1);
  });
});

describe('the time', () => {
  test('a time in milliseconds is refused before anything is read or written', async () => {
    await fix(T0 + 600);
    await cacheReport(1, T0 + 2 * HOUR);
    const seen = recording(db);
    for (const bad of [(T0 + 2 * HOUR) * 1_000, T0 + 0.5, -1, Number.NaN]) {
      await expect(runMatchPass(seen.store, bad)).rejects.toThrow(RangeError);
    }
    expect(seen.statements).toEqual([]);
    expect(await cursorOf(1)).toBeNull();
    expect(await listMatches(db)).toEqual([]);
  });

  test('the same store and the same time give the same matches, whatever the clock says', async () => {
    const stores = [db, openMemoryDb()] as const;
    await migrate(stores[1]);
    const outcomes = [];
    for (const store of stores) {
      await insertLocationSample(store, {
        ts_utc: T0 + 600,
        ...PLACE,
        accuracy_m: 20,
        source: 'wm',
      });
      const entry = await verifiedQueryWith({
        query_id: queryIdOf(1),
        issued_at: T0 + HOUR,
        expires_at: T0 + 20 * DAY,
        center: PLACE,
        radius_m: 150,
        window: { from: T0, to: T0 + 1_800 },
      });
      await upsertCachedReport(store, entry, T0 + 2 * HOUR);
      outcomes.push(await runMatchPass(store, T0 + 2 * HOUR));
    }
    stores[1].close();
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]?.matches[0]?.created_at).toBe(T0 + 2 * HOUR);
  });
});
