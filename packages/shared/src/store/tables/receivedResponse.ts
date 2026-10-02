import type { ReceivedResponse } from '../../api/responses';
import type { QueryId } from '../../payload/primitives';
import { num, numOrNull, text, textOrNull, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `received_response`: tips received for this device owner's own reports.
 *
 * WRITERS: the reporter's response fetch stores tips (saveReceivedResponses); the active-report
 * screen marks them read.
 *
 * The server's `response_id` is the primary key, so storing the same page twice changes
 * nothing. That is what makes the fetch safe to repeat after a push, a cold launch or a retry.
 */
export interface StoredResponse {
  response_id: string;
  query_id: QueryId;
  text: string;
  /** The responder's number if they shared it, null if they stayed anonymous. */
  phone: string | null;
  /** When the server received the tip. */
  received_at: number;
  fetched_at: number;
  /** Null while unread. */
  read_at: number | null;
}

const COLUMNS = 'response_id, query_id, text, phone, received_at, fetched_at, read_at';

function fromRow(row: SqlRow): StoredResponse {
  return {
    response_id: text(row, 'response_id'),
    query_id: text(row, 'query_id'),
    text: text(row, 'text'),
    phone: textOrNull(row, 'phone'),
    received_at: num(row, 'received_at'),
    fetched_at: num(row, 'fetched_at'),
    read_at: numOrNull(row, 'read_at'),
  };
}

/** Stores a fetched page of tips. Returns how many were new to this device. */
export async function saveReceivedResponses(
  db: SqlExecutor,
  queryId: QueryId,
  responses: readonly ReceivedResponse[],
  fetchedAt: number,
): Promise<number> {
  let stored = 0;
  for (const response of responses) {
    const rows = await db.execute(
      `INSERT INTO received_response (response_id, query_id, text, phone, received_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (response_id) DO NOTHING RETURNING response_id`,
      [
        response.response_id,
        queryId,
        response.text,
        response.phone,
        response.received_at,
        fetchedAt,
      ],
    );
    stored += rows.length;
  }
  return stored;
}

/** The tips for one report, oldest first. */
export async function listReceivedResponses(
  db: SqlExecutor,
  queryId: QueryId,
): Promise<StoredResponse[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM received_response
     WHERE query_id = ? ORDER BY received_at, response_id`,
    [queryId],
  );
  return rows.map(fromRow);
}

export async function countUnreadResponses(db: SqlExecutor, queryId: QueryId): Promise<number> {
  const rows = await db.execute(
    'SELECT count(*) AS n FROM received_response WHERE query_id = ? AND read_at IS NULL',
    [queryId],
  );
  return num(rows[0] ?? {}, 'n');
}

/** Marks every unread tip of a report as read at `now`. Returns how many were unread. */
export async function markResponsesRead(
  db: SqlExecutor,
  queryId: QueryId,
  now: number,
): Promise<number> {
  const rows = await db.execute(
    `UPDATE received_response SET read_at = ?
     WHERE query_id = ? AND read_at IS NULL RETURNING response_id`,
    [now, queryId],
  );
  return rows.length;
}
