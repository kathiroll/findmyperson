import type { IdempotencyKey } from '../../api/idempotency';
import {
  ReportSchema,
  ReportSubmitRequestSchema,
  type Report,
  type ReportSubmitRequest,
} from '../../api/reports';
import type { QueryId } from '../../payload/primitives';
import {
  num,
  numOrNull,
  oneOf,
  StoreRowError,
  text,
  textOrNull,
  type SqlExecutor,
  type SqlRow,
} from '../driver';

/**
 * `own_report`: the reports this device's owner filed, and the durable queue that submits them.
 *
 * WRITERS: the send queue drives a row from `queued` to acknowledged; the active-report screen
 * records the server's answer to an edit or an end (applyServerReport); the reporter's response
 * fetch moves `responses_cursor`.
 *
 * The plan's schema had no table for the reporter's side. It is one table because a report is
 * one thing to the reporter from the moment they tap Broadcast: first a queued submit that may
 * be waiting for signal, then a live report.
 *
 * State machine:
 *
 *   queued  -> sending                  an attempt starts
 *   sending -> queued                   retryable failure
 *   sending -> failed                   final failure; the server never accepted the report
 *   sending -> active | ended | expired acknowledged: the state is the server's Report.status
 *   active  -> ended | expired          from a later server answer
 *
 * `query_id` and `report` are null exactly while the server has not acknowledged the submit.
 * `request` is the submit as queued; after acknowledgement `report` is the truth.
 */
export const OWN_REPORT_STATES = [
  'queued',
  'sending',
  'active',
  'ended',
  'expired',
  'failed',
] as const;
export type OwnReportState = (typeof OWN_REPORT_STATES)[number];

export interface OwnReport {
  id: number;
  /** Minted when the report is queued and sent unchanged on every submit attempt. */
  idempotency_key: IdempotencyKey;
  query_id: QueryId | null;
  state: OwnReportState;
  request: ReportSubmitRequest;
  report: Report | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  responses_cursor: string | null;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  'id, idempotency_key, query_id, state, request_json, report_json, attempts, next_attempt_at, last_error, responses_cursor, created_at, updated_at';

function fromRow(row: SqlRow): OwnReport {
  const id = num(row, 'id');
  const request = ReportSubmitRequestSchema.safeParse(JSON.parse(text(row, 'request_json')));
  if (!request.success) {
    throw new StoreRowError(`own_report ${id}: request_json does not match the schema`);
  }
  const reportJson = textOrNull(row, 'report_json');
  let report: Report | null = null;
  if (reportJson !== null) {
    const parsed = ReportSchema.safeParse(JSON.parse(reportJson));
    if (!parsed.success) {
      throw new StoreRowError(`own_report ${id}: report_json does not match the schema`);
    }
    report = parsed.data;
  }
  return {
    id,
    idempotency_key: text(row, 'idempotency_key'),
    query_id: textOrNull(row, 'query_id'),
    state: oneOf(row, 'state', OWN_REPORT_STATES),
    request: request.data,
    report,
    attempts: num(row, 'attempts'),
    next_attempt_at: numOrNull(row, 'next_attempt_at'),
    last_error: textOrNull(row, 'last_error'),
    responses_cursor: textOrNull(row, 'responses_cursor'),
    created_at: num(row, 'created_at'),
    updated_at: num(row, 'updated_at'),
  };
}

/** Queues a report for submission, due immediately. Returns the stored row. */
export async function enqueueOwnReport(
  db: SqlExecutor,
  idempotencyKey: IdempotencyKey,
  request: ReportSubmitRequest,
  now: number,
): Promise<OwnReport> {
  const rows = await db.execute(
    `INSERT INTO own_report
       (idempotency_key, state, request_json, next_attempt_at, created_at, updated_at)
     VALUES (?, 'queued', ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    [idempotencyKey, JSON.stringify(request), now, now, now],
  );
  return fromRow(rows[0] ?? {});
}

export async function getOwnReport(db: SqlExecutor, id: number): Promise<OwnReport | null> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM own_report WHERE id = ?`, [id]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

export async function getOwnReportByQueryId(
  db: SqlExecutor,
  queryId: QueryId,
): Promise<OwnReport | null> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM own_report WHERE query_id = ?`, [queryId]);
  return rows[0] === undefined ? null : fromRow(rows[0]);
}

/** Every report of this device's owner, newest first. */
export async function listOwnReports(db: SqlExecutor): Promise<OwnReport[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM own_report ORDER BY created_at DESC, id DESC`,
  );
  return rows.map(fromRow);
}

/** Queued submits whose next attempt is due at `now`, oldest first. */
export async function listDueOwnReports(db: SqlExecutor, now: number): Promise<OwnReport[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM own_report
     WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY created_at, id`,
    [now],
  );
  return rows.map(fromRow);
}

/** queued -> sending. Returns false if the row was not queued. */
export async function markOwnReportSending(
  db: SqlExecutor,
  id: number,
  now: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE own_report SET state = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND state = 'queued' RETURNING id`,
    [now, id],
  );
  return rows.length > 0;
}

/** sending -> acknowledged. The row takes its query id and state from the server's report. */
export async function markOwnReportAcknowledged(
  db: SqlExecutor,
  id: number,
  report: Report,
  now: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE own_report
     SET state = ?, query_id = ?, report_json = ?, next_attempt_at = NULL, last_error = NULL,
         updated_at = ?
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [report.status, report.query_id, JSON.stringify(report), now, id],
  );
  return rows.length > 0;
}

/** sending -> queued, to be tried again at `nextAttemptAt`. */
export async function markOwnReportRetry(
  db: SqlExecutor,
  id: number,
  error: string,
  nextAttemptAt: number,
  now: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE own_report SET state = 'queued', last_error = ?, next_attempt_at = ?, updated_at = ?
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [error, nextAttemptAt, now, id],
  );
  return rows.length > 0;
}

/** sending -> failed. Final: the server did not accept the report. */
export async function markOwnReportFailed(
  db: SqlExecutor,
  id: number,
  error: string,
  now: number,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE own_report SET state = 'failed', last_error = ?, next_attempt_at = NULL, updated_at = ?
     WHERE id = ? AND state = 'sending' RETURNING id`,
    [error, now, id],
  );
  return rows.length > 0;
}

/** Startup recovery: rows left in `sending` by a killed process go back to `queued`, due now. */
export async function requeueInterruptedOwnReports(db: SqlExecutor, now: number): Promise<number> {
  const rows = await db.execute(
    `UPDATE own_report SET state = 'queued', next_attempt_at = ?, updated_at = ?
     WHERE state = 'sending' RETURNING id`,
    [now, now],
  );
  return rows.length;
}

/**
 * Records the server's latest view of an acknowledged report, after an edit, an end or a
 * refresh. An older revision never replaces a newer one. Returns false if this device has no
 * such report or the stored revision is newer.
 */
export async function applyServerReport(
  db: SqlExecutor,
  report: Report,
  now: number,
): Promise<boolean> {
  const existing = await getOwnReportByQueryId(db, report.query_id);
  if (existing?.report == null || existing.report.revision > report.revision) {
    return false;
  }
  await db.execute(
    'UPDATE own_report SET state = ?, report_json = ?, updated_at = ? WHERE query_id = ?',
    [report.status, JSON.stringify(report), now, report.query_id],
  );
  return true;
}

/** Stores the cursor returned by GET /v1/reports/:id/responses. */
export async function setResponsesCursor(
  db: SqlExecutor,
  queryId: QueryId,
  cursor: string,
  now: number,
): Promise<boolean> {
  const rows = await db.execute(
    'UPDATE own_report SET responses_cursor = ?, updated_at = ? WHERE query_id = ? RETURNING id',
    [cursor, now, queryId],
  );
  return rows.length > 0;
}
