import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  MAX_PERSON_PHOTOS,
  MAX_PHOTO_BASE64_CHARS,
  matchCellAt,
  shardCellOf,
  type Person,
} from '@findmyperson/shared';
import { bundleKey } from './compiler';
import { BANGALORE, addReport, harness, incompressibleBytes } from './testSupport';

/**
 * BUNDLE SIZE FOR A SYNTHETIC 100-REPORT SHARD (task B3.4; input to the mobile fetch-cost work
 * in B3.6). Measured on every run; the assertions below are the record, and server/README.md
 * repeats the table.
 *
 * A report carries up to MAX_PERSON_PHOTOS (two) photos. A 9 KB thumbnail is 12,000 base64
 * characters.
 *
 *   100 reports in one res-5 shard                    bytes       gzip -9    per report
 *   typical: two 9 KB thumbnails each               2,479,566   1,820,014    24.8 KB (18.2 gzip)
 *   one 9 KB thumbnail each                         1,274,866     915,256    12.7 KB (9.2 gzip)
 *   no photo                                           69,066       8,853     0.7 KB
 *   worst case: two photos of the largest size      6,633,166   5,002,760    66.3 KB (50.0 gzip)
 *
 * Brotli at its highest setting, measured once and not asserted because it takes seconds:
 * 1,813,318, 910,564, 7,838 and 4,937,075 bytes. It gains about 1% on gzip when reports carry
 * photos.
 *
 * Reading the numbers:
 *   - The photos are nearly all of it. A report is about 0.7 KB without one.
 *   - Compression only undoes the base64 expansion of a photo (an image is already
 *     compressed), so plan on about 9 KB per photo over the wire: 18 KB for a report with two,
 *     which is over the plan's estimate of 15 KB a report (6.3). One photo stays under it.
 *   - A device pays for the whole bundle again whenever any one report in its shard changes:
 *     there is no delta. At 100 live reports with two photos each that is about 1.8 MB per
 *     change per res-5 shard, twice what it was when a report carried one.
 *   - The res-3 bundle of an area holds every report of all its res-5 shards, so it is at
 *     least as large as the largest of them.
 *
 * The input: photos are random bytes, which compress like a real WebP or JPEG does, not at all,
 * and the two photos of a report are different bytes. Names and descriptions are realistic in
 * length but the same text in every report, so the compressed no-photo figure is a floor (real
 * text repeats less). The byte counts are exact for this input and move only if the payload
 * format, the signing scheme or the cover changes.
 *
 * Cost of a pass at the typical size, measured once on the development laptop: about 550 ms for
 * the pass that builds the bundle and about 120 ms for a pass that finds nothing changed (each
 * report is signed again to compare contents). Both are twice the one-photo figures.
 */

const DESCRIPTION =
  'Wearing a blue rain jacket, grey trousers and white trainers, carrying a black backpack. ' +
  'About 170 cm, short dark hair, glasses. Last seen walking towards the metro entrance.';

// 9,000 bytes is 12,000 base64 characters: the middle of the plan's 10-15 KB (6.3).
const TYPICAL_PHOTO_BYTES = 9_000;
const LARGEST_PHOTO_BYTES = (MAX_PHOTO_BASE64_CHARS / 4) * 3;

/** What each report of the shard carries: how many photos, and of what size. */
const VARIANTS = {
  typical: { photos: MAX_PERSON_PHOTOS, bytes: TYPICAL_PHOTO_BYTES },
  onePhoto: { photos: 1, bytes: TYPICAL_PHOTO_BYTES },
  none: { photos: 0, bytes: 0 },
  largest: { photos: MAX_PERSON_PHOTOS, bytes: LARGEST_PHOTO_BYTES },
} as const;
type Variant = keyof typeof VARIANTS;

function person(n: number, variant: Variant): Person {
  const base = { name: `Synthetic Person ${n}`, description: DESCRIPTION };
  const { photos, bytes } = VARIANTS[variant];
  if (photos === 0) {
    return base;
  }
  return {
    ...base,
    // Each photo is its own random bytes: two pictures of one person share nothing gzip can use.
    photos: Array.from({ length: photos }, (_, i) => ({
      mime: 'image/webp' as const,
      w: 256,
      h: 256,
      b64: incompressibleBytes(bytes, `photo-${n}-${i}`).toString('base64'),
    })),
  };
}

async function measure(variant: Variant) {
  const h = harness();
  const shard = shardCellOf(matchCellAt(BANGALORE));
  for (let n = 0; n < 100; n++) {
    // Spread over about 300 m around a point well inside the shard, radii 0 to 290 m.
    addReport(h.db, {
      center: { lat: BANGALORE.lat + (n % 10) * 0.0003, lon: BANGALORE.lon + (n % 7) * 0.0003 },
      radius_m: (n % 30) * 10,
      person: person(n, variant),
    });
  }
  const result = await h.compile();
  expect(result.skipped).toEqual([]);
  expect((await h.bundle(shard, 1))?.queries).toHaveLength(100);
  const body = Buffer.from((await h.store.get(bundleKey(shard, 1))) as Uint8Array);
  return { bytes: body.length, gzip: gzipSync(body, { level: 9 }).length };
}

/** zlib builds differ a little in what they emit; the byte count of the bundle does not. */
function expectWithin(actual: number, recorded: number, tolerance: number): void {
  expect(Math.abs(actual - recorded) / recorded).toBeLessThan(tolerance);
}

describe('bundle size for a synthetic 100-report shard', () => {
  test('typical: every report has two 9 KB thumbnails', async () => {
    const size = await measure('typical');
    expect(size.bytes).toBe(2_479_566);
    expectWithin(size.gzip, 1_820_014, 0.02);
  });

  test('every report has one 9 KB thumbnail', async () => {
    const size = await measure('onePhoto');
    expect(size.bytes).toBe(1_274_866);
    expectWithin(size.gzip, 915_256, 0.02);
  });

  test('no report has a photo', async () => {
    const size = await measure('none');
    expect(size.bytes).toBe(69_066);
    expectWithin(size.gzip, 8_853, 0.1);
  });

  test('worst case: every report has two photos of the largest size the schema allows', async () => {
    const size = await measure('largest');
    expect(size.bytes).toBe(6_633_166);
    expectWithin(size.gzip, 5_002_760, 0.02);
    // Signing, verifying and gzipping 6.6 MB is about 2 s alone and over the default 5 s when the
    // whole suite runs beside it.
  }, 30_000);
});
