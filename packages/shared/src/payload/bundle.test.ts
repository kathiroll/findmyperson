import { describe, expect, test } from 'vitest';
import { searchAreaCells, shardCellOf, pushCellOf, matchCellAt } from '../geo/h3';
import { ed25519Verify } from '../testing/ed25519';
import {
  rawBundle,
  rawIndex,
  rawQuery,
  signedQueryWith,
  testKey,
  testKeyId,
  trustedTestKeys,
  withoutSig,
} from '../testing/fixtures';
import {
  readShardBundle,
  readShardIndex,
  SHARD_INDEX_PATH,
  shardBundlePath,
  ShardBundleSchema,
} from './bundle';
import { signDocument } from './signing';
import type { UnsignedBroadcastQuery } from './query';

const read = (raw: unknown, keys = trustedTestKeys) => readShardBundle(raw, keys, ed25519Verify);

async function bundleOf(queries: unknown[]): Promise<Record<string, unknown>> {
  return signDocument('bundle', { ...withoutSig(rawBundle()), queries }, testKey.sign);
}

describe('readShardBundle', () => {
  test('reads the sample bundle and both of its queries', async () => {
    const result = await read(rawBundle());
    expect(result).not.toBeNull();
    expect(result?.bundle.generation).toBe(3);
    expect(result?.queries).toHaveLength(2);
    expect(result?.skipped).toBe(0);
  });

  test('keeps the raw entry, unknown members included, for the cache', async () => {
    const result = await read(rawBundle());
    const second = result?.queries[1];
    expect(second?.raw.future_field).toEqual({ nested: [1, 2, 3] });
    expect('future_field' in (second?.query ?? {})).toBe(false);
    // The stored form can be verified again later, on its own.
    expect(await read(await bundleOf([JSON.parse(JSON.stringify(second?.raw))]))).toMatchObject({
      skipped: 0,
    });
  });

  test('discards a bundle whose envelope was altered', async () => {
    expect(await read({ ...rawBundle(), generation: 4 })).toBeNull();
    expect(await read({ ...rawBundle(), queries: [] })).toBeNull();
  });

  test('discards a bundle signed by a key the device does not trust', async () => {
    expect(await read(rawBundle(), {})).toBeNull();
  });

  test('discards a correctly signed bundle in a newer format', async () => {
    const newer = await signDocument('bundle', { ...withoutSig(rawBundle()), v: 2 }, testKey.sign);
    expect(await read(newer)).toBeNull();
  });

  test('discards an index offered as a bundle', async () => {
    expect(await read(rawIndex())).toBeNull();
  });

  test('skips an entry in a newer format and keeps the rest', async () => {
    const newerEntry = await signedQueryWith({ v: 2, query_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJN' });
    const result = await read(await bundleOf([rawQuery(), newerEntry]));
    expect(result?.queries.map((entry) => entry.query.query_id)).toEqual([
      '01JB3Z6Q7W8X9Y0ZABCDEFGHJK',
    ]);
    expect(result?.skipped).toBe(1);
  });

  test('skips an entry whose own signature is wrong, even inside a validly signed bundle', async () => {
    const tampered = { ...rawQuery(), reporter_phone: '+15559999999' };
    const result = await read(await bundleOf([tampered, rawQuery()]));
    expect(result?.queries).toHaveLength(1);
    expect(result?.queries[0]?.query.reporter_phone).toBe('+15550000000');
    expect(result?.skipped).toBe(1);
  });

  test('skips a correctly signed entry that fails the schema', async () => {
    const invalid = await signedQueryWith({ reporter_phone: 'not a number' });
    const result = await read(await bundleOf([invalid]));
    expect(result).toMatchObject({ queries: [], skipped: 1 });
  });

  test('an empty bundle is valid', async () => {
    expect(await read(await bundleOf([]))).toMatchObject({ queries: [], skipped: 0 });
  });
});

describe('readShardIndex', () => {
  const readIndex = (raw: unknown) => readShardIndex(raw, trustedTestKeys, ed25519Verify);

  test('reads the sample index', async () => {
    const index = await readIndex(rawIndex());
    const shard = shardCellOf(matchCellAt({ lat: 12.9716, lon: 77.5946 }));
    expect(index?.shards).toEqual({ [shard]: 3, [pushCellOf(shard)]: 7 });
  });

  test('discards an altered index, and a bundle offered as an index', async () => {
    expect(await readIndex({ ...rawIndex(), issued_at: 1 })).toBeNull();
    expect(await readIndex(rawBundle())).toBeNull();
  });

  test('discards a signed index whose shard key is not a shard cell', async () => {
    const bad = await signDocument(
      'index',
      { ...withoutSig(rawIndex()), shards: { '8760145b4ffffff': 1 } },
      testKey.sign,
    );
    expect(await readIndex(bad)).toBeNull();
  });
});

describe('publish and read, end to end', () => {
  test('a query built from parts survives sign, serialise, parse, verify', async () => {
    const center = { lat: 19.076, lon: 72.8777 };
    const unsigned: UnsignedBroadcastQuery = {
      v: 1,
      query_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHJP',
      revision: 2,
      key_id: testKeyId,
      issued_at: 1789900000,
      expires_at: 1789900000 + 86_400,
      center,
      radius_m: 250,
      window: { from: 1789880000, to: 1789883600 },
      cells: searchAreaCells(center, 250),
      person: { name: 'Sam Okafor', description: '' },
      reporter_phone: '+2348012345678',
      respond: { endpoint: 'https://api.findmyperson.example/v1/responses' },
    };
    const query = await signDocument('query', unsigned, testKey.sign);
    const shard = shardCellOf(matchCellAt(center));
    const bundle = await signDocument(
      'bundle',
      { v: 1, shard, generation: 1, key_id: testKeyId, issued_at: 1789900001, queries: [query] },
      testKey.sign,
    );
    expect(ShardBundleSchema.safeParse(bundle).success).toBe(true);

    const overTheWire: unknown = JSON.parse(JSON.stringify(bundle));
    const result = await read(overTheWire);
    expect(result?.queries[0]?.query).toEqual(query);
  });
});

describe('paths', () => {
  test('match the layout in plan 2.1', () => {
    expect(SHARD_INDEX_PATH).toBe('/index.json');
    expect(shardBundlePath('8560145bfffffff', 12)).toBe('/shards/8560145bfffffff/12.json');
  });
});
