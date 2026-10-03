import { sampleCells, type H3Cell } from '../../geo/h3';
import { num, numOrNull, placeholders, text, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `location_sample`: raw periodic fixes.
 *
 * WRITER: the native capture module, and nobody else in production. Coordinates never cross the
 * React Native bridge on the capture path (plan 5.5 rule 1), so TypeScript only reads this
 * table. insertLocationSample exists for tests, fixtures and the debug-only sample injector.
 */

/**
 * How a fix was obtained. `fgs` and `wm` are the two Android capture modes (foreground service,
 * WorkManager); `continuous`, `slc`, `visit` and `region` are the iOS sources. The column has no
 * CHECK constraint, so a reader must tolerate a label it does not know.
 */
export const SAMPLE_SOURCES = [
  'fgs',
  'wm',
  'continuous',
  'slc',
  'visit',
  'region',
  'manual',
  'fetch-wake',
] as const;
export type SampleSource = (typeof SAMPLE_SOURCES)[number];

export interface LocationSample {
  id: number;
  /** Time of the fix, Unix seconds. */
  ts_utc: number;
  lat: number;
  lon: number;
  accuracy_m: number;
  /** One of SAMPLE_SOURCES, or a label from a newer native module. */
  source: string;
  h3_r7: H3Cell;
  h3_r5: H3Cell;
}

/** A fix to store. The two cell columns are derived, never supplied. */
export interface NewLocationSample {
  ts_utc: number;
  lat: number;
  lon: number;
  accuracy_m: number;
  source: SampleSource;
}

/**
 * The exact statement the native writers run. Parameter order: ts_utc, lat, lon, accuracy_m,
 * source, h3_r7, h3_r5, where h3_r7 is the res-7 cell of (lat, lon) and h3_r5 is the res-5
 * PARENT of that cell (geo/h3.ts sampleCells).
 */
export const INSERT_LOCATION_SAMPLE_SQL =
  'INSERT INTO location_sample (ts_utc, lat, lon, accuracy_m, source, h3_r7, h3_r5) VALUES (?, ?, ?, ?, ?, ?, ?)';

const COLUMNS = 'id, ts_utc, lat, lon, accuracy_m, source, h3_r7, h3_r5';

function fromRow(row: SqlRow): LocationSample {
  return {
    id: num(row, 'id'),
    ts_utc: num(row, 'ts_utc'),
    lat: num(row, 'lat'),
    lon: num(row, 'lon'),
    accuracy_m: num(row, 'accuracy_m'),
    source: text(row, 'source'),
    h3_r7: text(row, 'h3_r7'),
    h3_r5: text(row, 'h3_r5'),
  };
}

/** Test and debug path only; see the file comment. Returns the new row id. */
export async function insertLocationSample(
  db: SqlExecutor,
  sample: NewLocationSample,
): Promise<number> {
  const cells = sampleCells(sample);
  const rows = await db.execute(`${INSERT_LOCATION_SAMPLE_SQL} RETURNING id`, [
    sample.ts_utc,
    sample.lat,
    sample.lon,
    sample.accuracy_m,
    sample.source,
    cells.h3_r7,
    cells.h3_r5,
  ]);
  return num(rows[0] ?? {}, 'id');
}

/** Samples with fromTs <= ts_utc <= toTs, oldest first. */
export async function listSamplesBetween(
  db: SqlExecutor,
  fromTs: number,
  toTs: number,
): Promise<LocationSample[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM location_sample WHERE ts_utc BETWEEN ? AND ? ORDER BY ts_utc, id`,
    [fromTs, toTs],
  );
  return rows.map(fromRow);
}

/** Samples in any of the given res-7 cells within the time range, oldest first. */
export async function listSamplesInCells(
  db: SqlExecutor,
  cells: readonly H3Cell[],
  fromTs: number,
  toTs: number,
): Promise<LocationSample[]> {
  if (cells.length === 0) {
    return [];
  }
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM location_sample
     WHERE h3_r7 IN (${placeholders(cells.length)}) AND ts_utc BETWEEN ? AND ?
     ORDER BY ts_utc, id`,
    [...cells, fromTs, toTs],
  );
  return rows.map(fromRow);
}

/** Samples written after the row with the given id, in insertion order. A cursor for readers. */
export async function listSamplesAfterId(
  db: SqlExecutor,
  afterId: number,
): Promise<LocationSample[]> {
  const rows = await db.execute(`SELECT ${COLUMNS} FROM location_sample WHERE id > ? ORDER BY id`, [
    afterId,
  ]);
  return rows.map(fromRow);
}

/**
 * The highest sample id in the table, or null when it is empty. The id is a rowid, so after the
 * table has been emptied new samples start again from 1; a reader holding a cursor above this
 * value must start over.
 */
export async function getLatestSampleId(db: SqlExecutor): Promise<number | null> {
  const rows = await db.execute('SELECT max(id) AS id FROM location_sample');
  return numOrNull(rows[0] ?? {}, 'id');
}

/** The distinct res-5 shard cells of samples taken at or after sinceTs, sorted. */
export async function listSampleShardCells(db: SqlExecutor, sinceTs: number): Promise<H3Cell[]> {
  const rows = await db.execute(
    'SELECT DISTINCT h3_r5 FROM location_sample WHERE ts_utc >= ? ORDER BY h3_r5',
    [sinceTs],
  );
  return rows.map((row) => text(row, 'h3_r5'));
}

export async function countSamplesSince(db: SqlExecutor, sinceTs: number): Promise<number> {
  const rows = await db.execute('SELECT count(*) AS n FROM location_sample WHERE ts_utc >= ?', [
    sinceTs,
  ]);
  return num(rows[0] ?? {}, 'n');
}

/** Retention purge: deletes samples older than the cutoff. Returns how many were deleted. */
export async function deleteSamplesBefore(db: SqlExecutor, cutoffTs: number): Promise<number> {
  const rows = await db.execute('DELETE FROM location_sample WHERE ts_utc < ? RETURNING id', [
    cutoffTs,
  ]);
  return rows.length;
}
