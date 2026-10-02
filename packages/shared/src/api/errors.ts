import { z } from 'zod';

/**
 * The one error shape every endpoint returns for a non-2xx status:
 *
 *   { "error": { "code": "...", "message": "...", ...optional detail } }
 *
 * `code` is the contract: clients branch on it and render their own copy. `message` is for
 * developers and logs and is never shown to a user. The HTTP status for each code is fixed by
 * API_ERROR_STATUS so the server cannot pick a different one per endpoint.
 *
 * No error may depend on whether any device matched a report (plan 10 item 2).
 */
export const API_ERROR_CODES = [
  /** The body, query or path failed validation. `issues` lists what was wrong. */
  'invalid_request',
  /** No device identity, or one the server does not accept. */
  'unauthenticated',
  /** A known device that may not do this, such as editing someone else's report. */
  'forbidden',
  'not_found',
  /** PATCH: `expected_revision` is not the report's current revision. Re-read and retry. */
  'revision_conflict',
  /** The report has ended or expired, so it can no longer be edited or responded to. */
  'report_not_active',
  /** This device has already sent a different response to this report (plan 9.3). */
  'already_responded',
  /** A request with this Idempotency-Key is still being processed. Retry shortly. */
  'idempotency_in_progress',
  /** This Idempotency-Key was already used with a different request body. */
  'idempotency_key_reused',
  /** PATCH: the edit would narrow the match criteria. `violations` says how. */
  'edit_not_widening',
  'payload_too_large',
  /** A rate limit was hit. `retry_after_sec` says when to try again. Policy is plan 12.1. */
  'rate_limited',
  'internal',
  /** Temporarily unable to serve. Safe to retry with the same Idempotency-Key. */
  'unavailable',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  revision_conflict: 409,
  report_not_active: 409,
  already_responded: 409,
  idempotency_in_progress: 409,
  idempotency_key_reused: 422,
  edit_not_widening: 422,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * `code` is validated as a plain string, not as the enum, so an app that predates a new code
 * can still read the error. Such an app treats an unknown code by its HTTP status.
 */
export const ApiErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    /** Server-side id of this request, for matching a user's report to a log line. */
    request_id: z.string().optional(),
    /** `invalid_request`: one "path: problem" line per failed field. */
    issues: z.array(z.string()).optional(),
    /** `edit_not_widening`: the EditViolation values from payload/widening.ts. */
    violations: z.array(z.string()).optional(),
    /** `rate_limited` and `unavailable`: seconds until a retry can succeed. */
    retry_after_sec: z.number().int().min(0).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

/** Optional detail fields of an error, by name. */
export type ApiErrorDetail = Omit<ApiErrorBody['error'], 'code' | 'message'>;

/** Builds an error body. The server pairs it with API_ERROR_STATUS[code]. */
export function apiError(
  code: ApiErrorCode,
  message: string,
  detail: ApiErrorDetail = {},
): ApiErrorBody {
  return { error: { code, message, ...detail } };
}

/**
 * True when the same request may succeed later without the user changing anything: the send
 * queues retry these and treat every other error as final.
 */
export function isRetryableError(code: string): boolean {
  return (
    code === 'rate_limited' ||
    code === 'internal' ||
    code === 'unavailable' ||
    code === 'idempotency_in_progress'
  );
}
