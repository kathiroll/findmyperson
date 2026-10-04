import {
  IDEMPOTENCY_KEY_TTL_SEC,
  enqueueOwnReport,
  listDueOwnReports,
  markOwnReportAcknowledged,
  markOwnReportFailed,
  markOwnReportRetry,
  markOwnReportSending,
  requeueInterruptedOwnReports,
  uuidV4FromBytes,
  type OwnReport,
  type Report,
  type ReportSubmitRequest,
  type SqlExecutor,
} from '@findmyperson/shared';
import type { ReportApi } from './api';

/** First retry after this long, doubling per attempt up to the cap. */
export const RETRY_BASE_SEC = 15;
export const RETRY_MAX_SEC = 15 * 60;

export function retryDelaySec(attempts: number): number {
  return Math.min(RETRY_BASE_SEC * 2 ** Math.max(0, attempts - 1), RETRY_MAX_SEC);
}

/**
 * Durably queues a report (`own_report`, state `queued`) with a fresh idempotency key. The row is
 * written before any network call, so a report the reporter confirmed survives a kill, no signal
 * and a restart.
 */
export function enqueueReport(
  db: SqlExecutor,
  request: ReportSubmitRequest,
  randomBytes: (length: number) => Uint8Array,
  now: number,
): Promise<OwnReport> {
  return enqueueOwnReport(db, uuidV4FromBytes(randomBytes(16)), request, now);
}

export interface QueueRunResult {
  /** Rows the server now holds, by `own_report.id`. */
  acknowledged: { id: number; report: Report }[];
  /** Rows that will be tried again later. */
  retrying: { id: number; code: string }[];
  /** Rows the server refused for good (or that outlived their idempotency key). */
  failed: { id: number; code: string; message: string }[];
}

/**
 * One pass over the due rows, oldest first. Rows a killed process left `sending` go back to
 * `queued` first. Never throws for a network or server failure: those are retries or `failed`
 * rows. A store error does throw, and leaves the row for the next pass.
 */
export async function runSubmitQueue(
  db: SqlExecutor,
  api: ReportApi,
  now: () => number,
): Promise<QueueRunResult> {
  const result: QueueRunResult = { acknowledged: [], retrying: [], failed: [] };
  await requeueInterruptedOwnReports(db, now());
  for (const row of await listDueOwnReports(db, now())) {
    if (!(await markOwnReportSending(db, row.id, now()))) continue;
    const attempts = row.attempts + 1;
    // A key the server may have forgotten must not be retried: it could file a second report.
    if (now() - row.created_at > IDEMPOTENCY_KEY_TTL_SEC) {
      await markOwnReportFailed(db, row.id, 'expired_in_queue', now());
      result.failed.push({ id: row.id, code: 'expired_in_queue', message: 'queued too long' });
      continue;
    }
    const outcome = await api.submitReport(row.request, row.idempotency_key);
    if (outcome.kind === 'ok') {
      await markOwnReportAcknowledged(db, row.id, outcome.report, now());
      result.acknowledged.push({ id: row.id, report: outcome.report });
    } else if (outcome.kind === 'retry') {
      const delay = Math.max(retryDelaySec(attempts), outcome.retryAfterSec ?? 0);
      await markOwnReportRetry(db, row.id, outcome.code, now() + delay, now());
      result.retrying.push({ id: row.id, code: outcome.code });
    } else {
      await markOwnReportFailed(db, row.id, outcome.code, now());
      result.failed.push({ id: row.id, code: outcome.code, message: outcome.message });
    }
  }
  return result;
}
