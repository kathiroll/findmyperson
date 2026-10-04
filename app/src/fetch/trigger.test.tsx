import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EncryptedStore, OpenStoreOptions } from '@findmyperson/encrypted-store';
import { createTestVault, nodeSqlcipherDriver } from '@findmyperson/encrypted-store/testing';
import { CAPTURE_DEFAULTS } from '@findmyperson/native-location-capture';
import {
  createFakeLocationCapture,
  type FakeLocationCapture,
} from '@findmyperson/native-location-capture/fake';
import {
  FETCH_METERED_INTERVAL_SEC,
  FETCH_SHARD_REQUESTS_PER_CYCLE,
  listLiveReports,
  listReportsAwaitingRetrospective,
  putSubscription,
  SHARD_INDEX_PATH,
  type FetchCycleResult,
  type H3Cell,
} from '@findmyperson/shared';
import { ed25519FromSeed } from '@findmyperson/shared/src/testing/ed25519';
import { trustedTestKeys } from '@findmyperson/shared/src/testing/fixtures';
import {
  CDN_T0,
  FakeShardCdn,
  queryIdOf,
  seededRandom,
  shardsAround,
  signedReport,
} from '@findmyperson/shared/src/testing/shardCdn';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { appStateLog } from '../design-system/__tests__/stubs/react-native';
import { AppNavigator } from '../navigation';
import { createDataStore, type DataStore, type StoreFetchInput } from '../store';
import {
  createFetchTrigger,
  ed25519Verify,
  FETCH_TRIGGER_MAX_CYCLES,
  FETCH_TRIGGER_MIN_INTERVAL_SEC,
  FETCH_TRIGGER_RECHECK_SEC,
  type FetchRun,
  type HttpFetch,
  type ReportSource,
} from './index';

vi.mock(
  '@react-navigation/native-stack',
  async () => await import('../navigation/__tests__/stubs'),
);
vi.mock(
  'react-native-safe-area-context',
  async () => await import('../navigation/__tests__/stubs'),
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = CDN_T0 + 1_000;
const HOME_FIX = { lat: 12.9716, lon: 77.5946 };
const config = { ...CAPTURE_DEFAULTS, notificationTitle: 't', notificationBody: 'b' };

/**
 * A STAND-IN report source: a reserved name that resolves nowhere, and the test key of
 * packages/shared/contracts/signing-vectors.json, which no real build may trust. The real origin
 * and keys are REPORT_CDN_ORIGIN and REPORT_TRUSTED_KEYS in ./reportCdn.ts, and are not set.
 */
const TEST_ORIGIN = 'https://cdn.example';
const TEST_SOURCE: ReportSource = { origin: TEST_ORIGIN, trustedKeys: trustedTestKeys };

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  vi.unstubAllGlobals();
});

const QUIET: FetchCycleResult = {
  outcome: 'completed',
  reason: null,
  requests: 1 + FETCH_SHARD_REQUESTS_PER_CYCLE,
  indexChanged: false,
  stored: [],
  inserted: 0,
  revised: 0,
  removed: 0,
  rematch: 0,
  deferred: 0,
  retryAt: null,
};

/** A fetch cycle that records what it was asked and answers from a script, then with QUIET. */
function scriptedCycle(script: Array<Partial<FetchCycleResult>> = []) {
  const inputs: StoreFetchInput[] = [];
  const runFetchCycle: DataStore['runFetchCycle'] = async (input) => {
    inputs.push(input);
    return { ...QUIET, ...script.shift() };
  };
  return { inputs, runFetchCycle, script };
}

const noNetwork: HttpFetch = async () => {
  throw new Error('nothing in this test may reach the network');
};

/** The platform's `fetch`, answered by the in-memory CDN. */
const overHttp =
  (cdn: FakeShardCdn): HttpFetch =>
  async (url, init) => {
    expect(url.startsWith(`${TEST_ORIGIN}/`)).toBe(true);
    const path = url.slice(TEST_ORIGIN.length);
    const ifNoneMatch = init.headers['If-None-Match'];
    const response = await cdn.transport.get(
      ifNoneMatch === undefined ? { path } : { path, ifNoneMatch },
    );
    return {
      status: response.status,
      headers: { get: (name) => (name.toLowerCase() === 'etag' ? response.etag : null) },
      text: async () => response.body ?? '',
    };
  };

const foreground = () =>
  act(async () => {
    for (const listener of appStateLog.listeners) listener('active');
  });
const background = () =>
  act(async () => {
    for (const listener of appStateLog.listeners) listener('background');
  });

describe('the app fetches reports', () => {
  /** The real navigator over a store whose maintenance does nothing and whose fetch is scripted. */
  async function mountApp(
    capture: FakeLocationCapture,
    clock: { now: number },
    options: { configured?: boolean } = {},
  ) {
    const cycle = scriptedCycle();
    const store = { runMaintenance: async () => undefined } as unknown as EncryptedStore;
    const neverOpens = (): OpenStoreOptions => {
      throw new Error('the store is already open; nothing should ask for its options');
    };
    const dataStore: DataStore = {
      ...createDataStore(neverOpens, { store }, () => clock.now),
      runFetchCycle: cycle.runFetchCycle,
    };
    const fetchTrigger = createFetchTrigger({
      dataStore,
      capture,
      source: () => TEST_SOURCE,
      now: () => clock.now,
      fetch: noNetwork,
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <AppNavigator
          capture={capture}
          dataStore={dataStore}
          {...(options.configured === false ? {} : { fetchTrigger })}
        />,
      );
    });
    cleanups.push(() => act(async () => renderer.unmount()));
    return { renderer, inputs: cycle.inputs };
  }

  test('when it starts, and when it returns to the foreground', async () => {
    const clock = { now: NOW };
    const { inputs } = await mountApp(createFakeLocationCapture(), clock);
    expect(inputs).toHaveLength(1);

    // Leaving the screen is not a reason; coming back is.
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await background();
    expect(inputs).toHaveLength(1);
    await foreground();
    expect(inputs).toHaveLength(2);

    clock.now += 3 * 86_400;
    await background();
    await foreground();
    expect(inputs).toHaveLength(3);
  });

  test('on a capture wake that reaches JavaScript', async () => {
    const clock = { now: NOW };
    // The module's own clock, so that a fix can be too soon for it when a fetch would be due.
    const fixClock = { now: NOW };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => fixClock.now });
    await capture.start(config);
    const { inputs } = await mountApp(capture, clock);
    expect(inputs).toHaveLength(1);

    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await act(async () => {
      expect(await capture.controls.deliverFix(HOME_FIX)).toBe('stored');
    });
    expect(inputs).toHaveLength(2);

    // A fix the module drops wakes nobody.
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    fixClock.now += 60;
    await act(async () => {
      expect(await capture.controls.deliverFix(HOME_FIX)).toBe('filtered');
    });
    expect(inputs).toHaveLength(2);
  });

  test('not at every one: wakes that come close together are one fetch', async () => {
    const clock = { now: NOW };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => clock.now });
    await capture.start({ ...config, minIntervalSec: 5, minDistanceM: 0 });
    const { inputs } = await mountApp(capture, clock);

    // A moving phone: a stored fix every few seconds, and the app opened twice on the way.
    for (let i = 0; i < 20; i++) {
      clock.now += 10;
      await act(async () => {
        expect(await capture.controls.deliverFix(HOME_FIX)).toBe('stored');
      });
    }
    await foreground();
    await foreground();
    expect(inputs).toHaveLength(1);

    clock.now = NOW + FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await foreground();
    expect(inputs).toHaveLength(2);
  });

  test('and stops when the app is torn down', async () => {
    const clock = { now: NOW };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => clock.now });
    await capture.start(config);
    const { renderer, inputs } = await mountApp(capture, clock);
    await act(async () => renderer.unmount());

    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await foreground();
    await capture.controls.deliverFix(HOME_FIX);
    expect(inputs).toHaveLength(1);
  });

  test('what it hands the fetcher: the source, the real verify, and the phone’s own answer about its connection', async () => {
    const capture = createFakeLocationCapture();
    const { inputs } = await mountApp(capture, { now: NOW });
    const input = inputs[0]!;

    // The shard-key list is the store's to supply, from its subscription table.
    expect('watch' in input).toBe(false);
    expect(input.trustedKeys).toBe(trustedTestKeys);
    expect(input.verify).toBe(ed25519Verify);
    const draw = input.random();
    expect(draw >= 0 && draw < 1).toBe(true);

    expect(await input.network?.()).toEqual({ metered: true });
    capture.controls.setNetworkConditions({ metered: false });
    expect(await input.network?.()).toEqual({ metered: false });

    // The transport goes to the source's origin, through the `fetch` it was given.
    await expect(input.transport.get({ path: SHARD_INDEX_PATH })).rejects.toThrow(
      'nothing in this test may reach the network',
    );
  });

  test('a build with no report source asks nothing of the store or the network', async () => {
    const network = vi.fn(async () => {
      throw new Error('no request may be made');
    });
    vi.stubGlobal('fetch', network);
    const clock = { now: NOW };
    const capture = createFakeLocationCapture({ permission: 'always', now: () => clock.now });
    await capture.start(config);
    const asked = vi.spyOn(capture, 'getNetworkConditions');

    // Production's own trigger: no `fetchTrigger` passed, so it is built on this build's source.
    const { inputs } = await mountApp(capture, clock, { configured: false });
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await foreground();
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    await act(async () => {
      await capture.controls.deliverFix(HOME_FIX);
    });

    expect(inputs).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('the fetch trigger', () => {
  function setup(script: Array<Partial<FetchCycleResult>> = []) {
    const clock = { now: NOW };
    const cycle = scriptedCycle(script);
    const rematches: number[] = [];
    const capture = createFakeLocationCapture();
    const trigger = createFetchTrigger({
      dataStore: cycle,
      capture,
      source: () => TEST_SOURCE,
      onRematch: (reports) => void rematches.push(reports),
      now: () => clock.now,
      fetch: noNetwork,
    });
    return { clock, trigger, rematches, ...cycle };
  }

  const cyclesOf = (run: FetchRun) => (run.outcome === 'ran' ? run.cycles.length : null);

  test('a cycle that completed is not repeated inside the interval', async () => {
    const { clock, trigger, inputs } = setup();
    expect(await trigger.run()).toMatchObject({ outcome: 'ran', rematch: 0, deferred: 0 });

    clock.now = NOW + FETCH_TRIGGER_MIN_INTERVAL_SEC - 1;
    expect(await trigger.run()).toEqual({
      outcome: 'too_soon',
      notBefore: NOW + FETCH_TRIGGER_MIN_INTERVAL_SEC,
    });
    expect(inputs).toHaveLength(1);

    clock.now = NOW + FETCH_TRIGGER_MIN_INTERVAL_SEC;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran' });
    expect(inputs).toHaveLength(2);
  });

  test('deferred shards: the next cycle runs at once, until none are waiting', async () => {
    const { trigger, inputs } = setup([{ deferred: 11 }, { deferred: 3 }, { deferred: 0 }]);
    const run = await trigger.run();
    expect(run).toMatchObject({ outcome: 'ran', deferred: 0 });
    expect(cyclesOf(run)).toBe(3);
    expect(inputs).toHaveLength(3);
  });

  test('deferred shards: one wake runs a bounded number of cycles, and the next wake does not wait', async () => {
    const backlog = Array.from({ length: 20 }, () => ({ deferred: 40 }));
    const { clock, trigger, inputs } = setup(backlog);
    const run = await trigger.run();
    expect(run).toMatchObject({ outcome: 'ran', deferred: 40 });
    expect(cyclesOf(run)).toBe(FETCH_TRIGGER_MAX_CYCLES);

    // Changed shards are still waiting, so there is no interval to sit out.
    clock.now += 1;
    expect(cyclesOf(await trigger.run())).toBe(FETCH_TRIGGER_MAX_CYCLES);
    expect(inputs).toHaveLength(2 * FETCH_TRIGGER_MAX_CYCLES);
  });

  test('rematch: the match hook is told once per run how many reports owe a pass', async () => {
    const { clock, trigger, rematches } = setup([
      { rematch: 2, inserted: 2, deferred: 1 },
      { rematch: 1, revised: 1 },
      {},
    ]);
    expect(await trigger.run()).toMatchObject({ outcome: 'ran', rematch: 3 });
    expect(rematches).toEqual([3]);

    // Nothing new: nobody is told.
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran', rematch: 0 });
    expect(rematches).toEqual([3]);
  });

  test('rematch: a hook that throws does not fail the run', async () => {
    const cycle = scriptedCycle([{ rematch: 1, inserted: 1 }]);
    const trigger = createFetchTrigger({
      dataStore: cycle,
      capture: createFakeLocationCapture(),
      source: () => TEST_SOURCE,
      onRematch: () => {
        throw new Error('the match runner broke');
      },
      now: () => NOW,
      fetch: noNetwork,
    });
    expect(await trigger.run()).toMatchObject({ outcome: 'ran', rematch: 1 });
  });

  test('a cycle put off for a metered connection is asked again soon, not after the interval', async () => {
    const metered: Partial<FetchCycleResult> = {
      outcome: 'skipped',
      reason: 'metered',
      requests: 0,
      retryAt: NOW + FETCH_METERED_INTERVAL_SEC,
    };
    const { clock, trigger, inputs } = setup([metered, metered]);
    expect(cyclesOf(await trigger.run())).toBe(1);

    clock.now = NOW + FETCH_TRIGGER_RECHECK_SEC - 1;
    expect(await trigger.run()).toMatchObject({ outcome: 'too_soon' });
    // The phone may have joined Wi-Fi: the fetcher is asked again long before its own retryAt.
    clock.now = NOW + FETCH_TRIGGER_RECHECK_SEC;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran' });
    expect(inputs).toHaveLength(2);
  });

  test('a failed cycle waits for the fetcher’s backoff, and is not repeated for its deferred shards', async () => {
    const { clock, trigger, inputs } = setup([
      {
        outcome: 'failed',
        reason: 'bundle_unavailable',
        deferred: 6,
        retryAt: NOW + 120,
      },
      { outcome: 'skipped', reason: 'backoff', requests: 0, retryAt: NOW + 400 },
    ]);
    const failed = await trigger.run();
    expect(cyclesOf(failed)).toBe(1);

    clock.now = NOW + 119;
    expect(await trigger.run()).toEqual({ outcome: 'too_soon', notBefore: NOW + 120 });
    clock.now = NOW + 120;
    expect(cyclesOf(await trigger.run())).toBe(1);
    // That one was told the backoff is still on: the trigger now waits for its end.
    clock.now = NOW + 399;
    expect(await trigger.run()).toEqual({ outcome: 'too_soon', notBefore: NOW + 400 });
    clock.now = NOW + 400;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran' });
    expect(inputs).toHaveLength(3);
  });

  test('a store that could not be opened is asked again soon', async () => {
    const { clock, trigger } = setup([
      { outcome: 'failed', reason: 'store_failed', requests: 0, retryAt: null },
    ]);
    expect(cyclesOf(await trigger.run())).toBe(1);
    clock.now = NOW + FETCH_TRIGGER_RECHECK_SEC - 1;
    expect(await trigger.run()).toMatchObject({ outcome: 'too_soon' });
    clock.now = NOW + FETCH_TRIGGER_RECHECK_SEC;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran' });
  });

  test('wakes that arrive while a run is in progress join it', async () => {
    let release!: (result: FetchCycleResult) => void;
    let started = 0;
    const trigger = createFetchTrigger({
      dataStore: {
        runFetchCycle: () => {
          started += 1;
          return new Promise<FetchCycleResult>((resolve) => (release = resolve));
        },
      },
      capture: createFakeLocationCapture(),
      source: () => TEST_SOURCE,
      now: () => NOW,
      fetch: noNetwork,
    });
    const first = trigger.run();
    const second = trigger.run();
    expect(second).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(1);
    release(QUIET);
    expect(await first).toMatchObject({ outcome: 'ran' });
  });

  test('a clock that was set back does not hold the fetch off', async () => {
    const { clock, trigger, inputs } = setup();
    await trigger.run();
    clock.now = NOW - 30 * 86_400;
    expect(await trigger.run()).toMatchObject({ outcome: 'ran' });
    expect(inputs).toHaveLength(2);
  });

  test('a source that is wrong, or a fetcher that refuses, is a result and never a rejection', async () => {
    const cycle = scriptedCycle();
    const capture = createFakeLocationCapture();
    const broken = createFetchTrigger({
      dataStore: cycle,
      capture,
      source: () => ({ origin: 'http://cdn.example/reports', trustedKeys: trustedTestKeys }),
      now: () => NOW,
      fetch: noNetwork,
    });
    expect(await broken.run()).toMatchObject({ outcome: 'error', error: expect.any(RangeError) });
    expect(cycle.inputs).toEqual([]);

    let refuse = true;
    const refusing = createFetchTrigger({
      dataStore: {
        runFetchCycle: async () => {
          if (refuse) throw new RangeError('watch list entry is not a res-5 or res-3 H3 cell');
          return QUIET;
        },
      },
      capture,
      source: () => TEST_SOURCE,
      now: () => NOW,
      fetch: noNetwork,
    });
    expect(await refusing.run()).toMatchObject({ outcome: 'error' });
    // Nothing is held against the next wake.
    refuse = false;
    expect(await refusing.run()).toMatchObject({ outcome: 'ran' });
  });
});

describe('from a wake to the store: a stand-in CDN, a real store, the real verify', () => {
  const DISTRICT = shardsAround(2);
  const [HOME] = shardsAround(0) as [H3Cell];

  /** A real SQLCipher store, opened, with the trigger a real build would run on it. */
  async function device(cdn: FakeShardCdn) {
    const directory = mkdtempSync(join(tmpdir(), 'fmp-app-trigger-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const vault = createTestVault(directory);
    const driver = nodeSqlcipherDriver();
    const current: { store: EncryptedStore | null } = { store: null };
    cleanups.push(() => current.store?.close());
    const clock = { now: NOW };
    const dataStore = createDataStore(
      () => ({ vault, driver }),
      current,
      () => clock.now,
    );
    await dataStore.runMaintenance();
    const db = current.store!.db;

    const capture = createFakeLocationCapture();
    const rematches: number[] = [];
    const trigger = createFetchTrigger({
      dataStore,
      capture,
      source: () => TEST_SOURCE,
      onRematch: (reports) => void rematches.push(reports),
      now: () => clock.now,
      random: seededRandom(7),
      fetch: overHttp(cdn),
    });
    const cached = async () =>
      (await listLiveReports(db, clock.now)).map((report) => report.query.query_id).sort();
    return { clock, db, capture, trigger, rematches, cached };
  }

  const only = (run: FetchRun): FetchCycleResult => {
    if (run.outcome !== 'ran' || run.cycles.length !== 1) {
      throw new Error(`expected one cycle, got ${JSON.stringify(run)}`);
    }
    return run.cycles[0]!;
  };

  test('reports of the shards the store subscribes to are verified and cached, and owe a match', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    const { clock, db, capture, trigger, rematches, cached } = await device(cdn);
    capture.controls.setNetworkConditions({ metered: false });

    // Nothing subscribed yet (no subscription manager): a whole cycle, and nothing to keep.
    const empty = only(await trigger.run());
    expect(empty).toMatchObject({ outcome: 'completed', stored: [], inserted: 0 });
    expect(empty.requests).toBe(1 + FETCH_SHARD_REQUESTS_PER_CYCLE);
    expect(await cached()).toEqual([]);
    expect(rematches).toEqual([]);

    await putSubscription(db, HOME, 'visited', clock.now);
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    const fetched = only(await trigger.run());
    expect(fetched).toMatchObject({ outcome: 'completed', stored: [HOME], inserted: 2 });
    expect(await cached()).toEqual([queryIdOf(1), queryIdOf(2)]);

    // The signal, and the debt it stands for, which is what the match runner will read.
    expect(rematches).toEqual([2]);
    expect(await listReportsAwaitingRetrospective(db, clock.now)).toHaveLength(2);
  });

  test('a backlog of changed shards is cleared in one wake, in whole cycles', async () => {
    const cdn = await FakeShardCdn.start();
    const published: Record<H3Cell, Record<string, unknown>[]> = {};
    for (const [n, shard] of DISTRICT.entries()) {
      published[shard] = [await signedReport(n + 1)];
    }
    await cdn.publish(published);
    const { clock, db, capture, trigger, rematches, cached } = await device(cdn);
    capture.controls.setNetworkConditions({ metered: false });
    for (const shard of DISTRICT) {
      await putSubscription(db, shard, 'ring', clock.now);
    }
    expect(DISTRICT).toHaveLength(19);

    const run = await trigger.run();
    if (run.outcome !== 'ran') throw new Error(run.outcome);
    // 19 changed shards at 8 a cycle.
    expect(run.cycles.map((cycle) => cycle.stored.length)).toEqual([8, 8, 3]);
    expect(run.cycles.map((cycle) => cycle.deferred)).toEqual([11, 3, 0]);
    expect(run).toMatchObject({ rematch: 19, deferred: 0 });
    expect(rematches).toEqual([19]);
    expect(await cached()).toHaveLength(19);
    // Every cycle is the same size on the wire, whatever it had to fetch.
    expect(cdn.requests).toHaveLength(3 * (1 + FETCH_SHARD_REQUESTS_PER_CYCLE));
  });

  test('a bundle that was tampered with, or signed by somebody else, never reaches the store', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const { clock, db, capture, trigger, rematches, cached } = await device(cdn);
    capture.controls.setNetworkConditions({ metered: false });
    await putSubscription(db, HOME, 'visited', clock.now);

    const path = cdn.pathOf(HOME);
    const genuine = JSON.parse(cdn.file(path)!) as Record<string, unknown>;
    cdn.overrides.set(path, () => ({
      status: 200,
      body: JSON.stringify({ ...genuine, issued_at: Number(genuine.issued_at) + 1 }),
      etag: '"tampered"',
    }));
    const tampered = only(await trigger.run());
    expect(tampered).toMatchObject({ outcome: 'failed', reason: 'bundle_rejected', inserted: 0 });
    expect(await cached()).toEqual([]);

    // The same shard and generation, well formed and well signed, by a key this build does not pin.
    const stranger = ed25519FromSeed(new Uint8Array(32).fill(7));
    const forged = await FakeShardCdn.start();
    await forged.publish(
      { [HOME]: [await signedReport(1)] },
      { keyId: 'test-2026', sign: stranger.sign },
    );
    cdn.overrides.set(path, () => ({ status: 200, body: forged.file(path)!, etag: '"forged"' }));
    clock.now = tampered.retryAt!;
    expect(only(await trigger.run())).toMatchObject({
      outcome: 'failed',
      reason: 'bundle_rejected',
    });
    expect(await cached()).toEqual([]);
    expect(rematches).toEqual([]);

    // The genuine file again: accepted.
    cdn.overrides.clear();
    clock.now += 3_600;
    expect(only(await trigger.run())).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect(await cached()).toEqual([queryIdOf(1)]);
  });

  test('on a metered connection the phone’s answer puts the cycle off; on Wi-Fi it runs', async () => {
    const cdn = await FakeShardCdn.start();
    await cdn.publish({ [HOME]: [await signedReport(1)] });
    const { clock, db, capture, trigger, cached } = await device(cdn);
    await putSubscription(db, HOME, 'visited', clock.now);
    const asked = vi.spyOn(capture, 'getNetworkConditions');

    // Mobile data. A new install is not made to wait, and is not even asked.
    expect(only(await trigger.run())).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect(asked).not.toHaveBeenCalled();
    cdn.takeRequests();

    await cdn.publish({ [HOME]: [await signedReport(1), await signedReport(2)] });
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    expect(only(await trigger.run())).toMatchObject({
      outcome: 'skipped',
      reason: 'metered',
      requests: 0,
      retryAt: NOW + FETCH_METERED_INTERVAL_SEC,
    });
    expect(asked).toHaveBeenCalledOnce();
    expect(cdn.requests).toEqual([]);

    // The phone joins Wi-Fi: the next wake past the recheck fetches.
    capture.controls.setNetworkConditions({ metered: false });
    clock.now += FETCH_TRIGGER_RECHECK_SEC;
    expect(only(await trigger.run())).toMatchObject({ outcome: 'completed', inserted: 1 });
    expect(await cached()).toEqual([queryIdOf(1), queryIdOf(2)]);
    expect(cdn.requests).toHaveLength(1 + FETCH_SHARD_REQUESTS_PER_CYCLE);

    // And a module that cannot answer counts as metered.
    asked.mockRejectedValueOnce(new Error('the native module is gone'));
    clock.now += FETCH_TRIGGER_MIN_INTERVAL_SEC;
    expect(only(await trigger.run())).toMatchObject({ outcome: 'skipped', reason: 'metered' });
  });
});
