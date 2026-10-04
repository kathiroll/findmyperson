import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StoreError,
  type EncryptedStore,
  type OpenStoreOptions,
} from '@findmyperson/encrypted-store';
import { createTestVault, nodeSqlcipherDriver } from '@findmyperson/encrypted-store/testing';
import {
  FETCH_SHARD_REQUESTS_PER_CYCLE,
  insertLocationSample,
  listLiveReports,
  listWatchedShards,
  pushCellOf,
  putSubscription,
  SHARD_INDEX_PATH,
  type FetchCycleInput,
  type H3Cell,
} from '@findmyperson/shared';
import { ed25519Verify } from '@findmyperson/shared/src/testing/ed25519';
import { trustedTestKeys } from '@findmyperson/shared/src/testing/fixtures';
import {
  CDN_T0,
  FakeShardCdn,
  queryIdOf,
  seededRandom,
  shardsAround,
  signedReport,
} from '@findmyperson/shared/src/testing/shardCdn';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createDataStore } from '../store';
import { createHttpTransport, type HttpFetch } from './index';

// The store module reaches the permission screens, which import this.
vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

const NOW = CDN_T0 + 1_000;
const [HOME, OTHER] = shardsAround(1) as [H3Cell, H3Cell];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A real SQLCipher store on a temporary directory, not yet opened. */
function unopenedStore() {
  const directory = mkdtempSync(join(tmpdir(), 'fmp-app-fetch-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const vault = createTestVault(directory);
  const driver = nodeSqlcipherDriver();
  let opens = 0;
  const current: { store: EncryptedStore | null } = { store: null };
  cleanups.push(() => current.store?.close());
  const options = (): OpenStoreOptions => ({
    vault,
    driver: (target) => {
      opens += 1;
      return driver(target);
    },
  });
  return { current, options, opens: () => opens };
}

/** Everything a cycle needs but the time and the watch list. */
const sourceOf = (cdn: FakeShardCdn): Omit<FetchCycleInput, 'nowTs' | 'watch'> => ({
  transport: cdn.transport,
  trustedKeys: trustedTestKeys,
  verify: ed25519Verify,
  random: seededRandom(1),
  network: async () => ({ metered: false }),
});

const fetchInput = (
  cdn: FakeShardCdn,
  watch: readonly H3Cell[],
): Omit<FetchCycleInput, 'nowTs'> => ({ watch, ...sourceOf(cdn) });

const cachedIds = async (store: EncryptedStore | null) =>
  (await listLiveReports(store!.db, NOW)).map((report) => report.query.query_id).sort();

describe('the bundle fetch on a cold background wake', () => {
  test('opens the store itself, with no UI mounted, and stores what it verified', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    const { current, options, opens } = unopenedStore();
    // Nothing has run before this call: no provider, no maintenance, no open store.
    const dataStore = createDataStore(options, current, () => NOW);
    expect(current.store).toBeNull();

    const result = await dataStore.runFetchCycle(fetchInput(cdn, [HOME]));
    expect(result).toMatchObject({ outcome: 'completed', stored: [HOME], inserted: 2 });
    expect(result.requests).toBe(1 + FETCH_SHARD_REQUESTS_PER_CYCLE);
    expect(opens()).toBe(1);
    expect(await cachedIds(current.store)).toEqual([queryIdOf(1), queryIdOf(2)]);

    // The next wake uses the store that is open, and the state the last one left in it.
    cdn.takeRequests();
    const again = await dataStore.runFetchCycle(fetchInput(cdn, [HOME]));
    expect(again).toMatchObject({ outcome: 'completed', indexChanged: false, stored: [] });
    expect(cdn.requests[0]).toMatchObject({ path: SHARD_INDEX_PATH, status: 304 });
    expect(opens()).toBe(1);
  });

  test('a process that starts again picks up from the file, not from memory', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const { current, options } = unopenedStore();
    await createDataStore(options, current, () => NOW).runFetchCycle(fetchInput(cdn, [HOME]));
    await current.store?.close();
    current.store = null;
    cdn.takeRequests();

    const restarted = createDataStore(options, current, () => NOW + 60);
    const result = await restarted.runFetchCycle(fetchInput(cdn, [HOME]));
    expect(result).toMatchObject({ outcome: 'completed', indexChanged: false, inserted: 0 });
    expect(cdn.requests.every((request) => request.status === 304)).toBe(true);
  });

  test('a store that cannot be opened is the result, not a crash, and nothing is requested', async () => {
    const cdn = await FakeShardCdn.start();
    const locked = (): OpenStoreOptions => {
      throw new StoreError('OPEN_FAILED', 'the phone has not been unlocked since it restarted');
    };
    const dataStore = createDataStore(locked, { store: null }, () => NOW);
    expect(await dataStore.runFetchCycle(fetchInput(cdn, [HOME]))).toMatchObject({
      outcome: 'failed',
      reason: 'store_failed',
      requests: 0,
    });
    expect(cdn.requests).toEqual([]);
  });

  test('with no watch list given, it follows the shards the store subscribes to', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const { current, options } = unopenedStore();
    const clock = { now: NOW };
    const dataStore = createDataStore(options, current, () => clock.now);
    const withoutWatch = sourceOf(cdn);

    // An empty subscription table is an empty list: a whole cycle that keeps nothing.
    const none = await dataStore.runFetchCycle(withoutWatch);
    expect(none).toMatchObject({ outcome: 'completed', stored: [], inserted: 0 });
    expect(none.requests).toBe(1 + FETCH_SHARD_REQUESTS_PER_CYCLE);

    await putSubscription(current.store!.db, HOME, 'visited', NOW);
    clock.now += 60;
    expect(await dataStore.runFetchCycle(withoutWatch)).toMatchObject({
      outcome: 'completed',
      stored: [HOME],
      inserted: 1,
    });
    // A list that is given is used as given, whatever the table holds: here, nothing.
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    clock.now += 60;
    expect(await dataStore.runFetchCycle({ ...withoutWatch, watch: [] })).toMatchObject({
      outcome: 'completed',
      stored: [],
    });
    clock.now += 60;
    expect(await dataStore.runFetchCycle(withoutWatch)).toMatchObject({
      outcome: 'completed',
      stored: [HOME],
      inserted: 1,
    });
  });

  test('a res-3 topic is fetched only when it stands in for res-5 shards', async () => {
    const region = pushCellOf(HOME);
    const cdn = await FakeShardCdn.start();
    // The publisher files a report under its res-5 shard and under the res-3 cell above it.
    await cdn.publish({
      [HOME]: [await signedReport(1)],
      [region]: [await signedReport(1), await signedReport(2)],
    });
    const { current, options } = unopenedStore();
    const clock = { now: NOW };
    const dataStore = createDataStore(options, current, () => clock.now);
    // No cover shards, so that what is stored is what the watch list asked for.
    const withoutWatch = { ...sourceOf(cdn), coverShards: 0 };
    await dataStore.runFetchCycle({ ...withoutWatch, watch: [] });
    const db = current.store!.db;

    // As the push-wake topic of a followed shard it is not downloaded: its bundle is the
    // whole region, and the device needs one shard of it.
    await putSubscription(db, HOME, 'visited', NOW);
    await putSubscription(db, region, 'ancestor', NOW);
    expect(await listWatchedShards(db)).toEqual([HOME]);
    clock.now += 60;
    expect(await dataStore.runFetchCycle(withoutWatch)).toMatchObject({
      outcome: 'completed',
      stored: [HOME],
      inserted: 1,
    });
    expect(cdn.requests.map((request) => request.path)).not.toContain(cdn.pathOf(region));

    // Coarsened, it is the shard the device follows there.
    await putSubscription(db, region, 'coarsened', NOW);
    expect(await listWatchedShards(db)).toEqual([region, HOME].sort());
    clock.now += 60;
    expect(await dataStore.runFetchCycle(withoutWatch)).toMatchObject({
      outcome: 'completed',
      stored: [region],
      inserted: 1,
    });
  });

  test('asked for in the same breath as maintenance, it follows the list that run leaves', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const { current, options } = unopenedStore();
    const dataStore = createDataStore(options, current, () => NOW);
    await dataStore.runMaintenance();
    // A fix in a shard the phone does not follow yet, and the wake it causes: maintenance is
    // asked for first (StoreMaintenance is mounted before ReportFetch), then the fetch.
    await insertLocationSample(current.store!.db, {
      ts_utc: NOW,
      lat: 12.9716,
      lon: 77.5946,
      accuracy_m: 20,
      source: 'wm',
    });
    const maintained = dataStore.runMaintenance();
    const fetched = dataStore.runFetchCycle(sourceOf(cdn));

    expect((await maintained).subscriptions?.added.map((topic) => topic.topic)).toContain(HOME);
    expect(await fetched).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect((await fetched).stored).toContain(HOME);
  });

  test('with no watch list given and a store that cannot be opened, nothing is requested', async () => {
    const cdn = await FakeShardCdn.start();
    const locked = (): OpenStoreOptions => {
      throw new StoreError('OPEN_FAILED', 'the phone has not been unlocked since it restarted');
    };
    const dataStore = createDataStore(locked, { store: null }, () => NOW);
    expect(await dataStore.runFetchCycle(sourceOf(cdn))).toEqual({
      outcome: 'failed',
      reason: 'store_failed',
      requests: 0,
      indexChanged: false,
      stored: [],
      inserted: 0,
      revised: 0,
      removed: 0,
      rematch: 0,
      deferred: 0,
      retryAt: null,
    });
    expect(cdn.requests).toEqual([]);
  });

  test('asked for in the same breath as "delete all my data", it writes to the new store', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)], [OTHER]: [await signedReport(2)] });
    const { current, options } = unopenedStore();
    const dataStore = createDataStore(options, current, () => NOW);
    await dataStore.runFetchCycle(fetchInput(cdn, [HOME]));
    const before = current.store;

    const deleted = dataStore.deleteAll();
    const fetched = dataStore.runFetchCycle(fetchInput(cdn, [HOME, OTHER]));
    expect(await deleted).toEqual({ emptyStoreConfirmed: true });
    expect(await fetched).toMatchObject({ outcome: 'completed', inserted: 2 });
    expect(current.store).not.toBe(before);
    expect(await cachedIds(current.store)).toEqual([queryIdOf(1), queryIdOf(2)]);
  });
});

describe('the HTTP transport', () => {
  const answer = (status: number, body = '', etag: string | null = null) => ({
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
    text: async () => body,
  });

  test('sends one GET to the origin and the path, with nothing about the device', async () => {
    const send = vi.fn<HttpFetch>(async () => answer(200, '{"v":1}', '"abc"'));
    const transport = createHttpTransport({ origin: 'https://cdn.example', fetch: send });
    expect(await transport.get({ path: '/index.json' })).toEqual({
      status: 200,
      body: '{"v":1}',
      etag: '"abc"',
    });
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0] ?? [];
    expect(url).toBe('https://cdn.example/index.json');
    expect(init).toMatchObject({ method: 'GET', headers: {}, credentials: 'omit' });
  });

  test('sends If-None-Match when given one, and a 304 has no body', async () => {
    const send = vi.fn<HttpFetch>(async () => answer(304, '', '"abc"'));
    const transport = createHttpTransport({ origin: 'https://cdn.example', fetch: send });
    const path = '/shards/8560145bfffffff/3.json';
    expect(await transport.get({ path, ifNoneMatch: '"abc"' })).toEqual({
      status: 304,
      body: null,
      etag: '"abc"',
    });
    expect(send.mock.calls[0]?.[1].headers).toEqual({ 'If-None-Match': '"abc"' });
  });

  test('any other status is passed on without a body', async () => {
    const send = vi.fn<HttpFetch>(async () => answer(404, 'not found'));
    const transport = createHttpTransport({ origin: 'https://cdn.example', fetch: send });
    expect(await transport.get({ path: '/shards/8560145bfffffff/2.json' })).toEqual({
      status: 404,
      body: null,
      etag: null,
    });
  });

  test('no answer is a rejection, and so is one that takes too long', async () => {
    const down = createHttpTransport({
      origin: 'https://cdn.example',
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    });
    await expect(down.get({ path: '/index.json' })).rejects.toThrow('Network request failed');

    const slow = createHttpTransport({
      origin: 'https://cdn.example',
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await expect(slow.get({ path: '/index.json' })).rejects.toThrow('aborted');
  });

  test('a body that stops arriving is abandoned, not passed on short', async () => {
    const stalled = createHttpTransport({
      origin: 'https://cdn.example',
      timeoutMs: 20,
      fetch: async (_url, init) => ({
        ...answer(200),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      }),
    });
    await expect(stalled.get({ path: '/index.json' })).rejects.toThrow('aborted');
  });

  test('refuses an origin that is not plain https', () => {
    for (const origin of [
      'http://cdn.example',
      'https://cdn.example/',
      'https://cdn.example/x',
      'cdn.example',
    ]) {
      expect(() => createHttpTransport({ origin })).toThrow(RangeError);
    }
  });

  test('drives a whole cycle against a CDN', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const overHttp: HttpFetch = async (url, init) => {
      const path = url.slice('https://cdn.example'.length);
      const ifNoneMatch = init.headers['If-None-Match'];
      const response = await cdn.transport.get(
        ifNoneMatch === undefined ? { path } : { path, ifNoneMatch },
      );
      return answer(response.status, response.body ?? '', response.etag);
    };
    const { current, options } = unopenedStore();
    const dataStore = createDataStore(options, current, () => NOW);
    const input = {
      ...fetchInput(cdn, [HOME]),
      transport: createHttpTransport({ origin: 'https://cdn.example', fetch: overHttp }),
    };
    expect(await dataStore.runFetchCycle(input)).toMatchObject({
      outcome: 'completed',
      inserted: 1,
    });
    cdn.takeRequests();
    await dataStore.runFetchCycle(input);
    expect(cdn.requests.every((request) => request.status === 304)).toBe(true);
    expect(cdn.requests).toHaveLength(1 + FETCH_SHARD_REQUESTS_PER_CYCLE);
  });
});
