import type { IdempotencyKey } from '../../api/idempotency';
import type { QueryId } from '../../payload/primitives';
import { num, numOrNull, oneOf, text, textOrNull, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `outbound_response`: the durable queue that delivers a bystander's tip (plan 9.3).
 *
 * WRITER: the send queue. The identity-choice screen only calls enqueueResponse, after the
 * user's final confirmation; nothing is written, and so nothing can be sent, before that.
 *
 * State machine:
 *
 *   queued  -> sending   an attempt starts (attempts + 1)
 *   sending -> sent      the server acknowledged; only now may the UI say "sent"
 *   sending -> queued    a retryable failure; next_attempt_at says when to try again
 *   sending -> failed    a final failure (see isRetryableError in api/errors.ts)
 *
 * A row found in `sending` at startup was interrupted mid-attempt. requeueInterruptedResponses
 * puts it back in `queued`; re-sending is safe because the idempotency key is unchanged.
 *
 * UNIQUE(query_id): this device sends at most one tip per report.
 */
export const OUTBOUND_RESPONSE_STATES = ['queued', 'sending', 'sent', 'failed'] as const;
export type OutboundResponseState = (typeof OUTBOUND_RESPONSE_STATES)[number];

export interface OutboundResponse {
  id: number;
  query_id: QueryId;
  /** Minted when the tip is queued and sent unchanged on every attempt. */
  idempotency_key: IdempotencyKey;
  text: string;
  /** The bystander's number if they chose to share it, null if they chose to stay anonymous. */
  phone: string | null;
  state: OutboundResponseState;
  attempts: number;
  next_attempt_at: number | null;
  /** ApiErrorCode, or a client-side label such as "network", of the last failed attempt. */
  last_error: string | null;
  /** Server id from the acknowledgement. */
  response_id: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface NewOutboundResponse {
  query_id: QueryId;
  idempotency_key: IdempotencyKey;
  text: string;
  phone: string | null;
}

const COLUMNS =
  'id, query_id, idempotency_key, text, phone, state, attempts, next_attempt_at, last_error, response_id, created_at, sent_at';

function fromRow(row: SqlRow): OutboundResponse {
  return {
    id: num(row, 'id'),
    query_id: text(row, 'query_id'),
    idempotency_key: text(row, 'idempotency_key'),
    text: text(row, 'text'),
    phone: textOrNull(row, 'phone'),
    state: oneOf(row, 'state', OUTBOUND_RESPONSE_STATES),
    attempts: num(row, 'attempts'),
    next_attempt_at: numOrNull(row, 'next_attempt_at'),
    last_error: textOrNull(row, 'last_error'),
    response_id: textOrNull(row, 'response_id'),
    created_at: num(row, 'created_at'),
    sent_at: numOrNull(row, 'sent_at'),
  };
}

/**
 * Queues a tip, due immediately. Returns the stored row, or null if this device already has a
 * tip for the report (queued, sent or failed), in which case nothing is written.
 */
export async function enqueueResponse(
  db: SqlExecutor,
  response: NewOutboundResponse,
  now: number,
): Promise<OutboundResponse | null> {
  const rows = await db.execute(
    `INSERT INTO outbound_response
       (query_id, idempotency_key, text, share_phone, phone, state, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT (query_id) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      response.query_id,
      response.idempotency_key,
      response.text,
      response.phone === null ? 0 : 1,
      response.phone,
      now,
      now,
    ],
  );
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

export async function getResponseForQuery(
  db: SqlExecutor,
  queryId: QueryId,
): Promise<OutboundResponse | null> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM outbound_response WHERE query_id = ?`, [
    queryId,
  ]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

/** Queued tips whose next attempt is due at `now`, oldest first. */
export async function listDueResponses(db: SqlExecutor, now: number): Promise<OutboundResponse[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM outbound_response
     WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY created_at, id`,
    [now],
  );
  return rows.map(fromRow);
}

/** queued -> sending. Returns false if the row was not queued (another attempt holds it). */
export async function markResponseSending(db: SqlExecutor, id: number): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE outbound_response SET state = 'sending', attempts = attempts + 1
     WHERE id = ? AND state = 'queued' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/** sending -> sent, on the server's acknowledgement. */
export async function markResponseSent(
  db: SqlExecutor,
  id: number,
  responseId: string,
  sentAt: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE outbound_response
     SET state = 'sent', response_id = ?, sent_at = ?, next_attempt_at = NULL, last_error = NULL
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [responseId, sentAt, id],
  );
  return rows.length > 0;
}

/** sending -> queued, to be tried again at `nextAttemptAt`. */
export async function markResponseRetry(
  db: SqlExecutor,
  id: number,
  error: string,
  nextAttemptAt: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE outbound_response SET state = 'queued', last_error = ?, next_attempt_at = ?
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [error, nextAttemptAt, id],
  );
  return rows.length > 0;
}

/** sending -> failed. Final: the tip will not be sent. */
export async function markResponseFailed(
  db: SqlExecutor,
  id: number,
  error: string,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE outbound_response SET state = 'failed', last_error = ?, next_attempt_at = NULL
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [error, id],
  );
  return rows.length > 0;
}

/** Startup recovery: rows left in `sending` by a killed process go back to `queued`, due now. */
export async function requeueInterruptedResponses(db: SqlExecutor, now: number): Promise<number> {
  const rows = await db.execute(
    `UPDATE outbound_response SET state = 'queued', next_attempt_at = ?
     WHERE state = 'sending' RETURNING id`,
    [now],
  );
  return rows.length;
}

/**
 * Retention purge: deletes sent and failed tips finished before the cutoff
 * (OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC ago). Returns how many.
 */
export async function deleteFinishedResponsesBefore(
  db: SqlExecutor,
  cutoffTs: number,
): Promise<number> {
  const rows = await db.execute(
    `DELETE FROM outbound_response
     WHERE state IN ('sent', 'failed') AND coalesce(sent_at, created_at) < ? RETURNING id`,
    [cutoffTs],
  );
  return rows.length;
}
