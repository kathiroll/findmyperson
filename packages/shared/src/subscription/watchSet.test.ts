import { describe, expect, test } from 'vitest';
import { H3_RES_PUSH, H3_RES_SHARD, RETENTION_SEC, SUBSCRIPTION_RES5_CAP } from '../constants';
import type { LatLon } from '../geo/distance';
import {
  matchCellAt,
  pushCellOf,
  ringCells,
  sampleCells,
  searchAreaCells,
  shardCellOf,
  shardKeysForCells,
  type H3Cell,
} from '../geo/h3';
import { MAX_SEARCH_RADIUS_M } from '../constants';
import {
  computeWatchSet,
  visitedShardCells,
  watchSetForCells,
  type WatchHistory,
  type WatchTopic,
} from './watchSet';

const DAY = 86_400;
const NOW = 1_791_000_000;
const CUTOFF = NOW - RETENTION_SEC;

const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9916, lon: 77.6146 };
const market = { lat: 12.93, lon: 77.55 };
const HOME = sampleCells(home).h3_r5;

const fix = (point: LatLon, ts_utc: number) => ({ ts_utc, h3_r5: sampleCells(point).h3_r5 });
const stayAt = (point: LatLon, end_ts: number) => ({ end_ts, h3_r7: matchCellAt(point) });

/** `steps + 1` points in a straight line from one place to another. */
function line(from: LatLon, to: LatLon, steps: number): LatLon[] {
  return Array.from({ length: steps + 1 }, (_, i) => ({
    lat: from.lat + ((to.lat - from.lat) * i) / steps,
    lon: from.lon + ((to.lon - from.lon) * i) / steps,
  }));
}

/**
 * Thirty days of a commuter: home at night, the office from 09:00 to 17:00 on weekdays, a fix
 * every five minutes on the road between them, and the market on the weekend. A fix every 15
 * minutes otherwise, and a stay a day at each place.
 */
function commuterTrace(nowTs: number): WatchHistory & { places: LatLon[] } {
  const samples: WatchHistory['samples'][number][] = [];
  const stays: WatchHistory['stays'][number][] = [];
  const road = line(home, office, 11);
  const places = [home, office, market, ...road];
  for (let day = 30; day >= 1; day--) {
    const midnight = nowTs - day * DAY;
    const weekday = day % 7 > 1;
    for (let ts = midnight; ts < midnight + DAY; ts += 900) {
      const hour = (ts - midnight) / 3600;
      const away = weekday ? hour >= 9 && hour < 17 : hour >= 11 && hour < 13;
      samples.push(fix(away ? (weekday ? office : market) : home, ts));
    }
    if (weekday) {
      road.forEach((point, i) => {
        samples.push(fix(point, midnight + 8 * 3600 + i * 300));
        samples.push(fix(point, midnight + 18 * 3600 - i * 300));
      });
    }
    stays.push(stayAt(home, midnight + 8 * 3600));
    stays.push(stayAt(weekday ? office : market, midnight + (weekday ? 17 : 13) * 3600));
  }
  return { samples, stays, places };
}

/** A month on the road: Bangalore to Mumbai to Delhi to Kolkata, a fix every kilometre or so. */
function travellerTrace(nowTs: number): WatchHistory & { places: LatLon[] } {
  const mumbai = { lat: 19.076, lon: 72.8777 };
  const delhi = { lat: 28.6139, lon: 77.209 };
  const kolkata = { lat: 22.5726, lon: 88.3639 };
  const places = [
    ...line(home, mumbai, 1500),
    ...line(mumbai, delhi, 1500),
    ...line(delhi, kolkata, 1500),
  ];
  const step = Math.floor((29 * DAY) / places.length);
  return {
    places,
    samples: places.map((point, i) => fix(point, nowTs - 29 * DAY + i * step)),
    // A night's stop every 150 km or so.
    stays: places
      .filter((_, i) => i % 150 === 0)
      .map((point, i) => stayAt(point, nowTs - 29 * DAY + i * 150 * step)),
  };
}

const topicsOf = (set: readonly WatchTopic[], ...reasons: WatchTopic['reason'][]) =>
  set.filter((topic) => reasons.includes(topic.reason)).map((topic) => topic.topic);

/** The topics the fetcher downloads as shards: everything but the push-only ancestors. */
const fetched = (set: readonly WatchTopic[]) =>
  new Set(topicsOf(set, 'visited', 'ring', 'coarsened'));

/** A res-5 cell is covered when it is followed itself or its res-3 parent is, as a shard. */
const covers = (set: readonly WatchTopic[], cell: H3Cell) => {
  const shards = fetched(set);
  return shards.has(cell) || shards.has(pushCellOf(cell));
};

describe('the watch set', () => {
  test('an empty history gives an empty set', () => {
    expect(computeWatchSet({ stays: [], samples: [] }, NOW)).toEqual([]);
    expect(watchSetForCells([])).toEqual([]);
  });

  test('one visited cell: the cell, its ring, and the res-3 ancestors of all seven', () => {
    const set = computeWatchSet({ stays: [], samples: [fix(home, NOW)] }, NOW);
    const ring = ringCells(HOME).filter((cell) => cell !== HOME);
    expect(ring).toHaveLength(6);
    const ancestors = [...new Set([HOME, ...ring].map(pushCellOf))];
    // Central Bangalore is where three res-3 cells meet, so the ring reaches into all three.
    expect(ancestors.length).toBeGreaterThan(1);

    expect(set).toEqual(
      [
        { topic: HOME, res: H3_RES_SHARD, reason: 'visited' },
        ...ring.map((topic) => ({ topic, res: H3_RES_SHARD, reason: 'ring' })),
        ...ancestors.map((topic) => ({ topic, res: H3_RES_PUSH, reason: 'ancestor' })),
      ].sort((a, b) => (a.topic < b.topic ? -1 : 1)),
    );
  });

  test('a stay counts as a fix does, by the res-5 parent of its res-7 cell', () => {
    const fromStay = computeWatchSet({ stays: [stayAt(home, NOW)], samples: [] }, NOW);
    const fromFix = computeWatchSet({ stays: [], samples: [fix(home, NOW)] }, NOW);
    expect(fromStay).toEqual(fromFix);

    // A place only a stay records (an iOS visit with no fix) is followed too.
    const both = computeWatchSet(
      { stays: [stayAt({ lat: 13.6, lon: 78.4 }, NOW)], samples: [fix(home, NOW)] },
      NOW,
    );
    expect(topicsOf(both, 'visited')).toEqual(
      [HOME, shardCellOf(matchCellAt({ lat: 13.6, lon: 78.4 }))].sort(),
    );
  });

  test('a cell visited and next to a visited cell is one topic, and it is visited', () => {
    const neighbour = ringCells(HOME).find((cell) => cell !== HOME) as H3Cell;
    const set = watchSetForCells([HOME, neighbour]);
    expect(set.filter((topic) => topic.topic === neighbour)).toEqual([
      { topic: neighbour, res: H3_RES_SHARD, reason: 'visited' },
    ]);
    expect(new Set(set.map((topic) => topic.topic)).size).toBe(set.length);
  });

  test('only the last 30 days count, purged or not', () => {
    const elsewhere = { lat: 13.6, lon: 78.4 };
    const there = sampleCells(elsewhere).h3_r5;
    const visited = (history: WatchHistory) => visitedShardCells(history, NOW);

    expect(visited({ stays: [], samples: [fix(elsewhere, CUTOFF)] })).toEqual([there]);
    expect(visited({ stays: [], samples: [fix(elsewhere, CUTOFF - 1)] })).toEqual([]);
    // A stay still running across the cutoff is inside it; one that ended before is not.
    expect(visited({ stays: [stayAt(elsewhere, CUTOFF)], samples: [] })).toEqual([there]);
    expect(visited({ stays: [stayAt(elsewhere, CUTOFF - 1)], samples: [] })).toEqual([]);
    // A row dated after now is kept by the purge, and is followed.
    expect(visited({ stays: [], samples: [fix(elsewhere, NOW + DAY)] })).toEqual([there]);

    const history = { stays: [], samples: [fix(home, NOW), fix(elsewhere, CUTOFF - 1)] };
    expect(computeWatchSet(history, NOW)).toEqual(watchSetForCells([HOME]));
  });

  test('a 30-day commuter is well within the cap, at res 5 throughout', () => {
    const trace = commuterTrace(NOW);
    expect(trace.samples.length).toBeGreaterThan(3000);
    const set = computeWatchSet(trace, NOW);

    const res5 = topicsOf(set, 'visited', 'ring');
    expect(res5.length).toBeLessThanOrEqual(SUBSCRIPTION_RES5_CAP);
    expect(res5.length).toBeLessThan(30);
    expect(topicsOf(set, 'coarsened')).toEqual([]);
    // Everywhere the commuter was is followed as its own res-5 shard.
    const visited = [...new Set(trace.places.map((place) => sampleCells(place).h3_r5))].sort();
    expect(topicsOf(set, 'visited')).toEqual(visited);
    for (const cell of res5) {
      expect(topicsOf(set, 'ancestor')).toContain(pushCellOf(cell));
    }
  });

  test('a heavy traveller is coarsened to res 3, and no visited cell loses its coverage', () => {
    const trace = travellerTrace(NOW);
    const visited = visitedShardCells(trace, NOW);
    const wanted = [...new Set(visited.flatMap(ringCells))];
    // More res-5 cells than the cap in visited cells alone, and far more with their rings.
    expect(visited.length).toBeGreaterThan(SUBSCRIPTION_RES5_CAP);
    expect(wanted.length).toBeGreaterThan(3 * SUBSCRIPTION_RES5_CAP);

    const set = computeWatchSet(trace, NOW);
    const res5 = topicsOf(set, 'visited', 'ring');
    const coarsened = new Set(topicsOf(set, 'coarsened'));
    expect(res5.length).toBeLessThanOrEqual(SUBSCRIPTION_RES5_CAP);
    expect(res5.length).toBeGreaterThan(0);
    expect(coarsened.size).toBeGreaterThan(0);

    // Coverage: every visited cell, and every neighbour kept for hysteresis, is still followed.
    expect(visited.filter((cell) => !covers(set, cell))).toEqual([]);
    expect(wanted.filter((cell) => !covers(set, cell))).toEqual([]);
    // Nothing is followed twice: no res-5 cell remains inside a coarsened region.
    expect(res5.filter((cell) => coarsened.has(pushCellOf(cell)))).toEqual([]);
    // Every res-3 cell of the route is a push topic, coarsened or not.
    expect(new Set(set.filter((topic) => topic.res === H3_RES_PUSH).map((t) => t.topic))).toEqual(
      new Set(wanted.map(pushCellOf)),
    );
    // And the set is far smaller than the cells it stands for.
    expect(set.length).toBeLessThan(wanted.length / 2);
  });

  test('a report filed where the traveller was is in a bundle the traveller fetches', () => {
    const trace = travellerTrace(NOW);
    const shards = fetched(computeWatchSet(trace, NOW));
    for (const place of trace.places.filter((_, i) => i % 97 === 0)) {
      // What the shard compiler does with a report centred here, at the smallest and the
      // largest search radius.
      for (const radius of [0, MAX_SEARCH_RADIUS_M]) {
        const keys = shardKeysForCells(searchAreaCells(place, radius));
        expect([...keys.r5, ...keys.r3].some((key) => shards.has(key))).toBe(true);
      }
    }
  });

  test('a res-3 bundle holds what the res-5 bundles inside it hold', () => {
    // Coarsening rests on this: the publisher files a report under the res-3 parent of the
    // same res-7 cells it files under res 5, and the two parents agree.
    for (const place of travellerTrace(NOW).places.filter((_, i) => i % 53 === 0)) {
      const cells = searchAreaCells(place, MAX_SEARCH_RADIUS_M);
      for (const cell of cells) {
        expect(pushCellOf(shardCellOf(cell))).toBe(pushCellOf(cell));
      }
      const keys = shardKeysForCells(cells);
      expect([...new Set(keys.r5.map(pushCellOf))].sort()).toEqual(keys.r3);
    }
  });
});

describe('the cap', () => {
  const seven = ringCells(HOME);
  const regionSizes = new Map<H3Cell, number>();
  for (const cell of seven) {
    regionSizes.set(pushCellOf(cell), (regionSizes.get(pushCellOf(cell)) ?? 0) + 1);
  }
  const fullest = [...regionSizes].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : 1))[0]![0];

  test('is on visited and ring cells together, and a set exactly at it is left alone', () => {
    const atCap = watchSetForCells([HOME], { res5Cap: 7 });
    expect(topicsOf(atCap, 'visited', 'ring')).toHaveLength(7);
    expect(topicsOf(atCap, 'coarsened')).toEqual([]);
    expect(atCap).toEqual(watchSetForCells([HOME]));
  });

  test('one cell over, the fullest region is coarsened and the rest stays at res 5', () => {
    const over = watchSetForCells([HOME], { res5Cap: 6 });
    expect(topicsOf(over, 'coarsened')).toEqual([fullest]);
    expect(topicsOf(over, 'visited', 'ring')).toEqual(
      seven.filter((cell) => pushCellOf(cell) !== fullest),
    );
    expect(topicsOf(over, 'ancestor')).toEqual(
      [...regionSizes.keys()].filter((region) => region !== fullest).sort(),
    );
    expect(seven.filter((cell) => !covers(over, cell))).toEqual([]);
  });

  test('regions are coarsened only until the rest fits', () => {
    const sizes = [...regionSizes.values()].sort((a, b) => b - a);
    // A cap one below what the fullest region leaves behind needs a second region.
    const afterOne = 7 - sizes[0]!;
    expect(topicsOf(watchSetForCells([HOME], { res5Cap: afterOne }), 'coarsened')).toHaveLength(1);
    expect(topicsOf(watchSetForCells([HOME], { res5Cap: afterOne - 1 }), 'coarsened')).toHaveLength(
      2,
    );
  });

  test('a cap of nothing leaves only res-3 shards, and still covers every cell', () => {
    const set = watchSetForCells([HOME], { res5Cap: 0 });
    expect(set.every((topic) => topic.res === H3_RES_PUSH && topic.reason === 'coarsened')).toBe(
      true,
    );
    expect(seven.filter((cell) => !covers(set, cell))).toEqual([]);
  });

  test('the set does not depend on the order or the repeats of the cells given', () => {
    const visited = visitedShardCells(travellerTrace(NOW), NOW);
    const reversed = [...visited].reverse();
    expect(watchSetForCells([...reversed, ...visited])).toEqual(watchSetForCells(visited));
  });

  test('a value that is not a res-5 cell is refused, as is a cap that is not a count', () => {
    expect(() => watchSetForCells([matchCellAt(home)])).toThrow(RangeError);
    expect(() => watchSetForCells([pushCellOf(HOME)])).toThrow(RangeError);
    expect(() => watchSetForCells(['not a cell'])).toThrow(RangeError);
    expect(() => watchSetForCells([HOME], { res5Cap: -1 })).toThrow(RangeError);
    expect(() => watchSetForCells([HOME], { res5Cap: 1.5 })).toThrow(RangeError);
  });
});
