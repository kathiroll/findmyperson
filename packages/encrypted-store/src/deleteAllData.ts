import { StoreError } from './errors';
import { openStore, type EncryptedStore, type OpenStoreOptions } from './openStore';

/**
 * "Delete all my data" (plan 4.7): drops the database, rotates the key and recreates an empty
 * store at the current schema. Returns the new handle; the old one is closed and dead.
 *
 *   1. close the JavaScript connection
 *   2. native: close the native connection, delete the file with its -wal and -shm, delete the key
 *   3. open again: a new key is made, a new file is created and migrated
 *
 * It then checks what it was told rather than trusting it: the key must differ from the old
 * one and the new file must have started empty. Either failing throws, so a Settings screen
 * can never report "deleted" when it was not.
 *
 * Pass `current` as null when the store could not be opened (a lost key, a damaged file): the
 * reset still works and is the way out of that state.
 *
 * Stop capture first (`LocationCapture.stop`) if samples must not resume straight away: the
 * capture module writes to the new store as soon as it exists.
 */
export async function deleteAllData(
  options: OpenStoreOptions,
  current: EncryptedStore | null,
): Promise<EncryptedStore> {
  // An unreadable key is one of the states this exists to recover from.
  const oldKey = await options.vault.getOrCreateStoreKeyHex().catch(() => null);
  await current?.close().catch(() => undefined);

  await options.vault.deleteAllData();

  const newKey = await options.vault.getOrCreateStoreKeyHex();
  if (oldKey !== null && newKey.toLowerCase() === oldKey.toLowerCase()) {
    throw new StoreError('KEY_NOT_ROTATED', 'the store key is unchanged after the delete');
  }
  const store = await openStore(options);
  if (store.migration.from !== 0) {
    await store.close().catch(() => undefined);
    throw new StoreError(
      'DELETE_INCOMPLETE',
      `the store file survived the delete (schema version ${store.migration.from})`,
    );
  }
  return store;
}
