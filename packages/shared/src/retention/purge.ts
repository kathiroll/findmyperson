import { OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC, RETENTION_SEC } from '../constants';
import { rewindStayCursorToStoredSamples } from '../stay/derive';
import type { SqlDatabase } from '../store/driver';
import { KV_KEYS, kvSet } from '../store/tables/kv';
import { deleteSamplesBefore } from '../store/tables/locationSample';
import { deleteOrphanMatches } from '../store/tables/match';
import { deleteFinishedResponsesBefore } from '../store/tables/outboundResponse';
import { deleteExpiredReports } from '../store/tables/reportCache';
import { deleteStaysEndedBefore, trimStaysStartedBefore } from '../store/tables/stay';

/**
 * THE RETENTION PURGE (plan 4.7): what makes "kept for 30 days, then deleted" true.
 *
 * Everything is decided from the time it is given and the times in the rows:
 *
 *   location_sample    fixes taken before the cutoff (`nowTs` - RETENTION_SEC)
 *   stay               rows that ended before the cutoff; a row still running across it keeps
 *                      only the part after it
 *   report_cache       reports that have expired
 *   match              rows whose report is no longer cached
 *   outbound_response  sent and failed tips finished more than
 *                      OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC ago
 *
 * `own_report` and `received_response` are left alone until their retention is decided
 * (store/ownership.ts), and so are `subscription` and a tip still waiting to be sent.
 *
 * NO "LAST RUN". The purge keeps no memory of earlier runs and skips nothing because of one, so
 * a run after the app was closed for weeks, or after the clock was changed, deletes exactly what
 * a run at that moment should. It records when it ran (KV_KEYS.purgeLastRunAt) for diagnostics
 * and never reads that back. Running it again deletes nothing more.
 *
 * ONE TRANSACTION, shared cutoff. Fixes and stays go together, so a stay never outlives the
 * fixes of its interval and no fix outlives the stay it belonged to; a report and its matches go
 * together. deriveStays is one transaction too, and transactions on the store's connection run
 * one at a time, so the purge sees either all of a derivation run or none of it.
 *
 * ORDER. Run deriveStays first (runRetention does). The promise does not depend on it: purging
 * first and deriving afterwards also leaves nothing before the cutoff, because a dwell cut by the
 * cutoff is then derived from the fixes after it. Deriving first keeps the row, and its id, that
 * a match may name, and lets a stay reach back to the cutoff itself.
 *
 * WHAT IT CANNOT DO. The device clock is the only clock there is. A row written while the clock
 * was ahead of where it is now is dated in the future, and it is kept until the clock passes its
 * date by the retention period. Deleting such rows instead would empty the store whenever a
 * phone starts up with its clock unset, so they are left.
 */
export interface PurgeResult {
  /** Fixes and stays before this time are gone: `nowTs` - RETENTION_SEC. */
  cutoffTs: number;
  samples: number;
  stays: number;
  /** Stays kept, with their start moved up to the cutoff. */
  staysTrimmed: number;
  reports: number;
  matches: number;
  responses: number;
}

/** Later than any real time in seconds; a value above it is milliseconds passed by mistake. */
const MAX_UNIX_SECONDS = 100_000_000_000;

/**
 * Deletes everything past retention as of `nowTs` (Unix seconds). Throws RangeError, deleting
 * nothing, if `nowTs` is not a whole number of seconds: a time in milliseconds would put the
 * cutoff after every row there is.
 */
export async function purgeExpired(db: SqlDatabase, nowTs: number): Promise<PurgeResult> {
  if (!Number.isSafeInteger(nowTs) || nowTs < 0 || nowTs > MAX_UNIX_SECONDS) {
    throw new RangeError(`purge time must be Unix seconds, got ${nowTs}`);
  }
  const cutoffTs = nowTs - RETENTION_SEC;
  return db.transaction(async (tx) => {
    const samples = await deleteSamplesBefore(tx, cutoffTs);
    const stays = await deleteStaysEndedBefore(tx, cutoffTs);
    const staysTrimmed = await trimStaysStartedBefore(tx, cutoffTs);
    if (samples > 0) {
      await rewindStayCursorToStoredSamples(tx);
    }
    // Reports before matches: a match is an orphan once its report is gone.
    const reports = await deleteExpiredReports(tx, nowTs);
    const matches = await deleteOrphanMatches(tx);
    const responses = await deleteFinishedResponsesBefore(
      tx,
      nowTs - OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC,
    );
    await kvSet(tx, KV_KEYS.purgeLastRunAt, String(nowTs));
    return { cutoffTs, samples, stays, staysTrimmed, reports, matches, responses };
  });
}
