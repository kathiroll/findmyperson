import type { H3Cell } from '../../geo/h3';
import { text, type SqlExecutor } from '../driver';

/**
 * `kv`: small named values, mostly cursors. Values are text; callers encode numbers themselves.
 *
 * Every key in use is listed here with its owner. A task that needs a new key adds it to this
 * file, so two tasks can never pick the same name for different things. The schema version is
 * NOT kept here: it is `PRAGMA user_version` (store/migrations.ts).
 */
export const KV_KEYS = {
  /**
   * Stay derivation: id of the last `location_sample` row it has finished with. The samples of
   * a dwell still too short to be a stay come after it and are read again (stay/derive.ts). The
   * retention purge pulls it back, through rewindStayCursorToStoredSamples, when it deletes the
   * newest rows; so does the native purge, with the same statement.
   */
  stayDerivationLastSampleId: 'stay_derivation.last_sample_id',
  /** Retention purge: when it last ran, Unix seconds. For diagnostics; the purge never reads it. */
  purgeLastRunAt: 'purge.last_run_at',
  /** Retention purge: when VACUUM last ran, Unix seconds. */
  vacuumLastRunAt: 'purge.last_vacuum_at',
  /** Bundle fetcher: `issued_at` of the newest shard index accepted, to refuse a rollback. */
  fetchIndexIssuedAt: 'fetch.index_issued_at',
  /** Bundle fetcher: the newest shard index accepted, as signed, and its ETag (fetch/state.ts). */
  fetchIndexCache: 'fetch.index_cache',
  /** Bundle fetcher: the secret that picks this device's cover shards. Never leaves the store. */
  fetchCoverSeed: 'fetch.cover_seed',
  /** Bundle fetcher: failed cycles in a row and the time before which it will not try again. */
  fetchBackoff: 'fetch.backoff',
  /** Bundle fetcher: when a cycle last completed and how many changed shards it left waiting. */
  fetchLastCompleted: 'fetch.last_completed',
  /** Device identity (R4.1): the client-generated device id, a UUID v4, created on first use. */
  deviceId: 'identity.device_id',
} as const;

/** Every shardGenerationKey starts with this. */
export const SHARD_GENERATION_KEY_PREFIX = 'fetch.shard_generation.';

/**
 * Bundle fetcher: what it holds of one shard: the generation it last stored, that bundle's ETag
 * and the reports that bundle listed (fetch/state.ts gives the value its shape).
 */
export function shardGenerationKey(shard: H3Cell): string {
  return `${SHARD_GENERATION_KEY_PREFIX}${shard}`;
}

export async function kvGet(db: SqlExecutor, key: string): Promise<string | null> {
  const rows = await db.execute('SELECT v FROM kv WHERE k = ?', [key]);
  return rows[0] === undefined ? null : text(rows[0], 'v');
}

/** Every row whose key starts with `prefix`, sorted by key. */
export async function kvListByPrefix(
  db: SqlExecutor,
  prefix: string,
): Promise<{ key: string; value: string }[]> {
  const rows = await db.execute('SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k', [
    prefix.length,
    prefix,
  ]);
  return rows.map((row) => ({ key: text(row, 'k'), value: text(row, 'v') }));
}

export async function kvSet(db: SqlExecutor, key: string, value: string): Promise<void> {
  await db.execute(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
    [key, value],
  );
}

export async function kvDelete(db: SqlExecutor, key: string): Promise<boolean> {
  const rows = await db.execute('DELETE FROM kv WHERE k = ? RETURNING k', [key]);
  return rows.length > 0;
}
