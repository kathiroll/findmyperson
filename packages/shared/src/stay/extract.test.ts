import { describe, expect, test } from 'vitest';
import { STAY_MERGE_GAP_SEC, STAY_MIN_DURATION_SEC, STAY_RADIUS_M } from '../constants';
import {
  expectStays,
  stayFixture,
  stayVectors,
  syntheticTrace,
  type VisitRow,
} from '../testing/stayVectors';
import { extractStays, overlapsVisit } from './extract';

const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9816, lon: 77.5946 };
const minutes = (count: number) => 1_791_000_000 + count * 60;
const fix = (minute: number, at = home) => ({ ts_utc: minutes(minute), ...at });

describe('golden vectors', () => {
  test('the fixture was worked out for the thresholds the code uses', () => {
    expect(stayFixture.stay_radius_m).toBe(STAY_RADIUS_M);
    expect(stayFixture.stay_min_duration_sec).toBe(STAY_MIN_DURATION_SEC);
    expect(stayFixture.stay_merge_gap_sec).toBe(STAY_MERGE_GAP_SEC);
  });

  test('the fixture covers the cases the derivation task names', () => {
    const names = stayVectors.map((vector) => vector.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'a clean single stay',
        'a stay that spans app restarts',
        'adjacent stays at the same place merge',
        'overlapping stays merge when the clock is set back',
        'a visit row and fixes for the same window give no derived stay',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  test.each(stayVectors)('$name', ({ samples, visits, expect: expected }) => {
    const stays = extractStays(samples, visits);
    expectStays(stays, expected);
    expect(stays.every((stay) => stay.source === 'derived')).toBe(true);
  });
});

describe('extractStays', () => {
  test('gives nothing for no fixes, one fix, or fixes always on the move', () => {
    expect(extractStays([])).toEqual([]);
    expect(extractStays([fix(0)])).toEqual([]);
    const moving = Array.from({ length: 40 }, (_, step) =>
      fix(step * 15, { lat: home.lat + step * 0.003, lon: home.lon }),
    );
    expect(extractStays(moving)).toEqual([]);
  });

  test('closes a stay at its last fix inside the radius, not at the fix that left', () => {
    const [stay] = extractStays([fix(0), fix(15), fix(30), fix(45, office)]);
    expect(stay).toMatchObject({ start_ts: minutes(0), end_ts: minutes(30), closed: true });
  });

  test('only the last stay can be open', () => {
    const stays = extractStays([fix(0), fix(15), fix(30, office), fix(45, office)]);
    expect(stays.map((stay) => stay.closed)).toEqual([true, false]);
  });

  test('a fix at the same place after a long silence continues the stay', () => {
    const [stay, ...more] = extractStays([fix(0), fix(15), fix(15 + 26 * 60), fix(30 + 26 * 60)]);
    expect(more).toEqual([]);
    expect(stay).toMatchObject({ end_ts: minutes(30 + 26 * 60), sample_count: 4, closed: false });
  });

  test('does not change the lists it is given', () => {
    const samples = Object.freeze([fix(0), fix(15), fix(30)].map((s) => Object.freeze(s)));
    const visits = Object.freeze([
      Object.freeze({ start_ts: minutes(40), end_ts: minutes(90), ...home, closed: true }),
    ]);
    expect(extractStays(samples, visits)).toHaveLength(1);
  });

  test('is ordered by start time', () => {
    const { samples, visits } = syntheticTrace(7);
    const starts = extractStays(samples, visits).map((stay) => stay.start_ts);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});

describe('over synthetic traces', () => {
  const seeds = Array.from({ length: 60 }, (_, index) => index + 1);

  test('the traces exercise what the properties are about', () => {
    const all = seeds.map((seed) => {
      const { samples, visits } = syntheticTrace(seed);
      return { visits, stays: extractStays(samples, visits), plain: extractStays(samples) };
    });
    expect(all.filter((run) => run.stays.length >= 3).length).toBeGreaterThan(30);
    // Visits remove stays that would otherwise be derived, and leave others standing.
    expect(all.some((run) => run.plain.length > run.stays.length)).toBe(true);
    expect(all.some((run) => run.visits.length > 0 && run.stays.length > 0)).toBe(true);
  });

  test.each(seeds)('seed %i: every stay is well formed', (seed) => {
    const { samples, visits } = syntheticTrace(seed);
    const stays = extractStays(samples, visits);
    for (const stay of stays) {
      expect(stay.end_ts - stay.start_ts).toBeGreaterThanOrEqual(STAY_MIN_DURATION_SEC);
      expect(stay.sample_count).toBeGreaterThanOrEqual(2);
      expect(stay.radius_m).toBeGreaterThanOrEqual(0);
      expect(stay.radius_m).toBeLessThanOrEqual(STAY_RADIUS_M);
    }
    expect(stays.filter((stay) => !stay.closed).length).toBeLessThanOrEqual(1);
    expect(stays.reduce((sum, stay) => sum + stay.sample_count, 0)).toBeLessThanOrEqual(
      samples.length,
    );
  });

  test.each(seeds)('seed %i: no stay overlaps a visit at the same place', (seed) => {
    const { samples, visits } = syntheticTrace(seed);
    for (const stay of extractStays(samples, visits)) {
      expect(overlapsVisit(stay, visits)).toBe(false);
    }
  });

  test.each(seeds)('seed %i: an open visit changes nothing', (seed) => {
    const { samples, visits } = syntheticTrace(seed);
    const open: VisitRow[] = visits.map((visit) => ({
      ...visit,
      end_ts: visit.start_ts,
      closed: false,
    }));
    expect(extractStays(samples, open)).toEqual(extractStays(samples));
  });
});
