import { deriveStays } from '../stay/derive';
import type { SqlDatabase, SqlExecutor } from '../store/driver';
import { num } from '../store/driver';
import { insertMatchIfAbsent } from '../store/tables/match';
import {
  enqueueResponse,
  markResponseFailed,
  markResponseSending,
  markResponseSent,
} from '../store/tables/outboundResponse';
import { upsertCachedReport } from '../store/tables/reportCache';
import { verifiedQueryWith } from './fixtures';
import { writeSamples, writeVisit } from './stayVectors';

/**
 * TEST SUPPORT, not exported from the package. A store as a phone would have it after
 * `SEED_DAYS` days with no purge: a fix every 15 minutes, the stays derived from them, a visit
 * row a day, and a report every three days with its match and a tip.
 */
export const DAY = 86_400;
export const SEED_DAYS = 60;
/** How long a seeded report lives. Shorter than retention, so the newer ones are still live. */
export const SEED_REPORT_TTL = 20 * DAY;
const FIX_INTERVAL = 15 * 60;

const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9916, lon: 77.6146 };
const road = { lat: 13.05, lon: 77.7 };

/** Home at night, the office from 09:00 to 17:00, one fix on the road each way. */
function placeAt(ts: number): { lat: number; lon: number } {
  const hour = Math.floor((ts % DAY) / 3600);
  const firstOfHour = ts % 3600 < FIX_INTERVAL;
  if (hour === 8 || hour === 17) {
    return firstOfHour ? road : hour === 8 ? office : home;
  }
  return hour > 8 && hour < 17 ? office : home;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A distinct, well-formed report id per index. */
export function seedQueryId(index: number): string {
  const digit = (value: number) => CROCKFORD[value % CROCKFORD.length] ?? '0';
  return `01JB3Z6Q7W8X9Y0ZABCDEFGH${digit(Math.floor(index / 32))}${digit(index)}`;
}

export async function count(db: SqlExecutor, table: string, where = '1 = 1'): Promise<number> {
  const rows = await db.execute(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`);
  return num(rows[0] ?? {}, 'n');
}

/** Rows in the three tables the purge must not touch, all dated at the far end of the seed. */
async function seedTablesOutsideThePurge(db: SqlExecutor, ts: number) {
  await db.execute(
    `INSERT INTO own_report (idempotency_key, state, request_json, created_at, updated_at)
     VALUES ('3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34', 'queued', '{}', ?, ?)`,
    [ts, ts],
  );
  await db.execute(
    `INSERT INTO received_response (response_id, query_id, text, received_at, fetched_at)
     VALUES ('r-old', ?, 'Seen at the station.', ?, ?)`,
    [seedQueryId(0), ts, ts],
  );
  await db.execute(
    `INSERT INTO subscription (topic, res, reason, added_at, refreshed_at)
     VALUES ('8560145bfffffff', 5, 'visited', ?, ?)`,
    [ts, ts],
  );
}

/**
 * Fills the store with `SEED_DAYS` days ending at `nowTs`. Reports are issued every three days;
 * each has a match, and a tip that is sent, failed or still queued in turn.
 */
export async function seedHistory(db: SqlDatabase, nowTs: number): Promise<void> {
  const start = nowTs - SEED_DAYS * DAY;
  await db.transaction(async (tx) => {
    const fixes = [];
    for (let ts = start; ts <= nowTs; ts += FIX_INTERVAL) {
      fixes.push({ ts_utc: ts, ...placeAt(ts) });
    }
    await writeSamples(tx, fixes);
    // What the iOS module adds: a visit a day, at a place no fix was taken.
    for (let day = 0; day < SEED_DAYS; day++) {
      const arrived = start + day * DAY + 18 * 3600 + 300;
      await writeVisit(tx, {
        start_ts: arrived,
        end_ts: arrived + 1800,
        lat: 12.93,
        lon: 77.55,
        radius_m: 65,
        closed: true,
      });
    }
    await seedTablesOutsideThePurge(tx, start);
  });
  await deriveStays(db);

  for (let index = 0; index * 3 <= SEED_DAYS; index++) {
    const issued = start + index * 3 * DAY;
    const query_id = seedQueryId(index);
    const entry = await verifiedQueryWith({
      query_id,
      issued_at: issued,
      expires_at: issued + SEED_REPORT_TTL,
      window: { from: issued - 7200, to: issued - 5400 },
    });
    await upsertCachedReport(db, entry, issued);
    await insertMatchIfAbsent(db, {
      query_id,
      revision: 1,
      stay_id: null,
      sample_id: 1 + index,
      distance_m: 40,
      dt_sec: 0,
      created_at: issued + 600,
    });
    const tip = await enqueueResponse(
      db,
      { query_id, idempotency_key: `tip-${index}`, text: 'Seen near the metro.', phone: null },
      issued + 3600,
    );
    if (tip !== null && index % 3 !== 2) {
      await markResponseSending(db, tip.id);
      if (index % 3 === 0) {
        await markResponseSent(db, tip.id, `r-${index}`, issued + 3660);
      } else {
        await markResponseFailed(db, tip.id, 'report_ended');
      }
    }
  }
}
