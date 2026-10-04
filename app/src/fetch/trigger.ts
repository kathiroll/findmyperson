import type { LocationCapture } from '@findmyperson/native-location-capture';
import {
  FETCH_BACKOFF_MAX_SEC,
  type FetchCycleResult,
  type FetchLogEntry,
} from '@findmyperson/shared';
import type { DataStore } from '../store';
import { ed25519Verify } from './ed25519';
import { createHttpTransport, type HttpFetch } from './httpTransport';
import { deviceRandom } from './random';
import { configuredReportSource, type ReportSource } from './reportCdn';

/**
 * THE FETCH TRIGGER: what turns a wake of the app into cycles of the bundle fetcher
 * (`runFetchCycle` of @findmyperson/shared, through `DataStore.runFetchCycle`). `ReportFetch`
 * calls `run` at the moments `useAppWake` names: at start, on every foreground and on every
 * capture wake that reaches JavaScript.
 *
 * It supplies what the fetcher leaves to its caller:
 *
 *   the source      the CDN origin and the pinned keys of ./reportCdn.ts. With none, a run
 *                   stops at once and nothing reaches the store or the network.
 *   the transport   ./httpTransport.ts, over the platform's `fetch`
 *   the verify      ./ed25519.ts
 *   the network     the capture module's `getNetworkConditions`, asked by the fetcher only when
 *                   the answer could put a cycle off
 *   the watch list  left to the store: its `subscription` table (`DataStore.runFetchCycle`)
 *
 * and makes the two decisions the fetcher leaves open.
 *
 * HOW OFTEN. On an unmetered connection the fetcher runs every time it is called, and a moving
 * phone stores a fix every few seconds. So a wake inside FETCH_TRIGGER_MIN_INTERVAL_SEC of a
 * cycle that completed asks for nothing. A failed cycle, or a call inside the fetcher's
 * backoff, waits for the time the fetcher gave; a cycle put off for a metered connection is
 * asked again after FETCH_TRIGGER_RECHECK_SEC, since the phone may have joined Wi-Fi and asking
 * costs a store read and no request. These waits are in memory: a new process asks at once,
 * and the fetcher's own gates, which are in the store, still hold.
 *
 * WHAT A RESULT ASKS FOR.
 *   `deferred` above 0   changed shards did not fit the cycle's constant request count. The
 *                        next cycle is run at once, up to FETCH_TRIGGER_MAX_CYCLES in one wake;
 *                        what is still waiting after that is taken up by the next wake, with
 *                        no interval to sit out.
 *   `rematch` above 0    reports now owe a retrospective match pass. `onRematch` is told how
 *                        many, once per run. See `matchRunnerNotBuilt`.
 *
 * A wake with no JavaScript in it (the app's process is gone and only the native capture
 * module ran) does not fetch: there is no headless task yet.
 */

/** PROVISIONAL. The least time between two cycles that completed, on any connection. */
export const FETCH_TRIGGER_MIN_INTERVAL_SEC = 900;
/** PROVISIONAL. How soon a cycle put off for a metered connection is asked for again. */
export const FETCH_TRIGGER_RECHECK_SEC = 60;
/** PROVISIONAL. Cycles one wake may run back to back while changed shards are waiting. */
export const FETCH_TRIGGER_MAX_CYCLES = 4;

export interface FetchTriggerOptions {
  dataStore: Pick<DataStore, 'runFetchCycle'>;
  capture: Pick<LocationCapture, 'getNetworkConditions'>;
  /** Asked at every run. Default: what this build was given (./reportCdn.ts). */
  source?: () => ReportSource | null;
  /** Told how many reports now owe a retrospective match pass. Default: nobody yet. */
  onRematch?: (reports: number) => void;
  /** The clock, Unix seconds. */
  now?: () => number;
  /** Default: `deviceRandom`. */
  random?: () => number;
  /** Default: the global `fetch`. */
  fetch?: HttpFetch;
  /** The fetcher's diagnostics. Entries name shard cells: keep them on the device. */
  log?: (entry: FetchLogEntry) => void;
}

/**
 * What one run came to.
 *
 *   unconfigured  this build has no CDN origin or no trusted key: nothing was asked of anybody
 *   too_soon      the last run said to wait until `notBefore`
 *   ran           `cycles` holds the result of each cycle that was asked for, in order.
 *                 `rematch` is their sum; `deferred` is what the last one left waiting.
 *   error         the source is malformed, or the fetcher refused its arguments
 */
export type FetchRun =
  | { outcome: 'unconfigured' }
  | { outcome: 'too_soon'; notBefore: number }
  | { outcome: 'ran'; cycles: FetchCycleResult[]; rematch: number; deferred: number }
  | { outcome: 'error'; error: unknown };

export interface FetchTrigger {
  /** Never rejects. A call made while a run is in progress joins it. */
  run(): Promise<FetchRun>;
}

/**
 * TODO(M5.2): the match runner is not built, so nobody acts on this signal yet. When it exists
 * it is passed as `onRematch` where ReportFetch creates the trigger, and runs its pass here.
 * Nothing is lost meanwhile: the debt is kept in the store, as `last_matched_at IS NULL` on
 * each report (`listReportsAwaitingRetrospective` of @findmyperson/shared), and the runner must
 * read it from there in any case, since a process can die between a fetch and a match.
 */
export function matchRunnerNotBuilt(): void {}

export function createFetchTrigger(options: FetchTriggerOptions): FetchTrigger {
  const { dataStore, capture } = options;
  const source = options.source ?? configuredReportSource;
  const onRematch = options.onRematch ?? matchRunnerNotBuilt;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const random = options.random ?? deviceRandom;

  let running: Promise<FetchRun> | null = null;
  let notBefore: number | null = null;

  /** When the network may next be asked, given how the last cycle of a run ended. */
  const waitAfter = (last: FetchCycleResult, startedAt: number): number => {
    if (last.outcome === 'completed') {
      return last.deferred > 0 ? startedAt : startedAt + FETCH_TRIGGER_MIN_INTERVAL_SEC;
    }
    if (last.reason === 'metered') {
      return startedAt + FETCH_TRIGGER_RECHECK_SEC;
    }
    // Failed, or inside a backoff: the fetcher says when it will next make a request.
    return last.retryAt ?? startedAt + FETCH_TRIGGER_RECHECK_SEC;
  };

  const once = async (): Promise<FetchRun> => {
    const reportSource = source();
    if (reportSource === null) {
      return { outcome: 'unconfigured' };
    }
    const startedAt = now();
    if (
      notBefore !== null &&
      startedAt < notBefore &&
      // A wait longer than any this file or the fetcher sets was left by a clock since set back.
      notBefore - startedAt <= Math.max(FETCH_BACKOFF_MAX_SEC, FETCH_TRIGGER_MIN_INTERVAL_SEC)
    ) {
      return { outcome: 'too_soon', notBefore };
    }
    const input = {
      transport: createHttpTransport({
        origin: reportSource.origin,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      trustedKeys: reportSource.trustedKeys,
      verify: ed25519Verify,
      random,
      network: () => capture.getNetworkConditions(),
      ...(options.log ? { log: options.log } : {}),
    };

    const cycles: FetchCycleResult[] = [];
    let last: FetchCycleResult;
    do {
      last = await dataStore.runFetchCycle(input);
      cycles.push(last);
    } while (
      last.outcome === 'completed' &&
      last.deferred > 0 &&
      cycles.length < FETCH_TRIGGER_MAX_CYCLES
    );
    notBefore = waitAfter(last, startedAt);

    const rematch = cycles.reduce((sum, cycle) => sum + cycle.rematch, 0);
    if (rematch > 0) {
      try {
        onRematch(rematch);
      } catch {
        // The reports are stored and their debt with them; a runner that throws loses nothing.
      }
    }
    return { outcome: 'ran', cycles, rematch, deferred: last.deferred };
  };

  return {
    run() {
      running ??= Promise.resolve()
        .then(once)
        .catch((error: unknown): FetchRun => ({ outcome: 'error', error }))
        .finally(() => {
          running = null;
        });
      return running;
    },
  };
}
