import { z } from 'zod';
import type { H3Cell } from '../geo/h3';
import { KeyIdSchema, ShardCellSchema, SignatureSchema, UnixSecondsSchema } from './primitives';
import { BROADCAST_VERSION, parseBroadcastQuery, type BroadcastQuery } from './query';
import { verifyDocument, type Ed25519Verify, type TrustedKeys } from './signing';

/**
 * The two static files a device downloads (plan 7.4).
 *
 *   /index.json                  every shard and its current generation, signed
 *   /shards/<h3 cell>/<gen>.json the live queries filed under one shard, signed
 *
 * Both are signed as a whole, and every query inside a bundle also carries its own signature.
 * The bundle signature proves the list is complete as published; the per-query signature lets
 * a cached query be re-checked on its own and lets the publisher reuse an entry across shards
 * and generations without re-signing it.
 */

/** Generation numbers start at 1 and only ever increase for a given shard. */
const GenerationSchema = z.number().int().min(1);

export const ShardBundleSchema = z.object({
  v: z.literal(BROADCAST_VERSION),
  /** The shard this bundle is for: an H3 cell at res 5, or res 3 for a coarsened shard. */
  shard: ShardCellSchema,
  generation: GenerationSchema,
  key_id: KeyIdSchema,
  issued_at: UnixSecondsSchema,
  /**
   * Broadcast queries, each left as raw JSON here. They are verified and parsed one by one, so
   * a single entry in a newer format is skipped without discarding the rest of the bundle.
   */
  queries: z.array(z.unknown()),
  sig: SignatureSchema,
});
export type ShardBundle = z.infer<typeof ShardBundleSchema>;

export const ShardIndexSchema = z.object({
  v: z.literal(BROADCAST_VERSION),
  key_id: KeyIdSchema,
  /** A device must ignore an index older than the newest one it has accepted (no rollback). */
  issued_at: UnixSecondsSchema,
  /** Shard cell id to current generation. A shard with no live reports is simply absent. */
  shards: z.record(ShardCellSchema, GenerationSchema),
  sig: SignatureSchema,
});
export type ShardIndex = z.infer<typeof ShardIndexSchema>;

/** Path of the signed index, relative to the CDN origin. */
export const SHARD_INDEX_PATH = '/index.json';

/** Path of one generation of one shard bundle, relative to the CDN origin. */
export function shardBundlePath(shard: H3Cell, generation: number): string {
  return `/shards/${shard}/${generation}.json`;
}

/** One query a device may cache: the typed view, and the JSON exactly as it was signed. */
export interface VerifiedQuery {
  query: BroadcastQuery;
  /** The entry as received, unknown members included. This is what `report_cache` stores. */
  raw: Record<string, unknown>;
}

export interface VerifiedBundle {
  bundle: ShardBundle;
  queries: VerifiedQuery[];
  /** Entries dropped: unknown version, bad signature, or failing the schema. */
  skipped: number;
}

/**
 * Verifies and reads a shard bundle. Returns null if the bundle itself is not acceptable (bad
 * signature, unknown key, unknown version, wrong shape); the caller discards it without telling
 * anyone (plan 6.4). The signature is always checked on the raw value before any schema runs.
 */
export async function readShardBundle(
  raw: unknown,
  trustedKeys: TrustedKeys,
  verify: Ed25519Verify,
): Promise<VerifiedBundle | null> {
  if (!(await verifyDocument('bundle', raw, trustedKeys, verify)).ok) {
    return null;
  }
  const parsed = ShardBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const queries: VerifiedQuery[] = [];
  for (const entry of parsed.data.queries) {
    if (!(await verifyDocument('query', entry, trustedKeys, verify)).ok) {
      continue;
    }
    const result = parseBroadcastQuery(entry);
    if (result.status === 'ok') {
      queries.push({ query: result.query, raw: entry as Record<string, unknown> });
    }
  }
  return {
    bundle: parsed.data,
    queries,
    skipped: parsed.data.queries.length - queries.length,
  };
}

/** Verifies and reads the shard index, or returns null if it is not acceptable. */
export async function readShardIndex(
  raw: unknown,
  trustedKeys: TrustedKeys,
  verify: Ed25519Verify,
): Promise<ShardIndex | null> {
  if (!(await verifyDocument('index', raw, trustedKeys, verify)).ok) {
    return null;
  }
  const parsed = ShardIndexSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
