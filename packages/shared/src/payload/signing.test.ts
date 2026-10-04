import { describe, expect, test } from 'vitest';
import fixture from '../../contracts/signing-vectors.json';
import { bytesToHex, ed25519FromSeed, ed25519Verify, hexToBytes } from '../testing/ed25519';
import {
  decodeSignature,
  encodeSignature,
  signDocument,
  signingInput,
  verifyDocument,
  type SignedKind,
  type TrustedKeys,
} from './signing';

const key = ed25519FromSeed(hexToBytes(fixture.seed_hex));
const trusted: TrustedKeys = { [fixture.key_id]: key.publicKey };
const documents = fixture.documents.map((entry) => ({
  kind: entry.kind as SignedKind,
  signingInputText: entry.signing_input,
  signed: entry.signed as Record<string, unknown> & { key_id: string; sig: string },
}));
const first = documents[0];
if (first === undefined) {
  throw new Error('the signing fixture is empty');
}

describe('golden vectors', () => {
  test('the test key is RFC 8032 test vector 1', () => {
    expect(bytesToHex(key.publicKey)).toBe(fixture.public_key_hex);
    expect(fixture.public_key_hex).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });

  test.each(documents)('$kind: signed bytes are exactly the recorded text', (doc) => {
    expect(new TextDecoder().decode(signingInput(doc.kind, doc.signed))).toBe(doc.signingInputText);
    expect(doc.signingInputText.startsWith(`findmyperson.${doc.kind}.v1\n{`)).toBe(true);
  });

  test.each(documents)('$kind: signing again reproduces the recorded signature', async (doc) => {
    const { sig, ...unsigned } = doc.signed;
    expect((await signDocument(doc.kind, unsigned, key.sign)).sig).toBe(sig);
  });

  test.each(documents)('$kind: verifies against the trusted key', async (doc) => {
    expect(await verifyDocument(doc.kind, doc.signed, trusted, ed25519Verify)).toEqual({
      ok: true,
      keyId: fixture.key_id,
    });
  });
});

describe('a query with two photos', () => {
  const photos = (first.signed.person as { photos: unknown[] }).photos;

  test('the first vector carries two, so every golden check above covers them', () => {
    expect(photos).toHaveLength(2);
    expect(first.signingInputText).toContain('"photos":[{"b64":');
  });

  test('signs, crosses the wire and verifies', async () => {
    const { sig, ...unsigned } = first.signed;
    const signed = await signDocument('query', { ...unsigned, revision: 2 }, key.sign);
    expect(signed.sig).not.toBe(sig);
    const received: unknown = JSON.parse(JSON.stringify(signed));
    expect(await verifyDocument('query', received, trusted, ed25519Verify)).toEqual({
      ok: true,
      keyId: fixture.key_id,
    });
    expect((received as typeof first.signed).person).toEqual(first.signed.person);
  });

  test.each([
    ['in the other order', [...photos].reverse()],
    ['with one dropped', photos.slice(0, 1)],
    ['with one repeated', [photos[0], photos[0]]],
  ])('the photos %s do not verify under the same signature', async (_label, changed) => {
    const person = { ...(first.signed.person as object), photos: changed };
    expect(
      await verifyDocument('query', { ...first.signed, person }, trusted, ed25519Verify),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('signingInput', () => {
  test('ignores `sig`, so signer and verifier compute the same bytes', () => {
    const { sig, ...unsigned } = first.signed;
    expect(sig).toBeDefined();
    expect(signingInput('query', unsigned)).toEqual(signingInput('query', first.signed));
  });

  test('covers key_id and members no schema knows', () => {
    const base = signingInput('query', first.signed);
    expect(signingInput('query', { ...first.signed, key_id: 'other' })).not.toEqual(base);
    expect(signingInput('query', { ...first.signed, extra: 1 })).not.toEqual(base);
  });
});

describe('verifyDocument', () => {
  const verifyQuery = (document: unknown, keys: TrustedKeys = trusted) =>
    verifyDocument('query', document, keys, ed25519Verify);

  test('survives a JSON round trip and any member order', async () => {
    const wire = JSON.stringify(first.signed);
    const reordered = Object.fromEntries(Object.entries(JSON.parse(wire) as object).reverse());
    expect((await verifyQuery(JSON.parse(wire))).ok).toBe(true);
    expect((await verifyQuery(reordered)).ok).toBe(true);
  });

  test.each([
    ['a changed phone number', { reporter_phone: '+15550000001' }],
    ['a changed centre', { center: { lat: 12.9717, lon: 77.5946 } }],
    ['a bumped revision', { revision: 2 }],
    ['an added member', { injected: true }],
  ])('rejects %s', async (_label, change) => {
    expect(await verifyQuery({ ...first.signed, ...change })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('rejects a removed member', async () => {
    const withoutPerson = Object.fromEntries(
      Object.entries(first.signed).filter(([name]) => name !== 'person'),
    );
    expect(await verifyQuery(withoutPerson)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('a signature for one kind does not verify as another kind', async () => {
    for (const kind of ['bundle', 'index'] as const) {
      expect(await verifyDocument(kind, first.signed, trusted, ed25519Verify)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  test('rejects a key the device does not trust', async () => {
    expect(await verifyQuery(first.signed, {})).toEqual({ ok: false, reason: 'unknown_key' });
    const otherKey = ed25519FromSeed(new Uint8Array(32).fill(7)).publicKey;
    expect(await verifyQuery(first.signed, { [fixture.key_id]: otherKey })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('a key id naming an Object.prototype member finds no key', async () => {
    const forged = { ...first.signed, key_id: 'constructor' };
    expect(await verifyQuery(forged)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  test('rejects a trusted key of the wrong length', async () => {
    const short = { [fixture.key_id]: key.publicKey.slice(0, 31) };
    expect(await verifyQuery(first.signed, short)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['an array', [first.signed]],
    ['a string', JSON.stringify(first.signed)],
    ['no sig', { ...first.signed, sig: undefined }],
    [
      'a sig with the wrong prefix',
      { ...first.signed, sig: first.signed.sig.replace('ed25519', 'rsa') },
    ],
    ['a truncated sig', { ...first.signed, sig: first.signed.sig.slice(0, -1) }],
    ['a padded sig', { ...first.signed, sig: `${first.signed.sig}=` }],
    ['no key_id', { ...first.signed, key_id: undefined }],
    ['a key_id that is not an id', { ...first.signed, key_id: 'Test 2026' }],
  ])('reports %s as malformed without throwing', async (_label, document) => {
    expect(await verifyQuery(document)).toEqual({ ok: false, reason: 'malformed' });
  });

  test('treats a verifier that throws as a failed check', async () => {
    const throwing = () => {
      throw new Error('native crypto unavailable');
    };
    expect(await verifyDocument('query', first.signed, trusted, throwing)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  test('accepts an asynchronous verifier', async () => {
    const result = await verifyDocument('query', first.signed, trusted, async (...args) =>
      ed25519Verify(...args),
    );
    expect(result.ok).toBe(true);
  });
});

describe('signDocument', () => {
  test('keeps every member and adds only `sig`', async () => {
    const signed = await signDocument('index', { key_id: 'k1', v: 1, shards: {} }, key.sign);
    expect(Object.keys(signed).sort()).toEqual(['key_id', 'shards', 'sig', 'v']);
    expect(await verifyDocument('index', signed, { k1: key.publicKey }, ed25519Verify)).toEqual({
      ok: true,
      keyId: 'k1',
    });
  });

  test('refuses a key id that a verifier would reject', async () => {
    await expect(signDocument('index', { key_id: 'Bad Id' }, key.sign)).rejects.toThrow(RangeError);
  });

  test('refuses a document that is not JSON data', async () => {
    await expect(
      signDocument('index', { key_id: 'k1', when: new Date(0) }, key.sign),
    ).rejects.toThrow('$.when');
  });
});

describe('signature encoding', () => {
  test('round-trips 64 bytes', () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);
    const sig = encodeSignature(bytes);
    expect(sig).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
    expect(decodeSignature(sig)).toEqual(bytes);
  });

  test('refuses to encode anything but 64 bytes', () => {
    expect(() => encodeSignature(new Uint8Array(63))).toThrow(RangeError);
  });

  test('two different sig strings never decode to the same bytes', () => {
    // The last base64url character of a 64-byte value carries 4 unused bits.
    const sig = encodeSignature(new Uint8Array(64));
    expect(sig.endsWith('A')).toBe(true);
    expect(decodeSignature(`${sig.slice(0, -1)}B`)).toBeNull();
  });
});
