import { buildApp } from './app';
import { ServerDb } from './db';
import { createDeviceAllowListOperatorPolicy } from './operator';
import {
  MIN_OPERATOR_WEB_TOKEN_CHARS,
  OPERATOR_PAGE_PATH,
  usableOperatorWebToken,
} from './operatorPage';
import { shardOptionsFromEnv, startShardWorker, type ShardWorker } from './shards/worker';

/**
 * Process entry: `node dist/main.js` (built by build.mjs). Configuration is environment only:
 *   FMP_DB_PATH               SQLite file (default ./findmyperson.db)
 *   FMP_PORT                  default 8080
 *   FMP_OPERATOR_DEVICE_IDS   comma-separated device ids allowed to release/reject reports.
 *                             Empty means nobody can, so no report can ever be released.
 *   FMP_OPERATOR_WEB_TOKEN    the one token that opens the operator page at /operator. TEMPORARY
 *                             STUB (operatorPage.ts). Unset, empty or under 16 characters means
 *                             the page refuses every request.
 *   FMP_SHARD_OUT_DIR or FMP_R2_BUCKET, ...  the shard compiler; see shards/worker.ts. Unset means released
 *                             reports are not published to devices.
 */
const operatorIds = (process.env['FMP_OPERATOR_DEVICE_IDS'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');

const operatorWebToken = process.env['FMP_OPERATOR_WEB_TOKEN'];
const db = new ServerDb(process.env['FMP_DB_PATH'] ?? './findmyperson.db');
const app = buildApp({
  db,
  operator: createDeviceAllowListOperatorPolicy(operatorIds),
  operatorWebToken,
  logger: true,
});

// Read before listening, so a bad shard configuration stops the process at start.
const shardOptions = shardOptionsFromEnv(process.env, db, app.log);
let shardWorker: ShardWorker | null = null;
app.addHook('onClose', async () => {
  await shardWorker?.stop();
});

await app.listen({ host: '0.0.0.0', port: Number(process.env['FMP_PORT'] ?? 8080) });

if (usableOperatorWebToken(operatorWebToken) === null) {
  app.log.warn(
    { event: 'operator_web.disabled' },
    `FMP_OPERATOR_WEB_TOKEN is unset or shorter than ${MIN_OPERATOR_WEB_TOKEN_CHARS} characters; ${OPERATOR_PAGE_PATH} refuses every request`,
  );
}

if (shardOptions === null) {
  app.log.warn(
    { event: 'shards.disabled' },
    'neither FMP_SHARD_OUT_DIR nor FMP_R2_BUCKET is set; nothing is published',
  );
} else {
  shardWorker = startShardWorker(shardOptions);
}
