import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { z } from 'zod';
import {
  ED25519_PUBLIC_KEY_BYTES,
  KeyIdSchema,
  UnixSecondsSchema,
  base64UrlDecode,
  base64UrlEncode,
  describeIssues,
  type Ed25519Sign,
  type Ed25519Verify,
  type TrustedKeys,
} from '@findmyperson/shared';

/**
 * The publisher's signing keys, and how they rotate (plan 6.4).
 *
 * What is signed and how a signature is written is defined once in @findmyperson/shared
 * (payload/signing.ts). This file supplies the two things that package leaves to the runtime:
 * the Ed25519 arithmetic, from Node's crypto, and which key is in force at a given moment.
 *
 * ROTATION WITH AN OVERLAP. Each key carries two times:
 *
 *   sign_from     the key signs from this moment on. Of the keys that may sign now, the one
 *                 with the latest sign_from is the signer, so adding a key with a future
 *                 sign_from schedules the switch without a deploy at that moment.
 *   verify_until  the key stops being trusted at this moment. Absent means no end.
 *
 * A device trusts whatever its app binary pins, so the order of a rotation is:
 *   1. generate the new key (`cli.ts keygen`) and add it here with sign_from in the future;
 *      ship an app release that pins both public keys.
 *   2. at sign_from the compiler signs everything with the new key. Every live query and bundle
 *      is re-signed, so every shard's generation goes up once (the bytes really changed).
 *   3. give the old key a verify_until at the end of the overlap. Until then both keys verify.
 *      After it, drop the old key from this ring and from the next app release.
 * The overlap has to outlast the app versions that pin only the old key, not just the 30-day
 * life of a report: an old app that never updates stops accepting bundles at step 2.
 */

const ED25519_SEED_BYTES = 32;

// DER wrappers around a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Unpadded base64url of exactly 32 bytes: how a seed or a public key is written in config. */
const Key32Schema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const SigningKeyConfigSchema = z
  .object({
    key_id: KeyIdSchema,
    /** The private seed. Leave out for a key this process may verify with but not sign with. */
    seed: Key32Schema.optional(),
    /** Required without a seed. With one, it must be the seed's own public key. */
    public_key: Key32Schema.optional(),
    sign_from: UnixSecondsSchema.optional(),
    verify_until: UnixSecondsSchema.optional(),
  })
  .refine((key) => key.seed !== undefined || key.public_key !== undefined, {
    message: 'a key needs a seed or a public_key',
  });
export type SigningKeyConfig = z.infer<typeof SigningKeyConfigSchema>;

export const KeyRingConfigSchema = z.array(SigningKeyConfigSchema).min(1);

/** The key that signs at one moment. */
export interface ActiveSigner {
  keyId: string;
  publicKey: Uint8Array;
  sign: Ed25519Sign;
}

interface RingKey {
  keyId: string;
  publicKey: Uint8Array;
  sign: Ed25519Sign | null;
  signFrom: number;
  verifyUntil: number | null;
}

/** Ed25519 verification from Node's crypto, for verifyDocument and the read helpers. */
export const ed25519Verify: Ed25519Verify = (publicKey, message, signature) =>
  verify(
    null,
    message,
    createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' }),
    signature,
  );

function decodeKey32(text: string, what: string): Uint8Array {
  const bytes = base64UrlDecode(text);
  if (bytes === null || bytes.length !== ED25519_SEED_BYTES) {
    throw new Error(`${what} is not 32 bytes of base64url`);
  }
  return bytes;
}

function signerFromSeed(seed: Uint8Array): { publicKey: Uint8Array; sign: Ed25519Sign } {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return {
    publicKey: Uint8Array.from(spki.subarray(SPKI_PREFIX.length)),
    sign: (message) => Uint8Array.from(sign(null, message, privateKey)),
  };
}

/** A fresh key, in the form the config takes. The seed is the secret; pin the public key. */
export function generateSigningKey(
  keyId: string,
): Required<Pick<SigningKeyConfig, 'key_id' | 'seed' | 'public_key'>> {
  const seed = Uint8Array.from(randomBytes(ED25519_SEED_BYTES));
  return {
    key_id: KeyIdSchema.parse(keyId),
    seed: base64UrlEncode(seed),
    public_key: base64UrlEncode(signerFromSeed(seed).publicKey),
  };
}

export class KeyRing {
  private readonly keys: RingKey[];

  /** Throws on a config a rotation could trip over: see the checks below. */
  constructor(config: unknown) {
    const parsed = KeyRingConfigSchema.safeParse(config);
    if (!parsed.success) {
      // Issues name paths and rules only; a seed never reaches an error message or a log.
      throw new Error(`signing key config: ${describeIssues(parsed.error).join('; ')}`);
    }
    this.keys = parsed.data.map((entry) => {
      const where = `signing key ${entry.key_id}`;
      const signer =
        entry.seed === undefined ? null : signerFromSeed(decodeKey32(entry.seed, `${where} seed`));
      const stated =
        entry.public_key === undefined
          ? null
          : decodeKey32(entry.public_key, `${where} public_key`);
      if (signer !== null && stated !== null && !Buffer.from(stated).equals(signer.publicKey)) {
        throw new Error(`${where}: public_key does not belong to the seed`);
      }
      const publicKey = signer?.publicKey ?? stated;
      if (publicKey === null || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
        throw new Error(`${where}: no public key`);
      }
      return {
        keyId: entry.key_id,
        publicKey,
        sign: signer?.sign ?? null,
        signFrom: entry.sign_from ?? 0,
        verifyUntil: entry.verify_until ?? null,
      };
    });
    const ids = new Set<string>();
    const starts = new Set<number>();
    for (const key of this.keys) {
      if (ids.has(key.keyId)) {
        throw new Error(`signing key config: key_id ${key.keyId} appears twice`);
      }
      ids.add(key.keyId);
      if (key.sign !== null) {
        // Two signing keys starting together would make the signer depend on config order.
        if (starts.has(key.signFrom)) {
          throw new Error(`signing key config: two signing keys share sign_from ${key.signFrom}`);
        }
        starts.add(key.signFrom);
      }
    }
  }

  private trusted(key: RingKey, now: number): boolean {
    return key.verifyUntil === null || now < key.verifyUntil;
  }

  /** The key that signs at `now`. Throws if none can: publishing unsigned is never an option. */
  signerAt(now: number): ActiveSigner {
    let best: RingKey | null = null;
    for (const key of this.keys) {
      if (key.sign === null || key.signFrom > now || !this.trusted(key, now)) {
        continue;
      }
      if (best === null || key.signFrom > best.signFrom) {
        best = key;
      }
    }
    if (best === null || best.sign === null) {
      throw new Error(`no signing key is in force at ${now}`);
    }
    return { keyId: best.keyId, publicKey: best.publicKey, sign: best.sign };
  }

  /**
   * Every key that verifies at `now`: the signer, keys still inside their overlap, and keys
   * announced ahead of their sign_from. This is the set an app release cut at `now` should pin.
   */
  trustedAt(now: number): TrustedKeys {
    const trusted: Record<string, Uint8Array> = {};
    for (const key of this.keys) {
      if (this.trusted(key, now)) {
        trusted[key.keyId] = key.publicKey;
      }
    }
    return trusted;
  }
}
