import { MATCH_RADIUS_M, MATCH_WINDOW_SEC, RETENTION_SEC } from '../constants';
import { haversineMeters, isValidLatLon, type LatLon } from '../geo/distance';
import type { BroadcastQuery, MatchCriteria } from '../payload/query';
import type { LocationSample } from '../store/tables/locationSample';
import type { Stay } from '../store/tables/stay';

/**
 * THE MATCH RULE (plan section 8): is anything in this device's history evidence that it crossed
 * the path of the person in a report? This file is the rule's only home. It opens no store and
 * reads no clock: the caller passes the history and the time, and the same inputs always give the
 * same result.
 *
 * A piece of history is evidence when it is close enough to the report in place and in time:
 *
 *   a stay    whose interval overlaps [window.from - windowSec, window.to + windowSec] and whose
 *             centroid is within radius_m + radiusM of the report's centre;
 *   a sample  taken inside that same time range and within that same distance.
 *
 * Stays are the stronger signal and are looked at first. Samples are the fallback: they are
 * returned only when no stay is evidence. In production radiusM is MATCH_RADIUS_M (150 m) and
 * windowSec is MATCH_WINDOW_SEC (30 minutes); matchParamsAt builds exactly that.
 *
 * THE CRITERIA ARE READ ON A GRID. Before the rule is applied, the report's radius is rounded up
 * to a multiple of radiusStepM and the two ends of its window are rounded outward to multiples of
 * windowStepSec (coarsenCriteria). In production the steps are the same 150 m and 30 minutes.
 *
 * Why: plan 8.3 relies on a report gaining nothing from precision finer than the two constants,
 * because a reporter who could sharpen a report and see who still answers could search for where
 * one person was. The rule above does not give that by itself. A radius of 5 m reaches 155 m and
 * a radius of 140 m reaches 290 m, so two reports that differ only in that would tell their
 * reporter whether somebody was in the ring between. Read on the grid, both radii are 150 m and
 * the two reports match exactly the same history, with exactly the same result. The same holds
 * for "last seen at 18:31:00" and "last seen at 18:45": both are the half hour from 18:30.
 *
 * What the rounding costs and what it keeps:
 *
 *   - It only ever rounds outward, so nothing the rule would find on the report as written is
 *     lost. A report already on the grid (radius 0, 150, 300 ..., window ends on a half hour) is
 *     matched by the rule exactly as written.
 *   - It reaches up to one step further in place and in time than the report as written, which
 *     is more matches. The offline harness (server/src/harness) measures how many.
 *   - A report that crosses a grid line differs from one that does not. That is the resolution
 *     the constants set; nothing finer than it is ever read.
 *   - The centre is not rounded. Moving the centre between reports is the attack the
 *     one-report-a-day limit bounds (plan 8.3).
 *
 * `now` does two things, and nothing else. A report at or past its `expires_at` matches nothing.
 * History older than retentionSec is not evidence, as if the retention purge had just run: a
 * sample before the cutoff is ignored, a stay that ended before it is ignored, and a stay running
 * across it counts from the cutoff on. A phone on which the purge is late therefore matches the
 * same as one on which it is not.
 */

/** What matching reads of a report. A BroadcastQuery is one. */
export type MatchQuery = Pick<
  BroadcastQuery,
  'query_id' | 'revision' | 'expires_at' | 'center' | 'radius_m' | 'window'
>;

/** What matching reads of a `stay` row, whichever writer the row came from, open or closed. */
export type MatchStay = Pick<Stay, 'id' | 'start_ts' | 'end_ts' | 'lat' | 'lon'>;

/** What matching reads of a `location_sample` row. */
export type MatchSample = Pick<LocationSample, 'id' | 'ts_utc' | 'lat' | 'lon'>;

export interface MatchHistory {
  stays: readonly MatchStay[];
  samples: readonly MatchSample[];
}

export interface MatchParams {
  /** The moment the match is made, Unix seconds. The caller reads the clock. */
  now: number;
  /** Metres allowed beyond the report's radius. */
  radiusM: number;
  /** Seconds allowed before and after the report's window. */
  windowSec: number;
  /** The report's radius is read rounded up to a multiple of this many metres. */
  radiusStepM: number;
  /** The ends of the report's window are read rounded outward to multiples of this. */
  windowStepSec: number;
  /** History older than this many seconds before `now` is not evidence. */
  retentionSec: number;
}

/**
 * The parameters every device matches with: the decided constants, at the given time. Anything
 * else is for the offline harness, which measures what other values would do.
 */
export function matchParamsAt(now: number): MatchParams {
  return {
    now,
    radiusM: MATCH_RADIUS_M,
    windowSec: MATCH_WINDOW_SEC,
    radiusStepM: MATCH_RADIUS_M,
    windowStepSec: MATCH_WINDOW_SEC,
    retentionSec: RETENTION_SEC,
  };
}

interface Evidence {
  query_id: MatchQuery['query_id'];
  /** The report revision that was matched. */
  revision: number;
  /** Metres from the report's centre to the stay's centroid or to the sample. */
  distance_m: number;
  /**
   * Seconds between the evidence and the report's window as it was read, that is on the grid;
   * 0 when inside it. Never more than windowSec.
   */
  dt_sec: number;
}

/**
 * One piece of evidence. With `created_at` added it is a NewMatch (store/tables/match.ts): the
 * match runner stores the first result and reads the clock for that column itself.
 */
export type MatchResult =
  | (Evidence & { kind: 'stay'; stay_id: number; sample_id: null })
  | (Evidence & { kind: 'sample'; stay_id: null; sample_id: number });

/**
 * Where and when history can be evidence for a report. Nothing outside it ever is, so a caller
 * may read only the rows inside it: stays with start_ts <= to_ts and end_ts >= from_ts, samples
 * with from_ts <= ts_utc <= to_ts, both within reach_m of center. `from_ts` is never before the
 * retention cutoff.
 */
export interface MatchBounds {
  center: LatLon;
  reach_m: number;
  from_ts: number;
  to_ts: number;
}

/** Later than any real time in seconds; a value above it is milliseconds passed by mistake. */
const MAX_UNIX_SECONDS = 100_000_000_000;

function checkParams(params: MatchParams): void {
  const fail = (what: string, value: number): never => {
    throw new RangeError(`match ${what}, got ${value}`);
  };
  if (!Number.isSafeInteger(params.now) || params.now < 0 || params.now > MAX_UNIX_SECONDS) {
    fail('time must be Unix seconds', params.now);
  }
  if (!(Number.isFinite(params.radiusM) && params.radiusM >= 0)) {
    fail('radius must be zero or more metres', params.radiusM);
  }
  if (!(Number.isFinite(params.windowSec) && params.windowSec >= 0)) {
    fail('window must be zero or more seconds', params.windowSec);
  }
  if (!(Number.isSafeInteger(params.radiusStepM) && params.radiusStepM >= 1)) {
    fail('radius step must be a whole number of metres, 1 or more', params.radiusStepM);
  }
  if (!(Number.isSafeInteger(params.windowStepSec) && params.windowStepSec >= 1)) {
    fail('window step must be a whole number of seconds, 1 or more', params.windowStepSec);
  }
  if (!(Number.isFinite(params.retentionSec) && params.retentionSec >= 0)) {
    fail('retention must be zero or more seconds', params.retentionSec);
  }
}

/** How far `value` is past the multiple of `step` at or below it. NaN stays NaN. */
function pastStep(value: number, step: number): number {
  return ((value % step) + step) % step;
}

function roundDown(value: number, step: number): number {
  return value - pastStep(value, step);
}

function roundUp(value: number, step: number): number {
  const past = pastStep(value, step);
  return past === 0 ? value : value - past + step;
}

/**
 * The criteria as matching reads them: the radius rounded up and the window's ends rounded
 * outward to the grid, the centre as given. See the top of this file for why.
 *
 * A caller that picks rows before calling matchReport must pick them by these, or by matchBounds,
 * and not by the report as written: searchAreaCells(coarse.center, coarse.radius_m) is the cover
 * to read, and it can hold cells the report's own `cells` does not. The radius returned may be
 * one step above MAX_SEARCH_RADIUS_M.
 */
export function coarsenCriteria(
  criteria: MatchCriteria,
  params: Pick<MatchParams, 'radiusStepM' | 'windowStepSec'>,
): MatchCriteria {
  return {
    center: { lat: criteria.center.lat, lon: criteria.center.lon },
    radius_m: roundUp(criteria.radius_m, params.radiusStepM),
    window: {
      from: roundDown(criteria.window.from, params.windowStepSec),
      to: roundUp(criteria.window.to, params.windowStepSec),
    },
  };
}

/** Everything the rule needs of a report, worked out once. Null when nothing can match. */
function scopeOf(
  query: MatchQuery,
  params: MatchParams,
): (MatchBounds & { window: MatchCriteria['window']; cutoff: number }) | null {
  checkParams(params);
  const { center, radius_m, window } = coarsenCriteria(query, params);
  const cutoff = params.now - params.retentionSec;
  const from_ts = Math.max(window.from - params.windowSec, cutoff);
  const to_ts = window.to + params.windowSec;
  const reach_m = radius_m + params.radiusM;
  // Every test is written as "allowed when", so a NaN anywhere in the report matches nothing.
  if (
    !(query.expires_at > params.now) ||
    !(from_ts <= to_ts) ||
    !(reach_m >= 0) ||
    !isValidLatLon(center)
  ) {
    return null;
  }
  return { center, reach_m, from_ts, to_ts, window, cutoff };
}

/**
 * The bounds outside which no history is evidence for the report, or null when nothing can be:
 * the report has expired, or all of its time range is past retention.
 */
export function matchBounds(query: MatchQuery, params: MatchParams): MatchBounds | null {
  const scope = scopeOf(query, params);
  return scope === null
    ? null
    : { center: scope.center, reach_m: scope.reach_m, from_ts: scope.from_ts, to_ts: scope.to_ts };
}

/** Strongest evidence first: nearest in time, then nearest in place, then lowest row id. */
function strongestFirst(a: MatchResult, b: MatchResult): number {
  const rowId = (result: MatchResult) =>
    result.kind === 'stay' ? result.stay_id : result.sample_id;
  return a.dt_sec - b.dt_sec || a.distance_m - b.distance_m || rowId(a) - rowId(b);
}

/**
 * The evidence in `history` that this device crossed the report: every matching stay, or, when
 * no stay matches, every matching sample. Empty when there is none. The strongest evidence is
 * first, and the order of the rows passed in makes no difference.
 *
 * Pass `matchParamsAt(now)`. Throws RangeError if `params` is not usable, for one a time in
 * milliseconds; a report or a row with a NaN in it matches nothing and does not throw.
 */
export function matchReport(
  query: MatchQuery,
  history: MatchHistory,
  params: MatchParams,
): MatchResult[] {
  const scope = scopeOf(query, params);
  if (scope === null) {
    return [];
  }
  const { query_id, revision } = query;
  const stays: MatchResult[] = [];
  for (const stay of history.stays) {
    if (
      stay.start_ts <= stay.end_ts &&
      stay.start_ts <= scope.to_ts &&
      stay.end_ts >= scope.from_ts
    ) {
      const distance_m = haversineMeters(scope.center, stay);
      if (distance_m <= scope.reach_m) {
        // The part of a stay before the retention cutoff is not history any more.
        const start = Math.max(stay.start_ts, scope.cutoff);
        const dt_sec = Math.max(0, start - scope.window.to, scope.window.from - stay.end_ts);
        stays.push({
          kind: 'stay',
          query_id,
          revision,
          stay_id: stay.id,
          sample_id: null,
          distance_m,
          dt_sec,
        });
      }
    }
  }
  if (stays.length > 0) {
    return stays.sort(strongestFirst);
  }
  const samples: MatchResult[] = [];
  for (const sample of history.samples) {
    if (sample.ts_utc >= scope.from_ts && sample.ts_utc <= scope.to_ts) {
      const distance_m = haversineMeters(scope.center, sample);
      if (distance_m <= scope.reach_m) {
        const dt_sec = Math.max(
          0,
          sample.ts_utc - scope.window.to,
          scope.window.from - sample.ts_utc,
        );
        samples.push({
          kind: 'sample',
          query_id,
          revision,
          stay_id: null,
          sample_id: sample.id,
          distance_m,
          dt_sec,
        });
      }
    }
  }
  return samples.sort(strongestFirst);
}
