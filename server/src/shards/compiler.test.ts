import { describe, expect, test } from 'vitest';
import {
  H3_RES_PUSH,
  H3_RES_SHARD,
  isH3Cell,
  matchCellAt,
  pushCellOf,
  readShardBundle,
  readShardIndex,
  shardBundlePath,
  shardCellOf,
  signDocument,
  type PersonPhoto,
} from '@findmyperson/shared';
import { BUNDLE_KEY_PREFIX, INDEX_KEY, bundleKey } from './compiler';
import { KeyRing, ed25519Verify } from './keys';
import {
  BANGALORE,
  MUMBAI,
  NOW,
  addReport,
  harness,
  parse,
  pointOnShardEdge,
  shardsOf,
  testKey,
} from './testSupport';

const bangaloreShard = shardCellOf(matchCellAt(BANGALORE));
const bangaloreRegion = pushCellOf(bangaloreShard);
const mumbaiShard = shardCellOf(matchCellAt(MUMBAI));

describe('what is published', () => {
  test('one signed bundle per res-5 and res-3 shard, and a signed index that lists them all', async () => {
    const h = harness();
    const queryId = addReport(h.db, { radius_m: 100 });
    const result = await h.compile();

    const { r5, r3 } = shardsOf(BANGALORE, 100);
    expect(r5).toHaveLength(1);
    expect(r3).toHaveLength(1);
    expect(isH3Cell(r5[0], H3_RES_SHARD)).toBe(true);
    expect(isH3Cell(r3[0], H3_RES_PUSH)).toBe(true);
    expect(result.shards).toEqual({ [r5[0] as string]: 1, [r3[0] as string]: 1 });

    for (const shard of [...r5, ...r3]) {
      const bundle = await h.bundle(shard, 1);
      expect(bundle?.bundle).toMatchObject({ shard, generation: 1, key_id: 'k1', issued_at: NOW });
      expect(bundle?.skipped).toBe(0);
      expect(bundle?.queries.map((entry) => entry.query.query_id)).toEqual([queryId]);
    }
    const index = await h.index();
    expect(index?.shards).toEqual(result.shards);
    expect(index?.key_id).toBe('k1');
    // The store holds exactly the index and the bundles it names, at the shared paths.
    const bundleKeys = [...r5, ...r3].map((shard) => shardBundlePath(shard, 1).slice(1));
    expect(await h.store.list('')).toEqual([INDEX_KEY, ...bundleKeys].sort());
    // A bundle path never changes its bytes, so it may be cached for good; the index may not.
    expect(h.store.options.get(INDEX_KEY)).toEqual({
      contentType: 'application/json',
      cacheControl: 'public, max-age=60',
    });
    for (const key of bundleKeys) {
      expect(h.store.options.get(key)?.cacheControl).toBe('public, max-age=31536000, immutable');
    }
  });

  test('the query carries the report as released, and nothing a device must fetch later', async () => {
    const h = harness();
    const queryId = addReport(h.db, { radius_m: 250 });
    await h.compile();
    const row = h.db.getReport(queryId);
    const query = (await h.bundle(bangaloreShard, 1))?.queries[0]?.query;
    expect(query).toMatchObject({
      v: 1,
      query_id: queryId,
      revision: 1,
      key_id: 'k1',
      issued_at: row?.updated_at,
      expires_at: row?.expires_at,
      center: BANGALORE,
      radius_m: 250,
      person: { name: 'Alex Rivera', description: 'Blue jacket.' },
      reporter_phone: '+15550000000',
      respond: { endpoint: 'https://api.findmyperson.example/v1/responses' },
    });
    expect(query?.cells).toContain(matchCellAt(BANGALORE));
  });

  test('both photos of a report are inside its signed query, in the order sent', async () => {
    const h = harness();
    const photos: PersonPhoto[] = [
      { mime: 'image/webp', w: 256, h: 192, b64: 'AAAA' },
      { mime: 'image/jpeg', w: 192, h: 256, b64: 'BBBB' },
    ];
    const person = { name: 'Alex Rivera', description: 'Blue jacket.', photos };
    const withTwo = addReport(h.db, { person });
    const withNone = addReport(h.db);
    await h.compile();
    // h.bundle verifies the bundle and each query against the published key.
    const queries = (await h.bundle(bangaloreShard, 1))?.queries ?? [];
    const personOf = (id: string) => queries.find((entry) => entry.query.query_id === id)?.raw;
    expect(personOf(withTwo)?.['person']).toEqual(person);
    expect(personOf(withNone)?.['person']).toEqual({
      name: 'Alex Rivera',
      description: 'Blue jacket.',
    });

    // Dropping one is a change of contents: the shard moves to a new generation.
    const row = h.db.getReport(withTwo)!;
    h.db.updateReportCriteria(
      withTwo,
      1,
      {
        center: row.center,
        radius_m: row.radius_m,
        window: row.window,
        person: { ...person, photos: photos.slice(1) },
      },
      NOW + 1,
    );
    h.clock.now = NOW + 2;
    expect((await h.compile()).shards[bangaloreShard]).toBe(2);
    const after = (await h.bundle(bangaloreShard, 2))?.queries ?? [];
    expect(after.find((entry) => entry.query.query_id === withTwo)?.query.person.photos).toEqual(
      photos.slice(1),
    );
  });

  test('with no released reports the index is published, signed and empty', async () => {
    const h = harness();
    const result = await h.compile();
    expect(result).toMatchObject({ reports: 0, shards: {}, indexWritten: true });
    expect((await h.index())?.shards).toEqual({});
    expect(await h.store.list(BUNDLE_KEY_PREFIX)).toEqual([]);
  });
});

describe('the manual-review gate', () => {
  test('pending, rejected, ended and expired reports never reach a bundle', async () => {
    const h = harness();
    const released = addReport(h.db);
    const hidden = [addReport(h.db, { state: 'pending' }), addReport(h.db, { state: 'rejected' })];
    const ended = addReport(h.db);
    h.db.setReportStatus(ended, 'ended', NOW - 10);
    // Released and still marked active, but past its expiry.
    const expired = addReport(h.db, { created_at: NOW - 40 * 86_400 });
    hidden.push(ended, expired);

    const result = await h.compile();
    expect(result.reports).toBe(1);
    const published = [...h.store.objects.values()]
      .map((body) => Buffer.from(body).toString('utf8'))
      .join('\n');
    expect(published).toContain(released);
    for (const queryId of hidden) {
      expect(published).not.toContain(queryId);
    }
  });

  test('a pending report appears only after release, and leaves when it ends', async () => {
    const h = harness();
    const queryId = addReport(h.db, { state: 'pending' });
    expect((await h.compile()).shards).toEqual({});

    h.db.setReviewState(queryId, 'released', 'operator', NOW);
    expect((await h.compile()).shards[bangaloreShard]).toBe(1);
    const path = `/${bundleKey(bangaloreShard, 1)}`;

    h.db.setReportStatus(queryId, 'ended', NOW + 5);
    h.clock.now = NOW + 10;
    const after = await h.compile();
    expect(after.shards).toEqual({});
    expect(after.removed).toContain(bangaloreShard);
    // The bundle that carried the reporter's number is gone from the store and from the CDN.
    expect(await h.store.list(BUNDLE_KEY_PREFIX)).toEqual([]);
    expect(after.invalidated).toContain(path);
    expect(after.invalidated).toContain('/index.json');
    expect((await h.index())?.shards).toEqual({});
  });

  test('a report expires out of its shard without anyone ending it', async () => {
    const h = harness();
    const queryId = addReport(h.db);
    await h.compile();
    h.clock.now = (h.db.getReport(queryId)?.expires_at ?? 0) + 1;
    expect((await h.compile()).shards).toEqual({});
  });

  test('a report that cannot be written as a valid query is left out; the rest publish', async () => {
    const h = harness();
    const good = addReport(h.db);
    // Not reachable through intake, which validates; a row like this means a bug upstream.
    const bad = addReport(h.db, { person: { name: '', description: '' } });
    const photo: PersonPhoto = { mime: 'image/webp', w: 1, h: 1, b64: 'AAAA' };
    const tooMany = addReport(h.db, {
      person: { name: 'Alex Rivera', description: '', photos: [photo, photo, photo] },
    });
    const result = await h.compile();
    expect(result.skipped).toEqual([bad, tooMany]);
    expect(
      (await h.bundle(bangaloreShard, 1))?.queries.map((entry) => entry.query.query_id),
    ).toEqual([good]);
  });
});

describe('a report near a shard edge', () => {
  test('appears in both adjacent res-5 shards', async () => {
    const h = harness();
    const edge = pointOnShardEdge(BANGALORE);
    const { r5 } = shardsOf(edge, 0);
    // The point is in one shard; its 150 m match disc reaches into the next.
    expect(r5.length).toBeGreaterThanOrEqual(2);
    expect(r5).toContain(shardCellOf(matchCellAt(edge)));

    const queryId = addReport(h.db, { center: edge, radius_m: 0 });
    const result = await h.compile();
    for (const shard of r5) {
      expect(result.shards[shard]).toBe(1);
      const bundle = await h.bundle(shard, 1);
      expect(bundle?.queries.map((entry) => entry.query.query_id)).toEqual([queryId]);
    }
  });

  test('a report well inside a shard appears in that res-5 shard only', async () => {
    const h = harness();
    addReport(h.db, { radius_m: 100 });
    const result = await h.compile();
    const res5 = Object.keys(result.shards).filter((shard) => isH3Cell(shard, H3_RES_SHARD));
    expect(res5).toEqual([bangaloreShard]);
  });

  test('two reports that share a shard are both in its bundle, in a stable order', async () => {
    const h = harness();
    const first = addReport(h.db);
    const second = addReport(h.db);
    const elsewhere = addReport(h.db, { center: MUMBAI });
    await h.compile();
    expect(
      (await h.bundle(bangaloreShard, 1))?.queries.map((entry) => entry.query.query_id),
    ).toEqual([first, second]);
    expect((await h.bundle(mumbaiShard, 1))?.queries.map((entry) => entry.query.query_id)).toEqual([
      elsewhere,
    ]);
  });
});

describe('verification', () => {
  async function published() {
    const h = harness();
    addReport(h.db);
    await h.compile();
    const trusted = h.keys.trustedAt(NOW);
    const bundle = parse((await h.store.get(bundleKey(bangaloreShard, 1))) as Uint8Array);
    const index = parse((await h.store.get(INDEX_KEY)) as Uint8Array);
    return { trusted, bundle, index };
  }
  const readBundle = (raw: unknown, trusted: Parameters<typeof readShardBundle>[1]) =>
    readShardBundle(raw, trusted, ed25519Verify);

  test('the bundle and index as published verify', async () => {
    const { trusted, bundle, index } = await published();
    expect(await readBundle(bundle, trusted)).not.toBeNull();
    expect(await readShardIndex(index, trusted, ed25519Verify)).not.toBeNull();
  });

  test('a tampered bundle fails verification', async () => {
    const { trusted, bundle } = await published();
    const query = (bundle.queries as Record<string, unknown>[])[0];
    const tampered: unknown[] = [
      // An attacker's number in place of the reporter's.
      { ...bundle, queries: [{ ...query, reporter_phone: '+15559999999' }] },
      // A report removed, added, or the envelope altered.
      { ...bundle, queries: [] },
      { ...bundle, queries: [query, query] },
      { ...bundle, generation: 2 },
      { ...bundle, shard: mumbaiShard },
      { ...bundle, issued_at: NOW + 1 },
      // No signature, or someone else's.
      { ...bundle, sig: undefined },
      { ...bundle, sig: (query as { sig: string }).sig },
    ];
    for (const raw of tampered) {
      expect(await readBundle(JSON.parse(JSON.stringify(raw)), trusted)).toBeNull();
    }
  });

  test('a bundle re-signed by a key the device does not trust fails verification', async () => {
    const { trusted, bundle } = await published();
    const attacker = new KeyRing([testKey('k1', 66)]).signerAt(NOW);
    const unsigned = Object.fromEntries(Object.entries(bundle).filter(([name]) => name !== 'sig'));
    const forged = await signDocument('bundle', { ...unsigned, key_id: 'k1' }, attacker.sign);
    expect(await readBundle(forged, trusted)).toBeNull();
    expect(await readBundle(bundle, {})).toBeNull();
  });

  test('a tampered index fails verification, and a bundle is not accepted as an index', async () => {
    const { trusted, bundle, index } = await published();
    const read = (raw: unknown) => readShardIndex(raw, trusted, ed25519Verify);
    expect(await read({ ...index, shards: { [bangaloreShard]: 9 } })).toBeNull();
    expect(await read({ ...index, shards: {} })).toBeNull();
    expect(await read({ ...index, issued_at: NOW + 100 })).toBeNull();
    expect(await read(bundle)).toBeNull();
  });
});

describe('generations', () => {
  test('a pass that finds nothing changed writes nothing and keeps every generation', async () => {
    const h = harness();
    addReport(h.db);
    addReport(h.db, { center: MUMBAI });
    const first = await h.compile();
    const bytes = new Map(h.store.objects);
    const puts = h.store.puts.length;
    const purges = h.cdn.calls.length;

    // Later passes, hours apart, with the same reports.
    for (const later of [NOW + 60, NOW + 3_600, NOW + 86_400]) {
      h.clock.now = later;
      const again = await h.compile();
      expect(again.shards).toEqual(first.shards);
      expect(again).toMatchObject({
        changed: [],
        removed: [],
        written: [],
        deleted: [],
        invalidated: [],
        indexWritten: false,
      });
    }
    expect(h.store.puts).toHaveLength(puts);
    expect(h.store.deletes).toEqual([]);
    expect(h.cdn.calls).toHaveLength(purges);
    // Byte for byte what the first pass wrote, index.json included (same ETag for a device).
    expect(h.store.objects).toEqual(bytes);
  });

  test('only the shards whose contents changed move, by one', async () => {
    const h = harness();
    addReport(h.db);
    addReport(h.db, { center: MUMBAI });
    const first = await h.compile();
    const mumbaiBefore = await h.store.get(bundleKey(mumbaiShard, 1));

    addReport(h.db);
    h.clock.now = NOW + 60;
    const second = await h.compile();
    expect(second.changed.sort()).toEqual([bangaloreShard, bangaloreRegion].sort());
    expect(second.shards[bangaloreShard]).toBe(2);
    expect(second.shards[bangaloreRegion]).toBe(2);
    expect(second.shards[mumbaiShard]).toBe(first.shards[mumbaiShard]);
    expect(await h.store.get(bundleKey(mumbaiShard, 1))).toEqual(mumbaiBefore);
    // The superseded generation is deleted and purged; the new one is a new path.
    expect(second.deleted.sort()).toEqual(
      [bundleKey(bangaloreShard, 1), bundleKey(bangaloreRegion, 1)].sort(),
    );
    expect(second.invalidated.sort()).toEqual(
      ['/index.json', ...second.deleted.map((key) => `/${key}`)].sort(),
    );
    expect((await h.bundle(bangaloreShard, 2))?.queries).toHaveLength(2);
    expect((await h.index())?.shards).toEqual(second.shards);
  });

  test('a widening edit is a change of contents', async () => {
    const h = harness();
    const queryId = addReport(h.db, { radius_m: 100 });
    await h.compile();
    const row = h.db.getReport(queryId);
    h.db.updateReportCriteria(
      queryId,
      1,
      { center: BANGALORE, radius_m: 400, window: row!.window, person: row!.person },
      NOW + 30,
    );
    h.clock.now = NOW + 60;
    const result = await h.compile();
    expect(result.shards[bangaloreShard]).toBe(2);
    const query = (await h.bundle(bangaloreShard, 2))?.queries[0]?.query;
    expect(query).toMatchObject({ revision: 2, radius_m: 400, issued_at: NOW + 30 });
  });

  test('a shard that empties and fills again continues its numbering', async () => {
    const h = harness();
    const first = addReport(h.db);
    await h.compile();
    h.db.setReportStatus(first, 'ended', NOW + 5);
    h.clock.now = NOW + 60;
    expect((await h.compile()).shards).toEqual({});

    addReport(h.db);
    h.clock.now = NOW + 120;
    const result = await h.compile();
    // Never 1 again: a device may still hold generation 1 and would not fetch a second one.
    expect(result.shards[bangaloreShard]).toBe(2);
    expect(await h.store.list(BUNDLE_KEY_PREFIX)).toEqual(
      [bundleKey(bangaloreShard, 2), bundleKey(bangaloreRegion, 2)].sort(),
    );
  });

  test('each new index is issued later than the last, even if the clock steps back', async () => {
    const h = harness();
    addReport(h.db);
    await h.compile();
    const first = (await h.index())?.issued_at ?? 0;
    addReport(h.db);
    h.clock.now = NOW - 500;
    await h.compile();
    expect((await h.index())?.issued_at).toBeGreaterThan(first);
  });
});

describe('repair', () => {
  test('a bundle or index lost from the store is written again with the same bytes', async () => {
    const h = harness();
    addReport(h.db);
    const first = await h.compile();
    const bytes = new Map(h.store.objects);
    h.store.objects.delete(bundleKey(bangaloreShard, 1));
    h.store.objects.delete(INDEX_KEY);

    h.clock.now = NOW + 600;
    const second = await h.compile();
    expect(second.shards).toEqual(first.shards);
    expect(second.changed).toEqual([]);
    expect(second.written.sort()).toEqual([INDEX_KEY, bundleKey(bangaloreShard, 1)].sort());
    expect(h.store.objects).toEqual(bytes);
  });

  test('an object the index does not name is deleted', async () => {
    const h = harness();
    addReport(h.db);
    await h.compile();
    // Left behind by a pass that died before it wrote its index.
    const stray = bundleKey(bangaloreShard, 7);
    h.store.objects.set(stray, new Uint8Array([1]));
    const result = await h.compile();
    expect(result.deleted).toEqual([stray]);
    expect(await h.store.get(stray)).toBeNull();
  });

  test('a failed CDN invalidation does not undo the publish and is retried', async () => {
    const h = harness();
    addReport(h.db);
    h.cdn.failing = true;
    const first = await h.compile();
    expect(first.invalidated).toEqual([]);
    expect(first.cdnPending).toEqual(['/index.json']);
    expect((await h.index())?.shards).toEqual(first.shards);

    // Nothing else changed, and the invalidation still goes out.
    h.cdn.failing = false;
    const second = await h.compile();
    expect(second).toMatchObject({ written: [], invalidated: ['/index.json'], cdnPending: [] });
    expect((await h.compile()).invalidated).toEqual([]);
  });
});
