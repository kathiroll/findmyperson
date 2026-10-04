import { VACUUM_INTERVAL_SEC } from '../constants';
import { deriveStays, type StayDerivationResult } from '../stay/derive';
import type { SqlDatabase } from '../store/driver';
import { KV_KEYS, kvGet, kvSet } from '../store/tables/kv';
import { purgeExpired, type PurgeResult } from './purge';

/**
 * STORE MAINTENANCE: stay derivation, the retention purge and the weekly VACUUM, in that order.
 *
 * createRetentionMaintenance() is the function to pass as `maintenance` to openStore in
 * @findmyperson/encrypted-store. `store.runMaintenance(now)` then does all three, on every
 * capture wake that runs JavaScript and on every app foreground (app/src/store/ calls it). A
 * capture wake with no JavaScript purges fixes and stays natively instead, with the statements
 * of store/nativeWriter.ts; it never vacuums.
 *
 * Derivation runs here, and not only before it in the caller, so that no caller can purge fixes
 * that were never looked at. Calling deriveStays elsewhere as well is harmless.
 *
 * VACUUM. Deleting rows frees pages inside the file; only VACUUM gives them back. It rewrites
 * the whole file, so it runs at most once per VACUUM_INTERVAL_SEC, and only while the device is
 * charging and nobody is using it. This package cannot see either; the app says so through
 * `deviceConditions` (the capture module's `getDeviceConditions`), and without an answer the
 * file is not vacuumed. Nothing here schedules
 * anything: a vacuum that is due waits for the next run that finds the device charging and idle.
 */
export interface DeviceConditions {
  /** The device is on external power. */
  charging: boolean;
  /** Nobody is using the app: it is in the background, or the screen is off. */
  idle: boolean;
}

export interface RetentionOptions {
  /**
   * Asked only when a vacuum is due. Left out, or failing, counts as "not charging": the purge
   * still runs and the vacuum waits.
   */
  deviceConditions?: () => Promise<DeviceConditions>;
  /**
   * 'disabled' switches the VACUUM off for this store, whatever the conditions: nothing is asked,
   * nothing is rewritten, and every run reports `disabled`. The purge is not affected. For a
   * platform where rewriting the whole file is not yet known to be safe; the app decides which
   * (ANDROID_VACUUM_ENABLED in app/src/store/retention.ts). Default 'enabled'.
   */
  vacuum?: 'enabled' | 'disabled';
}

/**
 *   disabled  the caller switched the vacuum off (RetentionOptions.vacuum)
 *   not_due   the last vacuum was less than VACUUM_INTERVAL_SEC ago
 *   waiting   due, but the device is not both charging and idle
 *   done      the file was vacuumed
 *   failed    VACUUM did not run to the end (the native writer held the file, or the disk is
 *             full); nothing is lost and the next run tries again
 */
export type VacuumOutcome = 'disabled' | 'not_due' | 'waiting' | 'done' | 'failed';

export interface RetentionRun {
  derived: StayDerivationResult;
  purge: PurgeResult;
  vacuum: VacuumOutcome;
}

/**
 * True when the stored time of the last vacuum does not rule one out. A missing or unreadable
 * time is due. So is one later than `nowTs`: it was written by a clock that has since been set
 * back, and waiting for the clock to pass it again could take years.
 */
function vacuumIsDue(lastRunAt: string | null, nowTs: number): boolean {
  const last = lastRunAt === null ? Number.NaN : Number(lastRunAt);
  return !Number.isFinite(last) || last > nowTs || nowTs - last >= VACUUM_INTERVAL_SEC;
}

/** Vacuums the store if a week has passed and the device is charging and idle. */
export async function vacuumIfDue(
  db: SqlDatabase,
  nowTs: number,
  options: RetentionOptions = {},
): Promise<VacuumOutcome> {
  if (options.vacuum === 'disabled') {
    return 'disabled';
  }
  if (!vacuumIsDue(await kvGet(db, KV_KEYS.vacuumLastRunAt), nowTs)) {
    return 'not_due';
  }
  const conditions = await options.deviceConditions?.().catch(() => undefined);
  if (conditions?.charging !== true || conditions.idle !== true) {
    return 'waiting';
  }
  try {
    // VACUUM cannot run inside a transaction. In WAL mode the rewritten file sits in the WAL
    // until a checkpoint, so the file on disk only shrinks once that has run.
    await db.execute('VACUUM');
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    return 'failed';
  }
  await kvSet(db, KV_KEYS.vacuumLastRunAt, String(nowTs));
  return 'done';
}

/** One run at a time per store: a second call made while one is running joins it. */
const running = new WeakMap<SqlDatabase, Promise<RetentionRun>>();

/**
 * Derives stays, purges what is past retention as of `nowTs` (Unix seconds), then vacuums if
 * that is due and allowed. If derivation throws, the purge still runs and the error is thrown
 * afterwards: a fault in derivation must not keep history past its time.
 */
export function runRetention(
  db: SqlDatabase,
  nowTs: number,
  options: RetentionOptions = {},
): Promise<RetentionRun> {
  const current = running.get(db);
  if (current !== undefined) {
    return current;
  }
  const run = (async () => {
    let derived: StayDerivationResult | null = null;
    let derivationError: unknown;
    try {
      derived = await deriveStays(db);
    } catch (error) {
      derivationError = error;
    }
    const purge = await purgeExpired(db, nowTs);
    if (derived === null) {
      throw derivationError;
    }
    return { derived, purge, vacuum: await vacuumIfDue(db, nowTs, options) };
  })().finally(() => running.delete(db));
  running.set(db, run);
  return run;
}

/**
 * The `maintenance` hook for openStore:
 *
 *   openStore({ vault, driver, maintenance: createRetentionMaintenance({ deviceConditions }) })
 */
export function createRetentionMaintenance(
  options: RetentionOptions = {},
): (db: SqlDatabase, nowTs: number) => Promise<void> {
  return async (db, nowTs) => {
    await runRetention(db, nowTs, options);
  };
}
