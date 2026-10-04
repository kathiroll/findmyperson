import { createHash } from 'node:crypto';
import type { ZodType, z } from 'zod';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  API_ENDPOINTS,
  API_ERROR_STATUS,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyKeySchema,
  QueryIdSchema,
  REPORT_TTL_SEC,
  apiError,
  applyReportPatch,
  canonicalJson,
  classifyCriteriaEdit,
  createStubDeviceAuthenticator,
  describeIssues,
  isWideningEdit,
  type ApiErrorCode,
  type ApiErrorDetail,
  type AuthenticatedDevice,
  type DeviceAuthenticator,
  type Report,
} from '@findmyperson/shared';
import { createLoggingOperatorAlerter, type OperatorAlerter } from './alerts';
import type { ReportRow, ServerDb } from './db';
import { transition, type ReviewAction } from './lifecycle';
import { moderateResponse } from './moderation';
import { createDeviceAllowListOperatorPolicy, type OperatorPolicy } from './operator';
import { registerOperatorPage, type ReportReview } from './operatorPage';
import { newUlid } from './ulid';

export interface AppOptions {
  db: ServerDb;
  /**
   * Device identity is the plain client-generated id (addendum 2026-10-03, decision 2): the
   * stub from @findmyperson/shared IS the real implementation. No attestation, no phone
   * verification. Overridable only so tests can swap nothing else.
   */
  authenticator?: DeviceAuthenticator;
  /** Who may release or reject reports. See operator.ts: NEEDS REAL OPERATOR AUTH. */
  operator?: OperatorPolicy;
  /**
   * The token that opens the operator page (operatorPage.ts). Unset, empty or too short means
   * the page refuses every request. TEMPORARY STUB, to be replaced by real operator login.
   */
  operatorWebToken?: string | undefined;
  alerter?: OperatorAlerter;
  /** Unix seconds. Injectable for tests. */
  now?: () => number;
  logger?: boolean;
}

const RESPONSE_PAGE_SIZE = 50;

class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly detail: ApiErrorDetail = {},
  ) {
    super(message);
  }
}

interface Result {
  status: number;
  body: unknown;
}

function failure(error: ApiFailure, requestId?: string): Result {
  const detail =
    requestId === undefined ? error.detail : { ...error.detail, request_id: requestId };
  return {
    status: API_ERROR_STATUS[error.code],
    body: apiError(error.code, error.message, detail),
  };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { db } = options;
  const authenticator = options.authenticator ?? createStubDeviceAuthenticator();
  const operator = options.operator ?? createDeviceAllowListOperatorPolicy([]);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024 });
  const alerter = options.alerter ?? createLoggingOperatorAlerter(app.log);

  // --- helpers -------------------------------------------------------------------------------

  function parse<S extends ZodType>(schema: S, value: unknown): z.infer<S> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiFailure('invalid_request', 'the request failed validation', {
        issues: describeIssues(parsed.error),
      });
    }
    return parsed.data as z.infer<S>;
  }

  function queryIdParam(req: FastifyRequest): string {
    const id = (req.params as { id?: string }).id;
    const parsed = QueryIdSchema.safeParse(id);
    if (!parsed.success) {
      throw new ApiFailure('not_found', 'no such report');
    }
    return parsed.data;
  }

  /** Reports expire lazily: the first read after `expires_at` records it. */
  function fresh(row: ReportRow): ReportRow {
    if (row.status === 'active' && now() >= row.expires_at) {
      db.setReportStatus(row.query_id, 'expired', now());
      return { ...row, status: 'expired' };
    }
    return row;
  }

  function toReport(row: ReportRow): Report {
    return {
      query_id: row.query_id,
      revision: row.revision,
      status: row.status,
      review_state: row.review_state,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
      center: row.center,
      radius_m: row.radius_m,
      window: row.window,
      person: row.person,
      reporter_phone: row.reporter_phone,
    };
  }

  /** The caller's own report. Anyone else's, and unknown ids, are the same `not_found`. */
  function ownReport(queryId: string, device: AuthenticatedDevice): ReportRow {
    const row = db.getReport(queryId);
    if (row === null || row.reporter_device_id !== device.device_id) {
      throw new ApiFailure('not_found', 'no such report');
    }
    return fresh(row);
  }

  function requireOperator(device: AuthenticatedDevice): void {
    // TODO(operator-auth): real operator authentication goes here. See operator.ts.
    if (!operator.isOperator(device)) {
      throw new ApiFailure('forbidden', 'operator only');
    }
  }

  /**
   * The idempotency convention of shared/src/api/idempotency.ts: scoped to (device, key), same
   * key and body replays the stored outcome, a different body is 422, and 5xx, 401 and 429 are
   * not remembered.
   */
  function idempotent(
    req: FastifyRequest,
    reply: FastifyReply,
    device: AuthenticatedDevice,
    body: unknown,
    run: () => Result,
  ): Result {
    const header = req.headers[IDEMPOTENCY_KEY_HEADER.toLowerCase()];
    const key = IdempotencyKeySchema.safeParse(header);
    if (!key.success) {
      throw new ApiFailure('invalid_request', `${IDEMPOTENCY_KEY_HEADER} header is required`);
    }
    const hash = createHash('sha256')
      .update(canonicalJson({ method: req.method, url: req.url, body }))
      .digest('hex');
    const existing = db.getIdempotency(device.device_id, key.data);
    if (existing !== null) {
      if (existing.request_hash !== hash) {
        throw new ApiFailure('idempotency_key_reused', 'key was used with a different request');
      }
      if (existing.status === null || existing.body_json === null) {
        throw new ApiFailure('idempotency_in_progress', 'the first request is still running');
      }
      reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return { status: existing.status, body: JSON.parse(existing.body_json) };
    }
    db.beginIdempotency(device.device_id, key.data, hash, now());
    let result: Result;
    try {
      result = run();
    } catch (error) {
      if (!(error instanceof ApiFailure)) {
        db.forgetIdempotency(device.device_id, key.data);
        throw error;
      }
      result = failure(error);
    }
    if (result.status >= 500 || result.status === 401 || result.status === 429) {
      db.forgetIdempotency(device.device_id, key.data);
    } else {
      db.finishIdempotency(device.device_id, key.data, result.status, JSON.stringify(result.body));
    }
    return result;
  }

  type Handler = (
    req: FastifyRequest,
    reply: FastifyReply,
    device: AuthenticatedDevice,
  ) => Result | Promise<Result>;

  function route(method: 'GET' | 'POST' | 'PATCH', url: string, handler: Handler): void {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        let result: Result;
        try {
          const device = await authenticator.authenticate(req.headers);
          if (device === null) {
            throw new ApiFailure('unauthenticated', 'a device identity is required');
          }
          result = await handler(req, reply, device);
        } catch (error) {
          if (error instanceof ApiFailure) {
            result = failure(error, req.id);
          } else {
            req.log.error({ err: error }, 'unhandled error');
            result = failure(new ApiFailure('internal', 'internal error'), req.id);
          }
        }
        return reply.code(result.status).send(result.body);
      },
    });
  }

  // --- framework-level errors, in the shared error shape -------------------------------------

  app.setErrorHandler((error, req, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const failed =
      statusCode === 413
        ? new ApiFailure('payload_too_large', 'request body too large')
        : statusCode !== undefined && statusCode >= 400 && statusCode < 500
          ? new ApiFailure('invalid_request', 'the request could not be read')
          : new ApiFailure('internal', 'internal error');
    const result = failure(failed, req.id);
    return reply.code(result.status).send(result.body);
  });
  app.setNotFoundHandler((req, reply) => {
    const result = failure(new ApiFailure('not_found', 'no such route'), req.id);
    return reply.code(result.status).send(result.body);
  });

  // --- POST /v1/devices ----------------------------------------------------------------------

  route(
    API_ENDPOINTS.registerDevice.method,
    API_ENDPOINTS.registerDevice.path,
    (req, _reply, device) => {
      const body = parse(API_ENDPOINTS.registerDevice.request, req.body);
      db.upsertDevice(device.device_id, body.platform, body.app_version, body.push, now());
      return {
        status: API_ENDPOINTS.registerDevice.successStatus,
        body: { device_id: device.device_id, push_registered: body.push !== undefined },
      };
    },
  );

  // --- reports -------------------------------------------------------------------------------

  /** Lands in `pending`. Nothing here broadcasts anything: see lifecycle.ts. */
  route(
    API_ENDPOINTS.submitReport.method,
    API_ENDPOINTS.submitReport.path,
    (req, reply, device) => {
      const body = parse(API_ENDPOINTS.submitReport.request, req.body);
      const result = idempotent(req, reply, device, body, () => {
        const createdAt = now();
        const queryId = newUlid(createdAt * 1000);
        db.insertPendingReport({
          query_id: queryId,
          reporter_device_id: device.device_id,
          created_at: createdAt,
          updated_at: createdAt,
          expires_at: createdAt + REPORT_TTL_SEC,
          center: body.center,
          radius_m: body.radius_m,
          window: body.window,
          person: body.person,
          reporter_phone: body.reporter_phone,
        });
        const row = db.getReport(queryId) as ReportRow;
        return {
          status: API_ENDPOINTS.submitReport.successStatus,
          body: { report: toReport(row) },
        };
      });
      if (
        result.status === API_ENDPOINTS.submitReport.successStatus &&
        reply.getHeader(IDEMPOTENCY_REPLAYED_HEADER) === undefined
      ) {
        const report = (result.body as { report: Report }).report;
        void alertOperator(report);
      }
      return result;
    },
  );

  async function alertOperator(report: Report): Promise<void> {
    try {
      await alerter.reportPending({
        query_id: report.query_id,
        reporter_phone: report.reporter_phone,
        created_at: report.created_at,
      });
    } catch (error) {
      app.log.error({ err: error, query_id: report.query_id }, 'operator alert failed');
    }
  }

  /** Not in the plan's table: lets a reporter see their own report's review state. */
  route('GET', '/v1/reports/:id', (req, _reply, device) => {
    const row = ownReport(queryIdParam(req), device);
    return { status: 200, body: { report: toReport(row) } };
  });

  route(API_ENDPOINTS.patchReport.method, API_ENDPOINTS.patchReport.path, (req, reply, device) => {
    const queryId = queryIdParam(req);
    const patch = parse(API_ENDPOINTS.patchReport.request, req.body);
    return idempotent(req, reply, device, patch, () => {
      const row = ownReport(queryId, device);
      // Meaningful only while the report is awaiting review or live. A rejected, ended or
      // expired report is final.
      if (row.review_state === 'rejected' || row.status !== 'active') {
        throw new ApiFailure('report_not_active', 'the report can no longer be edited');
      }
      if (patch.expected_revision !== row.revision) {
        throw new ApiFailure('revision_conflict', 'the report changed; re-read and retry');
      }
      const next = applyReportPatch(
        { center: row.center, radius_m: row.radius_m, window: row.window, person: row.person },
        patch,
      );
      if (!isWideningEdit(row, next)) {
        const verdict = classifyCriteriaEdit(row, next);
        throw new ApiFailure('edit_not_widening', 'an edit may only widen the match criteria', {
          violations: verdict.kind === 'narrowed' ? verdict.violations : [],
        });
      }
      if (!db.updateReportCriteria(queryId, patch.expected_revision, next, now())) {
        throw new ApiFailure('revision_conflict', 'the report changed; re-read and retry');
      }
      return {
        status: API_ENDPOINTS.patchReport.successStatus,
        body: { report: toReport(db.getReport(queryId) as ReportRow) },
      };
    });
  });

  route(API_ENDPOINTS.endReport.method, API_ENDPOINTS.endReport.path, (req, _reply, device) => {
    const queryId = queryIdParam(req);
    parse(API_ENDPOINTS.endReport.request, req.body ?? {});
    const row = ownReport(queryId, device);
    // Ending is idempotent. It never touches review_state: ending a pending report does not
    // release it, and `release` refuses a report that is no longer active.
    if (row.status === 'active') {
      db.setReportStatus(queryId, 'ended', now());
    }
    return {
      status: API_ENDPOINTS.endReport.successStatus,
      body: { report: toReport(db.getReport(queryId) as ReportRow) },
    };
  });

  // --- responses -----------------------------------------------------------------------------

  route(
    API_ENDPOINTS.submitResponse.method,
    API_ENDPOINTS.submitResponse.path,
    (req, reply, device) => {
      const body = parse(API_ENDPOINTS.submitResponse.request, req.body);
      return idempotent(req, reply, device, body, () => {
        const row = db.getReport(body.query_id);
        // A report that is not released is invisible to devices, so it does not exist for a
        // responder either; the answer is the same as for an unknown id (no oracle).
        if (row === null || row.review_state !== 'released') {
          throw new ApiFailure('not_found', 'no such report');
        }
        if (fresh(row).status !== 'active') {
          throw new ApiFailure('report_not_active', 'the report is no longer accepting responses');
        }
        // One response per (report, device), full stop: no daily or monthly cap (decision 1).
        if (db.hasResponse(body.query_id, device.device_id)) {
          throw new ApiFailure('already_responded', 'this device already responded to this report');
        }
        const receivedAt = now();
        const responseId = newUlid(receivedAt * 1000);
        // THE moderation call site: every response passes through here before it can be relayed.
        const verdict = moderateResponse(body.text);
        try {
          db.insertResponse({
            response_id: responseId,
            query_id: body.query_id,
            device_id: device.device_id,
            text: body.text,
            phone: body.phone,
            received_at: receivedAt,
            moderation: verdict.held ? 'held' : 'delivered',
            held_reason: verdict.held ? verdict.reason : null,
          });
        } catch (error) {
          if (
            String((error as Error).message).includes(
              'UNIQUE constraint failed: responses.query_id',
            )
          ) {
            throw new ApiFailure(
              'already_responded',
              'this device already responded to this report',
            );
          }
          throw error;
        }
        if (verdict.held) {
          req.log.warn(
            {
              event: 'response.held',
              response_id: responseId,
              query_id: body.query_id,
              reason: verdict.reason,
            },
            'response held for manual review (link or payment pattern); not delivered',
          );
        }
        // The ack is identical whether held or delivered: the sender is not told (plan 12.3).
        return {
          status: API_ENDPOINTS.submitResponse.successStatus,
          body: { response_id: responseId, received_at: receivedAt },
        };
      });
    },
  );

  route(
    API_ENDPOINTS.listResponses.method,
    API_ENDPOINTS.listResponses.path,
    (req, _reply, device) => {
      const queryId = queryIdParam(req);
      const query = parse(API_ENDPOINTS.listResponses.request, req.query);
      ownReport(queryId, device);
      let afterSeq = 0;
      if (query.after !== undefined) {
        if (!/^[0-9]{1,15}$/.test(query.after)) {
          throw new ApiFailure('invalid_request', 'after is not a cursor this server issued');
        }
        afterSeq = Number(query.after);
      }
      const rows = db.listDeliveredResponses(queryId, afterSeq, RESPONSE_PAGE_SIZE + 1);
      const page = rows.slice(0, RESPONSE_PAGE_SIZE);
      const last = page[page.length - 1];
      return {
        status: API_ENDPOINTS.listResponses.successStatus,
        body: {
          responses: page.map((r) => ({
            response_id: r.response_id,
            received_at: r.received_at,
            text: r.text,
            phone: r.phone,
          })),
          cursor: last !== undefined ? String(last.seq) : (query.after ?? null),
          has_more: rows.length > RESPONSE_PAGE_SIZE,
        },
      };
    },
  );

  // --- operator: the manual-review gate ------------------------------------------------------
  // Not part of the public API table. Every route here calls requireOperator first.

  /**
   * The one implementation of a review decision. The operator routes below and the operator
   * page both go through it, so the lifecycle rules cannot differ between them.
   */
  function reviewReport(queryId: string, action: ReviewAction, by: string): ReportReview {
    const row = db.getReport(queryId);
    if (row === null) {
      return { ok: false, code: 'not_found', message: 'no such report' };
    }
    const live = fresh(row);
    const moved = transition(live.review_state, action);
    if (!moved.ok) {
      return {
        ok: false,
        code: 'report_not_active',
        message: `report is already ${moved.current}`,
      };
    }
    // An ended or expired report must not go live later.
    if (action === 'release' && live.status !== 'active') {
      return {
        ok: false,
        code: 'report_not_active',
        message: `report is ${live.status}; it cannot be released`,
      };
    }
    if (!db.setReviewState(queryId, moved.next, by, now())) {
      return { ok: false, code: 'report_not_active', message: 'report was decided concurrently' };
    }
    app.log.info({ event: `report.${moved.next}`, query_id: queryId, by }, 'report reviewed');
    return { ok: true, report: db.getReport(queryId) as ReportRow };
  }

  function decide(req: FastifyRequest, device: AuthenticatedDevice, action: ReviewAction): Result {
    requireOperator(device);
    const outcome = reviewReport(queryIdParam(req), action, device.device_id);
    if (!outcome.ok) {
      throw new ApiFailure(outcome.code, outcome.message);
    }
    return { status: 200, body: { report: toReport(outcome.report) } };
  }

  /** The release action. Only this, and `reject`, ever move a report out of `pending`. */
  route('POST', '/v1/operator/reports/:id/release', (req, _reply, device) =>
    decide(req, device, 'release'),
  );
  route('POST', '/v1/operator/reports/:id/reject', (req, _reply, device) =>
    decide(req, device, 'reject'),
  );

  route('GET', '/v1/operator/reports', (req, _reply, device) => {
    requireOperator(device);
    const state = (req.query as { state?: string }).state ?? 'pending';
    if (state !== 'pending' && state !== 'released' && state !== 'rejected') {
      throw new ApiFailure('invalid_request', 'state must be pending, released or rejected');
    }
    return {
      status: 200,
      body: { reports: db.listReportsByReviewState(state).map((r) => toReport(fresh(r))) },
    };
  });

  route('GET', '/v1/operator/responses/held', (_req, _reply, device) => {
    requireOperator(device);
    return { status: 200, body: { responses: db.listHeldResponses() } };
  });

  // --- operator page: the same gate, and held responses, for a browser -----------------------

  registerOperatorPage(app, {
    db,
    now,
    token: options.operatorWebToken,
    listPendingReports: () => db.listReportsByReviewState('pending').map(fresh),
    reviewReport,
  });

  return app;
}
