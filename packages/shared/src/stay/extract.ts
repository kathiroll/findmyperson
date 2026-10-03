import type { NewStay, Stay } from '../store/tables/stay';
import {
  addSample,
  canMerge,
  clusterOf,
  isSamePlace,
  isStay,
  mergeClusters,
  type StayCluster,
  type StaySample,
} from './cluster';

/**
 * STAY-POINT EXTRACTION (plan 5.4): turning the stream of fixes into dwell intervals.
 *
 * Fixes are taken in the order they were stored. The rules, which stay/derive.ts applies to the
 * store and extractStays applies to a plain list:
 *
 *   1. A dwell is a run of consecutive fixes, each within STAY_RADIUS_M of the centroid of the
 *      fixes before it.
 *   2. Once a dwell spans STAY_MIN_DURATION_SEC it is a stay, and it is open.
 *   3. The first fix beyond the radius closes the stay, at the time of the last fix inside it,
 *      and begins the next dwell.
 *   4. A dwell broken before it became a stay is nothing. Its first fix is dropped and the rest
 *      are tried again as a dwell of their own, so a place reached a fix or two later is not
 *      missed.
 *   5. A new stay at the same place as an earlier one, overlapping it or beginning within
 *      STAY_MERGE_GAP_SEC of its end, is that earlier stay continuing: the two are merged into
 *      the earlier row, which is open again. One wild fix, or the centroid wandering across the
 *      radius, does not cut a dwell in two. A stay somewhere else in the gap between them means
 *      the device left, and then they are two stays. All this is judged once, when the later
 *      dwell becomes a stay, from where its centroid is then.
 *   6. No stay is built where a visit row already covers the place and time. A closed row from
 *      another writer (iOS's CLVisit rows) covers its interval within STAY_RADIUS_M of its
 *      coordinate. A fix inside that is the visit's and builds nothing; a dwell may not grow or
 *      merge across it. What lies before the arrival or after the departure is derived as
 *      usual, so nothing the visit does not cover is lost.
 *
 * An OPEN visit row covers nothing. Its end_ts is its arrival time: the row says a visit began
 * and not how long it lasted, and iOS sometimes never reports the departure. Until the departure
 * is written the derived stay is the only record of how long the device stayed; when it is
 * written, rule 6 removes what the visit now covers.
 *
 * Two deliberate differences from the textbook method (Li and Zheng):
 *
 *   The radius is measured from the centroid, not from the first fix. The first fix at a place
 *   is often the worst one, and the centroid is a column of the row, so the open row alone is
 *   the state of the dwell in progress and no position is kept anywhere retention does not
 *   reach.
 *
 *   There is no limit on the time between two fixes. Capture is sparse and the process is killed
 *   and relaunched; a stay must survive that, so a fix at the same place after a gap continues
 *   the stay. The cost is that a stay also bridges a gap in which capture was off altogether.
 */

/**
 * A stay row another writer owns, as far as extraction is concerned. Open ones are ignored.
 */
export type CoveringStay = Pick<Stay, 'start_ts' | 'end_ts' | 'lat' | 'lon' | 'closed'>;

/** True when a closed visit covers part of the cluster's interval at the cluster's place. */
export function overlapsVisit(cluster: StayCluster, visits: readonly CoveringStay[]): boolean {
  return visits.some(
    (visit) =>
      visit.closed &&
      visit.start_ts <= cluster.end_ts &&
      cluster.start_ts <= visit.end_ts &&
      isSamePlace(visit, cluster),
  );
}

/** A derived stay being worked on. `id` is null until the row has been inserted. */
export interface LedgerRow extends StayCluster {
  id: number | null;
  closed: boolean;
}

const FIELDS = ['start_ts', 'end_ts', 'lat', 'lon', 'radius_m', 'sample_count', 'closed'] as const;

/**
 * The derived stays of one run, in memory. The tracker changes rows here and the caller writes
 * the difference to the store afterwards, so a row inserted and removed again in the same run
 * never reaches the store, and one whose values end up unchanged is not written.
 */
export class StayLedger {
  readonly rows: LedgerRow[] = [];
  private readonly stored = new Map<number, LedgerRow>();
  private readonly removed: LedgerRow[] = [];

  constructor(derived: readonly Stay[] = []) {
    for (const stay of derived) {
      const row: LedgerRow = {
        id: stay.id,
        start_ts: stay.start_ts,
        end_ts: stay.end_ts,
        lat: stay.lat,
        lon: stay.lon,
        radius_m: stay.radius_m,
        sample_count: stay.sample_count,
        closed: stay.closed,
      };
      this.rows.push(row);
      this.stored.set(stay.id, { ...row });
    }
  }

  /**
   * Adds a stay. A row removed earlier in the run that began at the same instant is the same
   * dwell derived again, so it is brought back and keeps its id.
   */
  insert(cluster: StayCluster, closed: boolean): LedgerRow {
    const at = this.removed.findIndex((row) => row.start_ts === cluster.start_ts);
    const revived = at < 0 ? undefined : this.removed.splice(at, 1)[0];
    const row: LedgerRow = Object.assign(revived ?? { id: null }, cluster, { closed });
    this.rows.push(row);
    return row;
  }

  remove(row: LedgerRow): void {
    const at = this.rows.indexOf(row);
    if (at < 0) {
      return;
    }
    this.rows.splice(at, 1);
    if (row.id !== null) {
      this.removed.push(row);
    }
  }

  has(row: LedgerRow): boolean {
    return this.rows.includes(row);
  }

  /** What the run changed, against the rows the ledger was built from. */
  changes(): { inserts: LedgerRow[]; updates: LedgerRow[]; deletes: number[] } {
    const inserts = this.rows.filter((row) => row.id === null);
    const updates = this.rows.filter((row) => {
      const before = row.id === null ? undefined : this.stored.get(row.id);
      return before !== undefined && FIELDS.some((field) => before[field] !== row[field]);
    });
    const deletes = this.removed.flatMap((row) => (row.id === null ? [] : [row.id]));
    return { inserts, updates, deletes };
  }
}

/**
 * Applies the rules above to one fix at a time. It holds at most one dwell: an open stay (a
 * ledger row) or a dwell still too short to be one (`pending`, which has no row).
 */
export class StayTracker<S extends StaySample> {
  private pending: { members: S[]; cluster: StayCluster } | null = null;

  constructor(
    private readonly ledger: StayLedger,
    private readonly visits: readonly CoveringStay[],
    private open: LedgerRow | null = null,
  ) {}

  /** The open stay, if the dwell in progress is one. */
  get openStay(): LedgerRow | null {
    return this.open;
  }

  /** The first fix of the dwell still too short to be a stay, if there is one. */
  get pendingStart(): S | null {
    return this.pending?.members[0] ?? null;
  }

  feed(sample: S): void {
    let queue: S[] = [sample];
    for (let at = 0; at < queue.length;) {
      const next = queue[at++];
      const retry = next === undefined ? null : this.place(next);
      if (retry !== null) {
        queue = retry.concat(queue.slice(at));
        at = 0;
      }
    }
  }

  /** Ends the stream: the open stay is closed and a dwell still too short is dropped. */
  finish(): void {
    if (this.open !== null) {
      this.open.closed = true;
      this.open = null;
    }
    this.pending = null;
  }

  /** Takes one fix. Returns the fixes to take again, in order, when a short dwell was broken. */
  private place(sample: S): S[] | null {
    if (this.open !== null) {
      const grown = this.grow(this.open, sample);
      if (grown !== null) {
        Object.assign(this.open, grown);
        return null;
      }
      // Rule 3.
      this.open.closed = true;
      this.open = null;
    } else if (this.pending !== null) {
      const grown = this.grow(this.pending.cluster, sample);
      if (grown === null) {
        // Rule 4.
        const retry = [...this.pending.members.slice(1), sample];
        this.pending = null;
        return retry;
      }
      this.pending.members.push(sample);
      this.pending.cluster = grown;
      if (isStay(grown)) {
        this.begin(grown);
      }
      return null;
    }
    const alone = clusterOf(sample);
    if (overlapsVisit(alone, this.visits)) {
      return null;
    }
    if (isStay(alone)) {
      this.begin(alone);
    } else {
      this.pending = { members: [sample], cluster: alone };
    }
    return null;
  }

  /** The cluster with the fix added, unless the fix is elsewhere or a visit is in the way. */
  private grow(cluster: StayCluster, sample: S): StayCluster | null {
    const grown = addSample(cluster, sample);
    return grown === null || overlapsVisit(grown, this.visits) ? null : grown;
  }

  /** Rules 2 and 5: the dwell is now a stay, a new row or an earlier one continuing. */
  private begin(cluster: StayCluster): void {
    let stay = cluster;
    const absorbed: LedgerRow[] = [];
    for (;;) {
      const earlier = this.mergeable(stay, absorbed);
      if (earlier === null) {
        break;
      }
      stay = mergeClusters(earlier, stay);
      absorbed.push(earlier);
    }
    // The row that began first keeps its id; start_ts is the one column a row never changes.
    const keeper = absorbed.find((row) => row.start_ts === stay.start_ts) ?? null;
    for (const row of absorbed) {
      if (row !== keeper) {
        this.ledger.remove(row);
      }
    }
    this.open =
      keeper === null
        ? this.ledger.insert(stay, false)
        : Object.assign(keeper, stay, { closed: false });
    this.pending = null;
  }

  /** The closed stay ending latest that rule 5 joins to the cluster, if any. */
  private mergeable(cluster: StayCluster, taken: readonly LedgerRow[]): LedgerRow | null {
    let best: LedgerRow | null = null;
    for (const row of this.ledger.rows) {
      if (
        row.closed &&
        !taken.includes(row) &&
        (best === null || row.end_ts >= best.end_ts) &&
        canMerge(row, cluster) &&
        !this.interrupted(row, cluster, taken) &&
        !overlapsVisit(mergeClusters(row, cluster), this.visits)
      ) {
        best = row;
      }
    }
    return best;
  }

  /** True when another stay, anywhere, lies in the gap between the two: they are not one dwell. */
  private interrupted(row: LedgerRow, cluster: StayCluster, taken: readonly LedgerRow[]): boolean {
    const from = Math.min(row.end_ts, cluster.end_ts);
    const to = Math.max(row.start_ts, cluster.start_ts);
    const inGap = (other: Pick<Stay, 'start_ts' | 'end_ts'>) =>
      other.start_ts < to && other.end_ts > from;
    return (
      from < to &&
      (this.ledger.rows.some((other) => other !== row && !taken.includes(other) && inGap(other)) ||
        this.visits.some((visit) => visit.closed && inGap(visit)))
    );
  }
}

/**
 * The stays in a list of fixes, as a pure function: no store, no clock. Fixes are taken in the
 * order given, which must be the order they were stored in. `visits` are the stay rows another
 * writer owns (rule 6); leave it empty where there is no such writer, as on Android.
 *
 * The result is ordered by start time and is ready for insertStay. At most one stay is open: the
 * one the fixes end inside. Given the same visit rows, deriveStays leaves exactly these rows in
 * the store, however the fixes are split across runs.
 */
export function extractStays(
  samples: readonly StaySample[],
  visits: readonly CoveringStay[] = [],
): NewStay[] {
  const ledger = new StayLedger();
  const tracker = new StayTracker(ledger, visits);
  for (const sample of samples) {
    tracker.feed(sample);
  }
  return ledger.rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.start_ts - b.row.start_ts || a.index - b.index)
    .map(({ row }) => ({
      start_ts: row.start_ts,
      end_ts: row.end_ts,
      lat: row.lat,
      lon: row.lon,
      radius_m: row.radius_m,
      sample_count: row.sample_count,
      closed: row.closed,
      source: 'derived' as const,
    }));
}
