import { describe, expect, test } from 'vitest';
import { matchCellAt, shardCellOf, signDocument, verifyDocument } from '@findmyperson/shared';
import { bundleKey } from './compiler';
import { KeyRing, ed25519Verify, generateSigningKey } from './keys';
import { BANGALORE, NOW, addReport, harness, testKey } from './testSupport';

const SWITCH = NOW + 7 * 86_400;
// Short enough that the test report (30 days) outlives it; a real overlap is much longer.
const OVERLAP_END = SWITCH + 14 * 86_400;

/** A rotation in progress: `old` signs until SWITCH and verifies until OVERLAP_END. */
const rotating = [
  { ...testKey('old', 1), verify_until: OVERLAP_END },
  { ...testKey('new', 2), sign_from: SWITCH },
];

const shard = shardCellOf(matchCellAt(BANGALORE));

describe('KeyRing', () => {
  test('the signer is the key with the latest sign_from that has been reached', () => {
    const ring = new KeyRing(rotating);
    expect(ring.signerAt(NOW).keyId).toBe('old');
    expect(ring.signerAt(SWITCH - 1).keyId).toBe('old');
    expect(ring.signerAt(SWITCH).keyId).toBe('new');
    expect(ring.signerAt(OVERLAP_END + 1).keyId).toBe('new');
  });

  test('both keys are trusted from the announcement to the end of the overlap', () => {
    const ring = new KeyRing(rotating);
    // Before the switch the new key is already trusted, so apps can pin it ahead of time.
    expect(Object.keys(ring.trustedAt(NOW)).sort()).toEqual(['new', 'old']);
    expect(Object.keys(ring.trustedAt(OVERLAP_END - 1)).sort()).toEqual(['new', 'old']);
    expect(Object.keys(ring.trustedAt(OVERLAP_END))).toEqual(['new']);
  });

  test('a signature made by each key verifies with its own public key only', async () => {
    const ring = new KeyRing(rotating);
    const signer = ring.signerAt(NOW);
    const signed = await signDocument('index', { key_id: signer.keyId, n: 1 }, signer.sign);
    expect(await verifyDocument('index', signed, ring.trustedAt(NOW), ed25519Verify)).toEqual({
      ok: true,
      keyId: 'old',
    });
    // The same key id bound to the other key's public half does not verify.
    const swapped = { old: ring.trustedAt(NOW)['new'] as Uint8Array };
    expect(await verifyDocument('index', signed, swapped, ed25519Verify)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a key with no seed verifies but never signs', () => {
    const { public_key: publicKey } = generateSigningKey('retired');
    const ring = new KeyRing([{ key_id: 'retired', public_key: publicKey }, testKey('live', 3)]);
    expect(ring.signerAt(NOW).keyId).toBe('live');
    expect(Object.keys(ring.trustedAt(NOW)).sort()).toEqual(['live', 'retired']);
    expect(() => new KeyRing([{ key_id: 'retired', public_key: publicKey }]).signerAt(NOW)).toThrow(
      /no signing key/,
    );
  });

  test('there is no signer once the only signing key has left its overlap', () => {
    const ring = new KeyRing([{ ...testKey('old', 1), verify_until: OVERLAP_END }]);
    expect(() => ring.signerAt(OVERLAP_END)).toThrow(/no signing key/);
  });

  test('a generated key round-trips through the config', async () => {
    const generated = generateSigningKey('k2026a');
    const ring = new KeyRing([generated]);
    const signer = ring.signerAt(NOW);
    const signed = await signDocument('bundle', { key_id: 'k2026a' }, signer.sign);
    expect((await verifyDocument('bundle', signed, ring.trustedAt(NOW), ed25519Verify)).ok).toBe(
      true,
    );
  });

  test('refuses a config a rotation could trip over, without echoing a seed', () => {
    const key = testKey('k1', 1);
    const other = generateSigningKey('other');
    expect(() => new KeyRing([])).toThrow(/signing key config/);
    expect(() => new KeyRing([key, key])).toThrow(/appears twice/);
    expect(() => new KeyRing([key, testKey('k2', 2)])).toThrow(/share sign_from/);
    expect(() => new KeyRing([{ ...key, public_key: other.public_key }])).toThrow(
      /does not belong to the seed/,
    );
    expect(() => new KeyRing([{ key_id: 'k1' }])).toThrow(/seed or a public_key/);
    let message = '';
    try {
      new KeyRing([{ key_id: 'Not Valid', seed: key.seed }]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/signing key config/);
    expect(message).not.toContain(key.seed);
  });
});

describe('rotation, as the compiler and a device see it', () => {
  test('old and new keys both verify during the overlap; the old one stops after it', async () => {
    const h = harness(rotating);
    addReport(h.db);

    const before = await h.compile();
    expect(before.keyId).toBe('old');
    const oldBundle = await h.store.get(bundleKey(shard, 1));
    expect((await h.bundle(shard, 1))?.bundle.key_id).toBe('old');

    // The switch: everything is re-signed by the new key, so each shard moves up once.
    h.clock.now = SWITCH;
    const after = await h.compile();
    expect(after.keyId).toBe('new');
    expect(after.shards[shard]).toBe(2);
    const fresh = await h.bundle(shard, 2);
    expect(fresh?.bundle.key_id).toBe('new');
    expect(fresh?.queries.map((entry) => entry.query.key_id)).toEqual(['new']);
    expect((await h.index())?.key_id).toBe('new');

    // And not again: the generation is stable for the rest of the overlap and beyond.
    for (const later of [SWITCH + 60, OVERLAP_END - 1, OVERLAP_END + 60]) {
      h.clock.now = later;
      expect(await h.compile()).toMatchObject({ changed: [], written: [], keyId: 'new' });
    }

    // During the overlap a device that pins both keys accepts a bundle signed by either.
    const during = h.keys.trustedAt(SWITCH + 60);
    const read = async (body: Uint8Array | null, trusted: typeof during) => {
      h.store.objects.set(bundleKey(shard, 99), body as Uint8Array);
      return h.bundle(shard, 99, trusted);
    };
    const newBundle = await h.store.get(bundleKey(shard, 2));
    expect((await read(oldBundle, during))?.queries).toHaveLength(1);
    expect((await read(newBundle, during))?.queries).toHaveLength(1);

    // After it, only the new key verifies.
    const afterOverlap = h.keys.trustedAt(OVERLAP_END);
    expect(await read(oldBundle, afterOverlap)).toBeNull();
    expect((await read(newBundle, afterOverlap))?.queries).toHaveLength(1);

    // An app that was never updated pins the old key alone and rejects the new bundles, which
    // is why the overlap has to start with an app release that pins both.
    const oldAppOnly = { old: during['old'] as Uint8Array };
    expect(await read(newBundle, oldAppOnly)).toBeNull();
  });
});
