import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { rawQueryWithUnknownField, sampleQuery, verifiedQueryWith } from '../../testing/fixtures';
import { openMemoryDb } from '../../testing/memoryDb';
import { StoreRowError } from '../driver';
import { migrate } from '../migrations';
import {
  advanceMatchState,
  deleteOrphanMatches,
  getMatchByQueryId,
  insertMatchIfAbsent,
  listMatches,
  MATCH_STATES,
  type NewMatch,
} from './match';
import {
  deleteCachedReport,
  deleteExpiredReports,
  getCachedReport,
  listLiveReportCursors,
  listLiveReports,
  listReportsAwaitingRetrospective,
  setLastMatchedAt,
  upsertCachedReport,
} from './reportCache';
import {
  deleteSubscription,
  listSubscriptions,
  putSubscription,
  SUBSCRIPTION_REASONS,
} from './subscription';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const base = sampleQuery();
const OTHER_ID = '01JB3Z6Q7W8X9Y0ZABCDEFGHJQ';

describe('report_cache', () => {
  test('a new report is stored and owes a retrospective pass', async () => {
    const entry = await verifiedQueryWith({});
    expect(await upsertCachedReport(db, entry, 5000)).toEqual({
      outcome: 'inserted',
      rematch: true,
    });
    const cached = await getCachedReport(db, base.query_id);
    expect(cached).toEqual({
      query: entry.query,
      payload_json: JSON.stringify(entry.raw),
      received_at: 5000,
      last_matched_at: null,
    });
    expect(await listReportsAwaitingRetrospective(db, 5000)).toHaveLength(1);
  });

  test('stores the entry verbatim, members no schema knows included', async () => {
    const raw = rawQueryWithUnknownField();
    const { query } = await verifiedQueryWith({});
    await upsertCachedReport(db, { query: { ...query, query_id: String(raw.query_id) }, raw }, 1);
    const cached = await getCachedReport(db, String(raw.query_id));
    expect(JSON.parse(cached?.payload_json ?? '{}')).toEqual(raw);
  });

  test('the runner moves the cursor; the report then no longer awaits a retrospective pass', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    expect((await getCachedReport(db, base.query_id))?.last_matched_at).toBe(6000);
    expect(await listReportsAwaitingRetrospective(db, 6000)).toEqual([]);
    expect(await listLiveReports(db, 6000)).toHaveLength(1);
  });

  test('the cursor is written only for the revision the runner matched', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    expect(await setLastMatchedAt(db, base.query_id, base.revision, 6000)).toBe(true);
    // The fetcher stores a widened revision while a pass over the old one is still running.
    await upsertCachedReport(
      db,
      await verifiedQueryWith({ revision: 2, radius_m: base.radius_m + 200 }),
      7000,
    );
    expect(await setLastMatchedAt(db, base.query_id, base.revision, 7500)).toBe(false);
    expect((await getCachedReport(db, base.query_id))?.last_matched_at).toBeNull();
    expect(await setLastMatchedAt(db, OTHER_ID, 1, 7500)).toBe(false);
  });

  test('the cursors of live reports are listed without reading a payload', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    await upsertCachedReport(
      db,
      await verifiedQueryWith({ query_id: OTHER_ID, revision: 3, expires_at: base.issued_at + 10 }),
      4000,
    );
    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    await db.execute("UPDATE report_cache SET payload_json = 'not json' WHERE query_id = ?", [
      OTHER_ID,
    ]);
    // Oldest received first, and only what has not expired.
    expect(await listLiveReportCursors(db, 6000)).toEqual([
      { query_id: OTHER_ID, revision: 3, last_matched_at: null },
      { query_id: base.query_id, revision: base.revision, last_matched_at: 6000 },
    ]);
    expect(await listLiveReportCursors(db, base.issued_at + 10)).toEqual([
      { query_id: base.query_id, revision: base.revision, last_matched_at: 6000 },
    ]);
  });

  test('a revision that widens the criteria resets the cursor', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    const widened = await verifiedQueryWith({ revision: 2, radius_m: base.radius_m + 200 });
    expect(await upsertCachedReport(db, widened, 7000)).toEqual({
      outcome: 'revised',
      rematch: true,
    });
    const cached = await getCachedReport(db, base.query_id);
    expect(cached).toMatchObject({ received_at: 7000, last_matched_at: null });
    expect(cached?.query.revision).toBe(2);
    expect(cached?.query.radius_m).toBe(base.radius_m + 200);
  });

  test('a revision that only edits the description keeps the cursor', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    const described = await verifiedQueryWith({
      revision: 2,
      person: { ...base.person, description: 'Now wearing a red cap.' },
    });
    expect(await upsertCachedReport(db, described, 7000)).toEqual({
      outcome: 'revised',
      rematch: false,
    });
    const cached = await getCachedReport(db, base.query_id);
    expect(cached?.last_matched_at).toBe(6000);
    expect(cached?.query.person.description).toBe('Now wearing a red cap.');
  });

  test('both photos are kept in order, and a revision that changes them keeps the cursor', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    const [first, second] = base.person.photos ?? [];
    expect(first === undefined || second === undefined).toBe(false);
    expect((await getCachedReport(db, base.query_id))?.query.person.photos).toEqual([
      first,
      second,
    ]);

    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    const swapped = await verifiedQueryWith({
      revision: 2,
      person: { ...base.person, photos: [second, first] },
    });
    expect(await upsertCachedReport(db, swapped, 7000)).toEqual({
      outcome: 'revised',
      rematch: false,
    });
    const noPhotos = { name: base.person.name, description: base.person.description };
    const removed = await verifiedQueryWith({ revision: 3, person: noPhotos });
    expect(await upsertCachedReport(db, removed, 8000)).toEqual({
      outcome: 'revised',
      rematch: false,
    });
    const cached = await getCachedReport(db, base.query_id);
    expect(cached?.last_matched_at).toBe(6000);
    expect(cached !== null && 'photos' in cached.query.person).toBe(false);
  });

  test('a narrowing revision is stored and re-matched, never trusted to be harmless', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({ radius_m: 500 }), 5000);
    await setLastMatchedAt(db, base.query_id, base.revision, 6000);
    const narrowed = await verifiedQueryWith({ revision: 2, radius_m: 100 });
    expect(await upsertCachedReport(db, narrowed, 7000)).toEqual({
      outcome: 'revised',
      rematch: true,
    });
  });

  test.each([
    ['the same revision', 2],
    ['an older revision', 1],
  ])('%s never replaces the stored one', async (_label, revision) => {
    const stored = await verifiedQueryWith({ revision: 2, radius_m: 300 });
    await upsertCachedReport(db, stored, 5000);
    await setLastMatchedAt(db, base.query_id, 2, 6000);
    const stale = await verifiedQueryWith({ revision, radius_m: 900 });
    expect(await upsertCachedReport(db, stale, 7000)).toEqual({
      outcome: 'ignored',
      rematch: false,
    });
    expect(await getCachedReport(db, base.query_id)).toMatchObject({
      received_at: 5000,
      last_matched_at: 6000,
      query: { revision: 2, radius_m: 300 },
    });
  });

  test('a report is live strictly before its expiry and purged from it onwards', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    const expiry = base.expires_at;
    expect(await listLiveReports(db, expiry - 1)).toHaveLength(1);
    expect(await listLiveReports(db, expiry)).toEqual([]);
    expect(await deleteExpiredReports(db, expiry - 1)).toBe(0);
    expect(await deleteExpiredReports(db, expiry)).toBe(1);
    expect(await getCachedReport(db, base.query_id)).toBeNull();
  });

  test('a revision that moves the expiry moves the row with it', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    const sooner = await verifiedQueryWith({ revision: 2, expires_at: base.issued_at + 100 });
    await upsertCachedReport(db, sooner, 6000);
    expect(await listLiveReports(db, base.issued_at + 100)).toEqual([]);
  });

  test('the fetcher drops a report that is no longer published', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    expect(await deleteCachedReport(db, base.query_id)).toBe(true);
    expect(await deleteCachedReport(db, base.query_id)).toBe(false);
  });

  test('a stored payload that no longer parses is an error, not a silent skip', async () => {
    await db.execute(
      `INSERT INTO report_cache (query_id, payload_json, version, received_at, expires_at, revision)
       VALUES (?, ?, 1, 1, 99, 1)`,
      [OTHER_ID, JSON.stringify({ v: 1, query_id: OTHER_ID })],
    );
    await expect(getCachedReport(db, OTHER_ID)).rejects.toBeInstanceOf(StoreRowError);
  });
});

const match = (query_id = base.query_id): NewMatch => ({
  query_id,
  revision: 1,
  stay_id: 7,
  sample_id: null,
  distance_m: 83.4,
  dt_sec: 0,
  created_at: 5000,
});

describe('match', () => {
  test('a first match is stored in state new', async () => {
    const stored = await insertMatchIfAbsent(db, match());
    expect(stored).toEqual({ id: 1, ...match(), state: 'new' });
    expect(await getMatchByQueryId(db, base.query_id)).toEqual(stored);
  });

  test('a report matches at most once per device, whatever the revision or evidence', async () => {
    await insertMatchIfAbsent(db, match());
    const again = { ...match(), revision: 2, stay_id: null, sample_id: 99, created_at: 9000 };
    expect(await insertMatchIfAbsent(db, again)).toBeNull();
    expect(await listMatches(db)).toEqual([{ id: 1, ...match(), state: 'new' }]);
  });

  test('a match needs evidence: a stay or a sample', async () => {
    const baseless = { ...match(), stay_id: null, sample_id: null };
    await expect(insertMatchIfAbsent(db, baseless)).rejects.toThrow(/CHECK/);
  });

  test('lists newest first', async () => {
    await insertMatchIfAbsent(db, match());
    await insertMatchIfAbsent(db, { ...match(OTHER_ID), created_at: 6000 });
    expect((await listMatches(db)).map((row) => row.query_id)).toEqual([OTHER_ID, base.query_id]);
  });

  test('state advances only from the states the caller names', async () => {
    await insertMatchIfAbsent(db, match());
    expect(await advanceMatchState(db, base.query_id, ['new'], 'notified')).toBe(true);
    expect(await advanceMatchState(db, base.query_id, ['notified'], 'opened')).toBe(true);
    expect(await advanceMatchState(db, base.query_id, ['opened'], 'responded')).toBe(true);
    // A late notification must not overwrite a match the user already acted on.
    expect(await advanceMatchState(db, base.query_id, ['new'], 'notified')).toBe(false);
    expect(await advanceMatchState(db, base.query_id, [], 'dismissed')).toBe(false);
    expect((await getMatchByQueryId(db, base.query_id))?.state).toBe('responded');
    expect(await advanceMatchState(db, OTHER_ID, ['new'], 'notified')).toBe(false);
  });

  test('the schema accepts exactly the states the code knows', async () => {
    for (const [index, state] of MATCH_STATES.entries()) {
      const id = `01JB3Z6Q7W8X9Y0ZABCDEFGH${index}0`;
      await insertMatchIfAbsent(db, match(id));
      expect(await advanceMatchState(db, id, ['new'], state)).toBe(true);
    }
    await insertMatchIfAbsent(db, match());
    await expect(
      db.execute(`UPDATE "match" SET state = 'archived' WHERE query_id = ?`, [base.query_id]),
    ).rejects.toThrow(/CHECK/);
  });

  test('the purge removes matches whose report is gone and keeps the rest', async () => {
    await upsertCachedReport(db, await verifiedQueryWith({}), 5000);
    await insertMatchIfAbsent(db, match());
    await insertMatchIfAbsent(db, match(OTHER_ID));
    expect(await deleteOrphanMatches(db)).toBe(1);
    expect((await listMatches(db)).map((row) => row.query_id)).toEqual([base.query_id]);
  });
});

describe('subscription', () => {
  const R5 = '8560145bfffffff';
  const R3 = '836014fffffffff';

  test('stores topics with the resolution read from the cell', async () => {
    await putSubscription(db, R5, 'visited', 100);
    await putSubscription(db, R3, 'ancestor', 100);
    expect(await listSubscriptions(db)).toEqual([
      { topic: R3, res: 3, reason: 'ancestor', added_at: 100, refreshed_at: 100 },
      { topic: R5, res: 5, reason: 'visited', added_at: 100, refreshed_at: 100 },
    ]);
  });

  test('putting a topic again refreshes it and keeps when it was first added', async () => {
    await putSubscription(db, R5, 'ring', 100);
    await putSubscription(db, R5, 'visited', 900);
    expect(await listSubscriptions(db)).toEqual([
      { topic: R5, res: 5, reason: 'visited', added_at: 100, refreshed_at: 900 },
    ]);
  });

  test('refuses a topic that is not a res-5 or res-3 cell', async () => {
    await expect(putSubscription(db, '8760145b4ffffff', 'visited', 1)).rejects.toThrow(RangeError);
    await expect(putSubscription(db, 'everyone', 'visited', 1)).rejects.toThrow(RangeError);
    expect(await listSubscriptions(db)).toEqual([]);
  });

  test('the schema accepts exactly the reasons the code knows', async () => {
    for (const reason of SUBSCRIPTION_REASONS) {
      await putSubscription(db, R5, reason, 1);
    }
    await expect(
      db.execute("UPDATE subscription SET reason = 'whim' WHERE topic = ?", [R5]),
    ).rejects.toThrow(/CHECK/);
  });

  test('deletes a topic', async () => {
    await putSubscription(db, R5, 'visited', 1);
    expect(await deleteSubscription(db, R5)).toBe(true);
    expect(await deleteSubscription(db, R5)).toBe(false);
  });
});
