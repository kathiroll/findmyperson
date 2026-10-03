import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
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
 *   100 reports in one res-5 shard                    bytes       gzip -9    per report
 *   typical: 9 KB thumbnail (12,000 base64 chars)   1,274,566     915,251    12.7 KB (9.2 gzip)
 *   no photo                                           69,066       8,853     0.7 KB
 *   worst case: largest photo the schema allows     3,351,366   2,529,364    33.5 KB (25.3 gzip)
 *
 * Brotli at its highest setting, measured once and not asserted because it takes seconds:
 * 910,675, 7,838 and 2,472,543 bytes. It gains under 1% on gzip when reports carry photos.
 *
 * Reading the numbers:
 *   - The photo is nearly all of it. A report is about 0.7 KB without one.
 *   - Compression only undoes the base64 expansion of the photo (an image is already
 *     compressed), so plan on about 9 KB per report over the wire, against the plan's estimate
 *     of 15 KB (6.3).
 *   - A device pays for the whole bundle again whenever any one report in its shard changes:
 *     there is no delta. At 100 live reports that is about 0.9 MB per change per res-5 shard.
 *   - The res-3 bundle of an area holds every report of all its res-5 shards, so it is at
 *     least as large as the largest of them.
 *
 * The input: photos are random bytes, which compress like a real WebP or JPEG does, not at all.
 * Names and descriptions are realistic in length but the same text in every report, so the
 * compressed no-photo figure is a floor (real text repeats less). The byte counts are exact for
 * this input and move only if the payload format, the signing scheme or the cover changes.
 *
 * Cost of a pass at this size, measured once on the development laptop: about 300 ms for the pass that builds the
 * bundle and about 65 ms for a pass that finds nothing changed (each report is signed again to
 * compare contents).
 */

const DESCRIPTION =
  'Wearing a blue rain jacket, grey trousers and white trainers, carrying a black backpack. ' +
  'About 170 cm, short dark hair, glasses. Last seen walking towards the metro entrance.';

type Variant = 'typical' | 'none' | 'largest';

function person(n: number, variant: Variant): Person {
  const base = { name: `Synthetic Person ${n}`, description: DESCRIPTION };
  if (variant === 'none') {
    return base;
  }
  // 9,000 bytes is 12,000 base64 characters: the middle of the plan's 10-15 KB (6.3).
  const b64 =
    variant === 'typical'
      ? incompressibleBytes(9_000, `photo-${n}`).toString('base64')
      : incompressibleBytes((MAX_PHOTO_BASE64_CHARS / 4) * 3, `photo-${n}`).toString('base64');
  return { ...base, photo: { mime: 'image/webp', w: 256, h: 256, b64 } };
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
  test('typical: every report has a 9 KB thumbnail', async () => {
    const size = await measure('typical');
    expect(size.bytes).toBe(1_274_566);
    expectWithin(size.gzip, 915_251, 0.02);
  });

  test('no report has a photo', async () => {
    const size = await measure('none');
    expect(size.bytes).toBe(69_066);
    expectWithin(size.gzip, 8_853, 0.1);
  });

  test('worst case: every report has the largest photo the schema allows', async () => {
    const size = await measure('largest');
    expect(size.bytes).toBe(3_351_366);
    expectWithin(size.gzip, 2_529_364, 0.02);
  });
});
