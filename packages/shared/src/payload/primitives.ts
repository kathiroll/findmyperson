import { z } from 'zod';
import {
  H3_RES_MATCH,
  H3_RES_PUSH,
  H3_RES_SHARD,
  MAX_SEARCH_RADIUS_M,
  RETENTION_SEC,
} from '../constants';
import { isH3Cell } from '../geo/h3';
import { KEY_ID_PATTERN, SIGNATURE_PATTERN } from './signing';

/**
 * Field-level schemas shared by the broadcast payload and the API shapes, so a phone number or
 * a search area is validated by the same rule wherever it appears.
 *
 * None of these schemas transforms its input (no trimming, no defaults). Parsing must never
 * change a value, because signed documents are canonicalised from the bytes as received.
 */

/** Whole seconds since the Unix epoch, UTC. Every timestamp in the project uses this unit. */
export const UnixSecondsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const LatLonSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/** A ULID in its canonical 26-character uppercase Crockford base32 form. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const QueryIdSchema = z.string().regex(ULID_PATTERN);
export type QueryId = z.infer<typeof QueryIdSchema>;

/** An E.164 phone number: "+" then 7 to 15 digits, no spaces or punctuation. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
export const PhoneSchema = z.string().regex(E164_PATTERN);

export const KeyIdSchema = z.string().regex(KEY_ID_PATTERN);
export const SignatureSchema = z.string().regex(SIGNATURE_PATTERN);

/** A res-7 H3 cell id, the resolution of every `cells` entry and `h3_r7` column. */
export const MatchCellSchema = z.string().refine((value) => isH3Cell(value, H3_RES_MATCH), {
  message: 'not a res-7 H3 cell id',
});

/** A shard key: an H3 cell id at res 5 (shard bundles) or res 3 (coarsened shards). */
export const ShardCellSchema = z
  .string()
  .refine((value) => isH3Cell(value, H3_RES_SHARD) || isH3Cell(value, H3_RES_PUSH), {
    message: 'not a res-5 or res-3 H3 cell id',
  });

/** When the person was last seen. `from` and `to` may be equal (a single instant). */
export const TimeWindowSchema = z
  .object({ from: UnixSecondsSchema, to: UnixSecondsSchema })
  .refine((window) => window.from <= window.to, { message: 'window.from is after window.to' })
  .refine((window) => window.to - window.from <= RETENTION_SEC, {
    message: 'window is longer than the retention period',
  });
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

/** The reporter's search radius in whole metres. The match test adds MATCH_RADIUS_M to it. */
export const SearchRadiusSchema = z.number().int().min(0).max(MAX_SEARCH_RADIUS_M);
