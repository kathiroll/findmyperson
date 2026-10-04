import { z } from 'zod';
import { MAX_PERSON_PHOTOS } from '../constants';
import {
  LatLonSchema,
  PhoneSchema,
  QueryIdSchema,
  SearchRadiusSchema,
  TimeWindowSchema,
  UnixSecondsSchema,
} from '../payload/primitives';
import {
  MatchCriteriaSchema,
  PersonPhotoSchema,
  PersonSchema,
  type MatchCriteria,
  type Person,
} from '../payload/query';

/**
 * The reporter's endpoints (plan 9.2):
 *
 *   POST  /v1/reports           file a report
 *   PATCH /v1/reports/:id       widen-only edit
 *   POST  /v1/reports/:id/end   end a report
 *
 * `:id` is the report's `query_id`. All three answer with the report as the server now holds
 * it. Nothing in any of these shapes may depend on whether a device matched (plan 10 item 2).
 */

export const ReportSubmitRequestSchema = z.object({
  ...MatchCriteriaSchema.shape,
  person: PersonSchema,
  reporter_phone: PhoneSchema,
  /**
   * SEAM for plan 12.2 (reporter verification, an open decision). Opaque proof that the
   * reporter controls `reporter_phone`. Nothing issues or checks one yet.
   */
  phone_verification: z.string().min(1).max(4_096).optional(),
});
export type ReportSubmitRequest = z.infer<typeof ReportSubmitRequestSchema>;

/**
 * `active` is being broadcast. `ended` was closed by the reporter. `expired` reached
 * `expires_at`. The last two are final.
 */
export const ReportStatusSchema = z.enum(['active', 'ended', 'expired']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

/**
 * The manual-review gate (plan addendum 2026-10-03). Every report is born `pending`: held, never
 * broadcast. Only the operator's explicit release makes it `released`, the one state the shard
 * compiler may read. `rejected` is final and is never broadcast. Nothing automatic changes it.
 *
 * While the review state is not `released`, `status` is a placeholder (`active`) and must not be
 * read as "being broadcast"; clients check `review_state` first. Optional only so reports from a
 * server that predates the gate still parse; the server always sends it.
 */
export const ReviewStateSchema = z.enum(['pending', 'released', 'rejected']);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** A report as its reporter sees it. */
export const ReportSchema = z.object({
  query_id: QueryIdSchema,
  revision: z.number().int().min(1),
  status: ReportStatusSchema,
  review_state: ReviewStateSchema.optional(),
  created_at: UnixSecondsSchema,
  updated_at: UnixSecondsSchema,
  expires_at: UnixSecondsSchema,
  ended_at: UnixSecondsSchema.nullable(),
  ...MatchCriteriaSchema.shape,
  person: PersonSchema,
  reporter_phone: PhoneSchema,
});
export type Report = z.infer<typeof ReportSchema>;

/** The body of every successful report call. */
export const ReportResponseSchema = z.object({ report: ReportSchema });
export type ReportResponse = z.infer<typeof ReportResponseSchema>;

/**
 * In a patch, a field left out is unchanged. `photos` replaces the whole list: there is no way
 * to add or drop one photo other than sending the list as it should become. `photos: null` and
 * `photos: []` both remove every photo.
 */
export const PersonPatchSchema = z.object({
  name: PersonSchema.shape.name.optional(),
  description: PersonSchema.shape.description.optional(),
  photos: z.array(PersonPhotoSchema).max(MAX_PERSON_PHOTOS).nullable().optional(),
});
export type PersonPatch = z.infer<typeof PersonPatchSchema>;

export const ReportPatchRequestSchema = z
  .object({
    /** The revision the edit was made against. A mismatch is 409 `revision_conflict`. */
    expected_revision: z.number().int().min(1),
    center: LatLonSchema.optional(),
    radius_m: SearchRadiusSchema.optional(),
    window: TimeWindowSchema.optional(),
    person: PersonPatchSchema.optional(),
  })
  .refine(
    (patch) =>
      patch.center !== undefined ||
      patch.radius_m !== undefined ||
      patch.window !== undefined ||
      patch.person !== undefined,
    { message: 'the patch changes nothing' },
  );
export type ReportPatchRequest = z.infer<typeof ReportPatchRequestSchema>;

/** POST /v1/reports/:id/end takes an empty JSON object. */
export const ReportEndRequestSchema = z.object({});
export type ReportEndRequest = z.infer<typeof ReportEndRequestSchema>;

/** The parts of a report an edit can change. */
export type EditableReport = MatchCriteria & { person: Person };

/**
 * Applies a patch to a report's editable fields and returns the result. The server and the app
 * both use this, so they agree on what a patch means before either runs classifyCriteriaEdit
 * on the outcome. It does not check the widen-only rule itself.
 */
export function applyReportPatch(
  current: EditableReport,
  patch: ReportPatchRequest,
): EditableReport {
  const person: Person = {
    name: patch.person?.name ?? current.person.name,
    description: patch.person?.description ?? current.person.description,
  };
  const photos = patch.person?.photos === undefined ? current.person.photos : patch.person.photos;
  // No photos is an absent member, never an empty list (PersonSchema).
  if (photos !== undefined && photos !== null && photos.length > 0) {
    person.photos = [...photos];
  }
  return {
    center: patch.center ?? current.center,
    radius_m: patch.radius_m ?? current.radius_m,
    window: patch.window ?? current.window,
    person,
  };
}
