import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  FETCH_BACKOFF_BASE_SEC,
  FETCH_BACKOFF_MAX_SEC,
  FETCH_COVER_SHARDS,
  FETCH_METERED_INTERVAL_SEC,
  FETCH_SHARD_REQUESTS_PER_CYCLE,
  MAX_PERSON_PHOTOS,
} from '../constants';
import { pushCellOf, ringCells, type H3Cell } from '../geo/h3';
import { SHARD_INDEX_PATH, shardBundlePath } from '../payload/bundle';
import { signDocument } from '../payload/signing';
import type { SqlDatabase, SqlRow } from '../store/driver';
import { migrate } from '../store/migrations';
import { KV_KEYS, kvGet, shardGenerationKey } from '../store/tables/kv';
import { getCachedReport, listLiveReports, setLastMatchedAt } from '../store/tables/reportCache';
import { ed25519FromSeed, ed25519Verify } from '../testing/ed25519';
import { sampleQuery, testKey, trustedTestKeys, withoutSig } from '../testing/fixtures';
import { openMemoryDb } from '../testing/memoryDb';
import {
  CDN_T0,
  FakeShardCdn,
  queryIdOf,
  seededRandom,
  shardsAround,
  signedReport,
} from '../testing/shardCdn';
import {
  runFetchCycle,
  type FetchCycleInput,
  type FetchCycleResult,
  type FetchLogEntry,
} from './cycle';
import type { FetchResponse, NetworkConditions } from './transport';

const SLOTS = FETCH_SHARD_REQUESTS_PER_CYCLE;
const NOW = CDN_T0 + 1_000;
/** 61 res-5 shards around central Bangalore. HOME is the one most tests watch. */
const SHARDS = shardsAround(4);
const HOME = SHARDS[30] as H3Cell;
const OTHER = SHARDS[31] as H3Cell;
const unmetered = async (): Promise<NetworkConditions> => ({ metered: false });
const metered = async (): Promise<NetworkConditions> => ({ metered: true });

let db: ReturnType<typeof openMemoryDb>;
let cdn: FakeShardCdn;
let logged: FetchLogEntry[];
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
  cdn = await FakeShardCdn.start();
  logged = [];
});
afterEach(() => {
  db.close();
});

/** One cycle, the way a wake would run it. The random source restarts each call. */
function cycle(
  watch: readonly H3Cell[],
  nowTs = NOW,
  overrides: Partial<FetchCycleInput> = {},
  store: SqlDatabase = db,
): Promise<FetchCycleResult> {
  return runFetchCycle(store, {
    watch,
    nowTs,
    transport: cdn.transport,
    trustedKeys: trustedTestKeys,
    verify: ed25519Verify,
    random: seededRandom(nowTs),
    network: unmetered,
    log: (entry) => logged.push(entry),
    ...overrides,
  });
}

/** Runs cycles until none leaves a changed shard waiting. */
async function catchUp(watch: readonly H3Cell[], nowTs = NOW): Promise<FetchCycleResult[]> {
  const results: FetchCycleResult[] = [];
  do {
    results.push(await cycle(watch, nowTs + results.length));
  } while ((results.at(-1)?.deferred ?? 0) > 0 && results.length < 50);
  return results;
}

const cachedIds = async (nowTs = NOW) =>
  (await listLiveReports(db, nowTs)).map((report) => report.query.query_id).sort();
const snapshot = async (): Promise<{ reports: SqlRow[]; kv: SqlRow[] }> => ({
  reports: await db.execute('SELECT * FROM report_cache ORDER BY query_id'),
  kv: await db.execute("SELECT * FROM kv WHERE k LIKE 'fetch.shard_generation.%' ORDER BY k"),
});
const heldGeneration = async (shard: H3Cell): Promise<number | null> => {
  const value = await kvGet(db, shardGenerationKey(shard));
  return value === null ? null : (JSON.parse(value) as { generation: number }).generation;
};
const bundleRequests = () => cdn.requests.filter((request) => request.path !== SHARD_INDEX_PATH);

describe('a cold background wake', () => {
  test('with no prior state: reads the index, fetches, verifies and stores', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    // Nothing but a migrated store, a clock reading and a transport.
    expect(await db.execute('SELECT * FROM kv')).toEqual([]);

    const result = await cycle([HOME]);
    expect(result).toMatchObject({
      outcome: 'completed',
      reason: null,
      indexChanged: true,
      stored: [HOME],
      inserted: 2,
      rematch: 2,
      deferred: 0,
      retryAt: null,
    });
    expect(await cachedIds()).toEqual([queryIdOf(1), queryIdOf(2)]);
    const report = await getCachedReport(db, queryIdOf(1));
    expect(report).toMatchObject({ received_at: NOW, last_matched_at: null });
    expect(await heldGeneration(HOME)).toBe(1);
    expect(logged).toEqual([]);
  });

  test('with an empty watch list and an empty index still completes', async () => {
    const result = await cycle([]);
    expect(result).toMatchObject({ outcome: 'completed', stored: [], requests: 1 + SLOTS });
    expect(await cachedIds()).toEqual([]);
  });

  test('keeps nothing in memory: a second store starts from its own state', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    await cycle([HOME]);
    const other = openMemoryDb();
    await migrate(other);
    const result = await cycle([HOME], NOW, {}, other);
    expect(result).toMatchObject({ outcome: 'completed', indexChanged: true, inserted: 1 });
    other.close();
  });
});

describe('what an unchanged shard costs', () => {
  test('one 304 for the index and one for the shard, and no body', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    await cycle([HOME, OTHER]);
    const before = await snapshot();
    cdn.takeRequests();

    const result = await cycle([HOME, OTHER], NOW + 60);
    expect(result).toMatchObject({ outcome: 'completed', indexChanged: false, stored: [] });
    const [index, ...rest] = cdn.requests;
    expect(index).toMatchObject({ path: SHARD_INDEX_PATH, status: 304 });
    expect(index?.ifNoneMatch).toMatch(/^"[0-9a-f]+"$/);
    // Nothing was downloaded: every request carried a validator and was answered 304.
    expect(cdn.requests.every((request) => request.status === 304)).toBe(true);
    expect(cdn.requests.every((request) => request.ifNoneMatch !== undefined)).toBe(true);
    for (const shard of [HOME, OTHER]) {
      expect(rest.filter((request) => request.path === cdn.pathOf(shard))).toHaveLength(1);
    }
    expect(await snapshot()).toEqual(before);
  });

  test('only the shard whose generation moved is downloaded', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    await cycle([HOME, OTHER]);
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(3)] });
    cdn.takeRequests();

    const result = await cycle([HOME, OTHER], NOW + 60);
    expect(result).toMatchObject({ indexChanged: true, stored: [HOME], inserted: 1 });
    expect(cdn.requests.filter((request) => request.status === 200)).toEqual([
      expect.objectContaining({ path: SHARD_INDEX_PATH }),
      { path: shardBundlePath(HOME, 2), status: 200 },
    ]);
    expect(bundleRequests().filter((request) => request.path === cdn.pathOf(OTHER))).toEqual([
      expect.objectContaining({ status: 304 }),
    ]);
    expect(await heldGeneration(HOME)).toBe(2);
    expect(await heldGeneration(OTHER)).toBe(1);
  });
});

describe('a bundle that does not verify', () => {
  /** Serves a changed copy of HOME's bundle at its path instead of the published one. */
  async function serve(change: (bundle: Record<string, unknown>) => unknown): Promise<void> {
    const path = cdn.pathOf(HOME);
    const published = JSON.parse(cdn.file(path) ?? '') as Record<string, unknown>;
    const changed = await change(published);
    const body = typeof changed === 'string' ? changed : JSON.stringify(changed);
    cdn.overrides.set(path, (): FetchResponse => ({ status: 200, body, etag: '"forged"' }));
  }
  const stranger = ed25519FromSeed(new Uint8Array(32).fill(7));
  const resign = (bundle: Record<string, unknown>, changes: Record<string, unknown>) =>
    signDocument('bundle', { ...withoutSig(bundle), ...changes }, testKey.sign);

  test.each<[string, (bundle: Record<string, unknown>) => unknown]>([
    ['tampered with after signing', (bundle) => ({ ...bundle, queries: [] })],
    ['with its signature removed', (bundle) => withoutSig(bundle)],
    [
      'signed by a key the device does not trust',
      (bundle) => signDocument('bundle', withoutSig(bundle), stranger.sign),
    ],
    ['validly signed for another shard', (bundle) => resign(bundle, { shard: OTHER })],
    ['validly signed for another generation', (bundle) => resign(bundle, { generation: 9 })],
    ['that is not JSON', () => '<html>captive portal</html>'],
    ['that is JSON but not a bundle', () => [1, 2, 3]],
  ])('%s never reaches report_cache', async (_label, change) => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    await serve(change);

    const result = await cycle([HOME]);
    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'bundle_rejected',
      stored: [],
      inserted: 0,
      requests: 1 + SLOTS,
    });
    expect(await db.execute('SELECT * FROM report_cache')).toEqual([]);
    expect(await heldGeneration(HOME)).toBeNull();
    // Logged for the device, with nothing thrown and nothing for a screen to show.
    expect(logged).toEqual([{ event: 'bundle_rejected', shard: HOME, generation: 1 }]);
  });

  test('is not asked for again in a tight loop, and is stored once it does verify', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    await serve((bundle) => ({ ...bundle, issued_at: 1 }));
    const first = await cycle([HOME]);
    expect(first.retryAt).toBe(NOW + FETCH_BACKOFF_BASE_SEC);
    cdn.takeRequests();

    // Wake after wake inside the backoff: no request at all.
    for (const later of [1, 10, FETCH_BACKOFF_BASE_SEC - 1]) {
      expect(await cycle([HOME], NOW + later)).toMatchObject({
        outcome: 'skipped',
        reason: 'backoff',
        requests: 0,
        retryAt: NOW + FETCH_BACKOFF_BASE_SEC,
      });
    }
    expect(cdn.requests).toEqual([]);

    // Still bad at the next try: the wait doubles.
    const second = await cycle([HOME], NOW + FETCH_BACKOFF_BASE_SEC);
    expect(second).toMatchObject({ outcome: 'failed', reason: 'bundle_rejected' });
    expect(second.retryAt).toBe(NOW + FETCH_BACKOFF_BASE_SEC + 2 * FETCH_BACKOFF_BASE_SEC);

    cdn.overrides.clear();
    const third = await cycle([HOME], second.retryAt ?? 0);
    expect(third).toMatchObject({ outcome: 'completed', stored: [HOME], retryAt: null });
    expect(await cachedIds()).toEqual([queryIdOf(1)]);
  });

  test('one bad entry inside a good bundle is skipped and the rest is stored', async () => {
    const forged = { ...(await signedReport(2)), reporter_phone: '+15559999999' };
    await cdn.publish({ [HOME]: [await signedReport(1), forged] });
    expect(await cycle([HOME])).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(1)]);
  });

  test('a report is stored with both of its photos; one signed with three is skipped', async () => {
    const photos = sampleQuery().person.photos ?? [];
    expect(photos).toHaveLength(MAX_PERSON_PHOTOS);
    const person = { ...sampleQuery().person, photos: [...photos, ...photos.slice(0, 1)] };
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2, { person })] });
    expect(await cycle([HOME])).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(1)]);
    expect((await getCachedReport(db, queryIdOf(1)))?.query.person.photos).toEqual(photos);
  });
});

describe('the index', () => {
  test('one that does not verify is not believed, and nothing else is asked for', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const forged = JSON.stringify({
      ...(JSON.parse(cdn.file(SHARD_INDEX_PATH) ?? '') as object),
      shards: { [HOME]: 7 },
    });
    cdn.overrides.set(SHARD_INDEX_PATH, () => ({ status: 200, body: forged, etag: '"x"' }));

    const result = await cycle([HOME]);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'index_rejected', requests: 1 });
    expect(result.retryAt).toBe(NOW + FETCH_BACKOFF_BASE_SEC);
    expect(await db.execute('SELECT * FROM report_cache')).toEqual([]);
    expect(await kvGet(db, KV_KEYS.fetchIndexCache)).toBeNull();
    expect(logged).toEqual([{ event: 'index_rejected' }]);
  });

  test('an older index is never taken over a newer one already accepted', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const olderIndex = cdn.file(SHARD_INDEX_PATH) ?? '';
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    await cycle([HOME]);
    expect(await heldGeneration(HOME)).toBe(2);

    // An edge that is behind serves the earlier, validly signed index.
    cdn.overrides.set(SHARD_INDEX_PATH, () => ({ status: 200, body: olderIndex, etag: '"old"' }));
    cdn.takeRequests();
    const result = await cycle([HOME], NOW + 60);
    expect(result).toMatchObject({ outcome: 'completed', indexChanged: false, stored: [] });
    expect(logged.map((entry) => entry.event)).toEqual(['index_stale']);
    // Generation 1 is not asked for, and the newer reports are still there.
    expect(cdn.requests.map((request) => request.path)).not.toContain(shardBundlePath(HOME, 1));
    expect(await cachedIds()).toEqual([queryIdOf(1), queryIdOf(2)]);
    expect(await kvGet(db, KV_KEYS.fetchIndexIssuedAt)).toBe(String(CDN_T0 + 3));
  });

  test('an index held under a key that is no longer trusted is fetched afresh', async () => {
    const retired = ed25519FromSeed(new Uint8Array(32).fill(9));
    const during = { ...trustedTestKeys, 'old-2025': retired.publicKey };
    await cdn.publish(
      { [HOME]: [await signedReport(1)] },
      { keyId: 'old-2025', sign: retired.sign },
    );
    // The bundle is signed by the retired key; its report by the current one.
    expect(await cycle([HOME], NOW, { trustedKeys: during })).toMatchObject({ inserted: 1 });

    // An app update drops the old key. The publisher has since signed everything again.
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    cdn.takeRequests();
    const result = await cycle([HOME], NOW + 60);
    expect(cdn.requests[0]).toEqual({ path: SHARD_INDEX_PATH, status: 200 });
    expect(result).toMatchObject({ outcome: 'completed', indexChanged: true, stored: [HOME] });
  });

  test('a shard missing from the watch list is not downloaded for its own sake', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const result = await cycle([OTHER], NOW, { coverShards: 0 });
    expect(result).toMatchObject({ outcome: 'completed', stored: [] });
    expect(cdn.requests.filter((request) => request.path.startsWith('/shards/'))).toEqual([]);
  });
});

describe('constant request count', () => {
  /** Every shard in SHARDS has one report. */
  async function publishAll(): Promise<void> {
    const reports: Record<H3Cell, Record<string, unknown>[]> = {};
    for (const [n, shard] of SHARDS.entries()) {
      reports[shard] = [await signedReport(n)];
    }
    await cdn.publish(reports);
  }

  test.each([
    ['no shard', 0],
    ['1 shard', 1],
    ['50 shards', 50],
  ])('watching %s: every cycle makes the same number of requests', async (_label, count) => {
    await publishAll();
    const watch = SHARDS.slice(0, count);
    const counts: number[] = [];
    const run = async (nowTs: number) => {
      cdn.takeRequests();
      const result = await cycle(watch, nowTs);
      expect(result.outcome).toBe('completed');
      // What the device counted is what reached the CDN.
      expect(cdn.requests).toHaveLength(result.requests);
      counts.push(result.requests);
      return result;
    };

    // Cold, with everything followed still to fetch.
    let nowTs = NOW;
    let result = await run(nowTs);
    // Catching up, then with nothing changed at all.
    while (result.deferred > 0) {
      result = await run((nowTs += 60));
    }
    await run((nowTs += 60));
    await run((nowTs += 60));
    // One watched shard changed; then every shard changed.
    await cdn.publish({ [SHARDS[0] as H3Cell]: [await signedReport(900)] });
    await run((nowTs += 60));
    await publishAll();
    await run(nowTs + 60);

    expect(new Set(counts)).toEqual(new Set([1 + SLOTS]));
  });

  test('the count does not depend on how many shards are watched', async () => {
    await publishAll();
    const requestsFor = async (watch: readonly H3Cell[]) => {
      const store = openMemoryDb();
      await migrate(store);
      cdn.takeRequests();
      const result = await cycle(watch, NOW, {}, store);
      store.close();
      return { counted: result.requests, seen: cdn.requests.length };
    };
    const one = await requestsFor(SHARDS.slice(0, 1));
    const fifty = await requestsFor(SHARDS.slice(0, 50));
    expect(one).toEqual({ counted: 1 + SLOTS, seen: 1 + SLOTS });
    expect(fifty).toEqual(one);
  });

  test('changed shards beyond the count wait, and every one arrives in later cycles', async () => {
    await publishAll();
    const watch = SHARDS.slice(0, 50);
    const first = await cycle(watch);
    expect(first.stored).toHaveLength(SLOTS);
    expect(first.deferred).toBeGreaterThanOrEqual(50 - SLOTS);

    const results = await catchUp(watch, NOW + 1);
    expect(results.every((result) => result.requests === 1 + SLOTS)).toBe(true);
    for (const shard of watch) {
      expect(await heldGeneration(shard)).toBe(1);
    }
    expect((await cachedIds(NOW)).length).toBeGreaterThanOrEqual(50);
  });

  test('a cycle with too few shards to ask for fills its slots with the index', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const result = await cycle([HOME]);
    expect(result.requests).toBe(1 + SLOTS);
    expect(cdn.requests.map((request) => request.path)).toEqual([
      SHARD_INDEX_PATH,
      shardBundlePath(HOME, 1),
      ...Array.from({ length: SLOTS - 1 }, () => SHARD_INDEX_PATH),
    ]);
    // The repeats are conditional: they cost a 304 each.
    expect(cdn.requests.slice(2).every((request) => request.status === 304)).toBe(true);
  });

  test('a request that gets no answer is still made, and still counted', async () => {
    await publishAll();
    await cycle(SHARDS.slice(0, 5));
    await publishAll();
    cdn.takeRequests();
    const seen: string[] = [];
    const flaky = {
      get: async (request: { path: string }) => {
        seen.push(request.path);
        if (seen.length === 3) {
          throw new Error('timed out');
        }
        return cdn.transport.get(request);
      },
    };
    const result = await cycle(SHARDS.slice(0, 5), NOW + 60, { transport: flaky });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'bundle_unavailable' });
    expect(result.requests).toBe(1 + SLOTS);
    expect(seen).toHaveLength(1 + SLOTS);
  });
});

describe('cover shards', () => {
  async function publishAll(): Promise<void> {
    const reports: Record<H3Cell, Record<string, unknown>[]> = {};
    for (const [n, shard] of SHARDS.entries()) {
      reports[shard] = [await signedReport(n)];
    }
    await cdn.publish(reports);
  }
  const downloaded = () =>
    cdn.requests
      .filter((request) => request.status === 200 && request.path.startsWith('/shards/'))
      .map((request) => request.path.split('/')[2] as H3Cell)
      .sort();

  test('are fetched, stored and revalidated exactly as the watched shard is', async () => {
    await publishAll();
    await catchUp([HOME]);
    const followed = downloaded();
    const cover = followed.filter((shard) => shard !== HOME);
    expect(followed).toContain(HOME);
    expect(cover).toHaveLength(FETCH_COVER_SHARDS);
    // Drawn from the device's own res-3 region and the ones next to it.
    const near = new Set(ringCells(pushCellOf(HOME)));
    expect(cover.every((shard) => near.has(pushCellOf(shard)))).toBe(true);

    // On the wire each followed shard got the same request: a plain GET of its bundle.
    const gets = cdn.requests.filter((request) => request.status === 200);
    expect(gets.every((request) => request.ifNoneMatch === undefined)).toBe(true);
    // And in the store each is held the same way, its reports included.
    for (const shard of followed) {
      expect(await heldGeneration(shard)).toBe(1);
    }
    expect(await cachedIds()).toHaveLength(followed.length);

    // Later cycles ask again for the same set, watched and cover alike, and nothing else.
    cdn.takeRequests();
    for (let i = 1; i <= 6; i++) {
      await cycle([HOME], NOW + 100 * i);
    }
    const revalidated = new Set(bundleRequests().map((request) => request.path.split('/')[2]));
    expect([...revalidated].sort()).toEqual(followed);
    expect(bundleRequests().every((request) => request.status === 304)).toBe(true);
  });

  test('follow each new generation, as a watched shard does', async () => {
    await publishAll();
    await catchUp([HOME]);
    const cover = downloaded().filter((shard) => shard !== HOME);
    const one = cover[0] as H3Cell;
    await cdn.publish({ [one]: [await signedReport(700)] });
    cdn.takeRequests();
    const result = await cycle([HOME], NOW + 600);
    expect(result.stored).toEqual([one]);
    expect(await heldGeneration(one)).toBe(2);
  });

  test('are picked by a secret in the store, so two devices differ', async () => {
    await publishAll();
    await catchUp([HOME]);
    const mine = downloaded();
    expect(await kvGet(db, KV_KEYS.fetchCoverSeed)).toMatch(/^[0-9a-f]{32}$/);

    const other = openMemoryDb();
    await migrate(other);
    cdn.takeRequests();
    let result: FetchCycleResult;
    let nowTs = NOW + 5_000;
    do {
      result = await cycle([HOME], (nowTs += 1), { random: seededRandom(42) }, other);
    } while (result.deferred > 0);
    other.close();
    expect(downloaded()).toContain(HOME);
    expect(downloaded()).not.toEqual(mine);
  });
});

describe('a metered connection', () => {
  beforeEach(async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
  });

  test('the first cycle of a new install runs', async () => {
    expect(await cycle([HOME], NOW, { network: metered })).toMatchObject({
      outcome: 'completed',
      inserted: 1,
    });
  });

  test('later cycles are put off whole, without a request, until the interval has passed', async () => {
    await cycle([HOME], NOW, { network: metered });
    cdn.takeRequests();
    const due = NOW + FETCH_METERED_INTERVAL_SEC;
    for (const nowTs of [NOW + 1, NOW + 3_600, due - 1]) {
      expect(await cycle([HOME], nowTs, { network: metered })).toMatchObject({
        outcome: 'skipped',
        reason: 'metered',
        requests: 0,
        retryAt: due,
      });
    }
    expect(cdn.requests).toEqual([]);

    const result = await cycle([HOME], due, { network: metered });
    expect(result).toMatchObject({ outcome: 'completed', requests: 1 + SLOTS });
  });

  test('no answer about the connection counts as metered', async () => {
    await cycle([HOME]);
    const silent = { network: undefined } as unknown as Partial<FetchCycleInput>;
    expect(await cycle([HOME], NOW + 120, silent)).toMatchObject({ reason: 'metered' });
    const failing = async (): Promise<NetworkConditions> => {
      throw new Error('no connectivity service');
    };
    expect(await cycle([HOME], NOW + 120, { network: failing })).toMatchObject({
      reason: 'metered',
    });
  });

  test('the connection is asked about only when the answer could put a cycle off', async () => {
    let asked = 0;
    const counting = async (): Promise<NetworkConditions> => {
      asked += 1;
      return { metered: true };
    };
    await cycle([HOME], NOW, { network: counting });
    expect(asked).toBe(0);
    await cycle([HOME], NOW + 60, { network: counting });
    expect(asked).toBe(1);
  });

  test('a log sink or a connection check that throws does not fail the cycle', async () => {
    cdn.overrides.set(cdn.pathOf(HOME), () => ({ status: 500, body: null, etag: null }));
    const result = await cycle([HOME], NOW, {
      log: () => {
        throw new Error('log file is full');
      },
    });
    expect(result).toMatchObject({ outcome: 'failed', reason: 'bundle_unavailable' });
    cdn.overrides.clear();
    await cycle([HOME], result.retryAt ?? 0);
    const throwing = (() => {
      throw new Error('no connectivity service');
    }) as unknown as () => Promise<NetworkConditions>;
    expect(await cycle([HOME], (result.retryAt ?? 0) + 60, { network: throwing })).toMatchObject({
      outcome: 'skipped',
      reason: 'metered',
    });
  });

  test('an unmetered connection is never put off', async () => {
    await cycle([HOME]);
    expect(await cycle([HOME], NOW + 1)).toMatchObject({ outcome: 'completed' });
  });

  test('a backlog is cleared before any cycle is put off', async () => {
    const reports: Record<H3Cell, Record<string, unknown>[]> = {};
    for (const [n, shard] of SHARDS.slice(0, 20).entries()) {
      reports[shard] = [await signedReport(100 + n)];
    }
    await cdn.publish(reports);
    const watch = SHARDS.slice(0, 20);
    let result = await cycle(watch, NOW, { network: metered });
    let nowTs = NOW;
    while (result.deferred > 0) {
      result = await cycle(watch, (nowTs += 1), { network: metered });
      expect(result.outcome).toBe('completed');
    }
    expect(await cycle(watch, nowTs + 1, { network: metered })).toMatchObject({
      reason: 'metered',
    });
  });
});

describe('failure and backoff', () => {
  test('an index that cannot be had: one request, exponential waits, capped', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    cdn.overrides.set(SHARD_INDEX_PATH, () => ({ status: 503, body: null, etag: null }));
    let nowTs = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 9; i++) {
      const result = await cycle([HOME], nowTs);
      expect(result).toMatchObject({
        outcome: 'failed',
        reason: 'index_unavailable',
        requests: 1,
      });
      waits.push((result.retryAt ?? 0) - nowTs);
      nowTs = result.retryAt ?? 0;
    }
    expect(waits).toEqual([60, 120, 240, 480, 960, 1_920, 3_600, 3_600, 3_600]);
    expect(Math.max(...waits)).toBe(FETCH_BACKOFF_MAX_SEC);

    cdn.overrides.clear();
    expect(await cycle([HOME], nowTs)).toMatchObject({ outcome: 'completed', retryAt: null });
    expect(await kvGet(db, KV_KEYS.fetchBackoff)).toBeNull();
    // After a success the next failure starts from the base again.
    cdn.offline = true;
    expect((await cycle([HOME], nowTs + 10)).retryAt).toBe(nowTs + 10 + FETCH_BACKOFF_BASE_SEC);
  });

  test('no network at all: nothing is written but the wait', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    await cycle([HOME]);
    await cdn.publish({ [HOME]: [await signedReport(2)] });
    const before = await snapshot();
    cdn.offline = true;

    const result = await cycle([HOME], NOW + 60);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'index_unavailable' });
    expect(await snapshot()).toEqual(before);
    expect(await cachedIds()).toEqual([queryIdOf(1)]);
  });

  test('a clock set back does not leave the fetcher waiting for years', async () => {
    cdn.offline = true;
    await cycle([HOME], NOW + 10 * 86_400);
    cdn.offline = false;
    expect(await cycle([HOME], NOW)).toMatchObject({ outcome: 'completed' });
  });

  test('a shard that fails mid-cycle keeps its old bundle whole; the others are stored whole', async () => {
    await cdn.publish({
      [HOME]: [await signedReport(1), await signedReport(2)],
      [OTHER]: [await signedReport(3)],
    });
    await cycle([HOME, OTHER]);
    await cdn.publish({
      [HOME]: [await signedReport(1, { revision: 2, radius_m: 400 })],
      [OTHER]: [await signedReport(3), await signedReport(4)],
    });
    cdn.overrides.set(cdn.pathOf(HOME), () => ({ status: 500, body: null, etag: null }));

    const result = await cycle([HOME, OTHER], NOW + 60);
    expect(result).toMatchObject({
      outcome: 'failed',
      reason: 'bundle_unavailable',
      stored: [OTHER],
      inserted: 1,
      removed: 0,
    });
    // HOME is exactly as generation 1 left it: both reports, the first at revision 1.
    expect(await heldGeneration(HOME)).toBe(1);
    expect((await getCachedReport(db, queryIdOf(1)))?.query.revision).toBe(1);
    expect(await cachedIds()).toEqual([1, 2, 3, 4].map(queryIdOf));

    cdn.overrides.clear();
    const retried = await cycle([HOME, OTHER], result.retryAt ?? 0);
    expect(retried).toMatchObject({ outcome: 'completed', stored: [HOME], revised: 1, removed: 1 });
    expect(await cachedIds()).toEqual([1, 3, 4].map(queryIdOf));
  });

  test('a write that fails part way is rolled back: report_cache is exactly as it was', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    await cycle([HOME, OTHER]);
    await cdn.publish({
      [HOME]: [await signedReport(1, { revision: 2, radius_m: 400 }), await signedReport(5)],
      [OTHER]: [await signedReport(6)],
    });
    const before = await snapshot();
    const issuedAt = await kvGet(db, KV_KEYS.fetchIndexIssuedAt);

    // The store gives out after the first few statements of the cycle's one transaction.
    let writes = 0;
    const failing: SqlDatabase = {
      execute: (sql, params) => db.execute(sql, params),
      transaction: (work) =>
        db.transaction((tx) =>
          work({
            execute: async (sql, params) => {
              if (/^\s*(INSERT|UPDATE|DELETE)/.test(sql) && ++writes > 3) {
                throw new Error('disk I/O error');
              }
              return tx.execute(sql, params);
            },
          }),
        ),
    };
    const result = await cycle([HOME, OTHER], NOW + 60, {}, failing);
    expect(writes).toBeGreaterThan(3);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'store_failed', inserted: 0 });
    expect(result.requests).toBe(1 + SLOTS);
    expect(await snapshot()).toEqual(before);
    expect(await kvGet(db, KV_KEYS.fetchIndexIssuedAt)).toBe(issuedAt);
    expect(logged.map((entry) => entry.event)).toEqual(['store_failed']);

    // With the store working again the same cycle goes through.
    const retried = await cycle([HOME, OTHER], result.retryAt ?? 0);
    expect(retried).toMatchObject({ outcome: 'completed', inserted: 2, revised: 1, removed: 1 });
  });

  test('a store that cannot be read is a result, not a rejection', async () => {
    const broken: SqlDatabase = {
      execute: async () => {
        throw new Error('file is not a database');
      },
      transaction: async () => {
        throw new Error('file is not a database');
      },
    };
    expect(await cycle([HOME], NOW, {}, broken)).toMatchObject({
      outcome: 'failed',
      reason: 'store_failed',
      requests: 0,
    });
    expect(cdn.requests).toEqual([]);
  });
});

describe('reports that are revised or end', () => {
  test('a new revision replaces the stored one and resets its match cursor if it widened', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    await cycle([HOME]);
    await setLastMatchedAt(db, queryIdOf(1), NOW + 5);
    await cdn.publish({ [HOME]: [await signedReport(1, { revision: 2, radius_m: 900 })] });

    const result = await cycle([HOME], NOW + 60);
    expect(result).toMatchObject({ revised: 1, inserted: 0, rematch: 1, removed: 0 });
    expect(await getCachedReport(db, queryIdOf(1))).toMatchObject({
      received_at: NOW + 60,
      last_matched_at: null,
      query: { revision: 2, radius_m: 900 },
    });
  });

  test('a report its shard no longer lists is removed', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    await cycle([HOME]);
    await cdn.publish({ [HOME]: [await signedReport(2)] });
    expect(await cycle([HOME], NOW + 60)).toMatchObject({ removed: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(2)]);
  });

  test('a shard that leaves the index has no reports left', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    await cycle([HOME, OTHER]);
    await cdn.publish({ [HOME]: [] });
    const result = await cycle([HOME, OTHER], NOW + 60);
    expect(result).toMatchObject({ outcome: 'completed', removed: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(2)]);
    expect(await heldGeneration(HOME)).toBeNull();
  });

  test('a report in two followed shards stays until neither lists it', async () => {
    const shared = await signedReport(1);
    await cdn.publish({ [HOME]: [shared], [OTHER]: [shared, await signedReport(2)] });
    await cycle([HOME, OTHER]);
    expect(await cachedIds()).toEqual([queryIdOf(1), queryIdOf(2)]);

    // The report ended. This device hears of it from one shard first.
    await cdn.publish({ [HOME]: [], [OTHER]: [await signedReport(2)] });
    cdn.overrides.set(cdn.pathOf(OTHER), () => ({ status: 503, body: null, etag: null }));
    const first = await cycle([HOME, OTHER], NOW + 60);
    expect(first).toMatchObject({ outcome: 'failed', removed: 0 });
    expect(await cachedIds()).toEqual([queryIdOf(1), queryIdOf(2)]);

    cdn.overrides.clear();
    expect(await cycle([HOME, OTHER], first.retryAt ?? 0)).toMatchObject({ removed: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(2)]);
  });

  test('a report listed in a form this build cannot read keeps its cached copy', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    await cycle([HOME]);
    await cdn.publish({ [HOME]: [await signedReport(1, { v: 2, revision: 2 })] });
    expect(await cycle([HOME], NOW + 60)).toMatchObject({ outcome: 'completed', removed: 1 });
    expect(await cachedIds()).toEqual([queryIdOf(1)]);
    expect((await getCachedReport(db, queryIdOf(1)))?.query.revision).toBe(1);
  });
});

describe('arguments', () => {
  test('a watch list entry that is not a shard cell is refused before anything happens', async () => {
    await expect(cycle(['8760145b4ffffff'])).rejects.toThrow(RangeError);
    await expect(cycle(['everyone'])).rejects.toThrow(RangeError);
    await expect(cycle([HOME], NOW * 1000)).rejects.toThrow(RangeError);
    await expect(cycle([HOME], NOW, { requestsPerCycle: 0 })).rejects.toThrow(RangeError);
    expect(cdn.requests).toEqual([]);
    expect(await db.execute('SELECT * FROM kv')).toEqual([]);
  });

  test('the watch list is a plain list: order and repeats do not matter', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    const result = await cycle([OTHER, HOME, OTHER, HOME]);
    expect(result.stored).toEqual([HOME, OTHER].sort());
  });

  test('a call made while a cycle is running joins it', async () => {
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const first = cycle([HOME]);
    const second = cycle([HOME], NOW + 1);
    expect(second).toBe(first);
    expect(await first).toMatchObject({ outcome: 'completed' });
    expect(cdn.requests).toHaveLength(1 + SLOTS);
  });
});
