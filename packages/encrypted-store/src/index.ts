/**
 * @findmyperson/encrypted-store: the on-device store, opened.
 *
 * @findmyperson/shared defines what is in the store (schema, migrations, cipher parameters,
 * one typed module per table). This package turns that into a real encrypted file on a phone:
 * it gets the key from the Keychain or the Keystore, opens the file with op-sqlite and
 * SQLCipher, proves the pinned parameters are in effect, runs the migrations, and resets
 * everything for "Delete all my data". It defines no table and no query of its own.
 *
 *   @findmyperson/encrypted-store           openStore, deleteAllData, types (this file)
 *   @findmyperson/encrypted-store/native    the real native module and the op-sqlite driver
 *   @findmyperson/encrypted-store/testing   a real SQLCipher store for Node tests
 *
 * The Kotlin and Swift halves (android/, ios/) hold the key, name the backup-excluded
 * directory and give the capture modules their writer. See README.md.
 */
export const packageName = '@findmyperson/encrypted-store';

/** The name both native modules register under, and the name the spec asks the registry for. */
export const NATIVE_MODULE_NAME = 'NativeEncryptedStore';

export { deleteAllData } from './deleteAllData';
export type { StoreConnection, StoreDriver, StoreDriverOptions } from './driver';
export { STORE_ERROR_CODES, StoreError, type StoreErrorCode } from './errors';
export { STORE_DIRECTORY_NAME, STORE_FILE_SUFFIXES } from './location';
export {
  openStore,
  STORE_BUSY_TIMEOUT_MS,
  type EncryptedStore,
  type OpenStoreOptions,
  type StoreMaintenance,
  type StoreVault,
} from './openStore';
