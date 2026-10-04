import {
  matchBounds,
  matchParamsAt,
  matchReport,
  type MatchHistory,
  type MatchParams,
  type MatchQuery,
} from '@findmyperson/shared';
import {
  buildPopulation,
  CAPTURE_INTERVAL_SEC,
  DAY,
  HEALTHY_CAPTURE,
  HOUR,
  isStill,
  MINUTE,
  positionIn,
  segmentAt,
  SIM_END_SEC,
  SIM_START,
  STREAM,
  streamRng,
  toLatLon,
  type CaptureProfile,
  type Person,
  type Point,
  type Rng,
  type Scenario,
} from './mobility';

/**
 * THE OFFLINE MATCHING HARNESS (plan 8.4, task M5.1): how often does matchReport find the
 * people who really crossed a missing person's path, and how many others does it notify?
 *
 * One run, for one scenario of mobility.ts:
 *
 *   1. Build the population and what each phone captured over three days.
 *   2. File reports. For each, one simulated person is the missing person, last seen at a
 *      moment of the second day between 07:00 and 22:00, wherever they then were: at home, at
 *      work, in a shop or on the way. The reporter knows the place only roughly: the pin is off
 *      by up to 0.8 of the radius they state, and the window they state holds the moment
 *      somewhere inside it. Radii and window lengths are drawn from REPORT_RADII_M and
 *      REPORT_WINDOWS_MIN. Pins near the edge of the area are not used (EDGE_MARGIN_M).
 *   3. Work out the truth from the true positions, minute by minute, with no reference to the
 *      phones: who crossed, who was merely in the stated area, who was neither.
 *   4. Run matchReport for every report against every other phone's captured history.
 *
 * The words used in the results:
 *
 *   crossed      At some whole minute of the stated window the missing person was inside the
 *                stated search area and this person was within CROSSING_RANGE_M of them. These
 *                are the people the report is looking for. A crossing is "still" when the
 *                bystander was at that minute in a stop of 15 minutes or more, and "moving"
 *                otherwise. A pass at vehicle speed between two whole minutes is not counted.
 *   in the area  Did not cross, but was truly inside the stated area at some minute of the
 *                stated window. Notifying them is what the reporter asked for.
 *   outside      Neither. Notifying them is the cost of the 150 m and 30 minutes of allowance,
 *                of reading the criteria on the grid, and of fix error.
 *   recall       Crossers that matched, out of all crossers.
 *   false-positive rate
 *                Phones that matched without having crossed, out of all that did not cross.
 *                Every simulated phone other than the missing person's is taken to have received
 *                the report. The rate depends on how large an area is simulated (the further
 *                away the phones, the smaller it gets), so read it beside the count per report.
 *   precision    Crossers among the phones that matched.
 *
 * Counts per report are given for ADOPTION_REFERENCE of residents carrying the app. They scale
 * in proportion: twice the adoption, twice the notifications. Rates do not depend on adoption.
 */

/** Two people this close at the same minute crossed paths. */
export const CROSSING_RANGE_M = 50;

/** Counts per report are scaled to this share of residents carrying the app. */
export const ADOPTION_REFERENCE = 0.1;

/**
 * A report is kept only if its pin is at least this far from the edge of the simulated area.
 * Nobody lives beyond the edge, so a search area that reached past it would be short of people
 * to notify and the false-positive figures would come out too low. 1,500 m is the furthest any
 * variant reaches: a 1,000 m radius read on a 300 m grid, plus 300 m.
 */
export const EDGE_MARGIN_M = 1_500;

/** What reporters state, and how often: a radius in metres and a window length in minutes. */
export const REPORT_RADII_M: readonly (readonly [number, number])[] = [
  [100, 0.35],
  [250, 0.3],
  [500, 0.25],
  [1_000, 0.1],
];
export const REPORT_WINDOWS_MIN: readonly (readonly [number, number])[] = [
  [30, 0.3],
  [60, 0.3],
  [120, 0.25],
  [240, 0.15],
];

export interface Variant {
  name: string;
  describes: string;
  params(now: number): MatchParams;
}

/** The parameters every device uses, and three others to see what they would change. */
export const VARIANTS: readonly Variant[] = [
  {
    name: 'shipped',
    describes: '150 m, 30 min, criteria read on the 150 m / 30 min grid',
    params: matchParamsAt,
  },
  {
    name: 'as-written',
    describes: '150 m, 30 min, criteria as written (the rule of plan 8.1 with no rounding)',
    params: (now) => ({ ...matchParamsAt(now), radiusStepM: 1, windowStepSec: 1 }),
  },
  {
    name: 'half',
    describes: '75 m, 15 min, criteria read on that grid',
    params: (now) => ({
      ...matchParamsAt(now),
      radiusM: 75,
      windowSec: 900,
      radiusStepM: 75,
      windowStepSec: 900,
    }),
  },
  {
    name: 'double',
    describes: '300 m, 60 min, criteria read on that grid',
    params: (now) => ({
      ...matchParamsAt(now),
      radiusM: 300,
      windowSec: 3_600,
      radiusStepM: 300,
      windowStepSec: 3_600,
    }),
  },
];

export interface HarnessOptions {
  /** Simulated people, each carrying the app. */
  devices: number;
  reports: number;
  seed: number;
  capture: CaptureProfile;
}

export const DEFAULT_OPTIONS: HarnessOptions = {
  devices: 4_000,
  reports: 400,
  seed: 20_261_004,
  capture: HEALTHY_CAPTURE,
};

interface Report {
  person: number;
  center: Point;
  radiusM: number;
  /** Seconds from SIM_START, whole minutes. */
  from: number;
  to: number;
  query: MatchQuery;
}

function pick(rng: Rng, choices: readonly (readonly [number, number])[]): number {
  let left = rng.next();
  for (const [value, share] of choices) {
    left -= share;
    if (left < 0) {
      return value;
    }
  }
  return choices[choices.length - 1]?.[0] ?? 0;
}

function fileReports(scenario: Scenario, people: readonly Person[], options: HarnessOptions) {
  const rng = streamRng(options.seed, STREAM.reports);
  const now = SIM_START + SIM_END_SEC;
  const reports: Report[] = [];
  const inside = (value: number) =>
    value >= EDGE_MARGIN_M && value <= scenario.sideM - EDGE_MARGIN_M;
  for (let tries = 0; reports.length < options.reports && tries < 500 * options.reports; tries++) {
    const n = reports.length;
    const person = rng.int(0, people.length - 1);
    const seenAt = DAY + rng.between(7 * HOUR, 22 * HOUR);
    const subject = people[person];
    if (subject === undefined) {
      continue;
    }
    const seen = positionIn(segmentAt(subject, seenAt), seenAt);
    const radiusM = pick(rng, REPORT_RADII_M);
    const lengthSec = pick(rng, REPORT_WINDOWS_MIN) * MINUTE;
    // People give a time to the minute.
    const from = Math.floor((seenAt - rng.next() * lengthSec) / MINUTE) * MINUTE;
    const angle = rng.between(0, 2 * Math.PI);
    const off = 0.8 * radiusM * Math.sqrt(rng.next());
    const center = { x: seen.x + off * Math.cos(angle), y: seen.y + off * Math.sin(angle) };
    if (!inside(center.x) || !inside(center.y)) {
      continue;
    }
    reports.push({
      person,
      center,
      radiusM,
      from,
      to: from + lengthSec,
      query: {
        query_id: `HARNESS-${n}`,
        revision: 1,
        expires_at: now + DAY,
        center: toLatLon(scenario.origin, center),
        radius_m: radiusM,
        window: { from: SIM_START + from, to: SIM_START + from + lengthSec },
      },
    });
  }
  return { reports, now };
}

/** Everybody's true position at every whole minute from `start`, minute by minute. */
function truePositions(people: readonly Person[], start: number, minutes: number) {
  const count = people.length;
  const xs = new Float32Array(count * minutes);
  const ys = new Float32Array(count * minutes);
  people.forEach((person, index) => {
    let at = 0;
    for (let minute = 0; minute < minutes; minute++) {
      const t = start + minute * MINUTE;
      while (at < person.segments.length - 1 && (person.segments[at]?.t1 ?? Infinity) < t) {
        at++;
      }
      const segment = person.segments[at];
      if (segment !== undefined) {
        const point = positionIn(segment, t);
        xs[minute * count + index] = point.x;
        ys[minute * count + index] = point.y;
      }
    }
  });
  return { xs, ys };
}

const CROSSED = 1;
const CROSSED_STILL = 2;
const IN_AREA = 4;

interface Tally {
  reports: number;
  crossers: number;
  crossersStill: number;
  others: number;
  matchedCrossers: number;
  matchedCrossersStill: number;
  matchedInArea: number;
  matchedOutside: number;
  byStay: number;
}

const emptyTally = (): Tally => ({
  reports: 0,
  crossers: 0,
  crossersStill: 0,
  others: 0,
  matchedCrossers: 0,
  matchedCrossersStill: 0,
  matchedInArea: 0,
  matchedOutside: 0,
  byStay: 0,
});

/** The rows of a phone's history that lie in a time range, which is all matchReport can use. */
function between(history: MatchHistory, fromTs: number, toTs: number): MatchHistory {
  const { samples } = history;
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((samples[middle]?.ts_utc ?? Infinity) < fromTs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  let end = low;
  while (end < samples.length && (samples[end]?.ts_utc ?? Infinity) <= toTs) {
    end++;
  }
  return {
    samples: samples.slice(low, end),
    stays: history.stays.filter((stay) => stay.start_ts <= toTs && stay.end_ts >= fromTs),
  };
}

export interface Measured {
  /** A variant's name, or a stated radius for the breakdown by radius. */
  name: string;
  reports: number;
  recall: number;
  recallStill: number;
  recallMoving: number;
  falsePositiveRate: number;
  precision: number;
  /** Per report, at ADOPTION_REFERENCE. notified = crossed + inArea + outside. */
  notified: number;
  crossed: number;
  inArea: number;
  outside: number;
  /** Share of matches whose evidence was a stay; the rest were sample fallbacks. */
  byStay: number;
  counts: Tally;
}

export interface ScenarioResult {
  scenario: string;
  describes: string;
  devices: number;
  reports: number;
  areaKm2: number;
  /** Share of residents carrying the app that the simulated number of phones amounts to. */
  simulatedAdoption: number;
  /** True crossers per report, at ADOPTION_REFERENCE. */
  crossersPerReport: number;
  capture: CaptureProfile;
  variants: Measured[];
  /** The shipped parameters, by the radius the reporter stated. */
  shippedByRadius: Measured[];
}

function measured(name: string, tally: Tally, scale: number): Measured {
  const ratio = (part: number, whole: number) => (whole === 0 ? 0 : part / whole);
  const falsePositives = tally.matchedInArea + tally.matchedOutside;
  const matched = tally.matchedCrossers + falsePositives;
  const perReport = (count: number) => ratio(count, tally.reports) * scale;
  return {
    name,
    reports: tally.reports,
    recall: ratio(tally.matchedCrossers, tally.crossers),
    recallStill: ratio(tally.matchedCrossersStill, tally.crossersStill),
    recallMoving: ratio(
      tally.matchedCrossers - tally.matchedCrossersStill,
      tally.crossers - tally.crossersStill,
    ),
    falsePositiveRate: ratio(falsePositives, tally.others),
    precision: ratio(tally.matchedCrossers, matched),
    notified: perReport(matched),
    crossed: perReport(tally.matchedCrossers),
    inArea: perReport(tally.matchedInArea),
    outside: perReport(tally.matchedOutside),
    byStay: ratio(tally.byStay, matched),
    counts: tally,
  };
}

export function runScenario(
  scenario: Scenario,
  options: HarnessOptions = DEFAULT_OPTIONS,
  variants: readonly Variant[] = VARIANTS,
): ScenarioResult {
  const { people, phones } = buildPopulation(
    scenario,
    options.devices,
    options.capture,
    options.seed,
  );
  const { reports, now } = fileReports(scenario, people, options);
  const count = people.length;

  const start = Math.min(...reports.map((report) => report.from));
  const end = Math.max(...reports.map((report) => report.to));
  const minutes = reports.length === 0 ? 0 : (end - start) / MINUTE + 1;
  const { xs, ys } = truePositions(people, start, minutes);

  const tallies = variants.map(emptyTally);
  const byRadius = new Map<number, Tally>();
  const truth = new Uint8Array(count);
  const rangeSq = CROSSING_RANGE_M * CROSSING_RANGE_M;

  for (const report of reports) {
    truth.fill(0);
    const radiusSq = report.radiusM * report.radiusM;
    for (let t = report.from; t <= report.to; t += MINUTE) {
      const row = ((t - start) / MINUTE) * count;
      const px = xs[row + report.person] ?? 0;
      const py = ys[row + report.person] ?? 0;
      const personInside = (px - report.center.x) ** 2 + (py - report.center.y) ** 2 <= radiusSq;
      for (let index = 0; index < count; index++) {
        const x = xs[row + index] ?? 0;
        const y = ys[row + index] ?? 0;
        let flags = truth[index] ?? 0;
        if ((x - report.center.x) ** 2 + (y - report.center.y) ** 2 <= radiusSq) {
          flags |= IN_AREA;
        }
        if (personInside && (x - px) ** 2 + (y - py) ** 2 <= rangeSq) {
          flags |= CROSSED;
          if ((flags & CROSSED_STILL) === 0) {
            const bystander = people[index];
            const segment = bystander === undefined ? undefined : segmentAt(bystander, t);
            if (
              segment !== undefined &&
              isStill(segment) &&
              segment.t1 - segment.t0 >= CAPTURE_INTERVAL_SEC
            ) {
              flags |= CROSSED_STILL;
            }
          }
        }
        truth[index] = flags;
      }
    }

    const radiusTally = byRadius.get(report.radiusM) ?? emptyTally();
    byRadius.set(report.radiusM, radiusTally);
    variants.forEach((variant, which) => {
      const params = variant.params(now);
      const bounds = matchBounds(report.query, params);
      const tally = tallies[which] ?? emptyTally();
      const into = variant.name === 'shipped' ? [tally, radiusTally] : [tally];
      for (const each of into) {
        each.reports++;
      }
      for (let index = 0; index < count; index++) {
        if (index === report.person) {
          continue;
        }
        const phone = phones[index];
        const flags = truth[index] ?? 0;
        const crossed = (flags & CROSSED) !== 0;
        const still = (flags & CROSSED_STILL) !== 0;
        const results =
          bounds === null || phone === undefined
            ? []
            : matchReport(report.query, between(phone, bounds.from_ts, bounds.to_ts), params);
        const matched = results.length > 0;
        for (const each of into) {
          each.crossers += crossed ? 1 : 0;
          each.crossersStill += still ? 1 : 0;
          each.others += crossed ? 0 : 1;
          if (!matched) {
            continue;
          }
          each.byStay += results[0]?.kind === 'stay' ? 1 : 0;
          if (crossed) {
            each.matchedCrossers++;
            each.matchedCrossersStill += still ? 1 : 0;
          } else if ((flags & IN_AREA) !== 0) {
            each.matchedInArea++;
          } else {
            each.matchedOutside++;
          }
        }
      }
    });
  }

  const areaKm2 = (scenario.sideM / 1_000) ** 2;
  const simulatedAdoption = count / (areaKm2 * scenario.peoplePerKm2);
  const scale = ADOPTION_REFERENCE / simulatedAdoption;
  const first = tallies[0] ?? emptyTally();
  return {
    scenario: scenario.name,
    describes: scenario.describes,
    devices: count,
    reports: reports.length,
    areaKm2,
    simulatedAdoption,
    crossersPerReport: reports.length === 0 ? 0 : (first.crossers / reports.length) * scale,
    capture: options.capture,
    variants: variants.map((variant, which) =>
      measured(variant.name, tallies[which] ?? emptyTally(), scale),
    ),
    shippedByRadius: [...byRadius.entries()]
      .sort(([a], [b]) => a - b)
      .map(([radius, tally]) => measured(`${radius} m`, tally, scale)),
  };
}
