import { describe, expect, test } from 'vitest';
import { STAY_MERGE_GAP_SEC, STAY_MIN_DURATION_SEC, STAY_RADIUS_M } from '../constants';
import { haversineMeters } from '../geo/distance';
import {
  addSample,
  canMerge,
  clusterOf,
  isSamePlace,
  isStay,
  mergeClusters,
  type StayCluster,
} from './cluster';

const home = { lat: 12.9716, lon: 77.5946 };
/** One ten-thousandth of a degree of latitude is 11.12 m. */
const north = (units: number) => ({ lat: home.lat + units * 1e-4, lon: home.lon });
const fix = (ts_utc: number, at = home) => ({ ts_utc, ...at });

function built(...fixes: ReturnType<typeof fix>[]): StayCluster {
  const [first, ...rest] = fixes;
  if (first === undefined) {
    throw new Error('a cluster needs a fix');
  }
  return rest.reduce((cluster, next) => {
    const grown = addSample(cluster, next);
    if (grown === null) {
      throw new Error('fix is outside the cluster');
    }
    return grown;
  }, clusterOf(first));
}

describe('a cluster', () => {
  test('of one fix is that fix, with no extent', () => {
    expect(clusterOf(fix(100))).toEqual({
      start_ts: 100,
      end_ts: 100,
      ...home,
      radius_m: 0,
      sample_count: 1,
    });
  });

  test('of identical fixes keeps the coordinates exactly', () => {
    const cluster = built(fix(0), fix(900), fix(1800), fix(2700));
    expect(cluster).toEqual({
      start_ts: 0,
      end_ts: 2700,
      ...home,
      radius_m: 0,
      sample_count: 4,
    });
  });

  test('has the mean of its fixes as centroid and the largest joining distance as radius', () => {
    const cluster = built(fix(0), fix(900, north(2)), fix(1800, north(-2)));
    expect(cluster.lat).toBeCloseTo(home.lat, 12);
    expect(cluster.lon).toBe(home.lon);
    // The third fix joined 3e-4 degrees from the centroid of the first two.
    expect(cluster.radius_m).toBeCloseTo(haversineMeters(north(1), north(-2)), 9);
    expect(cluster.sample_count).toBe(3);
  });

  test('takes a fix at the radius and refuses one beyond it', () => {
    const edge = north(13.4);
    expect(haversineMeters(home, edge)).toBeLessThanOrEqual(STAY_RADIUS_M);
    expect(addSample(clusterOf(fix(0)), fix(60, edge))).not.toBeNull();
    const beyond = north(13.6);
    expect(haversineMeters(home, beyond)).toBeGreaterThan(STAY_RADIUS_M);
    expect(addSample(clusterOf(fix(0)), fix(60, beyond))).toBeNull();
  });

  test('measures the radius from the centroid, not from the first fix', () => {
    // The centroid of fixes at 0, 111 and 133 m north is 82 m north. A fix 222 m north is
    // beyond the radius of the first fix and 141 m from the centroid, so it joins.
    const cluster = built(fix(0), fix(60, north(10)), fix(120, north(12)));
    expect(haversineMeters(home, north(20))).toBeGreaterThan(STAY_RADIUS_M);
    expect(addSample(clusterOf(fix(0)), fix(180, north(20)))).toBeNull();
    expect(addSample(cluster, fix(180, north(20)))).toMatchObject({ sample_count: 4 });
  });

  test('refuses a fix with a coordinate that is not a number', () => {
    expect(addSample(clusterOf(fix(0)), fix(60, { lat: Number.NaN, lon: home.lon }))).toBeNull();
  });

  test('counts a fix timed before the last one without moving either end back', () => {
    const cluster = built(fix(1000), fix(1900), fix(400));
    expect(cluster).toMatchObject({ start_ts: 1000, end_ts: 1900, sample_count: 3 });
  });

  test('is a stay once it spans the minimum duration, to the second', () => {
    expect(isStay(built(fix(0), fix(STAY_MIN_DURATION_SEC - 1)))).toBe(false);
    expect(isStay(built(fix(0), fix(STAY_MIN_DURATION_SEC)))).toBe(true);
  });

  test('averages longitudes the short way across the antimeridian', () => {
    const fiji = (lon: number) => ({ lat: -16.8, lon });
    const cluster = built(fix(0, fiji(179.9996)), fix(900, fiji(-179.9996)));
    expect(Math.abs(cluster.lon)).toBeCloseTo(180, 9);
    expect(cluster.radius_m).toBeLessThan(100);
    const east = built(fix(0, fiji(-179.9994)), fix(900, fiji(179.9998)));
    expect(east.lon).toBeCloseTo(-179.9998, 9);
    expect(east.lon).toBeGreaterThanOrEqual(-180);
    expect(isSamePlace(cluster, east)).toBe(true);
  });
});

describe('merging', () => {
  const first = built(fix(0), fix(900), fix(1800));
  const later = (start: number, at = home) => built(fix(start, at), fix(start + 900, at));

  test('joins stays at the same place up to the merge gap apart, and no further', () => {
    expect(canMerge(first, later(1800 + STAY_MERGE_GAP_SEC))).toBe(true);
    expect(canMerge(first, later(1800 + STAY_MERGE_GAP_SEC + 1))).toBe(false);
  });

  test('joins overlapping stays whichever is given first', () => {
    expect(canMerge(first, later(600))).toBe(true);
    expect(canMerge(later(600), first)).toBe(true);
    expect(canMerge(later(1800 + STAY_MERGE_GAP_SEC + 1), first)).toBe(false);
  });

  test('never joins stays at different places', () => {
    expect(canMerge(first, later(1900, north(13.6)))).toBe(false);
    expect(canMerge(first, later(1900, north(13.4)))).toBe(true);
  });

  test('gives the union of the intervals and the sample-weighted centroid', () => {
    const merged = mergeClusters(first, later(2700, north(10)));
    expect(merged).toMatchObject({ start_ts: 0, end_ts: 3600, sample_count: 5 });
    expect(merged.lat).toBeCloseTo(home.lat + 4e-4, 12);
    expect(merged.radius_m).toBeCloseTo(haversineMeters(home, north(10)), 9);
  });
});
