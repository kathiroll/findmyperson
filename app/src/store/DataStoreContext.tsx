/* eslint-disable @typescript-eslint/no-require-imports */
import {
  deleteAllData,
  type EncryptedStore,
  type OpenStoreOptions,
} from '@findmyperson/encrypted-store';
import { createRetentionMaintenance } from '@findmyperson/shared';
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';

/** What the app lets a screen do to the on-device store. Screens never see the store itself. */
export interface DataStore {
  /**
   * "Delete all my data": drops the file, rotates the key and returns once a new, empty store
   * exists. Throws a StoreError if the delete cannot be confirmed. Capture must already be
   * stopped by the caller.
   */
  deleteAll(): Promise<{ emptyStoreConfirmed: true }>;
}

const DataStoreContext = createContext<DataStore | null>(null);

/**
 * Wraps the encrypted-store package's `deleteAllData`. The handle of the open store is passed
 * in `current` when the app has one; with none, the reset still works (it is also the way out of
 * an unreadable store).
 */
export function createDataStore(
  options: () => OpenStoreOptions,
  current: { store: EncryptedStore | null } = { store: null },
): DataStore {
  return {
    async deleteAll() {
      const fresh = await deleteAllData(options(), current.store);
      // deleteAllData already refuses a surviving file; this is the screen-level confirmation.
      if (fresh.migration.from !== 0) {
        await fresh.close().catch(() => undefined);
        throw new Error('the store was not empty after the delete');
      }
      current.store = fresh;
      return { emptyStoreConfirmed: true as const };
    },
  };
}

/**
 * The real store options, looked up on first use: importing the native entry throws wherever
 * native code is not linked (unit tests, the app before the native projects exist).
 *
 * Every store the app opens carries the retention maintenance, so `store.runMaintenance(now)`
 * derives stays and purges what is past retention. Nothing here reports whether the phone is
 * charging, so the weekly VACUUM waits until a `deviceConditions` source is passed in.
 */
export function loadNativeStoreOptions(): OpenStoreOptions {
  const native = require('@findmyperson/encrypted-store/native') as {
    NativeEncryptedStore: OpenStoreOptions['vault'];
    opSqliteDriver: OpenStoreOptions['driver'];
  };
  return {
    vault: native.NativeEncryptedStore,
    driver: native.opSqliteDriver,
    maintenance: createRetentionMaintenance(),
  };
}

export function DataStoreProvider({
  dataStore,
  children,
}: {
  /** Production leaves it out and gets the real native store. */
  dataStore?: DataStore;
  children: ReactNode;
}) {
  const created = useRef<DataStore | null>(null);
  const value = useMemo(() => {
    if (dataStore) return dataStore;
    created.current ??= createDataStore(loadNativeStoreOptions);
    return created.current;
  }, [dataStore]);
  return <DataStoreContext.Provider value={value}>{children}</DataStoreContext.Provider>;
}

export function useDataStore(): DataStore {
  const store = useContext(DataStoreContext);
  if (store === null) throw new Error('useDataStore needs a DataStoreProvider above it');
  return store;
}
