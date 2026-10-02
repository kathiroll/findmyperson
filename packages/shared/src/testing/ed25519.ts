import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { Ed25519Sign, Ed25519Verify } from '../payload/signing';

/**
 * TEST SUPPORT, not exported from the package. Ed25519 from Node's crypto module, wired to the
 * signing seam. Ed25519 signatures are deterministic, so a fixed seed and message always give
 * the same signature; that is what lets contracts/signing-vectors.json hold exact values.
 */

// DER wrappers around a raw 32-byte Ed25519 key (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/** A signer and its public key, from a 32-byte private seed. */
export function ed25519FromSeed(seed: Uint8Array): { publicKey: Uint8Array; sign: Ed25519Sign } {
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

export const ed25519Verify: Ed25519Verify = (publicKey, message, signature) =>
  verify(
    null,
    message,
    createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    }),
    signature,
  );
