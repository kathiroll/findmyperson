import { z } from 'zod';
import { REPORT_TTL_SEC } from '../constants';
import { UUID_V4_PATTERN } from '../uuid';

/**
 * The idempotency convention. A phone sends from a durable queue and may retry a request it
 * cannot know succeeded (no signal, killed mid-send), so every request that creates or changes
 * something must be safe to send twice.
 *
 * 1. The client mints one key per user action, a version 4 UUID, at the moment the action is
 *    queued. It is stored in the queue row (`own_report.idempotency_key`,
 *    `outbound_response.idempotency_key`) and sent unchanged on every retry, in the
 *    `Idempotency-Key` header.
 *
 * 2. The server scopes keys to the authenticated device: the unit is (device_id, key).
 *      - First time: process the request and remember the status and body under the key.
 *      - Same key, same body: return the remembered status and body, with
 *        `Idempotency-Replayed: true`. Nothing is done twice.
 *      - Same key, different body: 422 `idempotency_key_reused`.
 *      - Same key while the first request is still running: 409 `idempotency_in_progress`.
 *    Bodies are compared by their canonical JSON. Outcomes are remembered for 2xx and for 4xx
 *    other than 401 and 429; a 5xx is not remembered, so a retry runs again.
 *
 * 3. The server keeps a key for at least IDEMPOTENCY_KEY_TTL_SEC. A client stops retrying
 *    before then, so a retry never arrives after its key was forgotten.
 *
 * 4. Which endpoints need the header is recorded per endpoint in api/endpoints.ts. Requests
 *    that are idempotent by nature (registering a device, ending a report, any GET) take none.
 *
 * 5. Separately from the header, a tip is unique per (query_id, device_id) by construction
 *    (plan 9.3). A second POST /v1/responses for the same pair under a new key gets
 *    409 `already_responded`; it is not a replay.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/** PROVISIONAL. Matches the report lifetime: no queued request outlives the report it is for. */
export const IDEMPOTENCY_KEY_TTL_SEC = REPORT_TTL_SEC;

/** An idempotency key is a lowercase version 4 UUID (uuid.ts builds one from random bytes). */
export const IdempotencyKeySchema = z.string().regex(UUID_V4_PATTERN);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
