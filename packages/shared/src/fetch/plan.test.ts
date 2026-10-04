import { describe, expect, test } from 'vitest';
import { matchCellAt, pushCellOf, ringCells, shardCellOf, type H3Cell } from '../geo/h3';
import { seededRandom, shardsAround } from '../testing/shardCdn';
import { chooseCover, coverRank, newCoverSeed, planCycle, type CyclePlanInput } from './plan';
import type { ShardState } from './state';

const SHARDS = shardsAround(4);
const HOME = SHARDS[30] as H3Cell;
const MUMBAI = shardCellOf(matchCellAt({ lat: 19.076, lon: 72.8777 }));
const SEED = '000102030405060708090a0b0c0d0e0f';
const indexOf = (shards: readonly H3Cell[], generation = 1): Record<H3Cell, number> =>
  Object.fromEntries(shards.map((shard) => [shard, generation]));
const held = (generation: number): ShardState => ({ generation, etag: '"e"', query_ids: [] });

function plan(overrides: Partial<CyclePlanInput>) {
  return planCycle({
    shards: indexOf(SHARDS),
    watch: new Set([HOME]),
    held: new Map(),
    seed: SEED,
    slots: 8,
    coverShards: 8,
    random: seededRandom(1),
    ...overrides,
  });
}

describe('chooseCover', () => {
  const index = indexOf([...SHARDS, MUMBAI]);

  test('takes unwatched shards from the watch list’s own res-3 region first', () => {
    const cover = chooseCover(index, new Set([HOME]), SEED, 8);
    expect(cover).toHaveLength(8);
    expect(cover).not.toContain(HOME);
    const inRegion = SHARDS.filter(
      (shard) => shard !== HOME && pushCellOf(shard) === pushCellOf(HOME),
    );
    expect(inRegion.length).toBeGreaterThanOrEqual(8);
    expect(cover.every((shard) => inRegion.includes(shard))).toBe(true);
  });

  test('then from the regions next to it, and never from further away', () => {
    const all = chooseCover(index, new Set([HOME]), SEED, 1_000);
    const near = new Set(ringCells(pushCellOf(HOME)));
    expect(all.every((shard) => near.has(pushCellOf(shard)))).toBe(true);
    expect(all).not.toContain(MUMBAI);
    expect(all.some((shard) => pushCellOf(shard) !== pushCellOf(HOME))).toBe(true);
  });

  test('is the same every time for one seed, and differs between seeds', () => {
    const again = () => chooseCover(index, new Set([HOME]), SEED, 8);
    expect(again()).toEqual(again());
    const other = chooseCover(index, new Set([HOME]), 'ffeeddccbbaa99887766554433221100', 8);
    expect(other).not.toEqual(again());
  });

  test('a res-3 shard counts as its own region', () => {
    const region = pushCellOf(HOME);
    const cover = chooseCover({ ...index, [region]: 1 }, new Set([region]), SEED, 1_000);
    expect(cover).toContain(HOME);
    expect(cover).not.toContain(region);
  });

  test('a device watching nothing has no region and no cover', () => {
    expect(chooseCover(index, new Set(), SEED, 8)).toEqual([]);
  });
});

describe('planCycle', () => {
  test('always fills exactly the slots it was given', () => {
    for (const watched of [0, 1, 7, 50]) {
      for (const heldCount of [0, 3, 61]) {
        const result = plan({
          watch: new Set(SHARDS.slice(0, watched)),
          held: new Map(SHARDS.slice(0, heldCount).map((shard) => [shard, held(1)])),
        });
        const total = result.downloads.length + result.revalidations.length + result.indexRepeats;
        expect(total).toBe(8);
      }
    }
  });

  test('a followed shard is downloaded when its generation is above the one held', () => {
    const result = plan({
      shards: indexOf(SHARDS, 3),
      coverShards: 0,
      held: new Map([[HOME, held(2)]]),
    });
    expect(result.downloads).toEqual([{ shard: HOME, generation: 3 }]);
    expect(result.revalidations).toEqual([]);
    expect(result.indexRepeats).toBe(7);
  });

  test('and revalidated with its ETag when it is the one held', () => {
    const result = plan({ coverShards: 0, held: new Map([[HOME, held(1)]]) });
    expect(result.downloads).toEqual([]);
    expect(result.revalidations).toEqual([{ shard: HOME, generation: 1, etag: '"e"' }]);
  });

  test('a generation below the one held is never asked for', () => {
    const result = plan({ coverShards: 0, held: new Map([[HOME, held(5)]]) });
    expect(result.downloads).toEqual([]);
    expect(result.revalidations).toEqual([]);
    expect(result.indexRepeats).toBe(8);
  });

  test('changed shards beyond the slots are counted as deferred', () => {
    const result = plan({ watch: new Set(SHARDS.slice(0, 20)), coverShards: 0 });
    expect(result.downloads).toHaveLength(8);
    expect(result.deferred).toBe(12);
    expect(new Set(result.downloads.map((entry) => entry.shard)).size).toBe(8);
  });

  test('which changed shards go first does not favour the watched ones', () => {
    // 4 watched, 8 cover, 8 slots: over many draws cover shards take slots too.
    const watch = new Set(SHARDS.slice(28, 32));
    let coverFirst = 0;
    for (let draw = 0; draw < 50; draw++) {
      const result = plan({ watch, random: seededRandom(draw) });
      expect(result.followed).toHaveLength(12);
      if (!watch.has(result.downloads[0]?.shard ?? '')) {
        coverFirst += 1;
      }
    }
    // 8 of 12 followed shards are cover, so about two draws in three start with one.
    expect(coverFirst).toBeGreaterThan(20);
    expect(coverFirst).toBeLessThan(45);
  });

  test('a watched shard the index does not list costs nothing', () => {
    const result = plan({ shards: {}, coverShards: 0 });
    expect(result).toMatchObject({ downloads: [], revalidations: [], indexRepeats: 8 });
  });

  test('a held shard the index no longer lists is reported as emptied, followed or not', () => {
    const result = plan({
      shards: indexOf([HOME]),
      held: new Map([
        [HOME, held(1)],
        [MUMBAI, held(4)],
      ]),
    });
    expect(result.emptied).toEqual([MUMBAI]);
  });
});

describe('the cover secret', () => {
  test('is 16 bytes of hex from the random source given', () => {
    expect(newCoverSeed(seededRandom(7))).toMatch(/^[0-9a-f]{32}$/);
    expect(newCoverSeed(seededRandom(7))).toBe(newCoverSeed(seededRandom(7)));
    expect(newCoverSeed(seededRandom(8))).not.toBe(newCoverSeed(seededRandom(7)));
    expect(newCoverSeed(() => 0.999999999999)).toBe('ff'.repeat(16));
  });

  test('ranks shards as an unsigned 32-bit number that depends on the seed', () => {
    const ranks = SHARDS.map((shard) => coverRank(SEED, shard));
    expect(ranks.every((rank) => Number.isInteger(rank) && rank >= 0 && rank < 2 ** 32)).toBe(true);
    expect(new Set(ranks).size).toBe(SHARDS.length);
    expect(coverRank('another seed', HOME)).not.toBe(coverRank(SEED, HOME));
  });
});
