import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  type Ed25519Verify,
} from '@findmyperson/shared';
import nacl from 'tweetnacl';

/**
 * ED25519 VERIFICATION ON THE DEVICE: the curve arithmetic @findmyperson/shared leaves to each
 * runtime (payload/signing.ts). The server's is Node's crypto (server/src/shards/keys.ts); this
 * is the app's, and every signature the bundle fetcher accepts goes through it.
 *
 * It is tweetnacl, and the choice is about Hermes. React Native's engine has no WebCrypto and
 * no Node crypto, so the primitive has to be either native code or plain JavaScript:
 *
 *   tweetnacl (here)   plain JavaScript over Uint8Array and Float64Array. It asks nothing of
 *                      the engine: no BigInt, no class syntax, no WebCrypto, no polyfill, no
 *                      dependency. Audited (Cure53, 2017). Verification needs no random
 *                      source, which is the one thing tweetnacl would otherwise have to be
 *                      given on Hermes.
 *   @noble/curves      also audited, and strict about S without help. It needs BigInt and a
 *                      second package for SHA-512. No faster: see the timing below.
 *   a native binding   CryptoKit on iOS; on Android the platform has Ed25519 only from API 33,
 *                      so a second library there, a new bridge method carrying every document,
 *                      and nothing of it testable without a phone. It stays possible: the
 *                      fetcher takes any `Ed25519Verify`.
 *
 * Being plain JavaScript, this exact code runs under Node in ed25519.test.ts against RFC 8032's
 * vectors, the repo's signing vectors and Node's own signer.
 *
 * ON HERMES, what was checked by hand and what was not. This file, bundled with tweetnacl, was
 * run on the Hermes command-line VM (release 0.12.0, the desktop build of the engine): it
 * accepted the four RFC 8032 vectors and refused every altered one, and the bundle compiles
 * with the `hermesc` of this repo's React Native. One verification took about 50 ms there on
 * an Apple-silicon Mac, against about 5 ms under Node, and @noble/curves took about the same
 * 50. NOT VERIFIED: anything on a phone, where it will be several times slower. A cycle
 * verifies the index it holds, a new index, and every bundle it downloads with every report
 * inside, all on the JavaScript thread; a cycle in which nothing changed verifies one document.
 *
 * One rule is added to tweetnacl. It accepts a signature whose S is not below the group order
 * L, so adding L to S gives a second signature that verifies for the same message. RFC 8032
 * (5.1.7) and Node reject those, and so does this, so that the device and the server never
 * disagree about a document. S and L are public values; the comparison need not be constant
 * time.
 */

// L = 2^252 + 27742317777372353535851937790883648493, little-endian (RFC 8032, 5.1).
const GROUP_ORDER = Uint8Array.from([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]);

/** True if the 32 little-endian bytes of `signature` from offset 32, its S, are below L. */
function scalarBelowGroupOrder(signature: Uint8Array): boolean {
  for (let i = GROUP_ORDER.length - 1; i >= 0; i--) {
    const s = signature[32 + i] ?? 0;
    const l = GROUP_ORDER[i] ?? 0;
    if (s !== l) {
      return s < l;
    }
  }
  return false;
}

/**
 * Checks an Ed25519 signature (RFC 8032, pure Ed25519). Never throws: a key or a signature of
 * the wrong length, or anything that is not bytes, is false.
 */
export const ed25519Verify: Ed25519Verify = (publicKey, message, signature) => {
  if (
    !(publicKey instanceof Uint8Array) ||
    !(message instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    publicKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    signature.length !== ED25519_SIGNATURE_BYTES ||
    !scalarBelowGroupOrder(signature)
  ) {
    return false;
  }
  try {
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
};
