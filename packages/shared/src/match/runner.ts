import { MATCH_RADIUS_M, MATCH_SAMPLE_LATE_SEC } from '../constants';
import { searchAreaCells } from '../geo/h3';
import type { QueryId } from '../payload/primitives';
import { StoreRowError, type SqlExecutor } from '../store/driver';
import { listSamplesBetween, listSamplesInCells } from '../store/tables/locationSample';
import { insertMatchIfAbsent, listMatches, type Match } from '../store/tables/match';
import {
  getCachedReport,
  listLiveReportCursors,
  setLastMatchedAt,
  type CachedReport,
} from '../store/tables/reportCache';
import { listStaysOverlapping } from '../store/tables/stay';
import {
  matchBounds,
  matchParamsAt,
  matchReport,
  type MatchBounds,
  type MatchQuery,
  type MatchResult,
} from './matchReport';

/**
 * THE MATCH RUNNER (plan 8.2; task M5.2): calls the match rule (match/matchReport.ts) on the
 * reports and the history in the store, and writes what it finds to `match`. `runMatchPass` is
 * one run. It is the only writer of new `match` rows and of `report_cache.last_matched_at`
 * (store/ownership.ts). It raises no notification and makes no request: it returns the rows it
 * inserted, and whoever notifies acts on those.
 *
 * ONE RUN looks at every report in `report_cache` that has not expired and has no `match` row,
 * whichever shard it came from (the cache also holds reports of cover shards; a match says the
 * history crossed the report, and nothing here says a report is near):
 *
 *   retrospective   `last_matched_at` is NULL: the report is new to this device, or the fetcher
 *                   stored a revision that changed its criteria. All the history inside the
 *                   report's bounds (`matchBounds`) is read and matched, and the cursor is set.
 *                   This finds the bystander who was there before the report reached the phone.
 *   prospective     the cursor is set: the report is matched against the history written since.
 *                   This finds the bystander who arrives after the report did.
 *
 * The strongest piece of evidence, if there is any, becomes the report's `match` row, in state
 * `new`, with the revision that was matched.
 *
 * AT MOST ONE MATCH PER REPORT, EVER. `match` is UNIQUE on `query_id`, and the insert is a no-op
 * when a row is there (`insertMatchIfAbsent`), so a second run, a second revision or a second
 * process cannot produce a second row, and only a row this run inserted is returned. A report
 * that has its match is not matched again. A revision that only edits the description keeps its
 * cursor (`upsertCachedReport`) and gets no retrospective pass; one that changes the criteria
 * gets one, and can then match a device it did not match before.
 *
 * WHAT "WRITTEN SINCE" MEANS. No row says when it was written, so the two kinds of history are
 * followed differently:
 *
 *   stays     are few, change in place (an open stay grows, a merge reopens one) and arrive late
 *             (a visit is written minutes to hours after the fact, stay/derive.ts). No cursor
 *             can say which changed, so every run reads the stays that overlap any open report
 *             and matches them all again. It is one read, of some hundreds of rows at most.
 *   fixes     are many. A run reads those taken since the cursor, and MATCH_SAMPLE_LATE_SEC
 *             before it, because a fix reaches the store a little after it was taken. A fix
 *             stored later than that after its own time, with no stay over it, is not matched.
 *
 * So a row is matched more than once. That is harmless: the rule gives the same answer for the
 * same rows, and the insert is a no-op. It is not free, which is why the read of fixes is kept
 * short.
 *
 * MOST RUNS WRITE NOTHING. The cursor is written when the retrospective pass is done, and after
 * that only when it has fallen more than MATCH_SAMPLE_LATE_SEC behind the time of the run (or
 * is ahead of it: the clock was set back). Between those a run reads and leaves the store as it
 * found it, so it cannot hold up the native writer, and a run repeated with nothing new changes
 * nothing. A run therefore reads again at most twice MATCH_SAMPLE_LATE_SEC of fixes, plus
 * whatever was stored while the runner was not running.
 *
 * THE COST OF A RUN is one row per live report (`listLiveReportCursors`, no payload parsed), the
 * `match` table, the overlapping stays, and at most one read of recent fixes. A report's payload
 * is parsed once per revision and process: what matching reads of it is remembered per store
 * handle, and forgotten when the report leaves the list.
 *
 * ORDER. Run it after stay derivation and the retention purge, in the same pass (the app's
 * `DataStore.runMaintenance` does), so that it sees the stays of the fixes just stored. It does
 * not depend on the purge: the rule ignores history past retention and reports past expiry as
 * of `nowTs`, whatever is still stored.
 *
 * WHAT IT DOES NOT COVER. A report whose stored payload this build cannot read is skipped and
 * counted, and its cursor is left alone. A match names the stay or fix that was the evidence by
 * id; derivation can later replace that stay row with another covering the same place and time.
 * If the store fails part of the way through, the rows already inserted stay inserted and are
 * not returned: `match` rows in state `new` are the durable list of what has not been notified.
 */

/** What one run did. The entries name reports this device matched: keep them on the device. */
export interface MatchRunResult {
  /** The `match` rows this run inserted, in state `new`, oldest-received report first. */
  matches: Match[];
  /** Reports that owed a retrospective pass and were given it. */
  retrospective: number;
  /** Reports matched against the history written since their cursor. */
  prospective: number;
  /** Live reports whose stored payload could not be read. They were skipped. */
  unreadable: number;
}

/** Later than any real time in seconds; a value above it is milliseconds passed by mistake. */
const MAX_UNIX_SECONDS = 100_000_000_000;

/** What matching reads of a stored report, or null when its payload cannot be read. */
interface ReadReport {
  revision: number;
  query: MatchQuery | null;
}

/** The reports already read from each store, so a payload is parsed once and not on every wake. */
const readReports = new WeakMap<SqlExecutor, Map<QueryId, ReadReport>>();

/** A report with work left on it this run. A null cursor is a retrospective pass owed. */
interface OpenReport {
  query: MatchQuery;
  bounds: MatchBounds;
  cursor: number | null;
}

async function readReport(
  db: SqlExecutor,
  queryId: QueryId,
): Promise<CachedReport | 'unreadable' | null> {
  try {
    return await getCachedReport(db, queryId);
  } catch (error) {
    // The row is there and is not a report this build knows. Anything else is the store failing.
    if (error instanceof StoreRowError || error instanceof SyntaxError) {
      return 'unreadable';
    }
    throw error;
  }
}

/**
 * Matches the reports in the store against the history in the store as of `nowTs` (Unix
 * seconds), and returns the matches it inserted. Throws RangeError, reading and writing nothing,
 * if `nowTs` is not a whole number of seconds: a time in milliseconds would put every report
 * past its expiry and every row past retention.
 */
export async function runMatchPass(db: SqlExecutor, nowTs: number): Promise<MatchRunResult> {
  if (!Number.isSafeInteger(nowTs) || nowTs < 0 || nowTs > MAX_UNIX_SECONDS) {
    throw new RangeError(`match run time must be Unix seconds, got ${nowTs}`);
  }
  const params = matchParamsAt(nowTs);
  const result: MatchRunResult = { matches: [], retrospective: 0, prospective: 0, unreadable: 0 };

  const listed = await listLiveReportCursors(db, nowTs);
  const known = readReports.get(db);
  const kept = new Map<QueryId, ReadReport>();
  readReports.set(db, kept);
  if (listed.length === 0) {
    return result;
  }

  const matched = new Set((await listMatches(db)).map((match) => match.query_id));
  const open: OpenReport[] = [];
  for (const row of listed) {
    if (matched.has(row.query_id)) {
      // Nothing more can come of it. A revision that widened it still has its debt cleared.
      if (row.last_matched_at === null) {
        await setLastMatchedAt(db, row.query_id, row.revision, nowTs);
      }
      continue;
    }
    let read = known?.get(row.query_id);
    let cursor = row.last_matched_at;
    if (read === undefined || read.revision !== row.revision) {
      const stored = await readReport(db, row.query_id);
      if (stored === null) {
        continue;
      }
      if (stored === 'unreadable') {
        read = { revision: row.revision, query: null };
      } else {
        // The row as it is now, which the fetcher may have revised since the list was read.
        const { query_id, revision, expires_at, center, radius_m, window } = stored.query;
        read = { revision, query: { query_id, revision, expires_at, center, radius_m, window } };
        cursor = stored.last_matched_at;
      }
    }
    kept.set(row.query_id, read);
    if (read.query === null) {
      result.unreadable += 1;
      continue;
    }
    const bounds = matchBounds(read.query, params);
    if (bounds === null) {
      // All of its time range is past retention: there is nothing to read, now or later.
      if (cursor === null) {
        await setLastMatchedAt(db, row.query_id, read.revision, nowTs);
        result.retrospective += 1;
      }
      continue;
    }
    open.push({ query: read.query, bounds, cursor });
  }
  if (open.length === 0) {
    return result;
  }

  // Every stay any open report could take as evidence, and the fixes written since the cursors.
  let staysFrom = Infinity;
  let staysTo = -Infinity;
  let fixesFrom = Infinity;
  let fixesTo = -Infinity;
  for (const { bounds, cursor } of open) {
    staysFrom = Math.min(staysFrom, bounds.from_ts);
    staysTo = Math.max(staysTo, bounds.to_ts);
    if (cursor !== null) {
      const since = Math.max(bounds.from_ts, Math.min(cursor, nowTs) - MATCH_SAMPLE_LATE_SEC);
      if (since <= bounds.to_ts) {
        fixesFrom = Math.min(fixesFrom, since);
        fixesTo = Math.max(fixesTo, bounds.to_ts);
      }
    }
  }
  const stays = await listStaysOverlapping(db, staysFrom, staysTo);
  const recent = fixesFrom <= fixesTo ? await listSamplesBetween(db, fixesFrom, fixesTo) : [];

  for (const { query, bounds, cursor } of open) {
    let evidence: MatchResult | undefined;
    if (cursor === null) {
      result.retrospective += 1;
      // Stays first, as the rule has it: the fixes are read only when no stay is evidence.
      evidence = matchReport(query, { stays, samples: [] }, params)[0];
      if (evidence === undefined) {
        const cover = searchAreaCells(bounds.center, bounds.reach_m - MATCH_RADIUS_M);
        const samples = await listSamplesInCells(db, cover, bounds.from_ts, bounds.to_ts);
        evidence = matchReport(query, { stays: [], samples }, params)[0];
      }
    } else {
      result.prospective += 1;
      evidence = matchReport(query, { stays, samples: recent }, params)[0];
    }
    if (evidence !== undefined) {
      const inserted = await insertMatchIfAbsent(db, { ...evidence, created_at: nowTs });
      if (inserted !== null) {
        result.matches.push(inserted);
      }
    }
    const behind = cursor === null || cursor > nowTs || nowTs - cursor > MATCH_SAMPLE_LATE_SEC;
    // A report that has just matched is never read again, so its cursor is only worth a write
    // when that write clears a debt.
    if (cursor === null || (evidence === undefined && behind)) {
      await setLastMatchedAt(db, query.query_id, query.revision, nowTs);
    }
  }
  return result;
}
