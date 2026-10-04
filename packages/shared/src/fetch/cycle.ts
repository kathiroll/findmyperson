import {
  FETCH_BACKOFF_BASE_SEC,
  FETCH_BACKOFF_MAX_SEC,
  FETCH_COVER_SHARDS,
  FETCH_METERED_INTERVAL_SEC,
  FETCH_SHARD_REQUESTS_PER_CYCLE,
} from '../constants';
import type { H3Cell } from '../geo/h3';
import {
  readShardBundle,
  readShardIndex,
  SHARD_INDEX_PATH,
  shardBundlePath,
  type ShardIndex,
  type VerifiedBundle,
} from '../payload/bundle';
import { ShardCellSchema } from '../payload/primitives';
import type { Ed25519Verify, TrustedKeys } from '../payload/signing';
import type { SqlDatabase } from '../store/driver';
import { deleteCachedReport, upsertCachedReport } from '../store/tables/reportCache';
import { newCoverSeed, planCycle } from './plan';
import {
  dropShardState,
  loadFetchState,
  saveBackoff,
  saveCoverSeed,
  saveIndex,
  saveLastCompleted,
  saveShardState,
  type BackoffState,
  type IndexCache,
  type ShardState,
} from './state';
import type { FetchRequest, FetchResponse, FetchTransport, NetworkConditions } from './transport';

/**
 * THE BUNDLE FETCHER (plan 7.3, 7.4; task B3.6): how a device learns of reports near where it
 * has been, without the server learning which device asked for what. `runFetchCycle` is one
 * cycle. It needs a database, a clock reading and a transport, and nothing else: no UI, no
 * state in memory, nothing a previous cycle left outside the store. It is what a cold
 * background wake calls.
 *
 * ONE CYCLE
 *   1. GET /index.json, with If-None-Match once an index is held. A 304 means the index held is
 *      still the index. An index is verified before it is believed, and one older than the
 *      newest accepted is not believed at all (no rollback).
 *   2. The followed shards (below) whose generation in the index is above the one held are
 *      fetched at their new path, /shards/<cell>/<generation>.json.
 *   3. Each bundle's Ed25519 signature is checked, and that it is the shard and generation that
 *      was asked for, before anything is stored. One that fails is dropped: logged through
 *      `log`, counted as a failed cycle so that backoff spaces out the next try, told to nobody.
 *   4. Everything the cycle learned is written in ONE transaction at the end: the reports of
 *      every verified bundle (upsertCachedReport), the removal of reports a shard no longer
 *      lists, what is now held of each shard, the index, and the backoff. A cycle that dies
 *      before that point has changed nothing; one that dies inside it is rolled back.
 *
 * PADDING (plan 7.3). The CDN operator sees (IP, path, time) for every request, and the shards
 * a device asks for are where it has been in 30 days, to the district. Two things blur that.
 *
 *   A cover set. Besides the watch list the device follows FETCH_COVER_SHARDS shards it has no
 *   use for, from the same res-3 regions, picked by a secret kept in the store (chooseCover in
 *   plan.ts). A cover shard is handled as a watched one in every respect: fetched when its
 *   generation moves, verified, stored in report_cache, asked for again in the same draw.
 *   Nothing on the wire differs between the two, so the operator sees one set of followed
 *   shards and not which of them the device was in. report_cache therefore also holds reports
 *   from places the device has not been; nothing may present it as "near you". They cost
 *   storage and nothing else, since a report only matches history that is inside its area.
 *
 *   A constant request count. A cycle that reads an index makes exactly
 *   FETCH_SHARD_REQUESTS_PER_CYCLE further requests, whether one shard is watched or fifty and
 *   whether none changed or all did. Changed followed shards come first, drawn at random; the
 *   ones that do not fit wait for the next cycle (`deferred`). Spare slots go to followed
 *   shards that did not change, asked for again with If-None-Match, so an unchanged shard costs
 *   one 304 and no body. If fewer shards are followed than there are slots, the rest ask for
 *   the index again. A cycle that cannot read an index makes that one request and stops; that
 *   depends on the CDN and the network, not on the device's shards.
 *
 * What padding does not hide, so nobody claims more: that the device fetched at all; the
 * followed set as a whole, and so roughly the region; and, from an operator who keeps a
 * history per device, how the followed set moves over weeks (a watched shard stays for as long
 * as the history behind it, a cover shard until the regions or the index shift). Running
 * cycles back to back to clear `deferred` shows how large the backlog was, in multiples of the
 * request count.
 *
 * METERED CONNECTIONS. `network` says whether data costs the user money; no answer counts as
 * metered. On a metered connection a cycle is put off until FETCH_METERED_INTERVAL_SEC after
 * the last one that completed, unless that one left changed shards waiting, or none ever
 * completed (a new install is not made to wait). It is put off whole: no request is made, so
 * there is no shorter cycle to tell apart. On an unmetered connection every call runs; how
 * often to call is the caller's decision.
 *
 * BACKOFF. A cycle fails if the index could not be read, or a changed shard could not be had or
 * did not verify. After a failure no cycle runs for FETCH_BACKOFF_BASE_SEC, doubling with each
 * failure in a row up to FETCH_BACKOFF_MAX_SEC; a call in that time returns `skipped` without
 * a request. What did verify in a failed cycle is still stored, whole. The first cycle that
 * completes clears it.
 */
export interface FetchCycleInput {
  /**
   * THE SHARD-KEY LIST: the shards this device needs, as H3 cell ids (15-character lowercase
   * hex) at res 5 or res 3, the keys of `shards` in index.json. Order and repeats do not matter.
   * It is the whole list every time, not a change to it, and may be empty. The subscription
   * manager (B3.7) keeps it in the store: `await listWatchedShards(db)`, which is every topic of
   * `subscription` but the res-3 ones that are push-wake topics only.
   */
  watch: readonly H3Cell[];
  /** Unix seconds. */
  nowTs: number;
  transport: FetchTransport;
  /** The publisher's public keys, pinned in the app binary (plan 6.4). */
  trustedKeys: TrustedKeys;
  verify: Ed25519Verify;
  /**
   * Uniform in [0, 1). It picks the cover secret and the order of requests, so it should not be
   * predictable from outside the device.
   */
  random: () => number;
  /** Asked only when the answer could put a cycle off. Left out or failing counts as metered. */
  network?: () => Promise<NetworkConditions>;
  /**
   * For the device's own diagnostics. Entries name shard cells: keep them on the device, and
   * never show them to the user (plan 6.4).
   */
  log?: (entry: FetchLogEntry) => void;
  /** Default FETCH_SHARD_REQUESTS_PER_CYCLE. Every device must use the same value. */
  requestsPerCycle?: number;
  /** Default FETCH_COVER_SHARDS. */
  coverShards?: number;
}

export type FetchFailure =
  /** No answer for the index, or one that was neither 200 nor 304. */
  | 'index_unavailable'
  /** The index did not verify, or was older than the newest accepted with none held to use. */
  | 'index_rejected'
  /** A changed shard's bundle could not be had (no answer, or not a 200). */
  | 'bundle_unavailable'
  /** A changed shard's bundle did not verify, or was not the bundle asked for. */
  | 'bundle_rejected'
  /** The store could not be read or written. */
  | 'store_failed';

export interface FetchLogEntry {
  event: FetchFailure | 'index_stale';
  shard?: H3Cell;
  generation?: number;
  detail?: string;
}

export interface FetchCycleResult {
  /**
   *   completed  the index was read and every changed shard that had a slot is stored
   *   failed     see `reason`; `retryAt` is when backoff ends
   *   skipped    nothing was asked of the network; `retryAt` is when a cycle will run again
   */
  outcome: 'completed' | 'failed' | 'skipped';
  reason: FetchFailure | 'backoff' | 'metered' | null;
  /** HTTP requests made: 0 when skipped, otherwise 1 for the index plus the request count. */
  requests: number;
  /** A new index was accepted (false for a 304). */
  indexChanged: boolean;
  /** Followed shards whose new generation is now stored. */
  stored: H3Cell[];
  inserted: number;
  revised: number;
  /** Reports deleted because the shards that listed them no longer do. */
  removed: number;
  /** Reports that now owe a retrospective match pass (new, or their criteria changed). */
  rematch: number;
  /** Changed followed shards left for the next cycle. Above 0, calling again at once is useful. */
  deferred: number;
  retryAt: number | null;
}

const MAX_UNIX_SECONDS = 100_000_000_000;

const NOTHING: Omit<FetchCycleResult, 'outcome' | 'reason'> = {
  requests: 0,
  indexChanged: false,
  stored: [],
  inserted: 0,
  revised: 0,
  removed: 0,
  rematch: 0,
  deferred: 0,
  retryAt: null,
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function parseJson(text: string | null): unknown {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function backoffAfter(previous: BackoffState | null, nowTs: number): BackoffState {
  const failures = (previous?.failures ?? 0) + 1;
  const delay = Math.min(FETCH_BACKOFF_MAX_SEC, FETCH_BACKOFF_BASE_SEC * 2 ** (failures - 1));
  return { failures, retry_at: nowTs + delay };
}

/**
 * The ids a bundle lists in entries this build could not read (a newer format, a bad entry
 * signature). The copy already cached for such a report is kept: the publisher still lists it.
 */
function unreadIds(bundle: VerifiedBundle): string[] {
  const read = new Set(bundle.queries.map((entry) => entry.query.query_id));
  const ids: string[] = [];
  for (const entry of bundle.bundle.queries) {
    const id = (entry as { query_id?: unknown } | null)?.query_id;
    if (typeof id === 'string' && !read.has(id)) {
      ids.push(id);
    }
  }
  return ids;
}

interface VerifiedDownload {
  shard: H3Cell;
  generation: number;
  etag: string | null;
  bundle: VerifiedBundle;
}

interface Checked {
  watch: Set<H3Cell>;
  slots: number;
  coverShards: number;
}

/** Throws RangeError for an argument no cycle could be run with. */
function check(input: FetchCycleInput): Checked {
  const { nowTs } = input;
  const slots = input.requestsPerCycle ?? FETCH_SHARD_REQUESTS_PER_CYCLE;
  const coverShards = input.coverShards ?? FETCH_COVER_SHARDS;
  if (!Number.isSafeInteger(nowTs) || nowTs < 0 || nowTs > MAX_UNIX_SECONDS) {
    throw new RangeError(`fetch time must be Unix seconds, got ${nowTs}`);
  }
  if (!Number.isSafeInteger(slots) || slots < 1 || !Number.isSafeInteger(coverShards)) {
    throw new RangeError('requestsPerCycle must be a whole number above 0, coverShards whole');
  }
  const watch = new Set<H3Cell>();
  for (const shard of input.watch) {
    if (!ShardCellSchema.safeParse(shard).success) {
      throw new RangeError(`watch list entry is not a res-5 or res-3 H3 cell: ${String(shard)}`);
    }
    watch.add(shard);
  }
  return { watch, slots, coverShards };
}

async function cycle(
  db: SqlDatabase,
  input: FetchCycleInput,
  { watch, slots, coverShards }: Checked,
): Promise<FetchCycleResult> {
  const { nowTs, transport, trustedKeys, verify, random } = input;
  // A sink that throws must not turn a logged event into a failed cycle.
  const log = (entry: FetchLogEntry): void => {
    try {
      input.log?.(entry);
    } catch {
      // Nothing to do: the entry is lost, the cycle goes on.
    }
  };

  let requests = 0;
  const send = async (request: FetchRequest): Promise<FetchResponse | { failed: string }> => {
    requests += 1;
    try {
      return await transport.get(request);
    } catch (error) {
      return { failed: message(error) };
    }
  };

  const state = await loadFetchState(db);

  // Gates. Neither makes a request.
  const { backoff, lastCompleted } = state;
  if (
    backoff !== null &&
    nowTs < backoff.retry_at &&
    // A time further off than any backoff was written by a clock that has since been set back.
    backoff.retry_at - nowTs <= FETCH_BACKOFF_MAX_SEC
  ) {
    return { ...NOTHING, outcome: 'skipped', reason: 'backoff', retryAt: backoff.retry_at };
  }
  if (lastCompleted !== null && lastCompleted.deferred === 0) {
    const since = nowTs - lastCompleted.at;
    if (since >= 0 && since < FETCH_METERED_INTERVAL_SEC) {
      const conditions = await Promise.resolve()
        .then(() => input.network?.())
        .catch(() => undefined);
      if (conditions?.metered !== false) {
        return {
          ...NOTHING,
          outcome: 'skipped',
          reason: 'metered',
          retryAt: lastCompleted.at + FETCH_METERED_INTERVAL_SEC,
        };
      }
    }
  }

  const failIndex = async (reason: FetchFailure): Promise<FetchCycleResult> => {
    const next = backoffAfter(backoff, nowTs);
    await saveBackoff(db, next);
    return { ...NOTHING, outcome: 'failed', reason, requests, retryAt: next.retry_at };
  };

  let seed = state.coverSeed;
  if (seed === null) {
    seed = newCoverSeed(random);
    await saveCoverSeed(db, seed);
  }

  // 1. The index.
  const held =
    state.indexCache === null
      ? null
      : await readShardIndex(state.indexCache.document, trustedKeys, verify);
  const heldEtag = held === null ? null : (state.indexCache?.etag ?? null);
  const floor = Math.max(state.indexIssuedAt ?? 0, held?.issued_at ?? 0);
  const answer = await send(
    heldEtag === null
      ? { path: SHARD_INDEX_PATH }
      : { path: SHARD_INDEX_PATH, ifNoneMatch: heldEtag },
  );
  let index: ShardIndex;
  let accepted: IndexCache | null = null;
  if ('failed' in answer) {
    log({ event: 'index_unavailable', detail: answer.failed });
    return failIndex('index_unavailable');
  } else if (answer.status === 304 && held !== null) {
    index = held;
  } else if (answer.status === 200) {
    const document = parseJson(answer.body);
    const read =
      document === undefined ? null : await readShardIndex(document, trustedKeys, verify);
    if (read === null) {
      log({ event: 'index_rejected' });
      return failIndex('index_rejected');
    }
    if (read.issued_at >= floor) {
      index = read;
      accepted = { etag: answer.etag, document };
    } else if (held !== null) {
      // An edge still serving an older copy. The newer index already held stays in force.
      log({ event: 'index_stale', detail: `issued_at ${read.issued_at}, holding ${floor}` });
      index = held;
    } else {
      log({ event: 'index_rejected', detail: `issued_at ${read.issued_at} is before ${floor}` });
      return failIndex('index_rejected');
    }
  } else {
    log({ event: 'index_unavailable', detail: `status ${answer.status}` });
    return failIndex('index_unavailable');
  }

  // 2 and 3. Exactly `slots` requests, whatever the plan found to do.
  const plan = planCycle({
    shards: index.shards,
    watch,
    held: state.shards,
    seed,
    slots,
    coverShards,
    random,
  });
  const verified: VerifiedDownload[] = [];
  let failure: FetchFailure | null = null;
  for (const { shard, generation } of plan.downloads) {
    const response = await send({ path: shardBundlePath(shard, generation) });
    if ('failed' in response || response.status !== 200) {
      const detail = 'failed' in response ? response.failed : `status ${response.status}`;
      log({ event: 'bundle_unavailable', shard, generation, detail });
      failure ??= 'bundle_unavailable';
      continue;
    }
    const document = parseJson(response.body);
    const bundle =
      document === undefined ? null : await readShardBundle(document, trustedKeys, verify);
    // A bundle signed for another shard or generation is a real bundle in the wrong place.
    if (
      bundle === null ||
      bundle.bundle.shard !== shard ||
      bundle.bundle.generation !== generation
    ) {
      log({ event: 'bundle_rejected', shard, generation });
      failure = 'bundle_rejected';
      continue;
    }
    verified.push({ shard, generation, etag: response.etag, bundle });
  }
  // Padding. The answers are not needed; a 304 is the expected one.
  for (const { shard, generation, etag } of plan.revalidations) {
    const path = shardBundlePath(shard, generation);
    await send(etag === null ? { path } : { path, ifNoneMatch: etag });
  }
  const indexEtag = accepted === null ? heldEtag : accepted.etag;
  for (let i = 0; i < plan.indexRepeats; i++) {
    await send(
      indexEtag === null
        ? { path: SHARD_INDEX_PATH }
        : { path: SHARD_INDEX_PATH, ifNoneMatch: indexEtag },
    );
  }

  // 4. One write.
  const nextBackoff = failure === null ? null : backoffAfter(backoff, nowTs);
  const write = db.transaction(async (tx) => {
    const next = new Map<H3Cell, ShardState>(state.shards);
    const dropped = new Set<string>();
    const counts = { inserted: 0, revised: 0, rematch: 0, removed: 0 };
    for (const { shard, generation, etag, bundle } of verified) {
      const ids: string[] = [];
      for (const entry of bundle.queries) {
        const result = await upsertCachedReport(tx, entry, nowTs);
        counts.inserted += result.outcome === 'inserted' ? 1 : 0;
        counts.revised += result.outcome === 'revised' ? 1 : 0;
        counts.rematch += result.rematch ? 1 : 0;
        ids.push(entry.query.query_id);
      }
      const listed = new Set([...ids, ...unreadIds(bundle)]);
      for (const id of state.shards.get(shard)?.query_ids ?? []) {
        if (!listed.has(id)) {
          dropped.add(id);
        }
      }
      const shardState: ShardState = { generation, etag, query_ids: [...listed] };
      next.set(shard, shardState);
      await saveShardState(tx, shard, shardState);
    }
    for (const shard of plan.emptied) {
      for (const id of state.shards.get(shard)?.query_ids ?? []) {
        dropped.add(id);
      }
      next.delete(shard);
      await dropShardState(tx, shard);
    }
    // A report leaves a shard only by ending, but it is deleted only once no followed shard
    // lists it: the bundles of one report's shards arrive one at a time.
    const kept = new Set(plan.followed.flatMap((shard) => next.get(shard)?.query_ids ?? []));
    for (const id of dropped) {
      if (!kept.has(id) && (await deleteCachedReport(tx, id))) {
        counts.removed += 1;
      }
    }
    if (accepted !== null) {
      await saveIndex(tx, accepted, index.issued_at);
    }
    await saveBackoff(tx, nextBackoff);
    if (nextBackoff === null) {
      await saveLastCompleted(tx, { at: nowTs, deferred: plan.deferred });
    }
    return counts;
  });
  let written: Awaited<typeof write>;
  try {
    written = await write;
  } catch (error) {
    // Rolled back: report_cache and what is held are as they were. The wait is recorded on its
    // own, if the store takes it, so that the same downloads are not repeated on every wake.
    log({ event: 'store_failed', detail: message(error) });
    const next = backoffAfter(backoff, nowTs);
    await saveBackoff(db, next).catch(() => undefined);
    return {
      ...NOTHING,
      outcome: 'failed',
      reason: 'store_failed',
      requests,
      deferred: plan.deferred,
      retryAt: next.retry_at,
    };
  }

  return {
    outcome: failure === null ? 'completed' : 'failed',
    reason: failure,
    requests,
    indexChanged: accepted !== null,
    stored: verified.map((download) => download.shard).sort(),
    ...written,
    deferred: plan.deferred,
    retryAt: nextBackoff?.retry_at ?? null,
  };
}

/** One cycle at a time per store: a call made while one is running joins it. */
const running = new WeakMap<SqlDatabase, Promise<FetchCycleResult>>();

/**
 * Runs one fetch cycle against the open store. See the top of this file.
 *
 * Rejects with RangeError, before doing anything, if an argument is malformed (a watch list
 * entry that is not a shard cell, a time in milliseconds). Otherwise it resolves: a network or
 * signature problem is a `failed` result, a store that cannot be read or written is `failed`
 * with `store_failed`, and report_cache is as it was. A call made while a cycle is running on
 * the same `db` returns that cycle's result, whatever its own watch list said.
 */
export function runFetchCycle(db: SqlDatabase, input: FetchCycleInput): Promise<FetchCycleResult> {
  let checked: Checked;
  try {
    checked = check(input);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  const current = running.get(db);
  if (current !== undefined) {
    return current;
  }
  const run = cycle(db, input, checked)
    .catch((error: unknown): FetchCycleResult => {
      try {
        input.log?.({ event: 'store_failed', detail: message(error) });
      } catch {
        // As in the cycle: a sink that throws changes nothing.
      }
      return { ...NOTHING, outcome: 'failed', reason: 'store_failed' };
    })
    .finally(() => running.delete(db));
  running.set(db, run);
  return run;
}
