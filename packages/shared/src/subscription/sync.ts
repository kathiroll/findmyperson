import { RETENTION_SEC } from '../constants';
import { shardCellOf } from '../geo/h3';
import type { SqlDatabase, SqlExecutor } from '../store/driver';
import { listSampleShardCells } from '../store/tables/locationSample';
import { listStayMatchCells } from '../store/tables/stay';
import {
  deleteSubscription,
  listSubscriptions,
  putSubscription,
  type Subscription,
} from '../store/tables/subscription';
import { watchSetForCells, type WatchSetOptions, type WatchTopic } from './watchSet';

/**
 * THE SUBSCRIPTION MANAGER (plan 7.2; task B3.7): keeps the `subscription` table equal to the
 * watch set of the device's history. `syncSubscriptions` is one run, and the only writer of
 * that table (store/ownership.ts). The rule for the set is at the top of subscription/watchSet.ts.
 *
 * ONE RUN reads the distinct res-5 cells of the fixes and stays within retention, computes the
 * watch set, and compares it with the rows stored. Only the difference is written, in one
 * transaction: topics no longer wanted are deleted, new ones inserted, and a row whose reason
 * changed (a neighbour the device has now been in, a region now coarsened) is rewritten. A row
 * still wanted for the same reason is not touched, so its `refreshed_at` is the time it was last
 * written and not the time it was last checked.
 *
 * MOST RUNS WRITE NOTHING. The set changes when the device enters a res-5 cell it has not been
 * in for 30 days, or when its last fix in one passes retention. A run that finds no difference
 * opens no transaction and takes no write lock, so it cannot hold up the native writer.
 *
 * IT SHRINKS WITH THE HISTORY. Call it after the retention purge, in the same pass (the app's
 * `DataStore.runMaintenance` does). It does not depend on the purge having run: the cells are
 * read as of `nowTs`, with the purge's own cutoff, so a row the purge has not yet deleted is
 * already not counted.
 *
 * PUSH IS NOT DONE HERE. The res-3 topics are also the push-wake topics (plan 7.3), and nothing
 * subscribes to them yet. The result lists what a run added and removed so that the push task
 * can apply the same difference to the push service; see SubscriptionSyncResult.
 */

/**
 * What one run wrote. For the push task: a push-wake topic is a row with `res` 3, whatever its
 * reason, so subscribe to the res-3 entries of `added` and unsubscribe from those of `removed`.
 * A result is gone if the process dies before it is applied, so the push side needs its own
 * record of what it has subscribed to, checked against the res-3 rows of the table, and cannot
 * rely on having seen every result. The entries name cells: keep them on the device.
 */
export interface SubscriptionSyncResult {
  /** Topics inserted by this run. */
  added: WatchTopic[];
  /** Topics deleted by this run, as they were stored. */
  removed: WatchTopic[];
  /** Topics kept whose reason changed, with the new reason. No push call follows from these. */
  changed: WatchTopic[];
  /** Rows in `subscription` after the run. */
  total: number;
}

/** Later than any real time in seconds; a value above it is milliseconds passed by mistake. */
const MAX_UNIX_SECONDS = 100_000_000_000;

function difference(
  wanted: readonly WatchTopic[],
  stored: readonly Subscription[],
): Omit<SubscriptionSyncResult, 'total'> {
  const held = new Map(stored.map((row) => [row.topic, row]));
  const wantedTopics = new Set(wanted.map((topic) => topic.topic));
  return {
    added: wanted.filter((topic) => !held.has(topic.topic)),
    removed: stored
      .filter((row) => !wantedTopics.has(row.topic))
      .map(({ topic, res, reason }) => ({ topic, res, reason })),
    changed: wanted.filter((topic) => {
      const row = held.get(topic.topic);
      return row !== undefined && row.reason !== topic.reason;
    }),
  };
}

async function wantedTopics(
  db: SqlExecutor,
  nowTs: number,
  options: WatchSetOptions,
): Promise<WatchTopic[]> {
  const sinceTs = nowTs - RETENTION_SEC;
  // The two queries are visitedShardCells (watchSet.ts) asked of the store, so that a run reads
  // a few dozen cells and not 30 days of rows.
  const visited = [
    ...(await listSampleShardCells(db, sinceTs)),
    ...(await listStayMatchCells(db, sinceTs)).map(shardCellOf),
  ];
  return watchSetForCells(visited, options);
}

/**
 * Brings `subscription` up to date with the history in the store as of `nowTs` (Unix seconds),
 * and returns what it changed. Throws RangeError, changing nothing, if `nowTs` is not a whole
 * number of seconds: a time in milliseconds would put every row past retention and empty the
 * table.
 */
export async function syncSubscriptions(
  db: SqlDatabase,
  nowTs: number,
  options: WatchSetOptions = {},
): Promise<SubscriptionSyncResult> {
  if (!Number.isSafeInteger(nowTs) || nowTs < 0 || nowTs > MAX_UNIX_SECONDS) {
    throw new RangeError(`subscription time must be Unix seconds, got ${nowTs}`);
  }
  const wanted = await wantedTopics(db, nowTs, options);
  const stored = await listSubscriptions(db);
  const pending = difference(wanted, stored);
  if (pending.added.length + pending.removed.length + pending.changed.length === 0) {
    return { ...pending, total: stored.length };
  }
  return db.transaction(async (tx) => {
    // Read again inside the transaction: what is written is the difference from the rows as
    // they are now, whatever another run did since the first look.
    const diff = difference(wanted, await listSubscriptions(tx));
    for (const { topic } of diff.removed) {
      await deleteSubscription(tx, topic);
    }
    for (const { topic, reason } of [...diff.added, ...diff.changed]) {
      await putSubscription(tx, topic, reason, nowTs);
    }
    return { ...diff, total: wanted.length };
  });
}
