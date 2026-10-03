import { buildApp } from './app';
import { ServerDb } from './db';
import { createDeviceAllowListOperatorPolicy } from './operator';
import { shardOptionsFromEnv, startShardWorker, type ShardWorker } from './shards/worker';

/**
 * Process entry: `node --experimental-strip-types src/main.ts`. Configuration is environment only:
 *   FMP_DB_PATH               SQLite file (default ./findmyperson.db)
 *   FMP_PORT                  default 8080
 *   FMP_OPERATOR_DEVICE_IDS   comma-separated device ids allowed to release/reject reports.
 *                             Empty means nobody can, so no report can ever be released.
 *   FMP_SHARD_OUT_DIR, ...    the shard compiler; see shards/worker.ts. Unset means released
 *                             reports are not published to devices.
 */
const operatorIds = (process.env['FMP_OPERATOR_DEVICE_IDS'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');

const db = new ServerDb(process.env['FMP_DB_PATH'] ?? './findmyperson.db');
const app = buildApp({
  db,
  operator: createDeviceAllowListOperatorPolicy(operatorIds),
  logger: true,
});

// Read before listening, so a bad shard configuration stops the process at start.
const shardOptions = shardOptionsFromEnv(process.env, db, app.log);
let shardWorker: ShardWorker | null = null;
app.addHook('onClose', async () => {
  await shardWorker?.stop();
});

await app.listen({ host: '0.0.0.0', port: Number(process.env['FMP_PORT'] ?? 8080) });

if (shardOptions === null) {
  app.log.warn({ event: 'shards.disabled' }, 'FMP_SHARD_OUT_DIR is not set; nothing is published');
} else {
  shardWorker = startShardWorker(shardOptions);
}
