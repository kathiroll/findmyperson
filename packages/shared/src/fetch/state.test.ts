import { afterEach, beforeEach, expect, test } from 'vitest';
import { migrate } from '../store/migrations';
import {
  KV_KEYS,
  kvListByPrefix,
  kvSet,
  SHARD_GENERATION_KEY_PREFIX,
  shardGenerationKey,
} from '../store/tables/kv';
import { openMemoryDb } from '../testing/memoryDb';
import {
  dropShardState,
  loadFetchState,
  saveBackoff,
  saveCoverSeed,
  saveIndex,
  saveLastCompleted,
  saveShardState,
} from './state';

const R5 = '8560145bfffffff';
const R3 = '836014fffffffff';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

test('a store that has never fetched holds nothing', async () => {
  expect(await loadFetchState(db)).toEqual({
    indexIssuedAt: null,
    indexCache: null,
    coverSeed: null,
    backoff: null,
    lastCompleted: null,
    shards: new Map(),
  });
});

test('what is saved is what the next cycle loads', async () => {
  const seed = '00112233445566778899aabbccddeeff';
  await saveCoverSeed(db, seed);
  await saveIndex(db, { etag: '"i"', document: { v: 1, shards: {} } }, 1_789_900_000);
  await saveBackoff(db, { failures: 2, retry_at: 1_789_900_120 });
  await saveLastCompleted(db, { at: 1_789_900_000, deferred: 3 });
  await saveShardState(db, R5, { generation: 4, etag: '"b"', query_ids: ['A', 'B'] });
  await saveShardState(db, R3, { generation: 1, etag: null, query_ids: [] });

  expect(await loadFetchState(db)).toEqual({
    indexIssuedAt: 1_789_900_000,
    indexCache: { etag: '"i"', document: { v: 1, shards: {} } },
    coverSeed: seed,
    backoff: { failures: 2, retry_at: 1_789_900_120 },
    lastCompleted: { at: 1_789_900_000, deferred: 3 },
    shards: new Map([
      [R3, { generation: 1, etag: null, query_ids: [] }],
      [R5, { generation: 4, etag: '"b"', query_ids: ['A', 'B'] }],
    ]),
  });

  await saveBackoff(db, null);
  await dropShardState(db, R3);
  const after = await loadFetchState(db);
  expect(after.backoff).toBeNull();
  expect([...after.shards.keys()]).toEqual([R5]);
});

test('a row that does not read back as its shape counts as absent', async () => {
  await kvSet(db, KV_KEYS.fetchIndexIssuedAt, 'yesterday');
  await kvSet(db, KV_KEYS.fetchIndexCache, '{"etag":');
  await kvSet(db, KV_KEYS.fetchCoverSeed, 'not hex');
  await kvSet(db, KV_KEYS.fetchBackoff, '{"failures":0,"retry_at":5}');
  await kvSet(db, KV_KEYS.fetchLastCompleted, '[]');
  // The value of an earlier layout (a bare generation), a cell that is no shard, and junk.
  await kvSet(db, shardGenerationKey(R5), '4');
  await kvSet(
    db,
    shardGenerationKey('8760145b4ffffff'),
    '{"generation":1,"etag":null,"query_ids":[]}',
  );
  await kvSet(db, shardGenerationKey(R3), 'junk');

  expect(await loadFetchState(db)).toEqual({
    indexIssuedAt: null,
    indexCache: null,
    coverSeed: null,
    backoff: null,
    lastCompleted: null,
    shards: new Map(),
  });
});

test('kvListByPrefix returns the rows under a prefix, sorted, and no others', async () => {
  await kvSet(db, shardGenerationKey(R5), 'b');
  await kvSet(db, shardGenerationKey(R3), 'a');
  await kvSet(db, KV_KEYS.fetchCoverSeed, 'c');
  await kvSet(db, 'fetch.shard_generationX', 'd');
  expect(await kvListByPrefix(db, SHARD_GENERATION_KEY_PREFIX)).toEqual([
    { key: shardGenerationKey(R3), value: 'a' },
    { key: shardGenerationKey(R5), value: 'b' },
  ]);
  expect(await kvListByPrefix(db, 'nothing.')).toEqual([]);
});
