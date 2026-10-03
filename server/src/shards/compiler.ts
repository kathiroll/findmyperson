import { createHash } from 'node:crypto';
import {
  BROADCAST_VERSION,
  SHARD_INDEX_PATH,
  canonicalJson,
  parseBroadcastQuery,
  readShardBundle,
  readShardIndex,
  searchAreaCells,
  shardBundlePath,
  shardKeysForCells,
  signDocument,
  type BroadcastQuery,
  type H3Cell,
  type UnsignedBroadcastQuery,
} from '@findmyperson/shared';
import type { ReportRow, ServerDb, ShardGenerationRow } from '../db';
import { ed25519Verify, type ActiveSigner, type KeyRing } from './keys';
import {
  BUNDLE_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
  JSON_CONTENT_TYPE,
  type CdnInvalidator,
  type ObjectStore,
  type PublishLog,
} from './storage';

/**
 * THE SHARD COMPILER (plan 7.2, 7.4; task B3.4): turns the released reports into the signed
 * static files devices fetch by location. `compileShards` is one pass; it is safe to run as
 * often as wanted, and a pass that finds nothing changed writes nothing.
 *
 * What a pass does:
 *   1. reads reports ONLY through `ServerDb.listBroadcastable` (released, active, unexpired), so
 *      a pending or rejected report cannot reach a bundle;
 *   2. signs each as a broadcast query and files it under every shard its search area touches.
 *      The cover is `searchAreaCells` and the shard keys are `shardKeysForCells`, both from
 *      @findmyperson/shared: every res-7 cell the search disc touches, mapped to its res-5 and
 *      res-3 ancestors. A report near a shard edge is therefore in each shard it touches;
 *   3. gives a shard a new generation only if its list of queries changed;
 *   4. makes the object store match: writes missing bundles, then index.json, then deletes
 *      every bundle the index no longer names;
 *   5. asks the CDN to drop index.json and the deleted bundles.
 *
 * On the cover: the plan names h3's polygonToCells + compactCells. polygonToCells keeps only
 * cells whose centre is inside the shape, which can leave out a cell the disc touches, and a
 * device derives its shards as parents of res-7 cells (`shardCellOf`). The shared helpers are
 * the cover both sides agree on, so the compiler uses them rather than a second definition.
 *
 * GENERATIONS. A generation is a statement about bytes: `shards/<cell>/<n>.json` is written
 * once and never holds different bytes later. Three rules keep that true.
 *   - Everything in a bundle is a function of the reports and the signing key. A query's
 *     `issued_at` is its report's `updated_at`, not the time of the pass, and Ed25519 is
 *     deterministic, so an unchanged report signs to the same bytes on every pass.
 *   - The number, the content hash and the bundle's `issued_at` are stored (`shard_generations`)
 *     before anything is written, so a pass that died half way is finished by the next one with
 *     the same bytes, and a shard that empties and fills again continues its numbering.
 *   - A change of signing key changes every query's `key_id` and `sig`, so it is a change of
 *     contents: each shard moves up one generation at the rotation, and not again.
 * That table must not be reset while devices hold caches: a device that has generation 4 of a
 * shard will not fetch a different generation 4.
 *
 * ONE COMPILER AT A TIME. Two passes running together could write index.json in the wrong
 * order. `startShardWorker` never overlaps its own passes; do not run a second process against
 * the same store.
 */

/** Key of the signed index in the object store. */
export const INDEX_KEY = SHARD_INDEX_PATH.slice(1);
/** Every bundle key starts with this. The compiler deletes only under it. */
export const BUNDLE_KEY_PREFIX = 'shards/';

/** Key of one generation of one shard's bundle in the object store. */
export function bundleKey(shard: H3Cell, generation: number): string {
  return shardBundlePath(shard, generation).slice(1);
}

export interface CompileOptions {
  db: ServerDb;
  store: ObjectStore;
  cdn: CdnInvalidator;
  keys: KeyRing;
  /** The `respond.endpoint` of every query: where a bystander's tip is posted. Must be https. */
  respondEndpoint: string;
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
  log?: PublishLog;
}

export interface CompileResult {
  now: number;
  /** The key that signed this pass. */
  keyId: string;
  /** Reports in the published set. */
  reports: number;
  /** Reports left out because they could not be written as a valid query. Logged as errors. */
  skipped: string[];
  /** What index.json lists after this pass: shard to generation. */
  shards: Record<H3Cell, number>;
  /** Shards whose generation went up in this pass. With `removed`, the input to push fan-out. */
  changed: H3Cell[];
  /** Shards that had reports and now have none. They are absent from the index. */
  removed: H3Cell[];
  indexWritten: boolean;
  /** Object keys written and deleted in this pass. */
  written: string[];
  deleted: string[];
  /** CDN paths invalidated in this pass. */
  invalidated: string[];
  /** CDN paths whose invalidation failed. The next pass tries them again. */
  cdnPending: string[];
}

const SILENT: PublishLog = { info() {}, warn() {}, error() {} };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** What decides a shard's generation: the queries exactly as a device would store them. */
function contentHash(queries: readonly BroadcastQuery[]): string {
  return sha256(canonicalJson(queries));
}

function unsignedQuery(row: ReportRow, keyId: string, endpoint: string): UnsignedBroadcastQuery {
  return {
    v: BROADCAST_VERSION,
    query_id: row.query_id,
    revision: row.revision,
    key_id: keyId,
    // When this revision came to be: the release, or the latest widening edit after it.
    issued_at: row.updated_at,
    expires_at: row.expires_at,
    center: row.center,
    radius_m: row.radius_m,
    window: row.window,
    cells: searchAreaCells(row.center, row.radius_m),
    person: row.person,
    reporter_phone: row.reporter_phone,
    respond: { endpoint },
  };
}

/**
 * Signs one report as a query and checks it against the schema a device applies. A report that
 * fails is left out and reported, so one bad row cannot stop every other report. Signatures are
 * checked when a bundle is built (every query in it is read back before the bundle is put).
 */
async function signQuery(
  row: ReportRow,
  signer: ActiveSigner,
  endpoint: string,
): Promise<{ query: BroadcastQuery } | { reason: string }> {
  try {
    const signed = await signDocument(
      'query',
      unsignedQuery(row, signer.keyId, endpoint),
      signer.sign,
    );
    const parsed = parseBroadcastQuery(signed);
    if (parsed.status !== 'ok') {
      return { reason: parsed.status === 'invalid' ? parsed.issues.join('; ') : parsed.status };
    }
    return { query: signed };
  } catch (error) {
    return { reason: (error as Error).message };
  }
}

interface Plan {
  /** Every shard that has reports, with the generation it is published at. */
  current: Map<H3Cell, ShardGenerationRow>;
  changed: H3Cell[];
  removed: H3Cell[];
}

/** Assigns generations. One transaction, so a pass sees and leaves a consistent table. */
function planGenerations(
  db: ServerDb,
  byShard: ReadonlyMap<H3Cell, BroadcastQuery[]>,
  now: number,
): Plan {
  const emptyHash = contentHash([]);
  return db.transaction(() => {
    const stored = new Map(db.listShardGenerations().map((row) => [row.shard, row]));
    const plan: Plan = { current: new Map(), changed: [], removed: [] };
    for (const shard of [...byShard.keys()].sort()) {
      const queries = byShard.get(shard) ?? [];
      const hash = contentHash(queries);
      const previous = stored.get(shard);
      if (previous !== undefined && previous.content_hash === hash) {
        plan.current.set(shard, previous);
        continue;
      }
      const next: ShardGenerationRow = {
        shard,
        generation: (previous?.generation ?? 0) + 1,
        content_hash: hash,
        query_count: queries.length,
        issued_at: now,
      };
      db.putShardGeneration(next);
      plan.current.set(shard, next);
      plan.changed.push(shard);
    }
    for (const previous of stored.values()) {
      if (!byShard.has(previous.shard) && previous.query_count > 0) {
        // The number is kept: if the shard fills again it continues from here.
        db.putShardGeneration({ ...previous, content_hash: emptyHash, query_count: 0 });
        plan.removed.push(previous.shard);
      }
    }
    return plan;
  });
}

function encode(document: object): Uint8Array {
  return Uint8Array.from(Buffer.from(canonicalJson(document), 'utf8'));
}

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

export async function compileShards(options: CompileOptions): Promise<CompileResult> {
  const { db, store, cdn, keys, respondEndpoint } = options;
  const log = options.log ?? SILENT;
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  const signer = keys.signerAt(now);
  const trusted = keys.trustedAt(now);

  // 1 and 2. The broadcastable reports, signed, filed under every shard they touch.
  const byShard = new Map<H3Cell, BroadcastQuery[]>();
  const skipped: string[] = [];
  let reports = 0;
  for (const row of db.listBroadcastable(now)) {
    const signed = await signQuery(row, signer, respondEndpoint);
    if ('reason' in signed) {
      skipped.push(row.query_id);
      log.error(
        { event: 'shards.report_skipped', query_id: row.query_id, reason: signed.reason },
        'a released report could not be written as a valid query and was left out',
      );
      continue;
    }
    reports += 1;
    const { r5, r3 } = shardKeysForCells(signed.query.cells);
    for (const shard of [...r5, ...r3]) {
      const queries = byShard.get(shard) ?? [];
      queries.push(signed.query);
      byShard.set(shard, queries);
    }
  }
  for (const queries of byShard.values()) {
    queries.sort((a, b) => (a.query_id < b.query_id ? -1 : a.query_id > b.query_id ? 1 : 0));
  }

  // 3. Generations.
  const plan = planGenerations(db, byShard, now);
  const shards: Record<H3Cell, number> = {};
  const wanted = new Map<string, ShardGenerationRow>();
  for (const [shard, row] of plan.current) {
    shards[shard] = row.generation;
    wanted.set(bundleKey(shard, row.generation), row);
  }

  // 4. What the store has against what it should have.
  const existing = new Set(await store.list(BUNDLE_KEY_PREFIX));
  const toWrite = [...wanted.keys()].filter((key) => !existing.has(key)).sort();
  const toDelete = [...existing].filter((key) => !wanted.has(key)).sort();

  const indexHash = sha256(canonicalJson({ key_id: signer.keyId, shards }));
  const indexState = db.getShardIndexState();
  const indexUnchanged = indexState !== null && indexState.index_hash === indexHash;
  const indexWritten = !indexUnchanged || (await store.get(INDEX_KEY)) === null;
  // Strictly later than the last one, even if the clock stepped back: a device ignores an index
  // older than the newest it accepted. A repair of a lost index.json reuses the same instant.
  const indexIssuedAt = indexUnchanged
    ? indexState.issued_at
    : Math.max(now, (indexState?.issued_at ?? -1) + 1);

  // Recorded before anything changes, so a pass that dies after this line still gets its
  // invalidation on the next one. A rewritten bundle whose generation did not just change is a
  // repair of a lost object, and the CDN may hold a 404 for it.
  const changedNow = new Set(plan.changed);
  const repaired = toWrite.filter((key) => !changedNow.has(wanted.get(key)?.shard ?? ''));
  db.addPendingCdnPaths([
    ...(indexWritten ? [SHARD_INDEX_PATH] : []),
    ...[...toDelete, ...repaired].map((key) => `/${key}`),
  ]);

  // Every new document is built and read back, as a device would read it, before any is put.
  const bundles: { key: string; body: Uint8Array }[] = [];
  for (const key of toWrite) {
    const row = wanted.get(key) as ShardGenerationRow;
    const queries = byShard.get(row.shard) ?? [];
    const bundle = await signDocument(
      'bundle',
      {
        v: BROADCAST_VERSION,
        shard: row.shard,
        generation: row.generation,
        key_id: signer.keyId,
        issued_at: row.issued_at,
        queries,
      },
      signer.sign,
    );
    const body = encode(bundle);
    const readBack = await readShardBundle(decode(body), trusted, ed25519Verify);
    if (readBack === null || readBack.skipped !== 0 || readBack.queries.length !== queries.length) {
      throw new Error(`bundle ${key} does not verify with the keys in force; nothing was written`);
    }
    bundles.push({ key, body });
  }
  let indexBody: Uint8Array | null = null;
  if (indexWritten) {
    const index = await signDocument(
      'index',
      { v: BROADCAST_VERSION, key_id: signer.keyId, issued_at: indexIssuedAt, shards },
      signer.sign,
    );
    indexBody = encode(index);
    if ((await readShardIndex(decode(indexBody), trusted, ed25519Verify)) === null) {
      throw new Error('index.json does not verify with the keys in force; nothing was written');
    }
  }

  // Bundles first, then the index that names them, then the bundles it no longer names.
  for (const { key, body } of bundles) {
    await store.put(key, body, {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: BUNDLE_CACHE_CONTROL,
    });
  }
  if (indexBody !== null) {
    await store.put(INDEX_KEY, indexBody, {
      contentType: JSON_CONTENT_TYPE,
      cacheControl: INDEX_CACHE_CONTROL,
    });
    // After the put: if the pass dies in between, the next one writes the index again.
    db.putShardIndexState({ index_hash: indexHash, issued_at: indexIssuedAt });
  }
  for (const key of toDelete) {
    await store.delete(key);
  }

  // 5. The CDN, including anything an earlier pass could not get invalidated.
  const pending = db.listPendingCdnPaths();
  let invalidated: string[] = [];
  let cdnPending: string[] = [];
  if (pending.length > 0) {
    try {
      await cdn.invalidate(pending);
      db.clearPendingCdnPaths(pending);
      invalidated = pending;
    } catch (error) {
      cdnPending = pending;
      log.error(
        { event: 'shards.cdn_failed', paths: pending, err: (error as Error).message },
        'CDN invalidation failed; the store is published and the next pass will try again',
      );
    }
  }

  const result: CompileResult = {
    now,
    keyId: signer.keyId,
    reports,
    skipped,
    shards,
    changed: plan.changed,
    removed: plan.removed,
    indexWritten,
    written: [...toWrite, ...(indexWritten ? [INDEX_KEY] : [])],
    deleted: toDelete,
    invalidated,
    cdnPending,
  };
  if (result.written.length > 0 || result.deleted.length > 0) {
    log.info(
      {
        event: 'shards.published',
        key_id: result.keyId,
        reports,
        shards: plan.current.size,
        changed: plan.changed,
        removed: plan.removed,
        written: result.written.length,
        deleted: result.deleted.length,
      },
      'shard bundles published',
    );
  }
  return result;
}
