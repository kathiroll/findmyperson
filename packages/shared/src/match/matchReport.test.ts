import { describe, expect, test } from 'vitest';
import fixture from '../../contracts/match-vectors.json';
import { MATCH_RADIUS_M, MATCH_WINDOW_SEC, RETENTION_SEC } from '../constants';
import { EARTH_RADIUS_M, haversineMeters, type LatLon } from '../geo/distance';
import { isWideningEdit } from '../payload/widening';
import { extractStays } from '../stay/extract';
import type { NewMatch } from '../store/tables/match';
import { sampleQuery } from '../testing/fixtures';
import { seededRandom, syntheticTrace } from '../testing/stayVectors';
import {
  coarsenCriteria,
  matchBounds,
  matchParamsAt,
  matchReport,
  type MatchHistory,
  type MatchParams,
  type MatchQuery,
  type MatchResult,
  type MatchSample,
  type MatchStay,
} from './matchReport';

const CENTER: LatLon = { lat: 12.9716, lon: 77.5946 };
/** On a 30-minute mark, and the time syntheticTrace starts at. */
const T0 = 1_791_000_000;
const NOW = T0 + 2 * 86_400;
const PARAMS = matchParamsAt(NOW);
/** The rule on the report exactly as written: no rounding of the criteria. */
const AS_WRITTEN: MatchParams = { ...PARAMS, radiusStepM: 1, windowStepSec: 1 };

function report(criteria: Partial<MatchQuery> = {}): MatchQuery {
  return {
    query_id: '01J8ZQ4T9W3F5K7M2N6P8R0S1V',
    revision: 1,
    expires_at: NOW + 86_400,
    center: CENTER,
    radius_m: 150,
    window: { from: T0, to: T0 + 1_800 },
    ...criteria,
  };
}

/** The point this many metres due north of CENTER. */
function north(meters: number): LatLon {
  return { lat: CENTER.lat + (meters / EARTH_RADIUS_M) * (180 / Math.PI), lon: CENTER.lon };
}

const stayAt = (id: number, place: LatLon, start_ts: number, end_ts: number): MatchStay => ({
  id,
  start_ts,
  end_ts,
  ...place,
});
const sampleAt = (id: number, place: LatLon, ts_utc: number): MatchSample => ({
  id,
  ts_utc,
  ...place,
});

const labelOf = (result: MatchResult) =>
  result.kind === 'stay' ? `stay:${result.stay_id}` : `sample:${result.sample_id}`;
const labels = (results: readonly MatchResult[]) => results.map(labelOf).sort();

/**
 * A day or two of one synthetic device: the fixes of syntheticTrace and the stays stay derivation
 * makes of them, with row ids. The places are within a few hundred metres of CENTER.
 */
function historyOf(seed: number): MatchHistory {
  const trace = syntheticTrace(seed);
  return {
    stays: extractStays(trace.samples).map((stay, index) => ({ id: index + 1, ...stay })),
    samples: trace.samples.map((sample, index) => ({ id: index + 1, ...sample })),
  };
}

/** A report somewhere in the area and the day the synthetic histories cover. */
function randomReport(random: () => number): MatchQuery {
  const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const from = T0 + int(-7_200, 72_000);
  return report({
    center: {
      lat: CENTER.lat + (random() - 0.5) * 0.012,
      lon: CENTER.lon + (random() - 0.5) * 0.012,
    },
    radius_m: int(0, 600),
    window: { from, to: from + int(0, 10_800) },
  });
}

const SEEDS = Array.from({ length: 300 }, (_unused, index) => index + 1);

describe('golden vectors', () => {
  test('the fixture was worked out for the constants the code uses', () => {
    expect(fixture.match_radius_m).toBe(MATCH_RADIUS_M);
    expect(fixture.match_window_sec).toBe(MATCH_WINDOW_SEC);
    expect(fixture.retention_sec).toBe(RETENTION_SEC);
  });

  test.each(fixture.vectors)('$name', ({ now, query, stays, samples, expect: expected }) => {
    const results = matchReport(query, { stays, samples }, matchParamsAt(now));
    const exact = results.map((result) => ({
      kind: result.kind,
      id: result.kind === 'stay' ? result.stay_id : result.sample_id,
      dt_sec: result.dt_sec,
    }));
    expect(exact).toEqual(expected.map(({ kind, id, dt_sec }) => ({ kind, id, dt_sec })));
    results.forEach((result, index) => {
      const wanted = expected[index]?.distance_m ?? Number.NaN;
      expect(Math.abs(result.distance_m - wanted)).toBeLessThanOrEqual(
        fixture.distance_tolerance_m,
      );
      expect(result.query_id).toBe(query.query_id);
      expect(result.revision).toBe(query.revision);
    });
  });

  test('both branches of the rule and both outcomes are among the vectors', () => {
    const kinds = fixture.vectors.map((vector) => vector.expect[0]?.kind ?? 'none');
    expect(new Set(kinds)).toEqual(new Set(['stay', 'sample', 'none']));
  });
});

describe('the rule', () => {
  test('matchParamsAt is the decided constants and nothing else', () => {
    expect(matchParamsAt(NOW)).toEqual({
      now: NOW,
      radiusM: MATCH_RADIUS_M,
      windowSec: MATCH_WINDOW_SEC,
      radiusStepM: MATCH_RADIUS_M,
      windowStepSec: MATCH_WINDOW_SEC,
      retentionSec: RETENTION_SEC,
    });
  });

  test('a report on the grid is matched by the rule of plan 8.1 exactly as written', () => {
    // The rule again, in the plan's own words and independently of the code under test.
    const planRule = (query: MatchQuery, history: MatchHistory): string[] => {
      const near = (place: LatLon) =>
        haversineMeters(place, query.center) <= query.radius_m + MATCH_RADIUS_M;
      const stays = history.stays.filter(
        (stay) =>
          stay.end_ts >= query.window.from - MATCH_WINDOW_SEC &&
          stay.start_ts <= query.window.to + MATCH_WINDOW_SEC &&
          near(stay),
      );
      if (stays.length > 0) {
        return stays.map((stay) => `stay:${stay.id}`).sort();
      }
      return history.samples
        .filter((sample) => {
          const nearest = Math.min(Math.max(sample.ts_utc, query.window.from), query.window.to);
          return Math.abs(sample.ts_utc - nearest) <= MATCH_WINDOW_SEC && near(sample);
        })
        .map((sample) => `sample:${sample.id}`)
        .sort();
    };

    const seen = { stay: 0, sample: 0, none: 0 };
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const loose = randomReport(random);
      const query = report({ ...coarsenCriteria(loose, PARAMS) });
      const history = historyOf(seed);
      const results = matchReport(query, history, PARAMS);
      expect(labels(results)).toEqual(planRule(query, history));
      seen[results[0]?.kind ?? 'none']++;
    }
    // The comparison means something only if all three outcomes occur.
    expect(seen.stay).toBeGreaterThan(30);
    expect(seen.sample).toBeGreaterThan(5);
    expect(seen.none).toBeGreaterThan(30);
  });

  test('the distance bound is inclusive, to the last representable point', () => {
    // Bisect the latitude until two neighbouring doubles straddle the 300 m reach.
    let inside = north(299).lat;
    let outside = north(301).lat;
    for (;;) {
      const middle = (inside + outside) / 2;
      if (middle === inside || middle === outside) {
        break;
      }
      if (haversineMeters(CENTER, { lat: middle, lon: CENTER.lon }) <= 300) {
        inside = middle;
      } else {
        outside = middle;
      }
    }
    const last = { lat: inside, lon: CENTER.lon };
    const first = { lat: outside, lon: CENTER.lon };
    expect(haversineMeters(CENTER, first) - haversineMeters(CENTER, last)).toBeLessThan(1e-6);

    const query = report({ radius_m: 150 });
    const at = (place: LatLon): MatchHistory => ({
      stays: [stayAt(1, place, T0, T0 + 900)],
      samples: [sampleAt(1, place, T0 + 600)],
    });
    expect(labels(matchReport(query, at(last), PARAMS))).toEqual(['stay:1']);
    expect(matchReport(query, at(first), PARAMS)).toEqual([]);
    expect(labels(matchReport(query, { ...at(last), stays: [] }, PARAMS))).toEqual(['sample:1']);
    expect(matchReport(query, { ...at(first), stays: [] }, PARAMS)).toEqual([]);
  });

  test('evidence at exactly the reach matches', () => {
    const place = north(137.5);
    const distance = haversineMeters(CENTER, place);
    const history = { stays: [stayAt(1, place, T0, T0 + 900)], samples: [] };
    const query = report({ radius_m: 0 });
    expect(matchReport(query, history, { ...PARAMS, radiusM: distance })).toHaveLength(1);
    expect(matchReport(query, history, { ...PARAMS, radiusM: distance - 1e-9 })).toEqual([]);
  });

  test('a stay with no length counts as the instant it records', () => {
    // An open visit row is written with end_ts equal to its arrival time.
    const arrival = [stayAt(1, north(50), T0 + 3_600, T0 + 3_600)];
    expect(matchReport(report(), { stays: arrival, samples: [] }, PARAMS)).toMatchObject([
      { kind: 'stay', stay_id: 1, dt_sec: 1_800 },
    ]);
    const late = [stayAt(1, north(50), T0 + 3_601, T0 + 3_601)];
    expect(matchReport(report(), { stays: late, samples: [] }, PARAMS)).toEqual([]);
  });

  test('a whole broadcast query and whole store rows are accepted as they are', () => {
    const query = sampleQuery();
    const stay = {
      id: 4,
      start_ts: query.window.from,
      end_ts: query.window.to,
      ...query.center,
      radius_m: 20,
      h3_r7: '87618925affffff',
      sample_count: 3,
      closed: true,
      source: 'derived',
    };
    const now = query.issued_at;
    const [result] = matchReport(query, { stays: [stay], samples: [] }, matchParamsAt(now));
    expect(result).toEqual({
      kind: 'stay',
      query_id: query.query_id,
      revision: query.revision,
      stay_id: 4,
      sample_id: null,
      distance_m: 0,
      dt_sec: 0,
    });
    // A result is a row of the `match` table once the runner adds the time.
    const row: NewMatch | undefined = result && { ...result, created_at: now };
    expect(row?.stay_id).toBe(4);
  });

  test('no result lies outside the bounds, and reading only inside them loses nothing', () => {
    let matched = 0;
    for (const seed of SEEDS) {
      const query = randomReport(seededRandom(seed));
      const history = historyOf(seed);
      const results = matchReport(query, history, PARAMS);
      const bounds = matchBounds(query, PARAMS);
      if (bounds === null) {
        throw new Error('a live report inside retention has bounds');
      }
      // The bounds are never more than one step beyond the report as written.
      expect(bounds.reach_m).toBeLessThan(query.radius_m + 2 * MATCH_RADIUS_M);
      expect(bounds.from_ts).toBeGreaterThan(query.window.from - 2 * MATCH_WINDOW_SEC);
      expect(bounds.to_ts).toBeLessThan(query.window.to + 2 * MATCH_WINDOW_SEC);
      for (const result of results) {
        expect(result.dt_sec).toBeLessThanOrEqual(MATCH_WINDOW_SEC);
        expect(result.distance_m).toBeLessThanOrEqual(bounds.reach_m);
      }
      const inTime: MatchHistory = {
        stays: history.stays.filter(
          (stay) => stay.start_ts <= bounds.to_ts && stay.end_ts >= bounds.from_ts,
        ),
        samples: history.samples.filter(
          (sample) => sample.ts_utc >= bounds.from_ts && sample.ts_utc <= bounds.to_ts,
        ),
      };
      const inPlace: MatchHistory = {
        stays: inTime.stays.filter(
          (stay) => haversineMeters(stay, bounds.center) <= bounds.reach_m,
        ),
        samples: inTime.samples.filter(
          (sample) => haversineMeters(sample, bounds.center) <= bounds.reach_m,
        ),
      };
      expect(matchReport(query, inTime, PARAMS)).toEqual(results);
      expect(matchReport(query, inPlace, PARAMS)).toEqual(results);
      // Everything outside the time range, on its own, is no evidence at all.
      const outside: MatchHistory = {
        stays: history.stays.filter((stay) => !inTime.stays.includes(stay)),
        samples: history.samples.filter((sample) => !inTime.samples.includes(sample)),
      };
      expect(matchReport(query, outside, PARAMS)).toEqual([]);
      matched += results.length > 0 ? 1 : 0;
    }
    expect(matched).toBeGreaterThan(50);
  });
});

describe('determinism', () => {
  const freeze = (history: MatchHistory): MatchHistory =>
    Object.freeze({
      stays: Object.freeze(history.stays.map((stay) => Object.freeze({ ...stay }))),
      samples: Object.freeze(history.samples.map((sample) => Object.freeze({ ...sample }))),
    });

  test('the same inputs give the same result, and the inputs are not changed', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const query = Object.freeze(randomReport(seededRandom(seed)));
      const history = freeze(historyOf(seed));
      const first = matchReport(query, history, Object.freeze({ ...PARAMS }));
      expect(matchReport(query, history, PARAMS)).toEqual(first);
      expect(history).toEqual(historyOf(seed));
    }
  });

  test('the order of the rows makes no difference', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const random = seededRandom(seed);
      const query = randomReport(random);
      const history = historyOf(seed);
      const shuffled = <T>(rows: readonly T[]): T[] =>
        rows
          .map((row) => ({ row, key: random() }))
          .sort((a, b) => a.key - b.key)
          .map(({ row }) => row);
      const mixed = { stays: shuffled(history.stays), samples: shuffled(history.samples) };
      expect(matchReport(query, mixed, PARAMS)).toEqual(matchReport(query, history, PARAMS));
    }
  });

  test('the clock is the one passed in', () => {
    const history = { stays: [stayAt(1, north(50), T0, T0 + 900)], samples: [] };
    const query = report({ expires_at: T0 + 10 * 86_400 });
    expect(matchReport(query, history, matchParamsAt(T0 + 86_400))).toHaveLength(1);
    // Expired, as of the time given.
    expect(matchReport(query, history, matchParamsAt(T0 + 10 * 86_400))).toEqual([]);
    // Past retention, as of the time given.
    const longLived = report({ expires_at: T0 + 90 * 86_400 });
    expect(matchReport(longLived, history, matchParamsAt(T0 + 31 * 86_400))).toEqual([]);
    expect(matchBounds(longLived, matchParamsAt(T0 + 31 * 86_400))).toBeNull();
  });
});

describe('monotonicity: widening a report never loses a match', () => {
  /** The same report with a larger radius, an earlier start and a later end, or some of those. */
  function widened(query: MatchQuery, random: () => number): MatchQuery {
    const grow = (most: number) => (random() < 0.4 ? 0 : Math.floor(random() * most));
    return {
      ...query,
      radius_m: query.radius_m + grow(500),
      window: { from: query.window.from - grow(7_200), to: query.window.to + grow(7_200) },
    };
  }

  test('with only stays, and with only samples, every match is kept', () => {
    let kept = 0;
    let gained = 0;
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const narrow = randomReport(random);
      const wide = widened(narrow, random);
      // The widen-only edit rule accepts exactly this kind of change.
      expect(isWideningEdit(narrow, wide)).toBe(true);
      const history = historyOf(seed);
      for (const part of [
        { stays: history.stays, samples: [] },
        { stays: [], samples: history.samples },
      ]) {
        const before = labels(matchReport(narrow, part, PARAMS));
        const after = labels(matchReport(wide, part, PARAMS));
        expect(after).toEqual(expect.arrayContaining(before));
        kept += before.length;
        gained += after.length - before.length;
      }
    }
    expect(kept).toBeGreaterThan(500);
    expect(gained).toBeGreaterThan(500);
  });

  test('with both, a device that matched still matches, on evidence at least as strong', () => {
    let upgraded = 0;
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const narrow = randomReport(random);
      const wide = widened(narrow, random);
      const history = historyOf(seed);
      const before = matchReport(narrow, history, PARAMS);
      const after = matchReport(wide, history, PARAMS);
      if (before.length === 0) {
        continue;
      }
      expect(after.length).toBeGreaterThan(0);
      if (before[0]?.kind === after[0]?.kind) {
        expect(labels(after)).toEqual(expect.arrayContaining(labels(before)));
      } else {
        // The only change of kind there can be: samples give way to a stay that now matches.
        expect([before[0]?.kind, after[0]?.kind]).toEqual(['sample', 'stay']);
        upgraded++;
      }
    }
    expect(upgraded).toBeGreaterThan(0);
  });

  test('a larger allowance never loses a match either', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const query = randomReport(seededRandom(seed));
      const history = { stays: historyOf(seed).stays, samples: [] };
      const tight = matchReport(query, history, { ...PARAMS, radiusM: 75, windowSec: 900 });
      const decided = matchReport(query, history, PARAMS);
      expect(labels(decided)).toEqual(expect.arrayContaining(labels(tight)));
    }
  });
});

describe('anti-oracle: precision below 150 m and 30 minutes changes nothing (plan 8.3)', () => {
  test('a pin dropped with 5 m precision matches exactly what one with 140 m precision does', () => {
    // Evidence in the ring between the two reports as written: beyond 5 + 150, within 140 + 150.
    const history: MatchHistory = {
      stays: [stayAt(1, north(120), T0, T0 + 900), stayAt(2, north(220), T0, T0 + 900)],
      samples: [sampleAt(1, north(180), T0 + 300), sampleAt(2, north(280), T0 + 600)],
    };
    const samplesOnly = { stays: [], samples: history.samples };
    const fine = report({ radius_m: 5 });
    const coarse = report({ radius_m: 140 });
    expect(matchReport(fine, history, PARAMS)).toEqual(matchReport(coarse, history, PARAMS));
    expect(matchReport(fine, samplesOnly, PARAMS)).toEqual(
      matchReport(coarse, samplesOnly, PARAMS),
    );
    expect(labels(matchReport(fine, history, PARAMS))).toEqual(['stay:1', 'stay:2']);
    expect(labels(matchReport(fine, samplesOnly, PARAMS))).toEqual(['sample:1', 'sample:2']);

    // Not a vacuous test: the rule on the reports as written does tell them apart, which is the
    // oracle. Reading the criteria on the grid is what removes it.
    expect(labels(matchReport(fine, history, AS_WRITTEN))).toEqual(['stay:1']);
    expect(labels(matchReport(coarse, history, AS_WRITTEN))).toEqual(['stay:1', 'stay:2']);
    expect(labels(matchReport(fine, samplesOnly, AS_WRITTEN))).toEqual([]);
    expect(labels(matchReport(coarse, samplesOnly, AS_WRITTEN))).toEqual(['sample:1', 'sample:2']);
  });

  test('"last seen at 18:31:00" matches exactly what "last seen at 18:45" does', () => {
    // T0 stands for 18:30. As written, the sample at 19:10 is within 30 minutes of 18:45 only,
    // the sample at 18:05 is within 30 minutes of 18:31 only, and the stay from 19:25 is within
    // 30 minutes of neither. Read on the grid both reports are the half hour 18:30 to 19:00,
    // which all three are within 30 minutes of.
    const history: MatchHistory = {
      stays: [stayAt(1, north(50), T0 + 3_300, T0 + 5_000)],
      samples: [sampleAt(1, north(50), T0 + 2_400), sampleAt(2, north(50), T0 - 1_500)],
    };
    const samplesOnly = { stays: [], samples: history.samples };
    const early = report({ window: { from: T0 + 60, to: T0 + 60 } });
    const late = report({ window: { from: T0 + 900, to: T0 + 900 } });
    expect(matchReport(early, history, PARAMS)).toEqual(matchReport(late, history, PARAMS));
    expect(matchReport(early, samplesOnly, PARAMS)).toEqual(matchReport(late, samplesOnly, PARAMS));
    expect(labels(matchReport(early, history, PARAMS))).toEqual(['stay:1']);
    expect(labels(matchReport(early, samplesOnly, PARAMS))).toEqual(['sample:1', 'sample:2']);

    // Not a vacuous test: as written, each report matches a sample the other does not.
    expect(labels(matchReport(early, history, AS_WRITTEN))).toEqual(['sample:2']);
    expect(labels(matchReport(late, history, AS_WRITTEN))).toEqual(['sample:1']);
  });

  test('any two reports that agree on the grid give identical results on any history', () => {
    let matched = 0;
    let toldApartAsWritten = 0;
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const int = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
      const center = {
        lat: CENTER.lat + (random() - 0.5) * 0.012,
        lon: CENTER.lon + (random() - 0.5) * 0.012,
      };
      // One step of radius, (150 (k - 1), 150 k], and one half hour for each end of the window.
      const step = int(0, 4);
      const radius = () => (step === 0 ? 0 : MATCH_RADIUS_M * step - int(0, MATCH_RADIUS_M - 1));
      const first = T0 + MATCH_WINDOW_SEC * int(-4, 40);
      const last = first + MATCH_WINDOW_SEC * int(1, 6);
      const window = () => {
        const from = first + int(0, MATCH_WINDOW_SEC - 1);
        const to = last - int(0, MATCH_WINDOW_SEC - 1);
        return from <= to ? { from, to } : { from: to, to: from };
      };
      const one = report({ center, radius_m: radius(), window: window() });
      const other = report({ center, radius_m: radius(), window: window() });
      expect(coarsenCriteria(one, PARAMS)).toEqual(coarsenCriteria(other, PARAMS));

      const history = historyOf(seed);
      for (const part of [history, { stays: [], samples: history.samples }]) {
        const result = matchReport(one, part, PARAMS);
        // The whole result: which rows, in which order, with which distances and times.
        expect(matchReport(other, part, PARAMS)).toEqual(result);
        matched += result.length > 0 ? 1 : 0;
        toldApartAsWritten +=
          labels(matchReport(one, part, AS_WRITTEN)).join() ===
          labels(matchReport(other, part, AS_WRITTEN)).join()
            ? 0
            : 1;
      }
    }
    // The histories do hold evidence near these reports, and the reports as written would often
    // have been told apart by it.
    expect(matched).toBeGreaterThan(150);
    expect(toldApartAsWritten).toBeGreaterThan(40);
  });

  test('the criteria as read are never narrower than the criteria as written', () => {
    for (const seed of SEEDS) {
      const query = randomReport(seededRandom(seed));
      const coarse = coarsenCriteria(query, PARAMS);
      expect(coarse.center).toEqual(query.center);
      expect(coarse.radius_m).toBeGreaterThanOrEqual(query.radius_m);
      expect(coarse.radius_m - query.radius_m).toBeLessThan(MATCH_RADIUS_M);
      expect(coarse.radius_m % MATCH_RADIUS_M).toBe(0);
      expect(coarse.window.from).toBeLessThanOrEqual(query.window.from);
      expect(query.window.from - coarse.window.from).toBeLessThan(MATCH_WINDOW_SEC);
      expect(coarse.window.to).toBeGreaterThanOrEqual(query.window.to);
      expect(coarse.window.to - query.window.to).toBeLessThan(MATCH_WINDOW_SEC);
      expect(coarse.window.from % MATCH_WINDOW_SEC).toBe(0);
      expect(coarse.window.to % MATCH_WINDOW_SEC).toBe(0);
      expect(coarsenCriteria(coarse, PARAMS)).toEqual(coarse);

      // So nothing the rule finds on the report as written is lost by reading it on the grid.
      const history = historyOf(seed);
      for (const part of [
        { stays: history.stays, samples: [] },
        { stays: [], samples: history.samples },
      ]) {
        expect(labels(matchReport(query, part, PARAMS))).toEqual(
          expect.arrayContaining(labels(matchReport(query, part, AS_WRITTEN))),
        );
      }
    }
  });

  test('known limit: a pin move the edit rule permits can still drop evidence', () => {
    // The widen-only rule (payload/widening.ts) judges the criteria as written. Radius 100 to
    // 140 with the pin moved 40 m is a covering edit there, but both radii are read as 150, so
    // on the grid the disc moves without growing. See "Matching" in README.md.
    const before = report({ radius_m: 100 });
    const moved = { lat: CENTER.lat - (north(40).lat - CENTER.lat), lon: CENTER.lon };
    const after = report({ radius_m: 140, center: moved, revision: 2 });
    expect(isWideningEdit(before, after)).toBe(true);
    const history = { stays: [stayAt(1, north(295), T0, T0 + 900)], samples: [] };
    expect(matchReport(before, history, PARAMS)).toHaveLength(1);
    expect(matchReport(after, history, PARAMS)).toEqual([]);
  });
});

describe('bad input', () => {
  const history: MatchHistory = {
    stays: [stayAt(1, north(50), T0, T0 + 900)],
    samples: [sampleAt(1, north(50), T0 + 600)],
  };

  test.each([
    ['radius', report({ radius_m: Number.NaN })],
    ['latitude', report({ center: { lat: Number.NaN, lon: CENTER.lon } })],
    ['longitude', report({ center: { lat: CENTER.lat, lon: Number.NaN } })],
    ['window start', report({ window: { from: Number.NaN, to: T0 } })],
    ['window end', report({ window: { from: T0, to: Number.NaN } })],
    ['expiry', report({ expires_at: Number.NaN })],
  ])('a report with a NaN %s matches nothing', (_label, query) => {
    expect(matchReport(query, history, PARAMS)).toEqual([]);
    expect(matchBounds(query, PARAMS)).toBeNull();
  });

  test('a window written backwards matches nothing it does not reach', () => {
    const backwards = report({ window: { from: T0 + 86_400, to: T0 - 86_400 } });
    expect(matchReport(backwards, history, PARAMS)).toEqual([]);
  });

  test('a broken row is skipped and the rows beside it still count', () => {
    const nan = Number.NaN;
    const stays = [
      stayAt(2, { lat: nan, lon: CENTER.lon }, T0, T0 + 900),
      stayAt(3, north(50), nan, T0 + 900),
      stayAt(4, north(50), T0, nan),
      // Ends before it begins.
      stayAt(5, north(50), T0 + 900, T0),
    ];
    const samples = [sampleAt(2, north(50), nan), sampleAt(3, { lat: CENTER.lat, lon: nan }, T0)];
    expect(matchReport(report(), { stays, samples }, PARAMS)).toEqual([]);
    expect(
      labels(matchReport(report(), { stays: [...stays, ...history.stays], samples }, PARAMS)),
    ).toEqual(['stay:1']);
    expect(
      labels(matchReport(report(), { stays, samples: [...samples, ...history.samples] }, PARAMS)),
    ).toEqual(['sample:1']);
  });

  test.each<[string, Partial<MatchParams>]>([
    ['a time in milliseconds', { now: NOW * 1_000 }],
    ['a time that is not a whole second', { now: NOW + 0.5 }],
    ['a NaN time', { now: Number.NaN }],
    ['a negative radius', { radiusM: -1 }],
    ['a NaN radius', { radiusM: Number.NaN }],
    ['an infinite window', { windowSec: Number.POSITIVE_INFINITY }],
    ['a radius step of zero', { radiusStepM: 0 }],
    ['a fractional radius step', { radiusStepM: 0.5 }],
    ['a window step of zero', { windowStepSec: 0 }],
    ['a NaN window step', { windowStepSec: Number.NaN }],
    ['a negative retention', { retentionSec: -1 }],
  ])('%s is refused', (_label, change) => {
    const params = { ...PARAMS, ...change };
    expect(() => matchReport(report(), history, params)).toThrow(RangeError);
    expect(() => matchBounds(report(), params)).toThrow(RangeError);
  });
});
