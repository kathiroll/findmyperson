import { createHash } from 'node:crypto';
import {
  REPORT_TTL_SEC,
  base64UrlEncode,
  matchCellAt,
  readShardBundle,
  readShardIndex,
  searchAreaCells,
  shardCellOf,
  shardKeysForCells,
  type LatLon,
  type Person,
  type ShardIndex,
  type TrustedKeys,
  type VerifiedBundle,
} from '@findmyperson/shared';
import { ServerDb } from '../db';
import { compileShards, INDEX_KEY, bundleKey, type CompileOptions } from './compiler';
import { KeyRing, ed25519Verify, type SigningKeyConfig } from './keys';
import { MemoryObjectStore, type CdnInvalidator } from './storage';

/** TEST SUPPORT for the shard compiler's tests. Not exported from the package. */

export const NOW = 1_789_900_000;
export const ENDPOINT = 'https://api.findmyperson.example/v1/responses';

/**
 * Two points whose search areas (up to 500 m) each lie inside a single res-5 shard, so a test
 * that is not about edges gets exactly one res-5 and one res-3 bundle per city. The city centre
 * of Bangalore itself sits on a shard edge, which is why the points are searched for.
 */
export const BANGALORE: LatLon = pointInsideShard({ lat: 12.9716, lon: 77.5946 }, 500);
/** Far enough from Bangalore to share neither a res-5 nor a res-3 shard with it. */
export const MUMBAI: LatLon = pointInsideShard({ lat: 19.076, lon: 72.8777 }, 500);

/** A signing key from a fixed seed, so signatures and sizes are the same on every run. */
export function testKey(keyId: string, seedByte: number): SigningKeyConfig {
  return { key_id: keyId, seed: base64UrlEncode(new Uint8Array(32).fill(seedByte)) };
}

/** A valid ULID that depends only on `n`. */
export function ulidOf(n: number): string {
  return `01JB3Z6Q7W${String(n).padStart(16, '0')}`;
}

export interface ReportSeed {
  center?: LatLon;
  radius_m?: number;
  person?: Person;
  created_at?: number;
  state?: 'pending' | 'released' | 'rejected';
}

let reportCounter = 0;

/** Inserts a report the way intake does, then moves it through review. Returns its id. */
export function addReport(db: ServerDb, seed: ReportSeed = {}): string {
  reportCounter += 1;
  const queryId = ulidOf(reportCounter);
  const createdAt = seed.created_at ?? NOW - 600;
  db.insertPendingReport({
    query_id: queryId,
    reporter_device_id: '3f2b8c1e-9d4a-4b6f-8a1c-0e5d7f9b2a34',
    created_at: createdAt,
    updated_at: createdAt,
    expires_at: createdAt + REPORT_TTL_SEC,
    center: seed.center ?? BANGALORE,
    radius_m: seed.radius_m ?? 100,
    window: { from: createdAt - 3_600, to: createdAt - 1_800 },
    person: seed.person ?? { name: 'Alex Rivera', description: 'Blue jacket.' },
    reporter_phone: '+15550000000',
  });
  const state = seed.state ?? 'released';
  if (state !== 'pending') {
    db.setReviewState(queryId, state, 'operator', createdAt + 60);
  }
  return queryId;
}

export class RecordingCdn implements CdnInvalidator {
  readonly calls: string[][] = [];
  failing = false;

  invalidate(paths: readonly string[]): Promise<void> {
    if (this.failing) {
      return Promise.reject(new Error('CDN unavailable'));
    }
    this.calls.push([...paths]);
    return Promise.resolve();
  }
}

/** A database, an in-memory store, a recording CDN and a clock the test moves by hand. */
export function harness(keyConfig: SigningKeyConfig[] = [testKey('k1', 1)]) {
  const db = new ServerDb();
  const store = new MemoryObjectStore();
  const cdn = new RecordingCdn();
  const keys = new KeyRing(keyConfig);
  const clock = { now: NOW };
  const options: CompileOptions = {
    db,
    store,
    cdn,
    keys,
    respondEndpoint: ENDPOINT,
    now: () => clock.now,
  };
  return {
    db,
    store,
    cdn,
    keys,
    clock,
    options,
    compile: () => compileShards(options),
    /** The published bundle, read the way a device reads it. Null if it is absent or rejected. */
    async bundle(
      shard: string,
      generation: number,
      trusted: TrustedKeys = keys.trustedAt(clock.now),
    ): Promise<VerifiedBundle | null> {
      const body = await store.get(bundleKey(shard, generation));
      return body === null ? null : readShardBundle(parse(body), trusted, ed25519Verify);
    },
    async index(trusted: TrustedKeys = keys.trustedAt(clock.now)): Promise<ShardIndex | null> {
      const body = await store.get(INDEX_KEY);
      return body === null ? null : readShardIndex(parse(body), trusted, ed25519Verify);
    },
  };
}

export function parse(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
}

/** The res-5 and res-3 shards a report at `center` is filed under. */
export function shardsOf(center: LatLon, radiusM: number): { r5: string[]; r3: string[] } {
  return shardKeysForCells(searchAreaCells(center, radiusM));
}

/**
 * A point just short of the line where the res-5 shard changes, walking east from `start` in
 * steps of about 40 m. A search disc there (at least 150 m) reaches across the line.
 */
export function pointOnShardEdge(start: LatLon): LatLon {
  let previous = start;
  for (let step = 1; step < 3_000; step++) {
    const next = { lat: start.lat, lon: start.lon + step * 0.0004 };
    if (shardCellOf(matchCellAt(next)) !== shardCellOf(matchCellAt(previous))) {
      return previous;
    }
    previous = next;
  }
  throw new Error('no shard edge found');
}

/** A point whose whole neighbourhood (a `radiusM` search area) lies inside one res-5 shard. */
export function pointInsideShard(start: LatLon, radiusM: number): LatLon {
  for (let step = 0; step < 200; step++) {
    const candidate = { lat: start.lat, lon: start.lon + step * 0.01 };
    if (shardsOf(candidate, radiusM).r5.length === 1) {
      return candidate;
    }
  }
  throw new Error('no interior point found');
}

/** `length` bytes that do not compress, the same on every run: a stand-in for an image. */
export function incompressibleBytes(length: number, label: string): Buffer {
  const blocks: Buffer[] = [];
  for (let i = 0; blocks.length * 32 < length; i++) {
    blocks.push(createHash('sha256').update(`${label}:${i}`).digest());
  }
  return Buffer.concat(blocks).subarray(0, length);
}
