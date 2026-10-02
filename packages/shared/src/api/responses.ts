import { z } from 'zod';
import { MAX_RESPONSE_TEXT_CHARS } from '../constants';
import { PhoneSchema, QueryIdSchema, ULID_PATTERN, UnixSecondsSchema } from '../payload/primitives';

/**
 * A bystander's tip, and the reporter reading tips (plan 9.2, 9.3):
 *
 *   POST /v1/responses               bystander sends one tip
 *   GET  /v1/reports/:id/responses   reporter reads the tips for their report
 *
 * A tip is one-way: at most one per device per report, no reply channel. The field holding the
 * message is called `text` everywhere: here, in `outbound_response` and in
 * `received_response`.
 */

/** A response id, a ULID assigned by the server. */
export const ResponseIdSchema = z.string().regex(ULID_PATTERN);

export const ResponseSubmitRequestSchema = z
  .object({
    query_id: QueryIdSchema,
    /** The message. May be empty only when a phone number is shared. */
    text: z.string().max(MAX_RESPONSE_TEXT_CHARS),
    /**
     * The bystander's own number if they chose to share it, null if they chose to stay
     * anonymous. It is required and never defaulted, so the choice is always explicit.
     */
    phone: PhoneSchema.nullable(),
  })
  .refine((response) => response.text.length > 0 || response.phone !== null, {
    message: 'a response needs a message or a phone number',
  });
export type ResponseSubmitRequest = z.infer<typeof ResponseSubmitRequestSchema>;

/**
 * The acknowledgement. Only after receiving it may the app say "sent" (plan 9.3). It says the
 * server has the tip, not that the reporter has seen it. It carries no moderation state;
 * whether a sender is ever told about moderation is plan 12.3's decision, not this shape's.
 */
export const ResponseSubmitResponseSchema = z.object({
  response_id: ResponseIdSchema,
  received_at: UnixSecondsSchema,
});
export type ResponseSubmitResponse = z.infer<typeof ResponseSubmitResponseSchema>;

/** One tip as the reporter receives it. */
export const ReceivedResponseSchema = z.object({
  response_id: ResponseIdSchema,
  /** When the server received the tip. */
  received_at: UnixSecondsSchema,
  text: z.string().max(MAX_RESPONSE_TEXT_CHARS),
  /** The responder's number if they shared it, otherwise null. */
  phone: PhoneSchema.nullable(),
});
export type ReceivedResponse = z.infer<typeof ReceivedResponseSchema>;

/** Query string of GET /v1/reports/:id/responses. */
export const ResponseListQuerySchema = z.object({
  /** The `cursor` of an earlier page. Left out, the list starts from the oldest tip. */
  after: z.string().min(1).max(256).optional(),
});
export type ResponseListQuery = z.infer<typeof ResponseListQuerySchema>;

export const ResponseListResponseSchema = z.object({
  /** Oldest first. Tips held or rejected by moderation never appear. */
  responses: z.array(ReceivedResponseSchema),
  /**
   * Opaque position just past the last tip returned. The app stores it
   * (`own_report.responses_cursor`) and sends it as `after` next time, so a later fetch brings
   * only newer tips. Null when there are no tips yet and no `after` was given.
   */
  cursor: z.string().min(1).max(256).nullable(),
  /** True when more tips are already waiting beyond this page. */
  has_more: z.boolean(),
});
export type ResponseListResponse = z.infer<typeof ResponseListResponseSchema>;
