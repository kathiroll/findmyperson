import { STAY_MERGE_GAP_SEC, STAY_MIN_DURATION_SEC, STAY_RADIUS_M } from '../constants';
import { haversineMeters, type LatLon } from '../geo/distance';
import type { LocationSample } from '../store/tables/locationSample';
import type { Stay } from '../store/tables/stay';

/**
 * The arithmetic of one dwell: a run of fixes at one place. Everything here is a plain function
 * of its arguments, and a cluster has exactly the shape of the `stay` columns it is stored in.
 * That is deliberate: an open `stay` row is the whole state of the dwell in progress, so a
 * process that dies and comes back continues from the row and computes the same numbers it would
 * have computed without the restart.
 */

/** What stay derivation reads of a fix. */
export type StaySample = Pick<LocationSample, 'ts_utc' | 'lat' | 'lon'>;

/**
 * A dwell being built.
 *   start_ts      time of the first fix. It never changes once set.
 *   end_ts        the latest fix time seen at the place.
 *   lat, lon      centroid: the mean of the member fixes.
 *   radius_m      the largest distance of a member fix from the centroid as it stood when that
 *                 fix joined, so never more than STAY_RADIUS_M. After a merge it is at least
 *                 the distance between the two centroids that were merged.
 *   sample_count  number of member fixes.
 */
export type StayCluster = Pick<
  Stay,
  'start_ts' | 'end_ts' | 'lat' | 'lon' | 'radius_m' | 'sample_count'
>;

/** A weighted mean written so that two equal values give exactly that value back. */
function mean(a: number, weightA: number, b: number, weightB: number): number {
  return a + ((b - a) * weightB) / (weightA + weightB);
}

/** The same for longitudes, taking the short way round across the antimeridian. */
function meanLon(a: number, weightA: number, b: number, weightB: number): number {
  let delta = b - a;
  if (delta > 180) {
    delta -= 360;
  } else if (delta < -180) {
    delta += 360;
  }
  const lon = a + (delta * weightB) / (weightA + weightB);
  if (lon > 180) {
    return lon - 360;
  }
  return lon < -180 ? lon + 360 : lon;
}

/** "The same place", everywhere in stay derivation: within STAY_RADIUS_M. */
export function isSamePlace(a: LatLon, b: LatLon): boolean {
  return haversineMeters(a, b) <= STAY_RADIUS_M;
}

/** A dwell of one fix. */
export function clusterOf(sample: StaySample): StayCluster {
  return {
    start_ts: sample.ts_utc,
    end_ts: sample.ts_utc,
    lat: sample.lat,
    lon: sample.lon,
    radius_m: 0,
    sample_count: 1,
  };
}

/**
 * The cluster with one more fix, or null when the fix is beyond STAY_RADIUS_M of the centroid
 * and so belongs somewhere else.
 *
 * A fix timed before the latest one (the clock was set back) is still counted but does not move
 * end_ts backwards, and start_ts stays where it is.
 */
export function addSample(cluster: StayCluster, sample: StaySample): StayCluster | null {
  const distance = haversineMeters(cluster, sample);
  if (!(distance <= STAY_RADIUS_M)) {
    return null;
  }
  const count = Math.max(cluster.sample_count, 1);
  return {
    start_ts: cluster.start_ts,
    end_ts: Math.max(cluster.end_ts, sample.ts_utc),
    lat: mean(cluster.lat, count, sample.lat, 1),
    lon: meanLon(cluster.lon, count, sample.lon, 1),
    radius_m: Math.max(cluster.radius_m, distance),
    sample_count: cluster.sample_count + 1,
  };
}

/** True once the dwell has lasted long enough to be a stay. */
export function isStay(cluster: StayCluster): boolean {
  return cluster.end_ts - cluster.start_ts >= STAY_MIN_DURATION_SEC;
}

/** True when two dwells are at the same place and overlap or lie within the merge gap. */
export function canMerge(a: StayCluster, b: StayCluster): boolean {
  return (
    b.start_ts - a.end_ts <= STAY_MERGE_GAP_SEC &&
    a.start_ts - b.end_ts <= STAY_MERGE_GAP_SEC &&
    isSamePlace(a, b)
  );
}

/** Two dwells as one: the union of the intervals and the sample-weighted mean of the centroids. */
export function mergeClusters(a: StayCluster, b: StayCluster): StayCluster {
  const weightA = Math.max(a.sample_count, 1);
  const weightB = Math.max(b.sample_count, 1);
  return {
    start_ts: Math.min(a.start_ts, b.start_ts),
    end_ts: Math.max(a.end_ts, b.end_ts),
    lat: mean(a.lat, weightA, b.lat, weightB),
    lon: meanLon(a.lon, weightA, b.lon, weightB),
    radius_m: Math.max(a.radius_m, b.radius_m, haversineMeters(a, b)),
    sample_count: a.sample_count + b.sample_count,
  };
}
