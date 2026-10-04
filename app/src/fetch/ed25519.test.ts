import { createHash } from 'node:crypto';
import {
  decodeSignature,
  readShardBundle,
  readShardIndex,
  utf8Encode,
  verifyDocument,
  type SignedKind,
} from '@findmyperson/shared';
import signing from '@findmyperson/shared/contracts/signing-vectors.json';
import {
  bytesToHex,
  ed25519FromSeed,
  ed25519Verify as nodeVerify,
  hexToBytes,
} from '@findmyperson/shared/src/testing/ed25519';
import nacl from 'tweetnacl';
import { describe, expect, test } from 'vitest';
import { ed25519Verify } from './ed25519';

/**
 * The device's Ed25519 verify against signatures known to be good and known to be bad. It runs
 * here under Node; the code under test is plain JavaScript and is the code Hermes runs.
 *
 * Node's crypto is the reference throughout: it is what the shard compiler signs with
 * (server/src/shards/keys.ts), so "the device accepts what the server signs and nothing else"
 * is checked against the server's own primitive.
 */

/** RFC 8032, section 7.1: TEST 1, TEST 2, TEST 3 and TEST SHA(abc). */
const RFC_8032 = [
  {
    name: 'TEST 1 (empty message)',
    seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    message: '',
    signature:
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'TEST 2 (one byte)',
    seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    message: '72',
    signature:
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
  {
    name: 'TEST 3 (two bytes)',
    seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
    publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    message: 'af82',
    signature:
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
  },
  {
    name: 'TEST SHA(abc)',
    seed: '833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42',
    publicKey: 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
    message:
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    signature:
      'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704',
  },
] as const;

/** L, the order of the base point (RFC 8032, 5.1). */
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

const littleEndian = (bytes: Uint8Array) =>
  bytes.reduceRight((value, byte) => (value << 8n) | BigInt(byte), 0n);

/** The same signature with `add` added to its S: R is the first half, S the second. */
function withScalarPlus(signature: Uint8Array, add: bigint): Uint8Array {
  let s = littleEndian(signature.subarray(32)) + add;
  const out = Uint8Array.from(signature);
  for (let i = 32; i < 64; i++) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  expect(s).toBe(0n);
  return out;
}

function flipBit(bytes: Uint8Array, bit: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[bit >> 3] = (out[bit >> 3] ?? 0) ^ (1 << (bit & 7));
  return out;
}

/** Bytes that depend only on `label`, any length. */
function bytesOf(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let offset = 0, block = 0; offset < length; offset += 32, block++) {
    out.set(
      createHash('sha256')
        .update(`${label}:${block}`)
        .digest()
        .subarray(0, length - offset),
      offset,
    );
  }
  return out;
}

const publisher = ed25519FromSeed(hexToBytes(signing.seed_hex));
const someMessage = utf8Encode('findmyperson.index.v1\n{"issued_at":1789900100}');

describe('signatures known to be good', () => {
  test.each(RFC_8032)('RFC 8032 $name', async ({ seed, publicKey, message, signature }) => {
    // The vector is what it claims to be: the reference signer reproduces it, bit for bit.
    const reference = ed25519FromSeed(hexToBytes(seed));
    expect(bytesToHex(reference.publicKey)).toBe(publicKey);
    expect(bytesToHex(await reference.sign(hexToBytes(message)))).toBe(signature);

    expect(ed25519Verify(hexToBytes(publicKey), hexToBytes(message), hexToBytes(signature))).toBe(
      true,
    );
  });

  test('every document of the repo’s signing vectors, byte for byte', () => {
    const publicKey = hexToBytes(signing.public_key_hex);
    expect(signing.documents.map((entry) => entry.kind)).toEqual([
      'query',
      'query',
      'bundle',
      'index',
    ]);
    for (const { signing_input, signed } of signing.documents) {
      const signature = decodeSignature(signed.sig);
      expect(signature).not.toBeNull();
      expect(ed25519Verify(publicKey, utf8Encode(signing_input), signature!)).toBe(true);
    }
  });

  test('those documents verify through the signing scheme the fetcher uses', async () => {
    const trusted = { [signing.key_id]: hexToBytes(signing.public_key_hex) };
    for (const { kind, signed } of signing.documents) {
      expect(await verifyDocument(kind as SignedKind, signed, trusted, ed25519Verify)).toEqual({
        ok: true,
        keyId: signing.key_id,
      });
    }
    const [, , bundle, index] = signing.documents;
    expect((await readShardBundle(bundle?.signed, trusted, ed25519Verify))?.queries).toHaveLength(
      2,
    );
    expect(await readShardIndex(index?.signed, trusted, ed25519Verify)).not.toBeNull();
  });

  test('whatever the server’s signer signs, of any length, from any key', async () => {
    const lengths = [0, 1, 2, 31, 32, 33, 63, 64, 65, 111, 112, 127, 128, 129, 1_000, 70_000];
    for (const [n, length] of lengths.entries()) {
      const key = ed25519FromSeed(bytesOf(`seed ${n}`, 32));
      const message = bytesOf(`message ${n}`, length);
      const signature = await key.sign(message);
      expect(ed25519Verify(key.publicKey, message, signature), `${length} bytes`).toBe(true);
      // A Buffer is bytes too: it is what Node hands back, and a Uint8Array underneath.
      expect(ed25519Verify(Buffer.from(key.publicKey), Buffer.from(message), signature)).toBe(true);
    }
  });
});

describe('signatures known to be bad', () => {
  test('any one bit changed, in the signature, the message or the key', async () => {
    const signature = await publisher.sign(someMessage);
    expect(ed25519Verify(publisher.publicKey, someMessage, signature)).toBe(true);

    // Bits spread over the whole signature: R is the first 256, S the rest. Not every bit:
    // each verification takes milliseconds.
    for (let bit = 0; bit < 512; bit += 9) {
      const changed = flipBit(signature, bit);
      expect(ed25519Verify(publisher.publicKey, someMessage, changed), `signature bit ${bit}`).toBe(
        false,
      );
    }
    for (let bit = 0; bit < someMessage.length * 8; bit += 29) {
      expect(ed25519Verify(publisher.publicKey, flipBit(someMessage, bit), signature)).toBe(false);
    }
    for (let bit = 0; bit < 256; bit += 9) {
      const changed = flipBit(publisher.publicKey, bit);
      expect(ed25519Verify(changed, someMessage, signature), `key bit ${bit}`).toBe(false);
    }
  }, 30_000);

  test('a good signature by somebody else, or for something else', async () => {
    const stranger = ed25519FromSeed(bytesOf('a stranger', 32));
    const forged = await stranger.sign(someMessage);
    expect(ed25519Verify(stranger.publicKey, someMessage, forged)).toBe(true);
    expect(ed25519Verify(publisher.publicKey, someMessage, forged)).toBe(false);

    const other = utf8Encode('findmyperson.bundle.v1\n{"issued_at":1789900100}');
    expect(ed25519Verify(publisher.publicKey, other, await publisher.sign(someMessage))).toBe(
      false,
    );
    // A message that only gained or lost a byte.
    const signature = await publisher.sign(someMessage);
    expect(ed25519Verify(publisher.publicKey, someMessage.subarray(1), signature)).toBe(false);
    expect(
      ed25519Verify(publisher.publicKey, Uint8Array.from([...someMessage, 0]), signature),
    ).toBe(false);
  });

  test('the same signature with the group order added to S, which tweetnacl alone would take', async () => {
    const signature = await publisher.sign(someMessage);
    const second = withScalarPlus(signature, GROUP_ORDER);
    expect(second).not.toEqual(signature);

    // Without the added rule this is a second valid signature for the same message.
    expect(nacl.sign.detached.verify(someMessage, second, publisher.publicKey)).toBe(true);
    // With it the device says what the server's primitive says.
    expect(await nodeVerify(publisher.publicKey, someMessage, second)).toBe(false);
    expect(ed25519Verify(publisher.publicKey, someMessage, second)).toBe(false);

    for (const { publicKey, message, signature: vector } of RFC_8032) {
      const malleated = withScalarPlus(hexToBytes(vector), GROUP_ORDER);
      expect(ed25519Verify(hexToBytes(publicKey), hexToBytes(message), malleated)).toBe(false);
    }
  });

  test('S at the group order exactly, and at the largest value 32 bytes hold', async () => {
    const signature = await publisher.sign(someMessage);
    const r = signature.subarray(0, 32);
    const order = withScalarPlus(Uint8Array.from([...r, ...new Uint8Array(32)]), GROUP_ORDER);
    const below = withScalarPlus(Uint8Array.from([...r, ...new Uint8Array(32)]), GROUP_ORDER - 1n);
    const full = Uint8Array.from([...r, ...new Uint8Array(32).fill(0xff)]);
    for (const candidate of [order, below, full]) {
      expect(ed25519Verify(publisher.publicKey, someMessage, candidate)).toBe(false);
      expect(await nodeVerify(publisher.publicKey, someMessage, candidate)).toBe(false);
    }
  });

  test('all zeroes, and a key that is not a point on the curve', async () => {
    const signature = await publisher.sign(someMessage);
    expect(ed25519Verify(publisher.publicKey, someMessage, new Uint8Array(64))).toBe(false);
    expect(ed25519Verify(new Uint8Array(32), someMessage, new Uint8Array(64))).toBe(false);
    // y = 2 has no x on the curve.
    const offCurve = Uint8Array.from([2, ...new Uint8Array(31)]);
    expect(ed25519Verify(offCurve, someMessage, signature)).toBe(false);
  });

  test('the wrong length, or not bytes at all: false, never an exception', async () => {
    const signature = await publisher.sign(someMessage);
    const key = publisher.publicKey;
    expect(ed25519Verify(key, someMessage, signature.subarray(0, 63))).toBe(false);
    expect(ed25519Verify(key, someMessage, Uint8Array.from([...signature, 0]))).toBe(false);
    expect(ed25519Verify(key, someMessage, new Uint8Array(0))).toBe(false);
    expect(ed25519Verify(key.subarray(0, 31), someMessage, signature)).toBe(false);
    expect(ed25519Verify(Uint8Array.from([...key, 0]), someMessage, signature)).toBe(false);
    expect(ed25519Verify(new Uint8Array(0), someMessage, signature)).toBe(false);

    const notBytes = [undefined, null, 'ed25519', 7, [1, 2, 3], {}, new ArrayBuffer(64)];
    for (const value of notBytes as unknown as Uint8Array[]) {
      expect(ed25519Verify(value, someMessage, signature)).toBe(false);
      expect(ed25519Verify(key, value, signature)).toBe(false);
      expect(ed25519Verify(key, someMessage, value)).toBe(false);
    }
  });

  test('a tampered document is refused by the signing scheme, with the reason it gives', async () => {
    const trusted = { [signing.key_id]: hexToBytes(signing.public_key_hex) };
    const index = signing.documents.find((entry) => entry.kind === 'index')!.signed;
    const tampered = { ...index, issued_at: index.issued_at + 1 };
    expect(await verifyDocument('index', tampered, trusted, ed25519Verify)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Signed as an index, offered as a bundle: the domain separator is inside the signed bytes.
    expect(await verifyDocument('bundle', index, trusted, ed25519Verify)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

test('it agrees with the server’s primitive on every case above it can be asked', async () => {
  const signature = await publisher.sign(someMessage);
  const cases: Array<[Uint8Array, Uint8Array, Uint8Array]> = [
    [publisher.publicKey, someMessage, signature],
    [publisher.publicKey, someMessage, flipBit(signature, 3)],
    [publisher.publicKey, someMessage, flipBit(signature, 300)],
    [publisher.publicKey, flipBit(someMessage, 9), signature],
    [publisher.publicKey, someMessage, withScalarPlus(signature, GROUP_ORDER)],
    [publisher.publicKey, someMessage, new Uint8Array(64)],
    ...RFC_8032.map(
      ({ publicKey, message, signature: vector }): [Uint8Array, Uint8Array, Uint8Array] => [
        hexToBytes(publicKey),
        hexToBytes(message),
        hexToBytes(vector),
      ],
    ),
  ];
  for (const [key, message, candidate] of cases) {
    expect(ed25519Verify(key, message, candidate)).toBe(await nodeVerify(key, message, candidate));
  }
});
