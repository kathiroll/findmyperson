import { buildApp } from './app';
import { ServerDb } from './db';
import { createDeviceAllowListOperatorPolicy } from './operator';

/**
 * Process entry: `node --experimental-strip-types src/main.ts`. Configuration is environment only:
 *   FMP_DB_PATH               SQLite file (default ./findmyperson.db)
 *   FMP_PORT                  default 8080
 *   FMP_OPERATOR_DEVICE_IDS   comma-separated device ids allowed to release/reject reports.
 *                             Empty means nobody can, so no report can ever be released.
 */
const operatorIds = (process.env['FMP_OPERATOR_DEVICE_IDS'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');

const app = buildApp({
  db: new ServerDb(process.env['FMP_DB_PATH'] ?? './findmyperson.db'),
  operator: createDeviceAllowListOperatorPolicy(operatorIds),
  logger: true,
});

await app.listen({ host: '0.0.0.0', port: Number(process.env['FMP_PORT'] ?? 8080) });
