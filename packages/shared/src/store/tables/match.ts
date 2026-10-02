import type { QueryId } from '../../payload/primitives';
import {
  num,
  numOrNull,
  oneOf,
  placeholders,
  text,
  type SqlExecutor,
  type SqlRow,
} from '../driver';

/**
 * `match`: this device's local match decisions. Nothing in this table is ever sent anywhere.
 *
 * WRITERS: the match runner inserts rows; the notification and match-screen code and the send
 * pipeline move `state` forward; the retention purge deletes rows whose report is gone.
 *
 * UNIQUE(query_id) is the structural form of "at most one notification per report per device,
 * ever" (plan 4.6): a second insert for the same report is a no-op, whatever the revision.
 */
export const MATCH_STATES = ['new', 'notified', 'opened', 'dismissed', 'responded'] as const;
export type MatchState = (typeof MATCH_STATES)[number];

export interface Match {
  id: number;
  query_id: QueryId;
  /** The report revision that produced the match. */
  revision: number;
  /** The evidence: a stay, a sample, or both. At least one is set. */
  stay_id: number | null;
  sample_id: number | null;
  distance_m: number;
  /** Seconds between the evidence and the report window; 0 when inside it. */
  dt_sec: number;
  state: MatchState;
  created_at: number;
}

export type NewMatch = Omit<Match, 'id' | 'state'>;

// `match` is quoted everywhere: MATCH is an SQL keyword.
const COLUMNS = 'id, query_id, revision, stay_id, sample_id, distance_m, dt_sec, state, created_at';

function fromRow(row: SqlRow): Match {
  return {
    id: num(row, 'id'),
    query_id: text(row, 'query_id'),
    revision: num(row, 'revision'),
    stay_id: numOrNull(row, 'stay_id'),
    sample_id: numOrNull(row, 'sample_id'),
    distance_m: num(row, 'distance_m'),
    dt_sec: num(row, 'dt_sec'),
    state: oneOf(row, 'state', MATCH_STATES),
    created_at: num(row, 'created_at'),
  };
}

/**
 * Records a match in state `new`. Returns the stored row, or null if this device already has a
 * match for the report, in which case nothing is written and no second notification is due.
 */
export async function insertMatchIfAbsent(db: SqlExecutor, match: NewMatch): Promise<Match | null> {
  const rows = await db.execute(
    `INSERT INTO "match"
       (query_id, revision, stay_id, sample_id, distance_m, dt_sec, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?)
     ON CONFLICT (query_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      match.query_id,
      match.revision,
      match.stay_id,
      match.sample_id,
      match.distance_m,
      match.dt_sec,
      match.created_at,
    ],
  );
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

export async function getMatchByQueryId(db: SqlExecutor, queryId: QueryId): Promise<Match | null> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM "match" WHERE query_id = ?`, [queryId]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

/** All matches, newest first. */
export async function listMatches(db: SqlExecutor): Promise<Match[]> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM "match" ORDER BY created_at DESC, id DESC`);
  return rows.map(fromRow);
}

/**
 * Moves a match to `next`, but only if it is currently in one of the `from` states. The caller
 * names the states it expects, so two writers cannot silently overwrite each other (for example
 * a late "notified" landing on a match the user already responded to). Returns whether the
 * change was applied.
 */
export async function advanceMatchState(
  db: SqlExecutor,
  queryId: QueryId,
  from: readonly MatchState[],
  next: MatchState,
): Promise<boolean> {
  if (from.length === 0) {
    return false;
  }
  const rows = await db.execute(
    `UPDATE "match" SET state = ?
     WHERE query_id = ? AND state IN (${placeholders(from.length)}) RETURNING id`,
    [next, queryId, ...from],
  );
  return rows.length > 0;
}

/** Retention purge: deletes matches whose report is no longer cached. Returns how many. */
export async function deleteOrphanMatches(db: SqlExecutor): Promise<number> {
  const rows = await db.execute(
    `DELETE FROM "match"
     WHERE query_id NOT IN (SELECT query_id FROM report_cache) RETURNING id`,
  );
  return rows.length;
}
