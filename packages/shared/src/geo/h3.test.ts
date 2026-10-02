import { describe, expect, test } from 'vitest';
import vectors from '../../contracts/geo-vectors.json';
import { MATCH_RADIUS_M, MAX_QUERY_CELLS, MAX_SEARCH_RADIUS_M } from '../constants';
import { EARTH_RADIUS_M, haversineMeters, type LatLon } from './distance';
import {
  cellAt,
  isH3Cell,
  matchCellAt,
  pushCellOf,
  ringCells,
  sampleCells,
  searchAreaCells,
  shardCellOf,
  shardKeysForCells,
} from './h3';

describe('cell golden vectors', () => {
  test.each(vectors.points)('$name', (point) => {
    expect(matchCellAt(point)).toBe(point.h3_r7);
    expect(sampleCells(point)).toEqual({ h3_r7: point.h3_r7, h3_r5: point.h3_r5 });
    expect(shardCellOf(point.h3_r7)).toBe(point.h3_r5);
    expect(pushCellOf(point.h3_r7)).toBe(point.h3_r3);
    expect(pushCellOf(point.h3_r5)).toBe(point.h3_r3);
    expect(cellAt(point, 5)).toBe(point.h3_r5_containing);
  });

  test("includes h3's own documented example, so the fixture is anchored outside this repo", () => {
    const example = vectors.points.find((point) => point.name === 'h3-docs-example');
    expect(example?.h3_r7).toBe('87283472bffffff');
  });

  test('includes points where the shard is NOT the res-5 cell containing the point', () => {
    // The trap sampleCells and shardCellOf exist to avoid: see the comment on shardCellOf.
    const traps = vectors.points.filter((point) => point.h3_r5 !== point.h3_r5_containing);
    expect(traps.map((point) => point.name)).toContain('shard-edge-parent-differs');
  });
});

describe('ringCells', () => {
  test.each(vectors.rings)('golden vector: $cell', ({ cell, ring }) => {
    expect(ringCells(cell)).toEqual(ring);
  });

  test('a hexagon has 7 cells in its ring and a pentagon 6, the cell itself included', () => {
    const sizes = vectors.rings.map(({ cell }) => ringCells(cell).length).sort();
    expect(sizes).toEqual([6, 7, 7]);
    for (const { cell } of vectors.rings) {
      expect(ringCells(cell)).toContain(cell);
    }
  });
});

/** The point `meters` from `origin` along a bearing, on the same sphere haversine uses. */
function destination(origin: LatLon, bearingDeg: number, meters: number): LatLon {
  const rad = Math.PI / 180;
  const delta = meters / EARTH_RADIUS_M;
  const phi1 = origin.lat * rad;
  const theta = bearingDeg * rad;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    origin.lon * rad +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  const lon = ((((lambda2 / rad + 180) % 360) + 360) % 360) - 180;
  return { lat: phi2 / rad, lon };
}

/** Small deterministic generator, so a failure reproduces. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('searchAreaCells', () => {
  test.each(vectors.search_areas)('golden vector: $name radius $radius_m', (area) => {
    expect(searchAreaCells(area.center, area.radius_m)).toEqual(area.cells);
  });

  test('is sorted, free of duplicates, and all res 7', () => {
    for (const { center, radius_m } of vectors.search_areas) {
      const cells = searchAreaCells(center, radius_m);
      expect(cells).toEqual([...new Set(cells)].sort());
      expect(cells.every((cell) => isH3Cell(cell, 7))).toBe(true);
    }
  });

  test('covers every point a stay or sample could match from', () => {
    const random = mulberry32(20261003);
    const centers = [...vectors.points, { lat: 89.99, lon: 10 }, { lat: -45, lon: -179.999 }];
    for (const center of centers) {
      for (const radius of [0, 137, 1_000, MAX_SEARCH_RADIUS_M]) {
        const cover = new Set(searchAreaCells(center, radius));
        const reach = radius + MATCH_RADIUS_M;
        for (let i = 0; i < 60; i++) {
          // Bias towards the rim, where a missing cell would be.
          const distance = reach * (i % 3 === 0 ? 1 : Math.sqrt(random()));
          const point = destination(center, random() * 360, distance);
          expect(haversineMeters(center, point)).toBeLessThanOrEqual(reach + 0.01);
          expect(cover.has(matchCellAt(point))).toBe(true);
        }
      }
    }
  });

  test('stays inside the cell cap at the largest allowed radius', () => {
    for (const center of vectors.points) {
      const cells = searchAreaCells(center, MAX_SEARCH_RADIUS_M);
      expect(cells.length).toBeLessThanOrEqual(MAX_QUERY_CELLS);
    }
  });

  test('grows with the radius and always holds the centre cell', () => {
    const center = { lat: 12.9716, lon: 77.5946 };
    const small = searchAreaCells(center, 0);
    const large = searchAreaCells(center, 3_000);
    expect(small).toContain(matchCellAt(center));
    expect(large.length).toBeGreaterThan(small.length);
    expect(small.every((cell) => large.includes(cell))).toBe(true);
  });
});

describe('shardKeysForCells', () => {
  test('maps cells to their sorted, de-duplicated res-5 and res-3 ancestors', () => {
    const cells = searchAreaCells({ lat: 12.9716, lon: 77.5946 }, 5_000);
    const keys = shardKeysForCells(cells);
    expect(keys.r5).toEqual([...new Set(cells.map(shardCellOf))].sort());
    expect(keys.r3).toEqual([...new Set(cells.map(pushCellOf))].sort());
    expect(keys.r5.every((cell) => isH3Cell(cell, 5))).toBe(true);
    expect(keys.r3.every((cell) => isH3Cell(cell, 3))).toBe(true);
  });

  test('an empty input gives empty keys', () => {
    expect(shardKeysForCells([])).toEqual({ r5: [], r3: [] });
  });
});

describe('isH3Cell', () => {
  test('accepts valid lowercase cell ids, optionally at one resolution', () => {
    expect(isH3Cell('8760145b4ffffff')).toBe(true);
    expect(isH3Cell('8760145b4ffffff', 7)).toBe(true);
    expect(isH3Cell('8760145b4ffffff', 5)).toBe(false);
    expect(isH3Cell('8560145bfffffff', 5)).toBe(true);
  });

  test.each([
    ['uppercase', '8760145B4FFFFFF'],
    ['too short', '8760145b4fffff'],
    ['not hex', '8760145b4fffffg'],
    ['well-formed but not a cell', 'ffffffffffffffff'.slice(0, 15)],
    ['empty', ''],
    ['a number', 0x8760145b4ffff],
    ['null', null],
  ])('rejects %s', (_label, value) => {
    expect(isH3Cell(value)).toBe(false);
  });
});
