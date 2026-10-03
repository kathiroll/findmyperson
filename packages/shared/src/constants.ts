/**
 * Every tunable number the contracts depend on, in one place. Consumers import these; nobody
 * writes 150 or 1800 at a call site.
 *
 * Each constant says where it comes from:
 *   DECIDED      a captain decision or a scout report the architecture plan treats as settled.
 *   PLAN         the architecture plan's own choice (data/fmp-arch-plan/report.md, section given).
 *   PROVISIONAL  a bound this package had to pick because a schema needs one. It is structural
 *                (keeps payloads sane), not product policy, and can move without a wire version
 *                bump as long as it only gets looser.
 */

const SECONDS_PER_DAY = 86_400;

/** DECIDED (fmp-granularity, plan 8.1): a match needs distance <= radius_m + this. */
export const MATCH_RADIUS_M = 150;

/** DECIDED (fmp-granularity, plan 8.1): a match needs the time gap to the window <= this. */
export const MATCH_WINDOW_SEC = 30 * 60;

/** DECIDED (fmp-retention, plan 4.7): location history older than this is purged. */
export const RETENTION_DAYS = 30;
export const RETENTION_SEC = RETENTION_DAYS * SECONDS_PER_DAY;

/** PLAN 6.1: a report expires this long after issue by default, and never later (plan 10 item 4). */
export const REPORT_TTL_SEC = RETENTION_SEC;

/** PLAN 4.7: sent or failed outbound responses are purged after this. */
export const OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC = 7 * SECONDS_PER_DAY;

/** PLAN 5.4: consecutive samples within this radius for at least the duration form a stay. */
export const STAY_RADIUS_M = 150;
export const STAY_MIN_DURATION_SEC = 15 * 60;

/**
 * PROVISIONAL (stay derivation). Two derived stays at the same place whose gap is at most this
 * are one stay. It is the matching window on purpose: the matcher already accepts any moment
 * within MATCH_WINDOW_SEC of a stay, so joining two stays across a gap this short claims nothing
 * it would not have accepted anyway. See stay/extract.ts.
 */
export const STAY_MERGE_GAP_SEC = MATCH_WINDOW_SEC;

/** PLAN 4.6: resolution of the `h3_r7` columns and of the `cells` pre-filter in a query. */
export const H3_RES_MATCH = 7;
/** PLAN 7.2: resolution of the shard bundles a device fetches. */
export const H3_RES_SHARD = 5;
/** PLAN 7.3: resolution of the push-wake topics, deliberately coarser than the shards. */
export const H3_RES_PUSH = 3;
/** PLAN 7.2: cap on res-5 cells in a device's subscription set; the excess coarsens to res 3. */
export const SUBSCRIPTION_RES5_CAP = 200;

/**
 * PROVISIONAL. Largest search radius a report may carry. 5 km keeps the res-7 cover of a report
 * to a few dozen cells and inside the 1-ring of res-5 shards a device already subscribes to.
 */
export const MAX_SEARCH_RADIUS_M = 5_000;

/**
 * PROVISIONAL. Slack allowed when an edit moves the centre: the new search disc must cover the
 * old one to within this many metres. It absorbs floating-point noise and coordinate rounding
 * and nothing more; see payload/widening.ts for why it must stay tiny.
 */
export const EDIT_CENTER_TOLERANCE_M = 1;

/** PROVISIONAL text and size caps for the broadcast payload (plan 6.3 budgets ~15 KB a report). */
export const MAX_PERSON_NAME_CHARS = 120;
export const MAX_PERSON_DESCRIPTION_CHARS = 1_000;
export const MAX_PHOTO_EDGE_PX = 256;
export const MAX_PHOTO_BASE64_CHARS = 32_768;
/** Upper bound on `cells`; a 5 km search disc needs well under this many res-7 cells. */
export const MAX_QUERY_CELLS = 128;

/** PROVISIONAL cap on a bystander's tip (plan 9.3: one message, no chat). */
export const MAX_RESPONSE_TEXT_CHARS = 1_000;
