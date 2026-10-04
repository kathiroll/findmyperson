import { z } from 'zod';
import type { H3Cell } from '../geo/h3';
import { ShardCellSchema, UnixSecondsSchema } from '../payload/primitives';
import type { SqlExecutor } from '../store/driver';
import {
  KV_KEYS,
  SHARD_GENERATION_KEY_PREFIX,
  kvDelete,
  kvGet,
  kvListByPrefix,
  kvSet,
  shardGenerationKey,
} from '../store/tables/kv';

/**
 * What the bundle fetcher remembers between cycles. All of it is in `kv`, in the encrypted
 * store, under the keys tables/kv.ts lists for it; nothing is kept in memory, so a cycle on a
 * cold wake starts from exactly what the last one left.
 *
 * A row that does not read back as the shape below counts as absent. Nothing here is the only
 * copy of anything: the fetcher asks the CDN again.
 */

/** What is held of one shard. Cover shards are held exactly like watched ones. */
export interface ShardState {
  /** The generation whose bundle was stored. */
  generation: number;
  /** That bundle's ETag, for the revalidation that fills a spare request slot. */
  etag: string | null;
  /** The reports that bundle listed. A later generation that drops one ends it. */
  query_ids: string[];
}

export interface IndexCache {
  etag: string | null;
  /** The signed index as received. It is verified again every time it is read back. */
  document: unknown;
}

export interface BackoffState {
  /** Failed cycles in a row. */
  failures: number;
  /** No cycle starts before this, Unix seconds. */
  retry_at: number;
}

export interface LastCompleted {
  at: number;
  /** Changed shards that cycle had no request slot left for. */
  deferred: number;
}

export interface FetchState {
  indexIssuedAt: number | null;
  indexCache: IndexCache | null;
  coverSeed: string | null;
  backoff: BackoffState | null;
  lastCompleted: LastCompleted | null;
  shards: Map<H3Cell, ShardState>;
}

const ShardStateSchema = z.object({
  generation: z.number().int().min(1),
  etag: z.string().nullable(),
  query_ids: z.array(z.string()),
});
const IndexCacheSchema = z.object({ etag: z.string().nullable(), document: z.unknown() });
const BackoffSchema = z.object({ failures: z.number().int().min(1), retry_at: UnixSecondsSchema });
const LastCompletedSchema = z.object({ at: UnixSecondsSchema, deferred: z.number().int().min(0) });
const SEED_PATTERN = /^[0-9a-f]{32}$/;

function read<T>(schema: z.ZodType<T>, value: string | null): T | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function loadFetchState(db: SqlExecutor): Promise<FetchState> {
  const issuedAt = Number(await kvGet(db, KV_KEYS.fetchIndexIssuedAt));
  const seed = await kvGet(db, KV_KEYS.fetchCoverSeed);
  const shards = new Map<H3Cell, ShardState>();
  for (const row of await kvListByPrefix(db, SHARD_GENERATION_KEY_PREFIX)) {
    const shard = row.key.slice(SHARD_GENERATION_KEY_PREFIX.length);
    const state = read(ShardStateSchema, row.value);
    if (state !== null && ShardCellSchema.safeParse(shard).success) {
      shards.set(shard, state);
    }
  }
  return {
    // Number(null) is 0, which no index is older than.
    indexIssuedAt: Number.isSafeInteger(issuedAt) && issuedAt > 0 ? issuedAt : null,
    indexCache: read(
      IndexCacheSchema,
      await kvGet(db, KV_KEYS.fetchIndexCache),
    ) as IndexCache | null,
    coverSeed: seed !== null && SEED_PATTERN.test(seed) ? seed : null,
    backoff: read(BackoffSchema, await kvGet(db, KV_KEYS.fetchBackoff)),
    lastCompleted: read(LastCompletedSchema, await kvGet(db, KV_KEYS.fetchLastCompleted)),
    shards,
  };
}

export async function saveCoverSeed(db: SqlExecutor, seed: string): Promise<void> {
  await kvSet(db, KV_KEYS.fetchCoverSeed, seed);
}

export async function saveShardState(
  db: SqlExecutor,
  shard: H3Cell,
  state: ShardState,
): Promise<void> {
  await kvSet(db, shardGenerationKey(shard), JSON.stringify(state));
}

export async function dropShardState(db: SqlExecutor, shard: H3Cell): Promise<void> {
  await kvDelete(db, shardGenerationKey(shard));
}

export async function saveIndex(
  db: SqlExecutor,
  cache: IndexCache,
  issuedAt: number,
): Promise<void> {
  await kvSet(db, KV_KEYS.fetchIndexCache, JSON.stringify(cache));
  await kvSet(db, KV_KEYS.fetchIndexIssuedAt, String(issuedAt));
}

export async function saveBackoff(db: SqlExecutor, backoff: BackoffState | null): Promise<void> {
  if (backoff === null) {
    await kvDelete(db, KV_KEYS.fetchBackoff);
  } else {
    await kvSet(db, KV_KEYS.fetchBackoff, JSON.stringify(backoff));
  }
}

export async function saveLastCompleted(db: SqlExecutor, last: LastCompleted): Promise<void> {
  await kvSet(db, KV_KEYS.fetchLastCompleted, JSON.stringify(last));
}
