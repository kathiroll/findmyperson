import { matchCellAt, type H3Cell } from '../../geo/h3';
import { num, placeholders, text, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `stay`: dwell intervals, the primary matching unit (plan 5.4).
 *
 * This table has two writers, told apart by `source`:
 *
 *   'derived'  TypeScript stay-point extraction over `location_sample` (deriveStays in
 *              stay/derive.ts). It inserts, extends and closes its own rows, and it alone removes
 *              duplicates between the two sources.
 *   'visit'    the iOS capture module, from CLVisit. It only ever touches 'visit' rows, with the
 *              two statements below, and never a 'derived' row.
 *
 * What a 'visit' row must contain:
 *   start_ts      the arrival time, a real instant. A visit whose arrival iOS reports as
 *                 unknown is not written until an arrival time is known.
 *   end_ts        the departure time once known, otherwise equal to start_ts.
 *   closed        1 once the departure is known, otherwise 0.
 *   lat, lon      the visit coordinate.
 *   radius_m      the visit's horizontal accuracy, in metres.
 *   h3_r7         the res-7 cell of (lat, lon).
 *   sample_count  0, because the row is not built from samples.
 *
 * For every row, whoever wrote it: start_ts <= end_ts, and an open stay (closed = 0) has
 * end_ts set to the latest time the device is known to have still been there.
 */
export const STAY_SOURCES = ['derived', 'visit'] as const;
export type StaySource = (typeof STAY_SOURCES)[number];

export interface Stay {
  id: number;
  start_ts: number;
  end_ts: number;
  /** Centroid of the stay. */
  lat: number;
  lon: number;
  radius_m: number;
  h3_r7: H3Cell;
  sample_count: number;
  closed: boolean;
  /** One of STAY_SOURCES, or a label from a newer native module. */
  source: string;
}

/** A stay to store. `h3_r7` is derived from the centroid, never supplied. */
export type NewStay = Omit<Stay, 'id' | 'h3_r7' | 'source'> & { source: StaySource };

/** The fields that change while an open stay grows or closes. */
export type StayUpdate = Pick<
  Stay,
  'end_ts' | 'lat' | 'lon' | 'radius_m' | 'sample_count' | 'closed'
>;

/**
 * Native statement: record a visit on arrival, or a whole visit seen only at departure.
 * Parameter order: start_ts, end_ts, lat, lon, radius_m, h3_r7, closed.
 */
export const INSERT_VISIT_STAY_SQL =
  "INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'visit')";

/**
 * Native statement: close the open visit that began at the given arrival time. Parameter
 * order: end_ts, start_ts. If it changes no row, the arrival was never recorded and the module
 * inserts a closed row with INSERT_VISIT_STAY_SQL instead.
 */
export const CLOSE_VISIT_STAY_SQL =
  "UPDATE stay SET end_ts = ?, closed = 1 WHERE source = 'visit' AND closed = 0 AND start_ts = ?";

const COLUMNS = 'id, start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source';

function fromRow(row: SqlRow): Stay {
  return {
    id: num(row, 'id'),
    start_ts: num(row, 'start_ts'),
    end_ts: num(row, 'end_ts'),
    lat: num(row, 'lat'),
    lon: num(row, 'lon'),
    radius_m: num(row, 'radius_m'),
    h3_r7: text(row, 'h3_r7'),
    sample_count: num(row, 'sample_count'),
    closed: num(row, 'closed') !== 0,
    source: text(row, 'source'),
  };
}

/** Inserts a stay and returns its id. */
export async function insertStay(db: SqlExecutor, stay: NewStay): Promise<number> {
  const rows = await db.execute(
    `INSERT INTO stay (start_ts, end_ts, lat, lon, radius_m, h3_r7, sample_count, closed, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      stay.start_ts,
      stay.end_ts,
      stay.lat,
      stay.lon,
      stay.radius_m,
      matchCellAt(stay),
      stay.sample_count,
      stay.closed ? 1 : 0,
      stay.source,
    ],
  );
  return num(rows[0] ?? {}, 'id');
}

/**
 * Extends or closes a 'derived' stay. The cell is recomputed because the centroid moves as
 * samples are added. Returns false if there is no such 'derived' row; 'visit' rows belong to
 * the native module and are never changed here.
 */
export async function updateDerivedStay(
  db: SqlExecutor,
  id: number,
  update: StayUpdate,
): Promise<boolean> {
  const rows = await db.execute(
    `UPDATE stay SET end_ts = ?, lat = ?, lon = ?, radius_m = ?, h3_r7 = ?, sample_count = ?, closed = ?
     WHERE id = ? AND source = 'derived' RETURNING id`,
    [
      update.end_ts,
      update.lat,
      update.lon,
      update.radius_m,
      matchCellAt(update),
      update.sample_count,
      update.closed ? 1 : 0,
      id,
    ],
  );
  return rows.length > 0;
}

/** Stays not yet closed, oldest first. Normally at most one per source. */
export async function listOpenStays(db: SqlExecutor): Promise<Stay[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM stay WHERE closed = 0 ORDER BY start_ts, id`,
  );
  return rows.map(fromRow);
}

/** Stays whose interval overlaps [fromTs, toTs], oldest first. */
export async function listStaysOverlapping(
  db: SqlExecutor,
  fromTs: number,
  toTs: number,
): Promise<Stay[]> {
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM stay WHERE start_ts <= ? AND end_ts >= ? ORDER BY start_ts, id`,
    [toTs, fromTs],
  );
  return rows.map(fromRow);
}

/** Stays in any of the given res-7 cells whose interval overlaps [fromTs, toTs]. */
export async function listStaysInCells(
  db: SqlExecutor,
  cells: readonly H3Cell[],
  fromTs: number,
  toTs: number,
): Promise<Stay[]> {
  if (cells.length === 0) {
    return [];
  }
  const rows = await db.execute(
    `SELECT ${COLUMNS} FROM stay
     WHERE h3_r7 IN (${placeholders(cells.length)}) AND start_ts <= ? AND end_ts >= ?
     ORDER BY start_ts, id`,
    [...cells, toTs, fromTs],
  );
  return rows.map(fromRow);
}

/** The distinct res-7 cells of stays that ended at or after sinceTs, sorted. */
export async function listStayMatchCells(db: SqlExecutor, sinceTs: number): Promise<H3Cell[]> {
  const rows = await db.execute(
    'SELECT DISTINCT h3_r7 FROM stay WHERE end_ts >= ? ORDER BY h3_r7',
    [sinceTs],
  );
  return rows.map((row) => text(row, 'h3_r7'));
}

/** Removes one 'derived' stay (reconciliation with a 'visit' row covering the same dwell). */
export async function deleteDerivedStay(db: SqlExecutor, id: number): Promise<boolean> {
  const rows = await db.execute(
    "DELETE FROM stay WHERE id = ? AND source = 'derived' RETURNING id",
    [id],
  );
  return rows.length > 0;
}

/** Retention purge: deletes stays that ended before the cutoff. Returns how many. */
export async function deleteStaysEndedBefore(db: SqlExecutor, cutoffTs: number): Promise<number> {
  const rows = await db.execute('DELETE FROM stay WHERE end_ts < ? RETURNING id', [cutoffTs]);
  return rows.length;
}

/**
 * Retention purge: a stay still running across the cutoff keeps its row, but the part before the
 * cutoff is history past retention, and the fixes it was built from are deleted. Its start is
 * moved up to the cutoff, so no row claims a time the store no longer holds. Run it after
 * deleteStaysEndedBefore with the same cutoff. Returns how many rows were shortened.
 *
 * It applies to both sources. An open 'visit' row is never shortened: its end_ts is its arrival
 * time, so it is either wholly inside retention or already deleted, and CLOSE_VISIT_STAY_SQL
 * still finds it by the arrival time it was written with.
 */
export async function trimStaysStartedBefore(db: SqlExecutor, cutoffTs: number): Promise<number> {
  const rows = await db.execute(
    'UPDATE stay SET start_ts = ? WHERE start_ts < ? AND end_ts >= ? RETURNING id',
    [cutoffTs, cutoffTs, cutoffTs],
  );
  return rows.length;
}
