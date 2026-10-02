import type { VerifiedQuery } from '../../payload/bundle';
import type { QueryId } from '../../payload/primitives';
import { parseBroadcastQuery, type BroadcastQuery } from '../../payload/query';
import { classifyCriteriaEdit } from '../../payload/widening';
import { num, numOrNull, StoreRowError, text, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `report_cache`: verified broadcast queries, kept as received.
 *
 * WRITERS: the bundle fetcher inserts and revises rows (upsertCachedReport) and removes reports
 * that left their shard; the match runner moves the `last_matched_at` cursor; the retention
 * purge deletes expired rows.
 *
 * `last_matched_at` is the hand-off between fetcher and runner. NULL means "this report has
 * never been checked against stored history in its current form", so the runner owes it a
 * retrospective pass. A value is the time up to which new history has been checked against it.
 */
export interface CachedReport {
  query: BroadcastQuery;
  /** The signed entry verbatim, unknown members included. */
  payload_json: string;
  received_at: number;
  last_matched_at: number | null;
}

/** What upsertCachedReport did. */
export interface UpsertOutcome {
  /**
   * `inserted`  a report this device had not seen.
   * `revised`   a newer revision replaced the stored one.
   * `ignored`   the stored revision is the same or newer; nothing changed.
   */
  outcome: 'inserted' | 'revised' | 'ignored';
  /** True when the report now needs a retrospective pass (new, or its criteria changed). */
  rematch: boolean;
}

const COLUMNS = 'query_id, payload_json, received_at, last_matched_at';

function fromRow(row: SqlRow): CachedReport {
  const payload_json = text(row, 'payload_json');
  const parsed = parseBroadcastQuery(JSON.parse(payload_json));
  if (parsed.status !== 'ok') {
    throw new StoreRowError(`report_cache ${text(row, 'query_id')}: payload is ${parsed.status}`);
  }
  return {
    query: parsed.query,
    payload_json,
    received_at: num(row, 'received_at'),
    last_matched_at: numOrNull(row, 'last_matched_at'),
  };
}

export async function getCachedReport(
  db: SqlExecutor,
  queryId: QueryId,
): Promise<CachedReport | null> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM report_cache WHERE query_id = ?`, [
    queryId,
  ]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

/**
 * Stores a verified query. Only a strictly newer revision replaces a stored one, so a stale
 * bundle can never roll a report back.
 *
 * When a revision changes the match criteria, the cursor is reset so the runner matches the
 * report against history again. A revision that only edits descriptive fields keeps the cursor:
 * nobody who did not match before can match now (plan 8.2). The widen-only rule is the
 * server's to enforce; a revision that narrows is still stored and re-matched, never trusted
 * to be harmless.
 *
 * Reads then writes: call it inside a transaction if anything else may write the same row.
 */
export async function upsertCachedReport(
  db: SqlExecutor,
  entry: VerifiedQuery,
  receivedAt: number,
): Promise<UpsertOutcome> {
  const { query } = entry;
  const payload = JSON.stringify(entry.raw);
  const existing = await getCachedReport(db, query.query_id);
  if (existing === null) {
    await db.execute(
      `INSERT INTO report_cache
         (query_id, payload_json, version, received_at, expires_at, revision, last_matched_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [query.query_id, payload, query.v, receivedAt, query.expires_at, query.revision],
    );
    return { outcome: 'inserted', rematch: true };
  }
  if (query.revision <= existing.query.revision) {
    return { outcome: 'ignored', rematch: false };
  }
  const rematch = classifyCriteriaEdit(existing.query, query).kind !== 'unchanged';
  await db.execute(
    `UPDATE report_cache
     SET payload_json = ?, version = ?, received_at = ?, expires_at = ?, revision = ?,
         last_matched_at = CASE WHEN ? = 1 THEN NULL ELSE last_matched_at END
     WHERE query_id = ?`,
    [
      payload,
      query.v,
      receivedAt,
      query.expires_at,
      query.revision,
      rematch ? 1 : 0,
      query.query_id,
    ],
  );
  return { outcome: 'revised', rematch };
}

/** Reports that have not expired at `now`, oldest received first. */
export async function listLiveReports(db: SqlExecutor, now: number): Promise<CachedReport[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM report_cache WHERE expires_at > ? ORDER BY received_at, query_id`,
    [now],
  );
  return rows.map(fromRow);
}

/** Live reports that still need their retrospective pass. */
export async function listReportsAwaitingRetrospective(
  db: SqlExecutor,
  now: number,
): Promise<CachedReport[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM report_cache
     WHERE expires_at > ? AND last_matched_at IS NULL ORDER BY received_at, query_id`,
    [now],
  );
  return rows.map(fromRow);
}

/** Match runner: records that history up to `matchedAt` has been checked against the report. */
export async function setLastMatchedAt(
  db: SqlExecutor,
  queryId: QueryId,
  matchedAt: number,
): Promise<void> {
  await db.execute('UPDATE report_cache SET last_matched_at = ? WHERE query_id = ?', [
    matchedAt,
    queryId,
  ]);
}

/** Fetcher: drops a report that is no longer published (ended by its reporter). */
export async function deleteCachedReport(db: SqlExecutor, queryId: QueryId): Promise<boolean> {
  const rows = await db.execute('DELETE FROM report_cache WHERE query_id = ? RETURNING query_id', [
    queryId,
  ]);
  return rows.length > 0;
}

/** Retention purge: deletes reports that expired at or before `now`. Returns how many. */
export async function deleteExpiredReports(db: SqlExecutor, now: number): Promise<number> {
  const rows = await db.execute(
    'DELETE FROM report_cache WHERE expires_at <= ? RETURNING query_id',
    [now],
  );
  return rows.length;
}
