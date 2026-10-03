import { expect } from 'vitest';
import fixture from '../../contracts/stay-vectors.json';
import { matchCellAt } from '../geo/h3';
import type { StaySample } from '../stay/cluster';
import type { SqlExecutor } from '../store/driver';
import { insertLocationSample } from '../store/tables/locationSample';
import {
  CLOSE_VISIT_STAY_SQL,
  INSERT_VISIT_STAY_SQL,
  listStaysOverlapping,
  type Stay,
} from '../store/tables/stay';

/**
 * TEST SUPPORT, not exported from the package. The stay golden vectors, typed, and what the
 * stay tests share: writing fixes and visit rows the way the native modules do, reading the
 * rows back, and a seeded generator of synthetic traces.
 */

export interface VisitRow {
  start_ts: number;
  end_ts: number;
  lat: number;
  lon: number;
  radius_m: number;
  closed: boolean;
}

export interface ExpectedStay {
  start_ts: number;
  end_ts: number;
  lat: number;
  lon: number;
  radius_m: number;
  sample_count: number;
  closed: boolean;
}

export interface StayVector {
  name: string;
  why: string;
  samples: StaySample[];
  visits: VisitRow[];
  /** Sample counts after which the process dies and derivation starts again from the store. */
  restart_after: number[];
  expect: ExpectedStay[];
}

export const stayFixture = fixture;
export const stayVectors: StayVector[] = fixture.vectors;

/** Compares stays with the vectors' tolerances: integers and flags exactly, positions closely. */
export function expectStays(actual: readonly ExpectedStay[], expected: readonly ExpectedStay[]) {
  const exact = (stay: ExpectedStay) => ({
    start_ts: stay.start_ts,
    end_ts: stay.end_ts,
    sample_count: stay.sample_count,
    closed: stay.closed,
  });
  expect(actual.map(exact)).toEqual(expected.map(exact));
  actual.forEach((stay, index) => {
    const want = expected[index];
    if (want === undefined) {
      throw new Error('unreachable: lengths were compared above');
    }
    expect(Math.abs(stay.lat - want.lat)).toBeLessThanOrEqual(fixture.coordinate_tolerance_deg);
    expect(Math.abs(stay.lon - want.lon)).toBeLessThanOrEqual(fixture.coordinate_tolerance_deg);
    expect(Math.abs(stay.radius_m - want.radius_m)).toBeLessThanOrEqual(fixture.radius_tolerance_m);
  });
}

/** Stores fixes as the native module would, in the order given. */
export async function writeSamples(db: SqlExecutor, samples: readonly StaySample[]) {
  for (const sample of samples) {
    await insertLocationSample(db, { ...sample, accuracy_m: 20, source: 'continuous' });
  }
}

/** Stores a visit with the statements the iOS module runs: arrival first, then the departure. */
export async function writeVisit(db: SqlExecutor, visit: VisitRow) {
  const cell = matchCellAt(visit);
  await db.execute(INSERT_VISIT_STAY_SQL, [
    visit.start_ts,
    visit.start_ts,
    visit.lat,
    visit.lon,
    visit.radius_m,
    cell,
    0,
  ]);
  if (visit.closed) {
    await db.execute(CLOSE_VISIT_STAY_SQL, [visit.end_ts, visit.start_ts]);
  }
}

export async function allStays(db: SqlExecutor): Promise<Stay[]> {
  return listStaysOverlapping(db, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

export async function derivedStays(db: SqlExecutor): Promise<Stay[]> {
  return (await allStays(db)).filter((stay) => stay.source === 'derived');
}

export async function visitStays(db: SqlExecutor): Promise<Stay[]> {
  return (await allStays(db)).filter((stay) => stay.source !== 'derived');
}

/** A stored row without the columns the store adds, for comparison with extractStays. */
export function withoutStoreColumns(stay: Stay) {
  return {
    start_ts: stay.start_ts,
    end_ts: stay.end_ts,
    lat: stay.lat,
    lon: stay.lon,
    radius_m: stay.radius_m,
    sample_count: stay.sample_count,
    closed: stay.closed,
    source: stay.source,
  };
}

/** A small deterministic generator, so a failing trace can be reproduced from its seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const METERS_PER_DEGREE_LAT = 111_195;

/**
 * A synthetic day or two of movement: dwells of 5 to 120 minutes at a handful of places a few
 * hundred metres apart (so some dwells are close enough to merge and others are not), with GPS
 * jitter, the odd wild fix, travel between places, and now and then a clock set back. Visits
 * are closed visit rows for some of the dwells, with times a few minutes off the fixes.
 */
export function syntheticTrace(seed: number): { samples: StaySample[]; visits: VisitRow[] } {
  const random = seededRandom(seed);
  const between = (low: number, high: number) => low + random() * (high - low);
  const origin = { lat: 12.9716, lon: 77.5946 };
  const places = Array.from({ length: 5 }, () => ({
    lat: origin.lat + between(-400, 400) / METERS_PER_DEGREE_LAT,
    lon: origin.lon + between(-400, 400) / METERS_PER_DEGREE_LAT,
  }));
  const near = (place: { lat: number; lon: number }, meters: number) => ({
    lat: place.lat + between(-meters, meters) / METERS_PER_DEGREE_LAT,
    lon: place.lon + between(-meters, meters) / METERS_PER_DEGREE_LAT,
  });

  const samples: StaySample[] = [];
  const visits: VisitRow[] = [];
  let now = 1_791_000_000;
  for (let dwell = 0; dwell < 12; dwell++) {
    const place = places[Math.floor(random() * places.length)] ?? origin;
    const arrived = now;
    const leaves = now + Math.round(between(5, 120)) * 60;
    while (now <= leaves) {
      const wild = random() < 0.06;
      samples.push({ ts_utc: now, ...near(place, wild ? 900 : 35) });
      now += Math.round(between(3, 20)) * 60;
    }
    if (random() < 0.4) {
      visits.push({
        start_ts: arrived + Math.round(between(-4, 4)) * 60,
        end_ts: leaves + Math.round(between(-4, 4)) * 60,
        ...near(place, 30),
        radius_m: 65,
        closed: true,
      });
    }
    for (let step = Math.floor(between(0, 3)); step > 0; step--) {
      samples.push({ ts_utc: now, ...near(origin, 3000) });
      now += Math.round(between(3, 10)) * 60;
    }
    if (random() < 0.1) {
      now -= Math.round(between(10, 40)) * 60;
    }
  }
  return { samples, visits: visits.filter((visit) => visit.end_ts >= visit.start_ts) };
}
