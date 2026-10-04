import { H3_RES_PUSH, H3_RES_SHARD } from '../../constants';
import { isH3Cell, type H3Cell } from '../../geo/h3';
import { num, oneOf, text, type SqlExecutor, type SqlRow } from '../driver';

/**
 * `subscription`: the shard and push topics this device follows (plan 7.2).
 *
 * WRITER: the subscription manager (syncSubscriptions in subscription/sync.ts), and nobody
 * else. It recomputes the wanted set from the last 30 days of history and applies the
 * difference here. Applying it to the push service as well is the push task's, not yet built.
 *
 * `reason` records why a topic is in the set:
 *   visited    a res-5 cell holding a stay or sample
 *   ring       a res-5 neighbour of a visited cell
 *   ancestor   the res-3 parent of a subscribed res-5 cell
 *   coarsened  a res-3 cell standing in for res-5 cells beyond SUBSCRIPTION_RES5_CAP
 *
 * A topic is one row with one reason: `visited` over `ring`, `coarsened` over `ancestor`.
 *
 * What a row is followed as:
 *   a shard        every res-5 row, and a res-3 row with reason `coarsened`. These are what the
 *                  bundle fetcher downloads (listWatchedShards).
 *   a push topic   every res-3 row, whatever its reason. An `ancestor` row is only this.
 *
 * `refreshed_at` is when the row was last written: added, or given a new reason. A run of the
 * manager that finds a row still wanted for the same reason does not touch it.
 */
export const SUBSCRIPTION_REASONS = ['visited', 'ring', 'ancestor', 'coarsened'] as const;
export type SubscriptionReason = (typeof SUBSCRIPTION_REASONS)[number];

export interface Subscription {
  topic: H3Cell;
  res: typeof H3_RES_SHARD | typeof H3_RES_PUSH;
  reason: SubscriptionReason;
  added_at: number;
  refreshed_at: number;
}

function fromRow(row: SqlRow): Subscription {
  const res = num(row, 'res');
  return {
    topic: text(row, 'topic'),
    res: res === H3_RES_PUSH ? H3_RES_PUSH : H3_RES_SHARD,
    reason: oneOf(row, 'reason', SUBSCRIPTION_REASONS),
    added_at: num(row, 'added_at'),
    refreshed_at: num(row, 'refreshed_at'),
  };
}

/** Every subscription, sorted by topic. */
export async function listSubscriptions(db: SqlExecutor): Promise<Subscription[]> {
  const rows = await db.execute(
    'SELECT topic, res, reason, added_at, refreshed_at FROM subscription ORDER BY topic',
  );
  return rows.map(fromRow);
}

/**
 * THE SHARD-KEY LIST of the bundle fetcher (`watch` of runFetchCycle): the topics followed as
 * shards, sorted. An `ancestor` row is left out. Its bundle holds every report of its res-3
 * region, which the res-5 rows beside it already bring for the cells the device needs.
 */
export async function listWatchedShards(db: SqlExecutor): Promise<H3Cell[]> {
  const rows = await db.execute(
    "SELECT topic FROM subscription WHERE reason <> 'ancestor' ORDER BY topic",
  );
  return rows.map((row) => text(row, 'topic'));
}

/**
 * Adds a topic, or refreshes one already present (its reason and `refreshed_at` are updated,
 * `added_at` is kept). Throws if the topic is not a res-5 or res-3 cell.
 */
export async function putSubscription(
  db: SqlExecutor,
  topic: H3Cell,
  reason: SubscriptionReason,
  now: number,
): Promise<void> {
  const res = isH3Cell(topic, H3_RES_SHARD)
    ? H3_RES_SHARD
    : isH3Cell(topic, H3_RES_PUSH)
      ? H3_RES_PUSH
      : null;
  if (res === null) {
    throw new RangeError(`subscription topic must be a res-5 or res-3 H3 cell: ${topic}`);
  }
  await db.execute(
    `INSERT INTO subscription (topic, res, reason, added_at, refreshed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (topic) DO UPDATE SET reason = excluded.reason, refreshed_at = excluded.refreshed_at`,
    [topic, res, reason, now, now],
  );
}

export async function deleteSubscription(db: SqlExecutor, topic: H3Cell): Promise<boolean> {
  const rows = await db.execute('DELETE FROM subscription WHERE topic = ? RETURNING topic', [
    topic,
  ]);
  return rows.length > 0;
}
