import { H3_RES_PUSH, H3_RES_SHARD, RETENTION_SEC, SUBSCRIPTION_RES5_CAP } from '../constants';
import { isH3Cell, pushCellOf, ringCells, shardCellOf, type H3Cell } from '../geo/h3';
import type { LocationSample } from '../store/tables/locationSample';
import type { Stay } from '../store/tables/stay';
import type { Subscription } from '../store/tables/subscription';

/**
 * THE WATCH SET (plan 7.2; task B3.7): which shards and push topics a device follows, worked out
 * from where it has been. Pure: rows and a time go in, a list of topics comes out. The store
 * side, which keeps the `subscription` table equal to this list, is subscription/sync.ts.
 *
 * THE RULE
 *   visited    every res-5 cell holding a fix taken, or a stay that ended, within RETENTION_SEC
 *              of `nowTs`. A fix's cell is its `h3_r5` column and a stay's is the res-5 parent
 *              of its `h3_r7`: both are `shardCellOf` a res-7 cell, which is how the publisher
 *              files a report (geo/h3.ts), and not the res-5 cell drawn around the point.
 *   ring       the neighbours of each visited cell. A device near a cell edge, or one whose next
 *              fix lands across it, is already following the other side.
 *   ancestor   the res-3 parent of every cell above. It is a push-wake topic and nothing else:
 *              its bundle holds every report of a region of 49 shards, and fetching it
 *              is the download the res-5 shards exist to avoid.
 *
 * THE CAP. `visited` and `ring` together are at most SUBSCRIPTION_RES5_CAP cells. A device over
 * it gives up res-5 cells a whole res-3 region at a time: the region's cells leave the list and
 * the region itself is followed as a shard, with reason `coarsened`. The publisher files every
 * report under the res-3 parent of the same res-7 cells it files under res 5, so a region's
 * bundle holds everything the bundles of its res-5 cells hold. Nothing a dropped cell would have
 * brought is lost; the device downloads the rest of the region as well, which is the price.
 *
 * Regions are taken fullest first (most wanted res-5 cells, then lowest cell id) until what is
 * left fits. That is the fewest region bundles, and the least in them the device had no use
 * for: a region it wants 25 cells of is mostly wanted already, one it wants 2 of is not.
 *
 * Coarsening is to res 3 and never res 4, because nothing publishes or stores a res-4 shard:
 * the compiler files reports under res 5 and res 3 only, and `subscription.res` and the shard
 * keys of the index admit no other.
 *
 * WHAT A CONSUMER CAN RELY ON. Every visited or ring cell is in the list, or its res-3 parent is
 * there as `coarsened`. Every res-5 cell in the list has its res-3 parent in it. The list holds
 * each topic once, sorted by topic, and is the same for the same cells in any order.
 */

/** One topic of the watch set: a `subscription` row without its times. */
export type WatchTopic = Pick<Subscription, 'topic' | 'res' | 'reason'>;

/** The history the watch set is read from. Rows of `stay` and `location_sample` fit as they are. */
export interface WatchHistory {
  stays: readonly Pick<Stay, 'h3_r7' | 'end_ts'>[];
  samples: readonly Pick<LocationSample, 'h3_r5' | 'ts_utc'>[];
}

export interface WatchSetOptions {
  /** Default SUBSCRIPTION_RES5_CAP. */
  res5Cap?: number;
}

const byTopic = (a: WatchTopic, b: WatchTopic) =>
  a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0;

/**
 * The watch set for a set of visited res-5 cells. Repeats and order do not matter. Throws
 * RangeError for a value that is not a res-5 cell: a row holding one was written by something
 * that does not follow the store's contract, and guessing its place would follow the wrong shard.
 */
export function watchSetForCells(
  visited: Iterable<H3Cell>,
  options: WatchSetOptions = {},
): WatchTopic[] {
  const cap = options.res5Cap ?? SUBSCRIPTION_RES5_CAP;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new RangeError(`the res-5 cap must be a whole number, got ${cap}`);
  }

  const wanted = new Map<H3Cell, 'visited' | 'ring'>();
  for (const cell of visited) {
    if (!isH3Cell(cell, H3_RES_SHARD)) {
      throw new RangeError(`visited cell is not a res-5 H3 cell: ${String(cell)}`);
    }
    wanted.set(cell, 'visited');
  }
  for (const cell of [...wanted.keys()]) {
    for (const neighbour of ringCells(cell)) {
      if (!wanted.has(neighbour)) {
        wanted.set(neighbour, 'ring');
      }
    }
  }

  const regions = new Map<H3Cell, number>();
  for (const cell of wanted.keys()) {
    const region = pushCellOf(cell);
    regions.set(region, (regions.get(region) ?? 0) + 1);
  }

  const coarsened = new Set<H3Cell>();
  let kept = wanted.size;
  const fullestFirst = [...regions].sort(
    ([a, cellsA], [b, cellsB]) => cellsB - cellsA || (a < b ? -1 : 1),
  );
  for (const [region, cells] of fullestFirst) {
    if (kept <= cap) {
      break;
    }
    coarsened.add(region);
    kept -= cells;
  }

  const topics: WatchTopic[] = [];
  for (const [cell, reason] of wanted) {
    if (!coarsened.has(pushCellOf(cell))) {
      topics.push({ topic: cell, res: H3_RES_SHARD, reason });
    }
  }
  for (const region of regions.keys()) {
    topics.push({
      topic: region,
      res: H3_RES_PUSH,
      reason: coarsened.has(region) ? 'coarsened' : 'ancestor',
    });
  }
  return topics.sort(byTopic);
}

/**
 * The res-5 cells a device has been in within RETENTION_SEC of `nowTs`, sorted. History older
 * than that does not count, purged or not, so a phone whose purge is late follows what one
 * whose purge is not does; `matchReport` reads history the same way. Rows dated after `nowTs`
 * count, as the purge keeps them.
 */
export function visitedShardCells(history: WatchHistory, nowTs: number): H3Cell[] {
  const sinceTs = nowTs - RETENTION_SEC;
  const cells = new Set<H3Cell>();
  for (const sample of history.samples) {
    if (sample.ts_utc >= sinceTs) {
      cells.add(sample.h3_r5);
    }
  }
  for (const stay of history.stays) {
    if (stay.end_ts >= sinceTs) {
      cells.add(shardCellOf(stay.h3_r7));
    }
  }
  return [...cells].sort();
}

/** The watch set of a device with this history, as of `nowTs` (Unix seconds). */
export function computeWatchSet(
  history: WatchHistory,
  nowTs: number,
  options: WatchSetOptions = {},
): WatchTopic[] {
  return watchSetForCells(visitedShardCells(history, nowTs), options);
}
