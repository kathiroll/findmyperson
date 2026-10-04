/* eslint-disable @typescript-eslint/no-require-imports */
import {
  deleteAllData,
  openStore,
  type EncryptedStore,
  type OpenStoreOptions,
} from '@findmyperson/encrypted-store';
import type { LocationCapture } from '@findmyperson/native-location-capture';
import { createRetentionMaintenance } from '@findmyperson/shared';
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useCapture } from '../permissions';
import { retentionOptions } from './retention';

/** What one maintenance run came to. `error` is why the store could not be opened or purged. */
export type MaintenanceResult = { ran: true } | { ran: false; error: unknown };

/** What the app lets a screen do to the on-device store. Screens never see the store itself. */
export interface DataStore {
  /**
   * "Delete all my data": drops the file, rotates the key and returns once a new, empty store
   * exists. Throws a StoreError if the delete cannot be confirmed. Capture must already be
   * stopped by the caller.
   */
  deleteAll(): Promise<{ emptyStoreConfirmed: true }>;
  /**
   * Opens the store if it is not open yet, then runs its maintenance as of now: stay
   * derivation, the retention purge and, when it is due and allowed, the weekly VACUUM
   * (`store.runMaintenance`). This is what makes "kept for 30 days, then deleted" true while
   * the app runs. `StoreMaintenance` calls it when the app starts, each time it returns to the
   * foreground and on each capture wake; a screen has no reason to.
   *
   * It never rejects. A store that cannot be opened or purged right now (the phone was not
   * unlocked since it restarted, the native writer held the file) is the result, and the next
   * call tries again from the start.
   */
  runMaintenance(): Promise<MaintenanceResult>;
}

const DataStoreContext = createContext<DataStore | null>(null);

/**
 * Wraps the encrypted-store package's `openStore` and `deleteAllData`. `current` holds the
 * handle of the open store: null until the first maintenance run opens it, and replaced by a
 * delete. With none, the reset still works (it is also the way out of an unreadable store).
 * `now` is the clock, Unix seconds.
 */
export function createDataStore(
  options: () => OpenStoreOptions,
  current: { store: EncryptedStore | null } = { store: null },
  now: () => number = () => Math.floor(Date.now() / 1000),
): DataStore {
  // One piece of work on the store at a time: a delete must not close the connection under a
  // purge, and a purge must not open the file a delete is about to remove.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };
  let maintaining: Promise<MaintenanceResult> | null = null;

  return {
    deleteAll: () =>
      serial(async () => {
        const fresh = await deleteAllData(options(), current.store);
        // deleteAllData already refuses a surviving file; this is the screen-level confirmation.
        if (fresh.migration.from !== 0) {
          await fresh.close().catch(() => undefined);
          throw new Error('the store was not empty after the delete');
        }
        current.store = fresh;
        return { emptyStoreConfirmed: true as const };
      }),

    runMaintenance() {
      // Start, foreground and a capture wake often arrive together. A call made while a run is
      // waiting or running joins it; the purge it would have done is the one being done.
      maintaining ??= serial<MaintenanceResult>(async () => {
        try {
          current.store ??= await openStore(options());
          await current.store.runMaintenance(now());
          return { ran: true };
        } catch (error) {
          return { ran: false, error };
        }
      }).finally(() => {
        maintaining = null;
      });
      return maintaining;
    },
  };
}

/**
 * The real store options, looked up on first use: importing the native entry throws wherever
 * native code is not linked (unit tests, the app before the native projects exist).
 *
 * Every store the app opens carries the retention maintenance, so `store.runMaintenance(now)`
 * derives stays and purges what is past retention. The capture module says whether the phone
 * is charging and idle, which is what the weekly VACUUM waits for; on Android the vacuum is
 * switched off altogether for now (ANDROID_VACUUM_ENABLED in ./retention.ts).
 */
export function loadNativeStoreOptions(
  capture: Pick<LocationCapture, 'getDeviceConditions'>,
): OpenStoreOptions {
  const native = require('@findmyperson/encrypted-store/native') as {
    NativeEncryptedStore: OpenStoreOptions['vault'];
    opSqliteDriver: OpenStoreOptions['driver'];
  };
  return {
    vault: native.NativeEncryptedStore,
    driver: native.opSqliteDriver,
    maintenance: createRetentionMaintenance(
      retentionOptions(capture, Platform.OS === 'ios' ? 'ios' : 'android'),
    ),
  };
}

/** Needs a CaptureProvider above it: the real store asks the capture module about the phone. */
export function DataStoreProvider({
  dataStore,
  children,
}: {
  /** Production leaves it out and gets the real native store. */
  dataStore?: DataStore;
  children: ReactNode;
}) {
  const capture = useCapture();
  const created = useRef<DataStore | null>(null);
  const value = useMemo(() => {
    if (dataStore) return dataStore;
    created.current ??= createDataStore(() => loadNativeStoreOptions(capture));
    return created.current;
  }, [dataStore, capture]);
  return <DataStoreContext.Provider value={value}>{children}</DataStoreContext.Provider>;
}

export function useDataStore(): DataStore {
  const store = useContext(DataStoreContext);
  if (store === null) throw new Error('useDataStore needs a DataStoreProvider above it');
  return store;
}
