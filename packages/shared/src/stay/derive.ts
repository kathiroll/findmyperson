import type { SqlDatabase, SqlExecutor } from '../store/driver';
import { KV_KEYS, kvGet, kvSet } from '../store/tables/kv';
import {
  getLatestSampleId,
  listSamplesAfterId,
  listSamplesBetween,
  type LocationSample,
} from '../store/tables/locationSample';
import {
  deleteDerivedStay,
  insertStay,
  listStaysOverlapping,
  updateDerivedStay,
} from '../store/tables/stay';
import { overlapsVisit, StayLedger, StayTracker, type LedgerRow } from './extract';

/**
 * STAY DERIVATION AGAINST THE STORE: the one writer of 'derived' rows in `stay`.
 *
 * deriveStays reads the fixes the native module has written since the last run, applies the
 * rules at the top of stay/extract.ts, and writes the difference. Call it on every capture wake
 * and every app foreground, before matching (which reads the rows) and before the retention
 * purge (which would otherwise delete fixes not yet looked at). It takes no clock.
 *
 * WHERE THE STATE IS. Nothing is kept in memory between runs, so a process killed at any point
 * resumes exactly where the last committed run stopped:
 *
 *   the open 'derived' row   is the dwell in progress, once it is a stay. A run continues from
 *                            the row's own columns.
 *   the cursor (kv)          is the id of the last fix that is finished with. The fixes of a
 *                            dwell still too short to be a stay are after it and are read
 *                            again, so that dwell is rebuilt, not remembered.
 *
 * A run is one transaction: either the rows and the cursor both move or neither does. That is
 * what keeps a restart from counting a fix twice or opening a second row for the same dwell.
 *
 * VISIT ROWS (iOS, source 'visit') are never written here. They arrive late, minutes to hours
 * after the fact, usually after the same dwell has already been derived from fixes. So every
 * run first looks for a 'derived' row that a closed visit row now covers, removes it, and
 * derives that stretch again from its fixes with the visit in view; only the parts the visit
 * does not cover come back. On a device with no visit rows (Android) that step finds nothing
 * and every stay is derived.
 */

export interface StayDerivationResult {
  /** Ids of 'derived' rows this run created. */
  inserted: number[];
  /** Ids of 'derived' rows this run extended, closed, reopened by a merge, or trimmed. */
  updated: number[];
  /**
   * Ids of 'derived' rows this run removed: a visit row now covers the dwell, or the row was
   * merged into an earlier one. A `match` that names one of these as its evidence has lost
   * that row; a row covering the same place and time is still in the table.
   */
  deleted: number[];
  /** The 'derived' stay still open after this run, if there is one. */
  openStayId: number | null;
}

const byId = (a: LocationSample, b: LocationSample): number => a.id - b.id;

async function readCursor(db: SqlExecutor): Promise<number> {
  const stored = Number(await kvGet(db, KV_KEYS.stayDerivationLastSampleId));
  return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
}

/**
 * For the retention purge, in the transaction that deleted fixes. Sample ids are rowids: once
 * the newest rows are gone the next fix takes an id at or below the cursor, and a run that came
 * after several such fixes would see a cursor that looks valid and skip them. The cursor is
 * therefore pulled back to the newest id still stored. Every fix that is left was already
 * finished with, so nothing is derived twice.
 *
 * It is one statement with no parameters, so the native modules can run the same thing after
 * their own purge on a wake with no JavaScript (store/nativeWriter.ts).
 */
export const REWIND_STAY_CURSOR_SQL = `UPDATE kv SET v = (SELECT CAST(coalesce(max(id), 0) AS TEXT) FROM location_sample) WHERE k = '${KV_KEYS.stayDerivationLastSampleId}' AND CAST(v AS INTEGER) > (SELECT coalesce(max(id), 0) FROM location_sample)`;

export async function rewindStayCursorToStoredSamples(tx: SqlExecutor): Promise<void> {
  await tx.execute(REWIND_STAY_CURSOR_SQL);
}

export async function deriveStays(db: SqlDatabase): Promise<StayDerivationResult> {
  return db.transaction(async (tx) => {
    const stays = await listStaysOverlapping(tx, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    // Any source that is not ours is another writer's row; closed ones cover their interval.
    const visits = stays.filter((stay) => stay.source !== 'derived' && stay.closed);
    const ledger = new StayLedger(stays.filter((stay) => stay.source === 'derived'));

    const storedCursor = await readCursor(tx);
    // Sample ids are rowids. They only start again below the cursor after the table has been
    // emptied (capture off for longer than retention), and then nothing before is in progress.
    const idsRestarted = storedCursor > ((await getLatestSampleId(tx)) ?? 0);
    let cursor = idsRestarted ? 0 : storedCursor;

    // At most one dwell is in progress. More than one open row, or an open row after the ids
    // restarted, is a leftover; it is closed where it stands and the newest one continues.
    const openRows = ledger.rows.filter((row) => !row.closed);
    let open: LedgerRow | null = idsRestarted ? null : (openRows.pop() ?? null);
    for (const leftover of idsRestarted ? ledger.rows : openRows) {
      leftover.closed = true;
    }

    // Rows a visit row has come to cover since they were derived.
    for (const row of ledger.rows.filter((candidate) => overlapsVisit(candidate, visits))) {
      if (!ledger.has(row)) {
        continue;
      }
      const members = (await listSamplesBetween(tx, row.start_ts, row.end_ts)).sort(byId);
      ledger.remove(row);
      if (row === open) {
        // The dwell in progress: go back to its first fix and take it again below.
        open = null;
        const first = members[0];
        if (first !== undefined) {
          cursor = Math.min(cursor, first.id - 1);
        }
      } else {
        const again = new StayTracker(ledger, visits);
        for (const member of members) {
          again.feed(member);
        }
        again.finish();
      }
    }

    const samples = await listSamplesAfterId(tx, cursor);
    const tracker = new StayTracker<LocationSample>(ledger, visits, open);
    for (const sample of samples) {
      tracker.feed(sample);
    }
    const pendingStart = tracker.pendingStart;
    if (pendingStart !== null) {
      cursor = pendingStart.id - 1;
    } else {
      cursor = samples.at(-1)?.id ?? cursor;
    }

    const { inserts, updates, deletes } = ledger.changes();
    for (const id of deletes) {
      await deleteDerivedStay(tx, id);
    }
    for (const row of updates) {
      if (row.id !== null) {
        await updateDerivedStay(tx, row.id, row);
      }
    }
    for (const row of inserts) {
      row.id = await insertStay(tx, { ...row, source: 'derived' });
    }
    if (cursor !== storedCursor) {
      await kvSet(tx, KV_KEYS.stayDerivationLastSampleId, String(cursor));
    }

    return {
      inserted: inserts.flatMap((row) => (row.id === null ? [] : [row.id])),
      updated: updates.flatMap((row) => (row.id === null ? [] : [row.id])),
      deleted: deletes,
      openStayId: tracker.openStay?.id ?? null,
    };
  });
}
