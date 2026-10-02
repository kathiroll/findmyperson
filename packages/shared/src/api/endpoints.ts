import type { QueryId } from '../payload/primitives';
import { DeviceRegistrationRequestSchema, DeviceRegistrationResponseSchema } from './devices';
import {
  ReportEndRequestSchema,
  ReportPatchRequestSchema,
  ReportResponseSchema,
  ReportSubmitRequestSchema,
} from './reports';
import {
  ResponseListQuerySchema,
  ResponseListResponseSchema,
  ResponseSubmitRequestSchema,
  ResponseSubmitResponseSchema,
} from './responses';

/**
 * The backend's public endpoints (plan 9.2), as data. The server registers its routes from
 * this table and the app builds its requests from it, so method, path, body shape, success
 * status and idempotency rule each have one definition.
 *
 * Every endpoint requires a device identity (identity/deviceIdentity.ts) and answers failures
 * with the shape in api/errors.ts. Paths use `:id` for the report's `query_id`, the same
 * syntax Fastify routes use.
 *
 * `idempotencyKey` is 'required' where the request must carry an Idempotency-Key header
 * (api/idempotency.ts) and 'none' where repeating the request is harmless by nature.
 */
export const API_ENDPOINTS = {
  registerDevice: {
    method: 'POST',
    path: '/v1/devices',
    idempotencyKey: 'none',
    successStatus: 200,
    request: DeviceRegistrationRequestSchema,
    response: DeviceRegistrationResponseSchema,
  },
  submitReport: {
    method: 'POST',
    path: '/v1/reports',
    idempotencyKey: 'required',
    successStatus: 201,
    request: ReportSubmitRequestSchema,
    response: ReportResponseSchema,
  },
  patchReport: {
    method: 'PATCH',
    path: '/v1/reports/:id',
    idempotencyKey: 'required',
    successStatus: 200,
    request: ReportPatchRequestSchema,
    response: ReportResponseSchema,
  },
  endReport: {
    method: 'POST',
    path: '/v1/reports/:id/end',
    idempotencyKey: 'none',
    successStatus: 200,
    request: ReportEndRequestSchema,
    response: ReportResponseSchema,
  },
  /** A GET: `request` describes the query string, not a body. */
  listResponses: {
    method: 'GET',
    path: '/v1/reports/:id/responses',
    idempotencyKey: 'none',
    successStatus: 200,
    request: ResponseListQuerySchema,
    response: ResponseListResponseSchema,
  },
  submitResponse: {
    method: 'POST',
    path: '/v1/responses',
    idempotencyKey: 'required',
    successStatus: 201,
    request: ResponseSubmitRequestSchema,
    response: ResponseSubmitResponseSchema,
  },
} as const;

export type ApiEndpointName = keyof typeof API_ENDPOINTS;

/** Fills the `:id` of a report path, for example reportPath('patchReport', queryId). */
export function reportPath(
  endpoint: 'patchReport' | 'endReport' | 'listResponses',
  queryId: QueryId,
): string {
  return API_ENDPOINTS[endpoint].path.replace(':id', queryId);
}
