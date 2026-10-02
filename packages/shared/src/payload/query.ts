import { z } from 'zod';
import {
  MAX_PERSON_DESCRIPTION_CHARS,
  MAX_PERSON_NAME_CHARS,
  MAX_PHOTO_BASE64_CHARS,
  MAX_PHOTO_EDGE_PX,
  MAX_QUERY_CELLS,
  REPORT_TTL_SEC,
} from '../constants';
import {
  KeyIdSchema,
  LatLonSchema,
  MatchCellSchema,
  PhoneSchema,
  QueryIdSchema,
  SearchRadiusSchema,
  SignatureSchema,
  TimeWindowSchema,
  UnixSecondsSchema,
} from './primitives';

/**
 * The broadcast query: one missing-person report as it reaches every device (plan 6.1).
 *
 * Everything the bystander's match screen shows is inside this object, including the photo and
 * the reporter's phone number. Nothing is fetched lazily, because a fetch made only by devices
 * that matched would tell the server who matched (plan 6.2).
 */

/** The payload version this code reads and writes. Any other value is ignored (plan 6.5). */
export const BROADCAST_VERSION = 1;

/**
 * The thumbnail, inline. WebP is preferred; JPEG is allowed because iOS has no built-in WebP
 * encoder. `b64` is standard base64 (RFC 4648 section 4) with padding.
 */
export const PersonPhotoSchema = z.object({
  mime: z.enum(['image/webp', 'image/jpeg']),
  w: z.number().int().min(1).max(MAX_PHOTO_EDGE_PX),
  h: z.number().int().min(1).max(MAX_PHOTO_EDGE_PX),
  b64: z
    .string()
    .min(4)
    .max(MAX_PHOTO_BASE64_CHARS)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export type PersonPhoto = z.infer<typeof PersonPhotoSchema>;

/** The missing person. `photo` is left out, not null, when the reporter supplied none. */
export const PersonSchema = z.object({
  name: z.string().min(1).max(MAX_PERSON_NAME_CHARS),
  description: z.string().max(MAX_PERSON_DESCRIPTION_CHARS),
  photo: PersonPhotoSchema.optional(),
});
export type Person = z.infer<typeof PersonSchema>;

/**
 * The three fields that decide who matches: where, how far, and when. The widen-only rule
 * (payload/widening.ts) is defined over exactly these.
 */
export const MatchCriteriaSchema = z.object({
  center: LatLonSchema,
  radius_m: SearchRadiusSchema,
  window: TimeWindowSchema,
});
export type MatchCriteria = z.infer<typeof MatchCriteriaSchema>;

export const BroadcastQuerySchema = z
  .object({
    v: z.literal(BROADCAST_VERSION),
    /** Report id, a ULID assigned by the server at intake. Stable across revisions. */
    query_id: QueryIdSchema,
    /** Starts at 1; the server bumps it on every accepted edit. */
    revision: z.number().int().min(1),
    key_id: KeyIdSchema,
    issued_at: UnixSecondsSchema,
    expires_at: UnixSecondsSchema,
    ...MatchCriteriaSchema.shape,
    /** The res-7 cover of the search area, exactly as geo/h3.ts searchAreaCells returns it. */
    cells: z.array(MatchCellSchema).min(1).max(MAX_QUERY_CELLS),
    person: PersonSchema,
    /** Mandatory and shown to bystanders who match (decided, plan 6.1). */
    reporter_phone: PhoneSchema,
    /** Where a bystander's tip is posted. The device identity authenticates it (plan 9.3). */
    respond: z.object({
      endpoint: z
        .string()
        .max(2_048)
        .regex(/^https:\/\/[^\s]+$/),
    }),
    sig: SignatureSchema,
  })
  .refine((query) => query.expires_at > query.issued_at, {
    message: 'expires_at is not after issued_at',
  })
  .refine((query) => query.expires_at - query.issued_at <= REPORT_TTL_SEC, {
    message: 'report lifetime is longer than the retention period',
  });

export type BroadcastQuery = z.infer<typeof BroadcastQuerySchema>;

/** A query before the publisher signs it: what signDocument('query', ...) takes. */
export type UnsignedBroadcastQuery = Omit<BroadcastQuery, 'sig'>;

/** What reading one untrusted JSON value as a broadcast query can produce. */
export type ParsedBroadcastQuery =
  | { status: 'ok'; query: BroadcastQuery }
  /** `v` is missing or is not a version this code knows. The entry must be skipped whole. */
  | { status: 'unsupported_version' }
  | { status: 'invalid'; issues: string[] };

/** Renders zod issues as short "path: message" lines for logs and API error details. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
}

/**
 * Reads an untrusted JSON value as a broadcast query. `v` is checked before anything else, and
 * an unknown version is reported as such rather than parsed on a best-effort basis: old apps
 * stay in the field for a long time and must not guess at formats they predate (plan 6.5).
 *
 * This checks shape only. Verify the signature first, on the same raw value, with
 * verifyDocument('query', ...); readShardBundle does both in the right order.
 */
export function parseBroadcastQuery(raw: unknown): ParsedBroadcastQuery {
  const version = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined;
  if (version !== BROADCAST_VERSION) {
    return { status: 'unsupported_version' };
  }
  const parsed = BroadcastQuerySchema.safeParse(raw);
  return parsed.success
    ? { status: 'ok', query: parsed.data }
    : { status: 'invalid', issues: describeIssues(parsed.error) };
}
