import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC, RETENTION_SEC } from '../constants';
import { deriveStays } from '../stay/derive';
import { migrate } from '../store/migrations';
import { KV_KEYS, kvGet, kvSet } from '../store/tables/kv';
import {
  listSamplesAfterId,
  listSamplesBetween,
  type LocationSample,
} from '../store/tables/locationSample';
import { listMatches } from '../store/tables/match';
import { listLiveReports } from '../store/tables/reportCache';
import { CLOSE_VISIT_STAY_SQL, insertStay, type Stay } from '../store/tables/stay';
import { openMemoryDb } from '../testing/memoryDb';
import { count, DAY, SEED_DAYS, seedHistory, seedQueryId } from '../testing/retentionSeed';
import { allStays, derivedStays, writeSamples, writeVisit } from '../testing/stayVectors';
import { purgeExpired } from './purge';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

/** 02:00 UTC, so the cutoff 30 days earlier falls in the middle of a night at home. */
const NOW = 1_791_000_000 - (1_791_000_000 % DAY) + 2 * 3600;
const CUTOFF = NOW - RETENTION_SEC;
const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9916, lon: 77.6146 };

const samples = (): Promise<LocationSample[]> => listSamplesAfterId(db, 0);
const cursor = async () => Number(await kvGet(db, KV_KEYS.stayDerivationLastSampleId));
const interval = (stay: Stay) => [stay.start_ts, stay.end_ts];

/** The oldest time held in each table the purge is responsible for. */
async function oldest() {
  const min = async (sql: string) => (await db.execute(sql))[0]?.oldest ?? null;
  return {
    sample: await min('SELECT min(ts_utc) AS oldest FROM location_sample'),
    stayStart: await min('SELECT min(start_ts) AS oldest FROM stay'),
    stayEnd: await min('SELECT min(end_ts) AS oldest FROM stay'),
    reportExpiry: await min('SELECT min(expires_at) AS oldest FROM report_cache'),
    match: await min('SELECT min(created_at) AS oldest FROM "match"'),
    finishedTip: await min(
      `SELECT min(coalesce(sent_at, created_at)) AS oldest FROM outbound_response
       WHERE state IN ('sent', 'failed')`,
    ),
  };
}

describe('60 days of history, never purged', () => {
  beforeEach(async () => {
    await seedHistory(db, NOW);
  });

  test('the seed reaches 60 days back in every table the purge owns', async () => {
    const start = NOW - SEED_DAYS * DAY;
    expect(await oldest()).toEqual({
      sample: start,
      stayStart: start,
      stayEnd: expect.any(Number),
      reportExpiry: expect.any(Number),
      match: start + 600,
      finishedTip: start + 3660,
    });
    expect(await count(db, 'location_sample', `ts_utc < ${CUTOFF}`)).toBe(30 * 96);
    expect(await count(db, 'stay', `end_ts < ${CUTOFF}`)).toBeGreaterThan(80);
    expect(await count(db, 'stay', `start_ts < ${CUTOFF} AND end_ts >= ${CUTOFF}`)).toBe(1);
    expect(await count(db, 'report_cache', `expires_at <= ${NOW}`)).toBe(14);
  });

  test('nothing older than 30 days survives the purge, in any table', async () => {
    const result = await purgeExpired(db, NOW);

    const after = await oldest();
    expect(after.sample).toBe(CUTOFF);
    expect(after.stayStart).toBe(CUTOFF);
    expect(after.stayEnd).toBeGreaterThanOrEqual(CUTOFF);
    expect(after.reportExpiry).toBeGreaterThan(NOW);
    expect(after.match).toBeGreaterThanOrEqual(CUTOFF);
    expect(after.finishedTip).toBeGreaterThanOrEqual(
      NOW - OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC,
    );
    expect(await count(db, 'match', 'query_id NOT IN (SELECT query_id FROM report_cache)')).toBe(0);

    expect(result).toMatchObject({
      cutoffTs: CUTOFF,
      samples: 30 * 96,
      staysTrimmed: 1,
      reports: 14,
      matches: 14,
    });
    expect(result.stays).toBeGreaterThan(80);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(NOW));
  });

  test('everything inside retention is still there', async () => {
    const kept = {
      location_sample: await count(db, 'location_sample', `ts_utc >= ${CUTOFF}`),
      stay: await count(db, 'stay', `end_ts >= ${CUTOFF}`),
      report_cache: await count(db, 'report_cache', `expires_at > ${NOW}`),
      outbound_response: await count(
        db,
        'outbound_response',
        `state IN ('queued', 'sending')
         OR coalesce(sent_at, created_at) >= ${NOW - OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC}`,
      ),
    };
    expect(kept).toEqual({
      location_sample: 30 * 96 + 1,
      stay: expect.any(Number),
      report_cache: 7,
      outbound_response: 9,
    });

    await purgeExpired(db, NOW);
    for (const [table, rows] of Object.entries(kept)) {
      expect(await count(db, table)).toBe(rows);
    }
    expect((await listLiveReports(db, NOW)).map((report) => report.query.query_id)).toEqual(
      [14, 15, 16, 17, 18, 19, 20].map(seedQueryId),
    );
    expect((await listMatches(db)).map((match) => match.query_id).sort()).toEqual(
      [14, 15, 16, 17, 18, 19, 20].map(seedQueryId),
    );
    // A tip still waiting to be sent is the send queue's, however old it is.
    expect(await count(db, 'outbound_response', "state = 'queued'")).toBe(7);
  });

  test('tables with no decided retention are left alone', async () => {
    await purgeExpired(db, NOW);
    expect(await count(db, 'own_report')).toBe(1);
    expect(await count(db, 'received_response')).toBe(1);
    expect(await count(db, 'subscription')).toBe(1);
  });

  test('a second run deletes nothing more', async () => {
    await purgeExpired(db, NOW);
    expect(await purgeExpired(db, NOW)).toEqual({
      cutoffTs: CUTOFF,
      samples: 0,
      stays: 0,
      staysTrimmed: 0,
      reports: 0,
      matches: 0,
      responses: 0,
    });
  });

  test('no stay is left claiming a time its fixes were deleted from, and no fix without its stay', async () => {
    const before = await derivedStays(db);
    await purgeExpired(db, NOW);
    const after = await derivedStays(db);

    for (const stay of after) {
      expect(stay.start_ts).toBeGreaterThanOrEqual(CUTOFF);
      expect((await listSamplesBetween(db, stay.start_ts, stay.end_ts)).length).toBeGreaterThan(0);
    }
    // The night at home that the cutoff cuts through: same row, now starting at the cutoff.
    const cut = before.find((stay) => stay.start_ts < CUTOFF && stay.end_ts >= CUTOFF);
    expect(after.find((stay) => stay.id === cut?.id)).toMatchObject({
      start_ts: CUTOFF,
      end_ts: cut?.end_ts,
      closed: true,
    });
    // The oldest fix left and the oldest stay left begin at the same moment.
    const first = (await samples())[0];
    expect(first?.ts_utc).toBe(CUTOFF);
    expect(after[0]).toMatchObject({ start_ts: CUTOFF });
  });

  test('the app was closed for weeks: one run catches up completely', async () => {
    // Last purge long ago, then nothing ran for 45 days while capture kept writing natively.
    await purgeExpired(db, NOW - 45 * DAY);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(NOW - 45 * DAY));

    await purgeExpired(db, NOW);
    const after = await oldest();
    expect(after.sample).toBe(CUTOFF);
    expect(after.stayStart).toBe(CUTOFF);
    expect(after.reportExpiry).toBeGreaterThan(NOW);
    expect(await count(db, 'location_sample')).toBe(30 * 96 + 1);
  });

  test('the app stays closed past the whole history: everything goes, and capture starts clean', async () => {
    const later = NOW + 40 * DAY;
    const result = await purgeExpired(db, later);
    expect(result.samples).toBe(SEED_DAYS * 96 + 1);
    expect(await samples()).toEqual([]);
    expect(await allStays(db)).toEqual([]);
    expect(await count(db, 'report_cache')).toBe(0);
    expect(await count(db, 'match')).toBe(0);
    // Sample ids start again at 1; the derivation cursor must not be left above them.
    expect(await cursor()).toBe(0);

    // The native module writes for a while before any JavaScript runs again.
    const fixes = Array.from({ length: 6 }, (_, index) => ({
      ts_utc: later + index * 900,
      ...home,
    }));
    await writeSamples(db, fixes);
    await deriveStays(db);
    expect((await derivedStays(db)).map(interval)).toEqual([[later, later + 5 * 900]]);
  });
});

describe('clock changes', () => {
  test('a "last run" in the future does not hold the purge back', async () => {
    // The clock was a year ahead when the purge last ran, and has been corrected since.
    await kvSet(db, KV_KEYS.purgeLastRunAt, String(NOW + 365 * DAY));
    await writeSamples(db, [
      { ts_utc: CUTOFF - 1, ...home },
      { ts_utc: CUTOFF, ...home },
    ]);
    expect((await purgeExpired(db, NOW)).samples).toBe(1);
    expect((await samples()).map((sample) => sample.ts_utc)).toEqual([CUTOFF]);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe(String(NOW));
  });

  test('the clock is set back: nothing inside retention by the new time is deleted', async () => {
    await writeSamples(db, [
      { ts_utc: NOW - DAY, ...home },
      { ts_utc: NOW, ...home },
    ]);
    await purgeExpired(db, NOW);
    // A phone that started with its clock unset: years before every row.
    expect((await purgeExpired(db, 946_684_800)).samples).toBe(0);
    expect(await samples()).toHaveLength(2);
  });

  test('the clock jumps forward: everything it puts past retention is deleted', async () => {
    await writeSamples(db, [
      { ts_utc: NOW - DAY, ...home },
      { ts_utc: NOW, ...home },
    ]);
    expect((await purgeExpired(db, NOW + RETENTION_SEC)).samples).toBe(1);
    expect((await samples()).map((sample) => sample.ts_utc)).toEqual([NOW]);
  });

  test('fixes stored with a clock that was behind are purged without stranding the cursor', async () => {
    // Ids 1 to 4 at the real time, then the clock goes back 40 days for ids 5 to 7.
    await writeSamples(db, [
      { ts_utc: NOW - 3600, ...home },
      { ts_utc: NOW - 2700, ...home },
      { ts_utc: NOW - 1800, ...home },
      { ts_utc: NOW - 900, ...home },
      { ts_utc: NOW - 40 * DAY, ...office },
      { ts_utc: NOW - 40 * DAY + 900, ...office },
      { ts_utc: NOW - 40 * DAY + 1800, ...office },
    ]);
    await deriveStays(db);
    expect(await cursor()).toBe(7);

    expect((await purgeExpired(db, NOW)).samples).toBe(3);
    expect(await cursor()).toBe(4);

    // Ids 5 to 8 are used again before derivation next runs. None may be skipped.
    await writeSamples(db, [
      { ts_utc: NOW, ...office },
      { ts_utc: NOW + 900, ...office },
      { ts_utc: NOW + 1800, ...office },
      { ts_utc: NOW + 2700, ...home },
    ]);
    await deriveStays(db);
    expect((await derivedStays(db)).map(interval)).toEqual([
      [NOW - 3600, NOW - 900],
      [NOW, NOW + 1800],
    ]);
  });

  test.each([
    ['milliseconds', NOW * 1000],
    ['a fraction', NOW + 0.5],
    ['a negative time', -1],
    ['not a number', Number.NaN],
  ])('%s is refused and nothing is deleted', async (_label, bad) => {
    await writeSamples(db, [{ ts_utc: NOW - 40 * DAY, ...home }]);
    await expect(purgeExpired(db, bad)).rejects.toThrow(RangeError);
    expect(await samples()).toHaveLength(1);
    expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBeNull();
  });
});

describe('with stay derivation', () => {
  /** A device that has not moved for 40 days: one open stay, far longer than retention. */
  async function fortyDaysAtHome() {
    const fixes = [];
    for (let ts = NOW - 40 * DAY; ts <= NOW; ts += 3600) {
      fixes.push({ ts_utc: ts, ...home });
    }
    await writeSamples(db, fixes);
  }

  test('an open stay longer than retention keeps its row, cut at the cutoff, and goes on growing', async () => {
    await fortyDaysAtHome();
    const { openStayId } = await deriveStays(db);
    await purgeExpired(db, NOW);
    expect(await derivedStays(db)).toMatchObject([
      { id: openStayId, start_ts: CUTOFF, end_ts: NOW, closed: false },
    ]);

    await writeSamples(db, [
      { ts_utc: NOW + 3600, ...home },
      { ts_utc: NOW + 7200, ...office },
    ]);
    await deriveStays(db);
    expect(await derivedStays(db)).toMatchObject([
      { id: openStayId, start_ts: CUTOFF, end_ts: NOW + 3600, closed: true },
    ]);
  });

  test('purging before deriving leaves nothing before the cutoff either', async () => {
    await fortyDaysAtHome();
    await purgeExpired(db, NOW);
    await deriveStays(db);
    expect((await derivedStays(db)).map(interval)).toEqual([[CUTOFF, NOW]]);
  });

  test('a purge between two derivation runs does not lose the dwell in progress', async () => {
    // Ten minutes at the office: not yet a stay, so derivation is still holding its fixes.
    await writeSamples(db, [
      { ts_utc: NOW - 600, ...office },
      { ts_utc: NOW, ...office },
    ]);
    await deriveStays(db);
    expect(await derivedStays(db)).toEqual([]);

    await purgeExpired(db, NOW);
    await writeSamples(db, [{ ts_utc: NOW + 600, ...office }]);
    await deriveStays(db);
    expect((await derivedStays(db)).map(interval)).toEqual([[NOW - 600, NOW + 600]]);
  });

  test('a rolled-back purge changes nothing: fixes and stays go together or not at all', async () => {
    await fortyDaysAtHome();
    await deriveStays(db);
    const before = { samples: await samples(), stays: await allStays(db) };
    // The last statement of the purge fails.
    await db.execute('DROP TABLE kv');
    await expect(purgeExpired(db, NOW)).rejects.toThrow(/kv/);
    expect({ samples: await samples(), stays: await allStays(db) }).toEqual(before);
  });

  test('visit rows: a closed one is cut like any stay, an open one is deleted whole', async () => {
    await writeVisit(db, {
      start_ts: CUTOFF - 3600,
      end_ts: CUTOFF + 3600,
      ...office,
      radius_m: 65,
      closed: true,
    });
    // Arrival 31 days ago, departure not reported yet.
    await writeVisit(db, {
      start_ts: CUTOFF - DAY,
      end_ts: CUTOFF - DAY,
      ...home,
      radius_m: 65,
      closed: false,
    });
    // Arrival inside retention, still open: must keep the arrival time the module closes it by.
    const arrival = NOW - 3600;
    await writeVisit(db, {
      start_ts: arrival,
      end_ts: arrival,
      ...home,
      radius_m: 65,
      closed: false,
    });

    expect(await purgeExpired(db, NOW)).toMatchObject({ stays: 1, staysTrimmed: 1 });
    expect(await allStays(db)).toMatchObject([
      { start_ts: CUTOFF, end_ts: CUTOFF + 3600, source: 'visit', closed: true },
      { start_ts: arrival, end_ts: arrival, source: 'visit', closed: false },
    ]);
    expect(await db.execute(`${CLOSE_VISIT_STAY_SQL} RETURNING id`, [NOW, arrival])).toHaveLength(
      1,
    );
  });

  test('a stay that ended exactly at the cutoff is kept; one second earlier it is not', async () => {
    const row = {
      ...home,
      radius_m: 30,
      sample_count: 3,
      closed: true,
      source: 'derived' as const,
    };
    await insertStay(db, { ...row, start_ts: CUTOFF - 3600, end_ts: CUTOFF - 1 });
    await insertStay(db, { ...row, start_ts: CUTOFF - 3600, end_ts: CUTOFF });
    await purgeExpired(db, NOW);
    expect((await allStays(db)).map(interval)).toEqual([[CUTOFF, CUTOFF]]);
  });
});
