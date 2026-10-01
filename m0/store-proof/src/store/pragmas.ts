import { CIPHER_PARAMS } from '../generated/cipherParams.generated';

/** The tunable subset of the pinned constant. Widened from the literal types so tests can override one value. */
export interface CipherSettings {
  cipherCompatibility: number;
  pageSizeBytes: number;
  kdfIterations: number;
  kdfAlgorithm: string;
  hmacAlgorithm: string;
  sqlcipherMajor: number;
  keyBytes: number;
}

export const PINNED: CipherSettings = CIPHER_PARAMS;

/**
 * Statements run right after the key is set and before the first read. The Kotlin and Swift
 * copies are emitted by scripts/gen-cipher-params.mjs; pragmas.test.ts asserts all three match.
 */
export function buildApplyPragmas(p: CipherSettings): string[] {
  return [
    `PRAGMA cipher_compatibility = ${p.cipherCompatibility}`,
    `PRAGMA cipher_page_size = ${p.pageSizeBytes}`,
    `PRAGMA kdf_iter = ${p.kdfIterations}`,
    `PRAGMA cipher_kdf_algorithm = ${p.kdfAlgorithm}`,
    `PRAGMA cipher_hmac_algorithm = ${p.hmacAlgorithm}`,
  ];
}

/** pragma name -> value that must be read back after opening. */
export function buildReadBack(p: CipherSettings): Array<[string, string]> {
  return [
    ['cipher_page_size', String(p.pageSizeBytes)],
    ['kdf_iter', String(p.kdfIterations)],
    ['cipher_kdf_algorithm', p.kdfAlgorithm],
    ['cipher_hmac_algorithm', p.hmacAlgorithm],
  ];
}

/**
 * SQLCipher raw-key literal: x'<64 hex>'. A passphrase would run PBKDF2 (kdf_iter rounds) on
 * every open; a raw 32-byte key skips that, which matters for a background launch. Side effect
 * worth knowing: with a raw key kdf_iter no longer changes whether the file decrypts, so a
 * kdf_iter mismatch is NOT caught by SQLCipher itself. verifyPinnedParams() catches it by
 * reading the pragma back.
 */
export function keyLiteral(keyHex: string, keyBytes = PINNED.keyBytes): string {
  if (!new RegExp(`^[0-9a-fA-F]{${keyBytes * 2}}$`).test(keyHex)) {
    throw new Error(
      `store key must be ${keyBytes * 2} hex characters (${keyBytes} bytes)`,
    );
  }
  return `x'${keyHex.toLowerCase()}'`;
}
