/* eslint-disable @typescript-eslint/no-require-imports */
import {
  deleteAllData,
  openStore,
  type EncryptedStore,
  type OpenStoreOptions,
} from '@findmyperson/encrypted-store';
import type { LocationCapture } from '@findmyperson/native-location-capture';
import {
  createRetentionMaintenance,
  listOwnReports,
  listWatchedShards,
  runFetchCycle,
  syncSubscriptions,
  type DeviceIdentity,
  type FetchCycleInput,
  type FetchCycleResult,
  type OwnReport,
  type ReportSubmitRequest,
  type SqlDatabase,
  type SubscriptionSyncResult,
} from '@findmyperson/shared';
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { useCapture } from '../permissions';
import type { ReportApi } from '../report/api';
import { createStoreDeviceIdentity, platformRandomBytes } from '../report/identity';
import { enqueueReport, runSubmitQueue, type QueueRunResult } from '../report/queue';
import { retentionOptions } from './retention';

/**
 * What one maintenance run came to. `error` is why the store could not be opened or purged, or
 * why the watch list could not be brought up to date.
 *
 * `subscriptions` is what the run changed in the `subscription` table: the topics it added and
 * removed (`syncSubscriptions` of @findmyperson/shared). On most runs both lists are empty. It
 * is there for the push task, which has to apply the same difference to the push service; it is
 * present on a failed run when the purge failed and the watch list was still updated.
 */
export type MaintenanceResult =
  | { ran: true; subscriptions: SubscriptionSyncResult }
  | { ran: false; error: unknown; subscriptions?: SubscriptionSyncResult };

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
   * The same pass then brings the watch list up to date (`syncSubscriptions`): the shards of
   * everywhere the phone has been in the 30 days the purge has just left, written to the
   * `subscription` table only where it differs from what is there. It runs after the purge so
   * that the list shrinks with the history, and it runs even if the purge failed, because it
   * reads the history by its dates and not by what is still stored: a fault in derivation must
   * not stop the phone from following a place it has just arrived in.
   *
   * It never rejects. A store that cannot be opened or purged right now (the phone was not
   * unlocked since it restarted, the native writer held the file) is the result, and the next
   * call tries again from the start.
   */
  runMaintenance(): Promise<MaintenanceResult>;
  /**
   * One cycle of the bundle fetcher (`runFetchCycle` of @findmyperson/shared) against the
   * store, opening it first if this is a cold wake: no screen, no provider and no earlier call
   * is needed. The time is this store's clock.
   *
   * `input.watch` is the shard-key list. Left out, it is read from the store: the shards of the
   * `subscription` table (`listWatchedShards`), which `runMaintenance` keeps equal to where the
   * phone has been. Before the first maintenance run of a new store the table is empty and so
   * is the list.
   *
   * For background work, never for a screen. It rejects only for a malformed argument; a store
   * that cannot be opened is a `failed` result with `store_failed`, and the next call tries
   * again. The cycle's network requests do not hold the store: maintenance and a delete can run
   * between its statements, and a cycle that ends after a delete writes what it fetched (public
   * reports) into the new store.
   */
  runFetchCycle(input: StoreFetchInput): Promise<FetchCycleResult>;
  /** This phone's device id, kept in the store (`kv`). Hand it to `createReportApi`. */
  deviceIdentity: DeviceIdentity;
  /**
   * Durably queues a report for submission (`own_report`, `queued`). Written before any network
   * call, so a confirmed report survives no signal and a kill. Follow with `runReportQueue`.
   */
  enqueueReport(request: ReportSubmitRequest): Promise<OwnReport>;
  /** One pass over the queued submits that are due. Never rejects for a network failure. */
  runReportQueue(api: ReportApi): Promise<QueueRunResult>;
  /**
   * The newest report of this owner that the server accepted and has not ended or expired (the
   * `own_report` row in state `active`), or null. Its `report.review_state` says whether it is
   * still held for review. Queued, sending and failed submits are not active reports.
   */
  getActiveReport(): Promise<OwnReport | null>;
}

/** A fetch cycle's input, less what the store supplies: the time, and the watch list if absent. */
export type StoreFetchInput = Omit<FetchCycleInput, 'nowTs' | 'watch'> & {
  watch?: FetchCycleInput['watch'];
};

/** A cycle that asked nothing of the network and changed nothing in the store. */
const NO_CYCLE: Omit<FetchCycleResult, 'outcome' | 'reason'> = {
  requests: 0,
  indexChanged: false,
  stored: [],
  inserted: 0,
  revised: 0,
  removed: 0,
  rematch: 0,
  deferred: 0,
  retryAt: null,
};

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
  randomBytes: (length: number) => Uint8Array = platformRandomBytes,
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
  const opened = async () => (current.store ??= await openStore(options()));
  // The store as background work sees it: whichever store is current when a statement runs,
  // opened on first use, each statement or transaction taking its turn in the queue above.
  const db: SqlDatabase = {
    execute: (sql, params) => serial(async () => (await opened()).db.execute(sql, params)),
    transaction: (work) => serial(async () => (await opened()).db.transaction(work)),
  };

  return {
    deviceIdentity: createStoreDeviceIdentity(db, randomBytes),
    enqueueReport: (request) => enqueueReport(db, request, randomBytes, now()),
    runReportQueue: (api) => runSubmitQueue(db, api, now),
    getActiveReport: async () =>
      (await listOwnReports(db)).find((row) => row.state === 'active') ?? null,

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
        let store: EncryptedStore;
        try {
          store = await opened();
        } catch (error) {
          return { ran: false, error };
        }
        const nowTs = now();
        const failed = await store.runMaintenance(nowTs).then(
          () => null,
          (error: unknown) => ({ error }),
        );
        // After the purge, in the same turn of the queue, so nothing comes between the two. A
        // failed purge does not put it off: it reads the same 30 days either way.
        try {
          const subscriptions = await syncSubscriptions(store.db, nowTs);
          return failed === null
            ? { ran: true, subscriptions }
            : { ran: false, error: failed.error, subscriptions };
        } catch (error) {
          return { ran: false, error: failed === null ? error : failed.error };
        }
      }).finally(() => {
        maintaining = null;
      });
      return maintaining;
    },

    async runFetchCycle(input) {
      let watch = input.watch;
      if (watch === undefined) {
        try {
          watch = await listWatchedShards(db);
        } catch {
          // Not an empty list: a cycle run on one would follow no shard and say so on the wire.
          return { ...NO_CYCLE, outcome: 'failed', reason: 'store_failed' };
        }
      }
      return runFetchCycle(db, { ...input, watch, nowTs: now() });
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
