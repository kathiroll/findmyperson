import { EDIT_CENTER_TOLERANCE_M } from '../constants';
import { haversineMeters, type LatLon } from '../geo/distance';
import type { MatchCriteria } from './query';

/**
 * The widen-only edit rule (plan 8.3). This file is its only home: the server calls it to accept
 * or reject a PATCH, the reporter's app calls it to disable a Save that would be rejected, and
 * the device calls it to decide whether a new revision needs matching again.
 *
 * Why the rule exists: a reporter who could narrow a report and watch whether tips keep
 * arriving could binary-search for where a specific person was. So once a report is live, the
 * set of (place, time) pairs it matches may only grow.
 *
 * An edit is allowed when the new criteria match everything the old criteria matched:
 *
 *   1. window: the new window contains the old one (from no later, to no earlier);
 *   2. radius: the new radius is not smaller;
 *   3. centre: the new search disc covers the old one, that is
 *          distance(old centre, new centre) + old radius <= new radius + EDIT_CENTER_TOLERANCE_M
 *
 * Rule 3 is deliberately a coverage test and not "the centre may move up to N metres". A
 * per-edit allowance can be spent again on every edit, so a chain of small moves would walk the
 * centre across a city, which is the centre-moving attack the one-report-a-day limit is meant
 * to bound. Under the coverage test every revision's search area contains all earlier ones, so
 * no sequence of edits narrows anything. Moving the pin is still possible: the radius has to
 * grow by the distance moved (minRadiusForCenterMove). The tolerance only absorbs floating-point
 * noise; at 1 m per edit it is negligible next to the 150 m match radius.
 *
 * Descriptive fields (name, description, photo) are not match criteria and are not judged here.
 */

/** Each way an edit can narrow the criteria. An edit can have several at once. */
export type EditViolation =
  /** `window.from` moved later, dropping times the old window covered. */
  | 'window_from_later'
  /** `window.to` moved earlier. */
  | 'window_to_earlier'
  /** `radius_m` got smaller. */
  | 'radius_smaller'
  /** The new search disc does not cover the old one (centre moved without enough radius). */
  | 'center_not_covered';

export type EditVerdict =
  /** Centre, radius and window are all identical. Nothing to re-match. */
  | { kind: 'unchanged' }
  /** The criteria changed and only grew. Devices must match this revision again. */
  | { kind: 'widened' }
  /** The edit would drop something the old criteria matched. It must be rejected. */
  | { kind: 'narrowed'; violations: EditViolation[] };

/** Classifies a change of match criteria. Inputs must already satisfy MatchCriteriaSchema. */
export function classifyCriteriaEdit(previous: MatchCriteria, next: MatchCriteria): EditVerdict {
  const violations: EditViolation[] = [];
  // Every test is written as "allowed when", so a NaN anywhere fails closed.
  if (!(next.window.from <= previous.window.from)) {
    violations.push('window_from_later');
  }
  if (!(next.window.to >= previous.window.to)) {
    violations.push('window_to_earlier');
  }
  if (!(next.radius_m >= previous.radius_m)) {
    violations.push('radius_smaller');
  }
  const moved = haversineMeters(previous.center, next.center);
  if (!(moved + previous.radius_m <= next.radius_m + EDIT_CENTER_TOLERANCE_M)) {
    violations.push('center_not_covered');
  }
  if (violations.length > 0) {
    return { kind: 'narrowed', violations };
  }
  const unchanged =
    next.center.lat === previous.center.lat &&
    next.center.lon === previous.center.lon &&
    next.radius_m === previous.radius_m &&
    next.window.from === previous.window.from &&
    next.window.to === previous.window.to;
  return { kind: unchanged ? 'unchanged' : 'widened' };
}

/**
 * True when an edit is permitted under the widen-only rule: the criteria are unchanged or only
 * grew. Use classifyCriteriaEdit when the caller needs to know which, or why not.
 */
export function isWideningEdit(previous: MatchCriteria, next: MatchCriteria): boolean {
  return classifyCriteriaEdit(previous, next).kind !== 'narrowed';
}

/**
 * The smallest `radius_m` that lets the centre move to `newCenter` under the rule. A client
 * that lets the reporter drag the pin sets the radius to at least this. The result can exceed
 * MAX_SEARCH_RADIUS_M, in which case the move is not possible as an edit.
 */
export function minRadiusForCenterMove(previous: MatchCriteria, newCenter: LatLon): number {
  const needed = haversineMeters(previous.center, newCenter) + previous.radius_m;
  return Math.max(previous.radius_m, Math.ceil(needed - EDIT_CENTER_TOLERANCE_M));
}
