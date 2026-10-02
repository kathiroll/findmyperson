import { canonicalJson } from './canonical';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from './encoding';

/**
 * The signing scheme for everything the publisher broadcasts (plan 6.4).
 *
 * A signed document is a JSON object with two reserved members:
 *   key_id   names the Ed25519 key that signed it, so keys can rotate with an overlap period;
 *   sig      "ed25519:" followed by the 64-byte signature as unpadded base64url.
 *
 * The signed bytes are the UTF-8 encoding of
 *
 *   findmyperson.<kind>.v1 + "\n" + canonicalJson(document without its `sig` member)
 *
 * `key_id` is inside the signed bytes. The first line is a domain separator: it stops a
 * signature made over one kind of document from verifying as another kind.
 *
 * The Ed25519 primitive itself is passed in by the caller (Ed25519Sign, Ed25519Verify). This
 * package runs unchanged on Node and on Hermes, which share no crypto API, so it defines what
 * is signed and how the signature is written, and each runtime supplies the curve arithmetic.
 */

/** The document kinds that are signed. Each has its own domain separator. */
export type SignedKind = 'query' | 'bundle' | 'index';

export const SIGNATURE_PREFIX = 'ed25519:';
export const ED25519_SIGNATURE_BYTES = 64;
export const ED25519_PUBLIC_KEY_BYTES = 32;

/** Matches a well-formed `sig` value: the prefix plus 86 base64url characters (64 bytes). */
export const SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9_-]{86}$/;

/** Matches a `key_id`: short, lowercase, safe to put in a URL or a log line. */
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Signs a message with the publisher's private key. Supplied by the server runtime. */
export type Ed25519Sign = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/** Checks an Ed25519 signature. Supplied by each runtime (Node crypto, a native module). */
export type Ed25519Verify = (
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
) => boolean | Promise<boolean>;

/** The public keys a device trusts, by key id. Pinned in the app binary (plan 6.4). */
export type TrustedKeys = Readonly<Record<string, Uint8Array>>;

/** Why a document was not accepted. Devices drop it silently either way (plan 6.4). */
export type VerifyFailure = 'malformed' | 'unknown_key' | 'bad_signature';
export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: VerifyFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The exact bytes that are signed for a document. Any `sig` member is ignored, so the same call
 * serves the signer (no `sig` yet) and the verifier (`sig` present).
 */
export function signingInput(
  kind: SignedKind,
  document: Readonly<Record<string, unknown>>,
): Uint8Array {
  const unsigned: Record<string, unknown> = {};
  for (const key of Object.keys(document)) {
    if (key !== 'sig') {
      unsigned[key] = document[key];
    }
  }
  return utf8Encode(`findmyperson.${kind}.v1\n${canonicalJson(unsigned)}`);
}

/** Formats raw signature bytes as a `sig` value. */
export function encodeSignature(signature: Uint8Array): string {
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new RangeError(`an Ed25519 signature is ${ED25519_SIGNATURE_BYTES} bytes`);
  }
  return SIGNATURE_PREFIX + base64UrlEncode(signature);
}

/** Parses a `sig` value back to bytes, or null if it is not well formed. */
export function decodeSignature(sig: unknown): Uint8Array | null {
  if (typeof sig !== 'string' || !SIGNATURE_PATTERN.test(sig)) {
    return null;
  }
  const bytes = base64UrlDecode(sig.slice(SIGNATURE_PREFIX.length));
  return bytes !== null && bytes.length === ED25519_SIGNATURE_BYTES ? bytes : null;
}

/**
 * Returns the document with its `sig` member added. The document must already carry the
 * `key_id` of the key behind `sign`. Throws if the document is not JSON data.
 */
export async function signDocument<T extends { key_id: string }>(
  kind: SignedKind,
  document: T,
  sign: Ed25519Sign,
): Promise<T & { sig: string }> {
  if (!KEY_ID_PATTERN.test(document.key_id)) {
    throw new RangeError('key_id is not a valid key id');
  }
  const signature = await sign(signingInput(kind, document as Record<string, unknown>));
  return { ...document, sig: encodeSignature(signature) };
}

/**
 * Verifies a document exactly as it was parsed from the wire, before any schema is applied, so
 * members this version does not know are still covered by the check.
 *
 * Never throws: a device treats every failure the same way, by ignoring the document.
 */
export async function verifyDocument(
  kind: SignedKind,
  document: unknown,
  trustedKeys: TrustedKeys,
  verify: Ed25519Verify,
): Promise<VerifyResult> {
  if (!isRecord(document)) {
    return { ok: false, reason: 'malformed' };
  }
  const keyId = document.key_id;
  const signature = decodeSignature(document.sig);
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId) || signature === null) {
    return { ok: false, reason: 'malformed' };
  }
  // Own-property lookup: a key id such as "constructor" must not find Object.prototype members.
  const publicKey = Object.hasOwn(trustedKeys, keyId) ? trustedKeys[keyId] : undefined;
  if (publicKey === undefined || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    return { ok: false, reason: 'unknown_key' };
  }
  let message: Uint8Array;
  try {
    message = signingInput(kind, document);
  } catch {
    // Not JSON data (only possible for a value that did not come from JSON.parse).
    return { ok: false, reason: 'malformed' };
  }
  let valid: boolean;
  try {
    valid = await verify(publicKey, message, signature);
  } catch {
    valid = false;
  }
  return valid ? { ok: true, keyId } : { ok: false, reason: 'bad_signature' };
}
