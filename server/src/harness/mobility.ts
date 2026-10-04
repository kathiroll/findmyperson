import { EARTH_RADIUS_M, extractStays, type LatLon, type MatchHistory } from '@findmyperson/shared';

/**
 * SYNTHETIC PEOPLE AND THEIR PHONES, for the offline matching harness (evaluate.ts).
 *
 * Nothing here is measured from real users. It is a model, built so that the things matching
 * quality depends on are present and can be varied: how closely people live and work, how many
 * of them share a shop or a bus stop at the same time, how fast they move between places, how
 * wrong a location fix can be and how often the phone captures none at all.
 *
 * The model, in the order it is built:
 *
 *   places   A square area holds the homes, workplaces and venues (shops, stops, clinics) of
 *            all its residents, the last two each with a popularity. Places are spread evenly
 *            or gathered around settlement centres, depending on the scenario.
 *   people   The people simulated are a sample of the residents: the ones carrying the app.
 *            Each has a home at one of the home sites and most have a workplace, chosen by
 *            popularity and by how near it is. Each has a handful of favourite venues near home
 *            and near work and goes back to those (people return to few places: Gonzalez et al.,
 *            Nature 2008).
 *   days     Three days. Workers commute, some go out for lunch, some run an errand on the way
 *            home; others run one to three errands from home; a quarter go out in the evening.
 *            Travel is a straight line, on foot when short and by vehicle otherwise.
 *   phones   One fix per 15 minutes (the capture cadence), each kept or lost by a two-state
 *            process so that losses come in runs, as they do when the OS suspends an app. Each
 *            fix is the true position plus an error drawn from one of three classes: a good
 *            fix, a degraded one (indoors, Wi-Fi), or a gross one (cell tower only). The stays
 *            are whatever stay derivation (extractStays) makes of those fixes.
 *
 * Everything is drawn from seeded generators, one stream per person and purpose, so a run is
 * reproducible and changing the number of people does not change the people already there.
 *
 * What it leaves out: iOS visit rows (every stay is derived from fixes, as on Android), streets
 * (travel is a straight line), weekends, and any difference between people in how well their
 * phone captures.
 */

export const DAY = 86_400;
export const HOUR = 3_600;
export const MINUTE = 60;

/** Midnight at the start of the first simulated day, Unix seconds. On a 30-minute mark. */
export const SIM_START = 1_790_985_600;
export const SIM_DAYS = 3;
export const SIM_END_SEC = SIM_DAYS * DAY;

/** The capture cadence the model samples at: `minIntervalSec` in production. */
export const CAPTURE_INTERVAL_SEC = 900;

const WALK_MPS = 1.3;
const METERS_PER_DEGREE = (Math.PI * EARTH_RADIUS_M) / 180;

export interface Scenario {
  name: string;
  /** What the scenario stands for, for the printed report. */
  describes: string;
  origin: LatLon;
  /** Side of the square area, metres. */
  sideM: number;
  /** Residents per square kilometre: sets how many homes there are and scales the output. */
  peoplePerKm2: number;
  /** Settlement centres that places gather around; 0 spreads everything evenly. */
  centres: number;
  /** Standard deviation of a place's distance from its centre, metres. */
  centreSpreadM: number;
  /** Share of homes, venues and workplaces that are near a centre; the rest are anywhere. */
  homesNearCentre: number;
  venuesNearCentre: number;
  workNearCentre: number;
  venues: number;
  workplaces: number;
  /** Residents per home site: a block of flats holds many, a farmhouse one family. */
  residentsPerHomeSite: number;
  /** Largest distance between two people at the same home site, metres. */
  homeSiteExtentM: number;
  /** How far people go for an errand: the distance at which a venue is e times less likely. */
  tripScaleM: number;
  /** Trips up to this long are walked; longer ones go at vehicleMps. */
  walkMaxM: number;
  vehicleMps: number;
  fix: {
    /** Standard deviation, per axis, of a good fix. */
    sigmaM: number;
    degradedShare: number;
    degradedSigmaM: number;
    grossShare: number;
    grossSigmaM: number;
  };
}

/**
 * The three populations. Densities are round figures for the kind of place named, not a survey
 * of any one. Fix errors follow the granularity report's sources: about 10 m in the open, tens
 * of metres among tall buildings, hundreds on cell positioning alone, which is commoner where
 * there is little Wi-Fi.
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    name: 'dense-urban',
    describes: 'inner city, blocks of flats, 20,000 people per km2',
    origin: { lat: 12.9716, lon: 77.5946 },
    sideM: 5_000,
    peoplePerKm2: 20_000,
    centres: 0,
    centreSpreadM: 0,
    homesNearCentre: 0,
    venuesNearCentre: 0,
    workNearCentre: 0,
    venues: 3_750,
    workplaces: 6_000,
    residentsPerHomeSite: 120,
    homeSiteExtentM: 30,
    tripScaleM: 700,
    walkMaxM: 800,
    vehicleMps: 5.5,
    fix: {
      sigmaM: 20,
      degradedShare: 0.15,
      degradedSigmaM: 90,
      grossShare: 0.02,
      grossSigmaM: 450,
    },
  },
  {
    name: 'suburban',
    describes: 'houses, 2,500 people per km2, shops gathered in a dozen centres',
    origin: { lat: 13.1, lon: 77.59 },
    sideM: 8_000,
    peoplePerKm2: 2_500,
    centres: 12,
    centreSpreadM: 450,
    homesNearCentre: 0.3,
    venuesNearCentre: 0.8,
    workNearCentre: 0.7,
    venues: 640,
    workplaces: 2_000,
    residentsPerHomeSite: 3.5,
    homeSiteExtentM: 10,
    tripScaleM: 2_000,
    walkMaxM: 500,
    vehicleMps: 10,
    fix: {
      sigmaM: 12,
      degradedShare: 0.1,
      degradedSigmaM: 70,
      grossShare: 0.02,
      grossSigmaM: 450,
    },
  },
  {
    name: 'rural',
    describes: 'villages and farms, 120 people per km2, 25 villages in 900 km2',
    origin: { lat: 13.5, lon: 77.0 },
    sideM: 30_000,
    peoplePerKm2: 120,
    centres: 25,
    centreSpreadM: 300,
    homesNearCentre: 0.85,
    venuesNearCentre: 0.95,
    workNearCentre: 0.5,
    venues: 600,
    workplaces: 6_000,
    residentsPerHomeSite: 4.5,
    homeSiteExtentM: 10,
    tripScaleM: 6_000,
    walkMaxM: 600,
    vehicleMps: 12,
    fix: {
      sigmaM: 10,
      degradedShare: 0.1,
      degradedSigmaM: 70,
      grossShare: 0.06,
      grossSigmaM: 600,
    },
  },
];

/** How well the phones capture. */
export interface CaptureProfile {
  /** Share of 15-minute slots in which a fix is stored. */
  rate: number;
  /** Mean length of a run of lost slots, minutes. */
  meanOutageMin: number;
}

/** The S0.6 bar for a healthy phone: 80% of slots, losses about an hour at a time. */
export const HEALTHY_CAPTURE: CaptureProfile = { rate: 0.8, meanOutageMin: 60 };

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [low, high). */
  between(low: number, high: number): number;
  /** A whole number, uniform in [low, high]. */
  int(low: number, high: number): number;
  normal(mean: number, sd: number): number;
  chance(p: number): boolean;
}

/** mulberry32. Small, fast, and the same on every platform. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const between = (low: number, high: number) => low + next() * (high - low);
  return {
    next,
    between,
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    normal: (mean, sd) =>
      mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    chance: (p) => next() < p,
  };
}

/** A generator of its own for one purpose and one index, so streams do not disturb each other. */
export function streamRng(seed: number, stream: number, index = 0): Rng {
  const mixed =
    Math.imul(seed ^ 0x9e3779b1, 0x85ebca6b) ^
    Math.imul(stream + 1, 0xc2b2ae35) ^
    Math.imul(index + 1, 0x27d4eb2f);
  return createRng(mixed);
}

export const STREAM = { places: 1, person: 2, capture: 3, reports: 4 } as const;

/** A position in metres east and north of the scenario's origin. */
export interface Point {
  x: number;
  y: number;
}

export function toLatLon(origin: LatLon, point: Point): LatLon {
  return {
    lat: origin.lat + point.y / METERS_PER_DEGREE,
    lon: origin.lon + point.x / (METERS_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

interface Place extends Point {
  popularity: number;
  /** People at the same place are within this of its middle. */
  extentM: number;
}

interface World {
  venues: Place[];
  workplaces: Place[];
  homeSites: Point[];
}

/** A stretch of one person's time: still when the two ends are the same point. */
export interface Segment {
  t0: number;
  t1: number;
  from: Point;
  to: Point;
}

export interface Person {
  /** In time order, covering [0, SIM_END_SEC] with no gaps. Times are seconds from SIM_START. */
  segments: Segment[];
}

function somewhereIn(scenario: Scenario, rng: Rng): Point {
  return { x: rng.between(0, scenario.sideM), y: rng.between(0, scenario.sideM) };
}

/**
 * The places of the whole resident population, not only of the people simulated. The simulated
 * people are a sample of the residents, so two of them share a block of flats or an office as
 * often as two residents picked at random would, and counts scale with the size of the sample.
 */
function buildWorld(scenario: Scenario, seed: number): World {
  const rng = streamRng(seed, STREAM.places);
  const clamp = (value: number) => Math.min(scenario.sideM, Math.max(0, value));
  const centres = Array.from({ length: scenario.centres }, () => somewhereIn(scenario, rng));
  const residents = (scenario.sideM / 1_000) ** 2 * scenario.peoplePerKm2;
  const site = (nearCentre: number): Point => {
    const centre = centres[rng.int(0, centres.length - 1)];
    if (centre === undefined || !rng.chance(nearCentre)) {
      return somewhereIn(scenario, rng);
    }
    return {
      x: clamp(rng.normal(centre.x, scenario.centreSpreadM)),
      y: clamp(rng.normal(centre.y, scenario.centreSpreadM)),
    };
  };
  const place = (nearCentre: number): Place => ({
    ...site(nearCentre),
    // A few places draw most of the visits.
    popularity: Math.exp(rng.normal(0, 1.1)),
    extentM: rng.between(5, 25),
  });
  return {
    venues: Array.from({ length: scenario.venues }, () => place(scenario.venuesNearCentre)),
    workplaces: Array.from({ length: scenario.workplaces }, () => place(scenario.workNearCentre)),
    homeSites: Array.from({ length: Math.ceil(residents / scenario.residentsPerHomeSite) }, () =>
      site(scenario.homesNearCentre),
    ),
  };
}

/** Draws places by popularity and nearness to `anchor`, with replacement. */
function drawNear(
  places: readonly Place[],
  anchor: Point,
  scaleM: number,
  count: number,
  rng: Rng,
) {
  const cumulative: number[] = [];
  let total = 0;
  for (const place of places) {
    total += place.popularity * Math.exp(-distance(place, anchor) / scaleM);
    cumulative.push(total);
  }
  const drawn: Place[] = [];
  for (let n = 0; n < count; n++) {
    const target = rng.next() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cumulative[middle] ?? 0) < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const place = places[low];
    if (place !== undefined) {
      drawn.push(place);
    }
  }
  return drawn;
}

function buildPerson(scenario: Scenario, world: World, rng: Rng): Person {
  const within = (middle: Point, extentM: number): Point => {
    const angle = rng.between(0, 2 * Math.PI);
    const radius = (extentM / 2) * Math.sqrt(rng.next());
    return { x: middle.x + radius * Math.cos(angle), y: middle.y + radius * Math.sin(angle) };
  };
  const homeSite = world.homeSites[rng.int(0, world.homeSites.length - 1)] ?? { x: 0, y: 0 };
  const home = within(homeSite, scenario.homeSiteExtentM);
  const workplace = rng.chance(0.65)
    ? drawNear(world.workplaces, home, 3 * scenario.tripScaleM, 1, rng)[0]
    : undefined;
  const desk = workplace === undefined ? undefined : within(workplace, workplace.extentM);
  const nearHome = drawNear(world.venues, home, scenario.tripScaleM, 6, rng);
  const nearWork = desk === undefined ? [] : drawNear(world.venues, desk, 500, 4, rng);
  const visit = (favourites: readonly Place[]): Point => {
    const venue = favourites[rng.int(0, favourites.length - 1)];
    return venue === undefined ? home : within(venue, venue.extentM);
  };

  const segments: Segment[] = [];
  let now = 0;
  let here = home;
  /** Stays put until `leaveAt` (or leaves at once if that has passed), then travels to `to`. */
  const goTo = (to: Point, leaveAt: number): void => {
    const leave = Math.max(now, leaveAt);
    if (leave > now) {
      segments.push({ t0: now, t1: leave, from: here, to: here });
    }
    const length = distance(here, to);
    const speed = length <= scenario.walkMaxM ? WALK_MPS : scenario.vehicleMps;
    const arrive = leave + length / speed;
    if (arrive > leave) {
      segments.push({ t0: leave, t1: arrive, from: here, to });
    }
    now = arrive;
    here = to;
  };

  for (let day = 0; day < SIM_DAYS; day++) {
    const at = (hour: number, sdMin: number) =>
      day * DAY + hour * HOUR + rng.normal(0, sdMin * MINUTE);
    if (desk !== undefined) {
      goTo(desk, at(8.5, 45));
      if (rng.chance(0.35)) {
        goTo(visit(nearWork), at(13, 30));
        goTo(desk, now + rng.between(20, 45) * MINUTE);
      }
      const leaveWork = at(17.5, 50);
      if (rng.chance(0.45)) {
        goTo(visit(nearHome), leaveWork);
        goTo(home, now + rng.between(10, 50) * MINUTE);
      } else {
        goTo(home, leaveWork);
      }
    } else {
      const errands = rng.int(1, 3);
      for (let errand = 0; errand < errands; errand++) {
        goTo(visit(nearHome), day * DAY + rng.between(9 + 3 * errand, 12 + 3 * errand) * HOUR);
        goTo(home, now + rng.between(15, 90) * MINUTE);
      }
    }
    if (rng.chance(0.25)) {
      goTo(visit(nearHome), at(19.5, 40));
      goTo(home, now + rng.between(40, 120) * MINUTE);
    }
  }
  if (now < SIM_END_SEC) {
    segments.push({ t0: now, t1: SIM_END_SEC, from: here, to: here });
  }
  return { segments };
}

/** The segment a person is in at time `t`, seconds from SIM_START. */
export function segmentAt(person: Person, t: number): Segment {
  const { segments } = person;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.t1 ?? Infinity) < t) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const found = segments[low];
  if (found === undefined) {
    throw new Error('a person has no segments');
  }
  return found;
}

export function positionIn(segment: Segment, t: number): Point {
  const span = segment.t1 - segment.t0;
  const share = span <= 0 ? 0 : Math.min(1, Math.max(0, (t - segment.t0) / span));
  return {
    x: segment.from.x + (segment.to.x - segment.from.x) * share,
    y: segment.from.y + (segment.to.y - segment.from.y) * share,
  };
}

export const isStill = (segment: Segment): boolean =>
  segment.from.x === segment.to.x && segment.from.y === segment.to.y;

/** What one phone holds after the three days: its fixes and the stays derived from them. */
function capture(
  scenario: Scenario,
  person: Person,
  profile: CaptureProfile,
  rng: Rng,
): MatchHistory {
  // A two-state chain: capturing or not. `resume` sets the mean run of lost slots, and `lose`
  // follows from the share of slots that must be kept.
  const resume = Math.min(1, CAPTURE_INTERVAL_SEC / (profile.meanOutageMin * MINUTE));
  const lose = profile.rate >= 1 ? 0 : (resume * (1 - profile.rate)) / profile.rate;
  let capturing = rng.chance(profile.rate);
  const { fix } = scenario;
  const fixes: { ts_utc: number; lat: number; lon: number }[] = [];
  let last = -1;
  for (let slot = rng.between(0, CAPTURE_INTERVAL_SEC); ; slot += CAPTURE_INTERVAL_SEC) {
    const t = Math.round(slot + rng.normal(0, 45));
    if (t >= SIM_END_SEC) {
      break;
    }
    capturing = capturing ? !rng.chance(lose) : rng.chance(resume);
    const kind = rng.next();
    const sigma =
      kind < fix.grossShare
        ? fix.grossSigmaM
        : kind < fix.grossShare + fix.degradedShare
          ? fix.degradedSigmaM
          : fix.sigmaM;
    const error = { x: rng.normal(0, sigma), y: rng.normal(0, sigma) };
    if (!capturing || t <= last || t < 0) {
      continue;
    }
    last = t;
    const truth = positionIn(segmentAt(person, t), t);
    fixes.push({
      ts_utc: SIM_START + t,
      ...toLatLon(scenario.origin, { x: truth.x + error.x, y: truth.y + error.y }),
    });
  }
  return {
    samples: fixes.map((sample, index) => ({ id: index + 1, ...sample })),
    stays: extractStays(fixes).map((stay, index) => ({ id: index + 1, ...stay })),
  };
}

export interface Population {
  scenario: Scenario;
  people: Person[];
  /** The phone of each person, same index. */
  phones: MatchHistory[];
}

export function buildPopulation(
  scenario: Scenario,
  count: number,
  profile: CaptureProfile,
  seed: number,
): Population {
  const world = buildWorld(scenario, seed);
  const people = Array.from({ length: count }, (_unused, index) =>
    buildPerson(scenario, world, streamRng(seed, STREAM.person, index)),
  );
  const phones = people.map((person, index) =>
    capture(scenario, person, profile, streamRng(seed, STREAM.capture, index)),
  );
  return { scenario, people, phones };
}
