import {
  cellToBoundary,
  cellToLatLng,
  cellToParent,
  getResolution,
  gridDisk,
  gridDiskDistances,
  isValidCell,
  latLngToCell,
} from 'h3-js';
import { H3_RES_MATCH, H3_RES_PUSH, H3_RES_SHARD, MATCH_RADIUS_M } from '../constants';
import { haversineMeters, type LatLon } from './distance';

/**
 * H3 cell ids are always the 15-character lowercase hex string form ("8760145b4ffffff"), in the
 * store, on the wire and in topic names. Kotlin (h3-java) and Swift (the H3 C library) must
 * produce byte-identical strings; contracts/geo-vectors.json is the shared test.
 */
export type H3Cell = string;

const CELL_STRING = /^[0-9a-f]{15}$/;

/** True for a valid lowercase H3 cell id, optionally at one exact resolution. */
export function isH3Cell(value: unknown, res?: number): value is H3Cell {
  if (typeof value !== 'string' || !CELL_STRING.test(value) || !isValidCell(value)) {
    return false;
  }
  return res === undefined || getResolution(value) === res;
}

/** The cell containing a point at the given resolution. */
export function cellAt(point: LatLon, res: number): H3Cell {
  return latLngToCell(point.lat, point.lon, res);
}

/** The res-7 cell containing a point: the value of every `h3_r7` column. */
export function matchCellAt(point: LatLon): H3Cell {
  return cellAt(point, H3_RES_MATCH);
}

/**
 * The res-5 shard a res-7 cell belongs to.
 *
 * This is the PARENT of the res-7 cell, not the res-5 cell that geometrically contains the
 * point. The two differ near shard edges, because H3 children only approximately nest inside
 * their parent. The publisher files a report under the parents of its res-7 cover, so a device
 * must derive its shards the same way or it would fetch a neighbouring shard and miss the
 * report. geo-vectors.json includes a point where the two answers differ.
 */
export function shardCellOf(cell: H3Cell): H3Cell {
  return cellToParent(cell, H3_RES_SHARD);
}

/** The res-3 push-wake topic a res-7 or res-5 cell belongs to (its res-3 ancestor). */
export function pushCellOf(cell: H3Cell): H3Cell {
  return cellToParent(cell, H3_RES_PUSH);
}

/** The two cell columns of a `location_sample` row for a point. Native writers must match this. */
export function sampleCells(point: LatLon): { h3_r7: H3Cell; h3_r5: H3Cell } {
  const h3_r7 = matchCellAt(point);
  return { h3_r7, h3_r5: shardCellOf(h3_r7) };
}

/** A cell plus its immediate neighbours (7 cells, 6 around a pentagon), sorted. */
export function ringCells(cell: H3Cell): H3Cell[] {
  return gridDisk(cell, 1).sort();
}

/** Largest distance from a cell's centre to one of its corners, in metres. */
function circumradiusMeters(cell: H3Cell, center: LatLon): number {
  let max = 0;
  for (const [lat, lon] of cellToBoundary(cell)) {
    max = Math.max(max, haversineMeters(center, { lat, lon }));
  }
  return max;
}

/**
 * The value of a query's `cells` field: every res-7 cell that can contain a point within
 * `radiusM + MATCH_RADIUS_M` of `center`, sorted ascending.
 *
 * It is a cover, so it may include a few cells that only come close to the disc, and it never
 * leaves out a cell that touches it. That is what makes `h3_r7 IN (cells)` a safe pre-filter
 * for the matcher: the exact haversine test still decides. h3's polygonToCells is not used
 * because it keeps only cells whose centre is inside the shape, which is not a cover.
 */
export function searchAreaCells(center: LatLon, radiusM: number): H3Cell[] {
  const reach = radiusM + MATCH_RADIUS_M;
  const origin = matchCellAt(center);
  const covered: H3Cell[] = [];
  for (let k = 0; ; k++) {
    const ring = gridDiskDistances(origin, k)[k] ?? [];
    const touching = ring.filter((cell) => {
      const [lat, lon] = cellToLatLng(cell);
      const cellCenter = { lat, lon };
      return haversineMeters(center, cellCenter) <= reach + circumradiusMeters(cell, cellCenter);
    });
    covered.push(...touching);
    // The disc is convex and contains the origin cell's point, so once a whole ring misses it
    // every ring further out misses it too.
    if (k > 0 && touching.length === 0) {
      break;
    }
  }
  return covered.sort();
}

/** Shard bundles (res 5) and push topics (res 3) a set of res-7 cells falls under, sorted. */
export function shardKeysForCells(cells: readonly H3Cell[]): { r5: H3Cell[]; r3: H3Cell[] } {
  const r5 = new Set<H3Cell>();
  const r3 = new Set<H3Cell>();
  for (const cell of cells) {
    r5.add(shardCellOf(cell));
    r3.add(pushCellOf(cell));
  }
  return { r5: [...r5].sort(), r3: [...r3].sort() };
}
