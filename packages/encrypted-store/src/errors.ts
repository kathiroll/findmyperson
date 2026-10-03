/**
 * Why the store could not be opened or reset. The Kotlin and Swift code use the same names for
 * the first four.
 *
 *   NOT_SQLCIPHER        the binding has no SQLCipher, or it is not version 4
 *   PARAM_MISMATCH       an effective cipher parameter or the journal mode differs from the
 *                        pinned constant (packages/shared/contracts/cipher-params.json)
 *   BAD_KEY_OR_PARAMS    the file did not decrypt: wrong key, or it was written with other
 *                        parameters, or it is not an encrypted store at all
 *   OPEN_FAILED          the binding could not open the file
 *   KEY_NOT_ROTATED      "delete all data" ran but the key afterwards is the old one
 *   DELETE_INCOMPLETE    "delete all data" ran but the old file is still there
 */
export const STORE_ERROR_CODES = [
  'NOT_SQLCIPHER',
  'PARAM_MISMATCH',
  'BAD_KEY_OR_PARAMS',
  'OPEN_FAILED',
  'KEY_NOT_ROTATED',
  'DELETE_INCOMPLETE',
] as const;
export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number];

/**
 * Every failure of openStore and deleteAllData. Neither returns a handle that might read empty
 * or garbage data; they throw this instead. The message never contains the key.
 */
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
  }
}
