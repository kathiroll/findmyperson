import {
  API_ENDPOINTS,
  ApiErrorBodySchema,
  DEVICE_AUTH_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  ReportResponseSchema,
  formatDeviceAuthorization,
  isRetryableError,
  type DeviceIdentity,
  type IdempotencyKey,
  type Report,
  type ReportSubmitRequest,
} from '@findmyperson/shared';

/**
 * Where the findmyperson backend lives. NOBODY SUPPLIES THIS YET (no deployment exists): until a
 * build sets it, every submit is "retry later" with the code `api_not_configured`, so a report
 * stays safely queued on the phone instead of being dropped or reported as sent.
 */
export const API_BASE_URL: string | null = null;

/** What one submit attempt came to. Only `ok` means the server holds the report. */
export type SubmitOutcome =
  | { kind: 'ok'; report: Report }
  /** Nothing is known to have been stored; the same request may be sent again unchanged. */
  | { kind: 'retry'; code: string; retryAfterSec?: number }
  /** The server answered and will never accept this request. */
  | { kind: 'rejected'; code: string; message: string };

export interface ReportApi {
  /** POST /v1/reports, with the queue row's idempotency key so a retry never files two. */
  submitReport(request: ReportSubmitRequest, key: IdempotencyKey): Promise<SubmitOutcome>;
}

/** The part of `fetch` this client uses. */
export type ApiFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export interface ReportApiOptions {
  baseUrl: string | null;
  identity: Pick<DeviceIdentity, 'getDeviceId'>;
  fetch?: ApiFetch;
  timeoutMs?: number;
}

export const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * The submit call over `fetch`. Auth goes through the device identity seam (the plain device id,
 * addendum 2026-10-03): the stub's header, built by `formatDeviceAuthorization`.
 */
export function createReportApi(options: ReportApiOptions): ReportApi {
  const send = options.fetch ?? (globalThis.fetch as unknown as ApiFetch);
  const timeoutMs = options.timeoutMs ?? SUBMIT_TIMEOUT_MS;
  const endpoint = API_ENDPOINTS.submitReport;
  return {
    async submitReport(request, key) {
      if (options.baseUrl === null) {
        return { kind: 'retry', code: 'api_not_configured' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status: number;
      let body: string;
      try {
        const deviceId = await options.identity.getDeviceId();
        const response = await send(`${options.baseUrl}${endpoint.path}`, {
          method: endpoint.method,
          headers: {
            'Content-Type': 'application/json',
            [DEVICE_AUTH_HEADER]: formatDeviceAuthorization(deviceId),
            [IDEMPOTENCY_KEY_HEADER]: key,
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        status = response.status;
        // Read to the end inside the timeout: a cut-off body must not pass for an answer.
        body = await response.text();
      } catch {
        return { kind: 'retry', code: 'network' };
      } finally {
        clearTimeout(timer);
      }

      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      if (status === endpoint.successStatus) {
        const parsed = ReportResponseSchema.safeParse(json);
        // The key makes a resend harmless, so an unreadable success is retried, not failed.
        return parsed.success
          ? { kind: 'ok', report: parsed.data.report }
          : { kind: 'retry', code: 'bad_response' };
      }
      const error = ApiErrorBodySchema.safeParse(json);
      const code = error.success ? error.data.error.code : `http_${status}`;
      const message = error.success ? error.data.error.message : `HTTP ${status}`;
      if (status >= 500 || status === 408 || status === 429 || isRetryableError(code)) {
        const wait = error.success ? error.data.error.retry_after_sec : undefined;
        return wait === undefined
          ? { kind: 'retry', code }
          : { kind: 'retry', code, retryAfterSec: wait };
      }
      return { kind: 'rejected', code, message };
    },
  };
}
