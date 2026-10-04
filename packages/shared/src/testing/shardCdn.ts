import { createHash } from 'node:crypto';
import { gridDisk } from 'h3-js';
import type { FetchRequest, FetchResponse, FetchTransport } from '../fetch/transport';
import { matchCellAt, shardCellOf, type H3Cell } from '../geo/h3';
import { SHARD_INDEX_PATH, shardBundlePath } from '../payload/bundle';
import { signDocument, type Ed25519Sign } from '../payload/signing';
import { signedQueryWith, testKey, testKeyId } from './fixtures';

/**
 * TEST SUPPORT, not exported from the package. A CDN in memory that publishes what the shard
 * compiler publishes (server/src/shards/compiler.ts): a signed /index.json and one signed,
 * immutable bundle per shard generation, each served with an ETag and answering If-None-Match
 * with a 304. Every request is recorded, which is what the padding tests read.
 */

export const CDN_T0 = 1_789_900_000;

/** The shard of central Bangalore, and its neighbours out to `rings` steps, sorted. */
export function shardsAround(rings: number): H3Cell[] {
  return gridDisk(shardCellOf(matchCellAt({ lat: 12.9716, lon: 77.5946 })), rings).sort();
}

/** A valid report id that depends only on `n`. */
export function queryIdOf(n: number): string {
  return `01JB3Z6Q7W${String(n).padStart(16, '0')}`;
}

/** A signed report, as an entry of a bundle. `changes` override members before signing. */
export function signedReport(
  n: number,
  changes: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return signedQueryWith({ query_id: queryIdOf(n), ...changes });
}

export interface RecordedRequest extends FetchRequest {
  status: number;
}

export interface PublishKey {
  keyId: string;
  sign: Ed25519Sign;
}

const etagOf = (body: string) =>
  `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`;

export class FakeShardCdn {
  /** Every request made, in order, with the status it got. */
  readonly requests: RecordedRequest[] = [];
  /** Answers given instead of the published file, by path. For outages and tampering. */
  readonly overrides = new Map<string, (request: FetchRequest) => FetchResponse>();
  /** When true no request gets an answer: the transport rejects. */
  offline = false;

  private readonly files = new Map<string, string>();
  private readonly generations = new Map<H3Cell, number>();
  private readonly live = new Map<H3Cell, number>();
  private issuedAt = CDN_T0;

  /** Starts with an index that lists no shard. */
  static async start(): Promise<FakeShardCdn> {
    const cdn = new FakeShardCdn();
    await cdn.writeIndex();
    return cdn;
  }

  readonly transport: FetchTransport = {
    get: async (request) => {
      if (this.offline) {
        this.requests.push({ ...request, status: 0 });
        throw new Error('network request failed');
      }
      const response = this.answer(request);
      this.requests.push({ ...request, status: response.status });
      return response;
    },
  };

  private answer(request: FetchRequest): FetchResponse {
    const override = this.overrides.get(request.path);
    if (override !== undefined) {
      return override(request);
    }
    const body = this.files.get(request.path);
    if (body === undefined) {
      return { status: 404, body: null, etag: null };
    }
    const etag = etagOf(body);
    return request.ifNoneMatch === etag
      ? { status: 304, body: null, etag }
      : { status: 200, body, etag };
  }

  /** What is being served at a path, or undefined. */
  file(path: string): string | undefined {
    return this.files.get(path);
  }

  generationOf(shard: H3Cell): number | undefined {
    return this.live.get(shard);
  }

  /** The path of a shard's current bundle. */
  pathOf(shard: H3Cell): string {
    const generation = this.live.get(shard);
    if (generation === undefined) {
      throw new Error(`shard ${shard} is not published`);
    }
    return shardBundlePath(shard, generation);
  }

  /**
   * Publishes a new generation of each shard given, holding exactly the reports given, and a
   * new index. An empty list empties the shard: it leaves the index and its bundle is deleted.
   */
  async publish(
    shards: Readonly<Record<H3Cell, readonly Record<string, unknown>[]>>,
    key: PublishKey = { keyId: testKeyId, sign: testKey.sign },
  ): Promise<void> {
    for (const [shard, queries] of Object.entries(shards)) {
      const previous = this.live.get(shard);
      if (previous !== undefined) {
        this.files.delete(shardBundlePath(shard, previous));
        this.live.delete(shard);
      }
      if (queries.length === 0) {
        continue;
      }
      const generation = (this.generations.get(shard) ?? 0) + 1;
      this.generations.set(shard, generation);
      this.live.set(shard, generation);
      const bundle = await signDocument(
        'bundle',
        { v: 1, shard, generation, key_id: key.keyId, issued_at: this.issuedAt + 1, queries },
        key.sign,
      );
      this.files.set(shardBundlePath(shard, generation), JSON.stringify(bundle));
    }
    await this.writeIndex(key);
  }

  private async writeIndex(
    key: PublishKey = { keyId: testKeyId, sign: testKey.sign },
  ): Promise<void> {
    this.issuedAt += 1;
    const shards = Object.fromEntries([...this.live].sort(([a], [b]) => (a < b ? -1 : 1)));
    const index = await signDocument(
      'index',
      { v: 1, key_id: key.keyId, issued_at: this.issuedAt, shards },
      key.sign,
    );
    this.files.set(SHARD_INDEX_PATH, JSON.stringify(index));
  }

  /** Forgets the requests seen so far and returns them. */
  takeRequests(): RecordedRequest[] {
    return this.requests.splice(0);
  }
}

/** A repeatable stand-in for the device's random source. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
