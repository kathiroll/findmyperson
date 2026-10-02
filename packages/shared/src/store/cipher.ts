import params from '../../contracts/cipher-params.json';

/**
 * The pinned SQLCipher parameters of the on-device store.
 *
 * Origin: m0/store-proof (PR #7). Its shared/cipher-params.json and src/store/pragmas.ts proved
 * on the M0 spike that a Kotlin writer, a Swift writer and op-sqlite open one file with these
 * values. The values live in contracts/cipher-params.json; this file gives them types and the
 * pragma lists built from them. cipher.test.ts fails if the JSON drifts from the m0 original.
 *
 * Why it matters: the native capture module and the TypeScript reader open the same database.
 * A mismatch corrupts nothing, the file just refuses to open, in the background, on a phone
 * with no debugger attached (plan 5.5).
 */
export interface CipherParams {
  sqlcipherMajor: number;
  cipherCompatibility: number;
  pageSizeBytes: number;
  kdfIterations: number;
  kdfAlgorithm: string;
  hmacAlgorithm: string;
  /** The key is given as a raw 32-byte hex literal, never a passphrase. */
  keyFormat: string;
  keyBytes: number;
  /** Must be set identically by the native writer and the TypeScript reader (plan 4.6). */
  journalMode: string;
}

export const CIPHER_PARAMS: CipherParams = {
  sqlcipherMajor: params.sqlcipherMajor,
  cipherCompatibility: params.cipherCompatibility,
  pageSizeBytes: params.pageSizeBytes,
  kdfIterations: params.kdfIterations,
  kdfAlgorithm: params.kdfAlgorithm,
  hmacAlgorithm: params.hmacAlgorithm,
  keyFormat: params.keyFormat,
  keyBytes: params.keyBytes,
  journalMode: params.journalMode,
};

/** A known key and the literal it must turn into, for native tests of their own key code. */
export const CIPHER_KEY_VECTOR: { hex: string; literal: string } = params.keyVector;

/** File name of the store inside the app's private, backup-excluded directory. */
export const STORE_FILE_NAME = 'findmyperson.db';

/** Statements to run right after the key is set and before the first read, in this order. */
export function buildApplyPragmas(p: CipherParams = CIPHER_PARAMS): string[] {
  return [
    `PRAGMA cipher_compatibility = ${p.cipherCompatibility}`,
    `PRAGMA cipher_page_size = ${p.pageSizeBytes}`,
    `PRAGMA kdf_iter = ${p.kdfIterations}`,
    `PRAGMA cipher_kdf_algorithm = ${p.kdfAlgorithm}`,
    `PRAGMA cipher_hmac_algorithm = ${p.hmacAlgorithm}`,
  ];
}

/**
 * Pragma name and the value that must be read back after opening. With a raw key SQLCipher
 * decrypts regardless of kdf_iter, so reading the pragmas back is the only check that catches
 * a writer that drifted on that value (found in m0/store-proof).
 */
export function buildReadBack(p: CipherParams = CIPHER_PARAMS): Array<[string, string]> {
  return [
    ['cipher_page_size', String(p.pageSizeBytes)],
    ['kdf_iter', String(p.kdfIterations)],
    ['cipher_kdf_algorithm', p.kdfAlgorithm],
    ['cipher_hmac_algorithm', p.hmacAlgorithm],
  ];
}

/**
 * The SQLCipher raw-key literal for a key: x'<64 hex>'. A raw key skips PBKDF2 on every open,
 * which matters for a background launch. Throws if the key is not exactly `keyBytes` of hex.
 */
export function keyLiteral(keyHex: string, keyBytes: number = CIPHER_PARAMS.keyBytes): string {
  if (!new RegExp(`^[0-9a-fA-F]{${keyBytes * 2}}$`).test(keyHex)) {
    throw new Error(`store key must be ${keyBytes * 2} hex characters (${keyBytes} bytes)`);
  }
  return `x'${keyHex.toLowerCase()}'`;
}
