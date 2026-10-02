import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import geo from '../../../contracts/geo-vectors.json';
import { matchCellAt, sampleCells } from '../../geo/h3';
import { openMemoryDb } from '../../testing/memoryDb';
import { migrate } from '../migrations';
import {
  countSamplesSince,
  deleteSamplesBefore,
  INSERT_LOCATION_SAMPLE_SQL,
  insertLocationSample,
  listSamplesAfterId,
  listSamplesBetween,
  listSampleShardCells,
  listSamplesInCells,
  SAMPLE_SOURCES,
  type NewLocationSample,
} from './locationSample';
import {
  CLOSE_VISIT_STAY_SQL,
  deleteDerivedStay,
  deleteStaysEndedBefore,
  INSERT_VISIT_STAY_SQL,
  insertStay,
  listOpenStays,
  listStayMatchCells,
  listStaysInCells,
  listStaysOverlapping,
  updateDerivedStay,
  type NewStay,
} from './stay';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(async () => {
  db = openMemoryDb();
  await migrate(db);
});
afterEach(() => {
  db.close();
});

const bengaluru = { lat: 12.9716, lon: 77.5946 };
const mumbai = { lat: 19.076, lon: 72.8777 };

const sample = (ts_utc: number, at = bengaluru): NewLocationSample => ({
  ts_utc,
  ...at,
  accuracy_m: 18.5,
  source: 'wm',
});

describe('location_sample', () => {
  test('stores a fix with both cell columns derived from the coordinates', async () => {
    const id = await insertLocationSample(db, sample(1000));
    expect(await listSamplesBetween(db, 0, 2000)).toEqual([
      { id, ...sample(1000), ...sampleCells(bengaluru) },
    ]);
  });

  test('h3_r5 is the parent of h3_r7, even where that is not the cell containing the point', async () => {
    const trap = geo.points.find((point) => point.h3_r5 !== point.h3_r5_containing);
    if (trap === undefined) {
      throw new Error('fixture has no shard-edge point');
    }
    await insertLocationSample(db, sample(1000, trap));
    const [stored] = await listSamplesBetween(db, 0, 2000);
    expect(stored?.h3_r5).toBe(trap.h3_r5);
    expect(stored?.h3_r5).not.toBe(trap.h3_r5_containing);
  });

  test('time range is inclusive at both ends and ordered oldest first', async () => {
    for (const ts of [300, 100, 200, 400]) {
      await insertLocationSample(db, sample(ts));
    }
    const listed = await listSamplesBetween(db, 100, 300);
    expect(listed.map((row) => row.ts_utc)).toEqual([100, 200, 300]);
  });

  test('filters by res-7 cell and time together', async () => {
    await insertLocationSample(db, sample(100));
    await insertLocationSample(db, sample(200, mumbai));
    await insertLocationSample(db, sample(900));
    const cells = [matchCellAt(bengaluru)];
    expect((await listSamplesInCells(db, cells, 0, 500)).map((row) => row.ts_utc)).toEqual([100]);
    expect(await listSamplesInCells(db, [], 0, 500)).toEqual([]);
  });

  test('listSamplesAfterId is a cursor over insertion order', async () => {
    const first = await insertLocationSample(db, sample(500));
    const second = await insertLocationSample(db, sample(100));
    expect((await listSamplesAfterId(db, 0)).map((row) => row.id)).toEqual([first, second]);
    expect((await listSamplesAfterId(db, first)).map((row) => row.id)).toEqual([second]);
    expect(await listSamplesAfterId(db, second)).toEqual([]);
  });

  test('lists the distinct shard cells of recent samples', async () => {
    await insertLocationSample(db, sample(100, mumbai));
    await insertLocationSample(db, sample(200));
    await insertLocationSample(db, sample(300));
    expect(await listSampleShardCells(db, 0)).toEqual(
      [sampleCells(bengaluru).h3_r5, sampleCells(mumbai).h3_r5].sort(),
    );
    expect(await listSampleShardCells(db, 150)).toEqual([sampleCells(bengaluru).h3_r5]);
  });

  test('counts and purges by time', async () => {
    for (const ts of [100, 200, 300]) {
      await insertLocationSample(db, sample(ts));
    }
    expect(await countSamplesSince(db, 200)).toBe(2);
    expect(await deleteSamplesBefore(db, 200)).toBe(1);
    expect((await listSamplesBetween(db, 0, 1000)).map((row) => row.ts_utc)).toEqual([200, 300]);
    expect(await deleteSamplesBefore(db, 200)).toBe(0);
  });

  test('the native statement stores a row TypeScript reads back identically', async () => {
    const cells = sampleCells(mumbai);
    await db.execute(INSERT_LOCATION_SAMPLE_SQL, [
      1234,
      mumbai.lat,
      mumbai.lon,
      9.5,
      'fgs',
      cells.h3_r7,
      cells.h3_r5,
    ]);
    expect(await listSamplesBetween(db, 0, 2000)).toEqual([
      { id: 1, ts_utc: 1234, ...mumbai, accuracy_m: 9.5, source: 'fgs', ...cells },
    ]);
  });

  test('a source label from a newer native module is stored and read, not rejected', async () => {
    const cells = sampleCells(bengaluru);
    await db.execute(INSERT_LOCATION_SAMPLE_SQL, [
      1,
      bengaluru.lat,
      bengaluru.lon,
      5,
      'some-future-source',
      cells.h3_r7,
      cells.h3_r5,
    ]);
    expect((await listSamplesBetween(db, 0, 10))[0]?.source).toBe('some-future-source');
  });

  test('the known sources cover both Android modes and the iOS triggers', () => {
    expect(SAMPLE_SOURCES).toEqual(
      expect.arrayContaining(['fgs', 'wm', 'continuous', 'slc', 'visit', 'region']),
    );
  });
});

const stay = (start_ts: number, end_ts: number, at = bengaluru): NewStay => ({
  start_ts,
  end_ts,
  ...at,
  radius_m: 40,
  sample_count: 3,
  closed: true,
  source: 'derived',
});

describe('stay', () => {
  test('stores a stay with its cell derived from the centroid', async () => {
    const id = await insertStay(db, stay(100, 2000));
    expect(await listStaysOverlapping(db, 0, 5000)).toEqual([
      { id, ...stay(100, 2000), h3_r7: matchCellAt(bengaluru) },
    ]);
  });

  test('overlap is inclusive: touching the range at one instant counts', async () => {
    await insertStay(db, stay(100, 200));
    expect(await listStaysOverlapping(db, 200, 300)).toHaveLength(1);
    expect(await listStaysOverlapping(db, 0, 100)).toHaveLength(1);
    expect(await listStaysOverlapping(db, 201, 300)).toHaveLength(0);
    expect(await listStaysOverlapping(db, 0, 99)).toHaveLength(0);
    expect(await listStaysOverlapping(db, 120, 150)).toHaveLength(1);
  });

  test('filters by cell and interval together', async () => {
    await insertStay(db, stay(100, 200));
    await insertStay(db, stay(100, 200, mumbai));
    const found = await listStaysInCells(db, [matchCellAt(mumbai)], 0, 1000);
    expect(found.map((row) => row.lat)).toEqual([mumbai.lat]);
    expect(await listStaysInCells(db, [], 0, 1000)).toEqual([]);
  });

  test('an open stay is extended and then closed; its cell follows the centroid', async () => {
    const id = await insertStay(db, { ...stay(100, 100), closed: false, sample_count: 1 });
    expect((await listOpenStays(db)).map((row) => row.id)).toEqual([id]);

    const moved = { ...mumbai, end_ts: 1900, radius_m: 55, sample_count: 4, closed: true };
    expect(await updateDerivedStay(db, id, moved)).toBe(true);
    expect(await listOpenStays(db)).toEqual([]);
    const [stored] = await listStaysOverlapping(db, 0, 5000);
    expect(stored).toMatchObject({ ...moved, start_ts: 100, h3_r7: matchCellAt(mumbai) });
  });

  test('lists the distinct cells of recent stays', async () => {
    await insertStay(db, stay(100, 200));
    await insertStay(db, stay(300, 400));
    await insertStay(db, stay(500, 600, mumbai));
    expect(await listStayMatchCells(db, 0)).toEqual(
      [matchCellAt(bengaluru), matchCellAt(mumbai)].sort(),
    );
    expect(await listStayMatchCells(db, 450)).toEqual([matchCellAt(mumbai)]);
  });

  test('purges stays that ended before the cutoff, keeping ones still running across it', async () => {
    await insertStay(db, stay(100, 200));
    await insertStay(db, stay(150, 900));
    expect(await deleteStaysEndedBefore(db, 500)).toBe(1);
    expect((await listStaysOverlapping(db, 0, 5000)).map((row) => row.end_ts)).toEqual([900]);
  });

  describe("two writers, kept apart by 'source'", () => {
    const visitCell = matchCellAt(mumbai);

    test('the native statements record a visit on arrival and close it on departure', async () => {
      await db.execute(INSERT_VISIT_STAY_SQL, [
        1000,
        1000,
        mumbai.lat,
        mumbai.lon,
        65,
        visitCell,
        0,
      ]);
      expect(await listOpenStays(db)).toMatchObject([
        { start_ts: 1000, end_ts: 1000, closed: false, source: 'visit', sample_count: 0 },
      ]);

      const closed = await db.execute(`${CLOSE_VISIT_STAY_SQL} RETURNING id`, [4600, 1000]);
      expect(closed).toHaveLength(1);
      expect(await listStaysOverlapping(db, 0, 9999)).toMatchObject([
        { start_ts: 1000, end_ts: 4600, closed: true, source: 'visit', radius_m: 65 },
      ]);
    });

    test('closing a visit whose arrival was never recorded changes nothing', async () => {
      const closed = await db.execute(`${CLOSE_VISIT_STAY_SQL} RETURNING id`, [4600, 1000]);
      expect(closed).toEqual([]);
    });

    test('closing a visit never touches a derived stay that began at the same second', async () => {
      const derived = await insertStay(db, { ...stay(1000, 1200), closed: false });
      await db.execute(CLOSE_VISIT_STAY_SQL, [4600, 1000]);
      const [row] = await listStaysOverlapping(db, 0, 9999);
      expect(row).toMatchObject({ id: derived, end_ts: 1200, closed: false, source: 'derived' });
    });

    test('TypeScript cannot update or delete a visit row', async () => {
      await db.execute(INSERT_VISIT_STAY_SQL, [
        1000,
        1000,
        mumbai.lat,
        mumbai.lon,
        65,
        visitCell,
        0,
      ]);
      const [visit] = await listOpenStays(db);
      const id = visit?.id ?? -1;
      const update = { ...bengaluru, end_ts: 5, radius_m: 1, sample_count: 9, closed: true };
      expect(await updateDerivedStay(db, id, update)).toBe(false);
      expect(await deleteDerivedStay(db, id)).toBe(false);
      expect(await listOpenStays(db)).toMatchObject([{ id, source: 'visit', end_ts: 1000 }]);
    });

    test('TypeScript removes its own duplicate of a visit', async () => {
      const derived = await insertStay(db, stay(1000, 4000, mumbai));
      await db.execute(INSERT_VISIT_STAY_SQL, [
        1000,
        4600,
        mumbai.lat,
        mumbai.lon,
        65,
        visitCell,
        1,
      ]);
      expect(await deleteDerivedStay(db, derived)).toBe(true);
      expect((await listStaysOverlapping(db, 0, 9999)).map((row) => row.source)).toEqual(['visit']);
    });
  });
});
