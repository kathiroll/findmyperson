import { H3_RES_PUSH } from '../constants';
import { isH3Cell, pushCellOf, ringCells, type H3Cell } from '../geo/h3';
import type { ShardState } from './state';

/**
 * Which requests one fetch cycle makes. Pure: the index, the watch list and what is held go in,
 * a list of requests comes out. fetch/cycle.ts says why it is shaped this way.
 */

export interface CyclePlanInput {
  /** `shards` of the index in force: shard to generation. */
  shards: Readonly<Record<H3Cell, number>>;
  /** The shards the device needs. */
  watch: ReadonlySet<H3Cell>;
  /** What the store holds of each shard. */
  held: ReadonlyMap<H3Cell, ShardState>;
  /** The device's cover secret (newCoverSeed). */
  seed: string;
  /** Shard requests this cycle makes. */
  slots: number;
  /** Cover shards to follow. */
  coverShards: number;
  /** Uniform in [0, 1). */
  random: () => number;
}

export interface CyclePlan {
  /** Followed and not needed: the cover set, sorted. */
  cover: H3Cell[];
  /** Watched and cover shards together, sorted. They are treated alike from here on. */
  followed: H3Cell[];
  /** Followed shards whose generation moved: fetched in full and stored. */
  downloads: { shard: H3Cell; generation: number }[];
  /** Followed shards that did not change: asked for again with If-None-Match. */
  revalidations: { shard: H3Cell; generation: number; etag: string | null }[];
  /** Slots left when there are too few followed shards: the index is asked for again. */
  indexRepeats: number;
  /** Changed followed shards this cycle has no slot for. */
  deferred: number;
  /** Shards the store holds a bundle of that the index no longer lists: they have no reports. */
  emptied: H3Cell[];
}

/** A 32-bit hash of the seed and a shard: the shard's place in this device's cover order. */
export function coverRank(seed: string, shard: H3Cell): number {
  const text = `${seed}:${shard}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** 16 random bytes as hex. Made once per store and kept in it. */
export function newCoverSeed(random: () => number): string {
  let seed = '';
  for (let i = 0; i < 16; i++) {
    seed += Math.min(255, Math.floor(random() * 256))
      .toString(16)
      .padStart(2, '0');
  }
  return seed;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** The res-3 cell a shard lies in: itself for a res-3 shard. */
function regionOf(shard: H3Cell): H3Cell {
  return isH3Cell(shard, H3_RES_PUSH) ? shard : pushCellOf(shard);
}

/**
 * The cover set: shards in the index that are not watched, from the res-3 regions the watch list
 * lies in and, after those, the regions next to them (plan 7.3: "decoy shards drawn from the
 * device's res-3 region"). Within a region the order is the seeded hash, so a device keeps the
 * same cover shards from cycle to cycle and follows each new generation of them, as it does for
 * a shard it needs. A device watching nothing has no region and no cover.
 */
export function chooseCover(
  shards: Readonly<Record<H3Cell, number>>,
  watch: ReadonlySet<H3Cell>,
  seed: string,
  count: number,
): H3Cell[] {
  const home = new Set([...watch].map(regionOf));
  const near = new Set([...home].flatMap(ringCells));
  const candidates: { shard: H3Cell; tier: number; rank: number }[] = [];
  for (const shard of Object.keys(shards)) {
    if (watch.has(shard)) {
      continue;
    }
    const region = regionOf(shard);
    const tier = home.has(region) ? 0 : near.has(region) ? 1 : -1;
    if (tier >= 0) {
      candidates.push({ shard, tier, rank: coverRank(seed, shard) });
    }
  }
  candidates.sort(
    (a, b) =>
      a.tier - b.tier || a.rank - b.rank || (a.shard < b.shard ? -1 : a.shard > b.shard ? 1 : 0),
  );
  return candidates
    .slice(0, Math.max(0, count))
    .map((candidate) => candidate.shard)
    .sort();
}

export function planCycle(input: CyclePlanInput): CyclePlan {
  const { shards, watch, held, random } = input;
  const slots = Math.max(0, input.slots);
  const cover = chooseCover(shards, watch, input.seed, input.coverShards);
  const followed = [...new Set([...watch, ...cover])].sort();

  const changed: CyclePlan['downloads'] = [];
  const unchanged: CyclePlan['revalidations'] = [];
  for (const shard of followed) {
    const generation = Object.hasOwn(shards, shard) ? shards[shard] : undefined;
    if (generation === undefined) {
      continue;
    }
    const state = held.get(shard);
    // Generations only go up. A held generation above the index's is left alone.
    if (state === undefined || state.generation < generation) {
      changed.push({ shard, generation });
    } else if (state.generation === generation) {
      unchanged.push({ shard, generation, etag: state.etag });
    }
  }

  // Which changed shards go first, and which unchanged ones are asked for again, is drawn at
  // random over watched and cover shards together, so neither choice says which is which.
  const downloads = shuffled(changed, random).slice(0, slots);
  const revalidations = shuffled(unchanged, random).slice(0, slots - downloads.length);
  return {
    cover,
    followed,
    downloads,
    revalidations,
    indexRepeats: slots - downloads.length - revalidations.length,
    deferred: changed.length - downloads.length,
    emptied: [...held.keys()].filter((shard) => !Object.hasOwn(shards, shard)).sort(),
  };
}
