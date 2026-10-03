import { pathToFileURL } from 'node:url';
import { ServerDb } from '../db';
import { compileShards } from './compiler';
import { generateSigningKey } from './keys';
import type { PublishLog } from './storage';
import { shardOptionsFromEnv } from './worker';

/**
 * Command line for the shard compiler, for a one-off pass or a cron job. The server process
 * runs the same compiler on a timer (main.ts), so this is not needed alongside it.
 *
 *   node src/shards/cli.ts compile          one pass; prints the result as JSON
 *   node src/shards/cli.ts keygen <key_id>  prints a new signing key as JSON
 *
 * `compile` reads the environment described in worker.ts, plus FMP_DB_PATH. The output of
 * `keygen` contains the private seed: store it as a secret and pin only `public_key` in the app.
 */

type Env = Readonly<Record<string, string | undefined>>;

const USAGE = 'usage: cli.ts compile | cli.ts keygen <key_id>';

function jsonLineLog(write: (line: string) => void): PublishLog {
  const at =
    (level: string) =>
    (object: Record<string, unknown>, message: string): void =>
      write(JSON.stringify({ level, ...object, msg: message }));
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

/** Returns the process exit code. `out` gets the result, `err` gets log lines and usage. */
export async function runCli(
  args: readonly string[],
  env: Env,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const [command, argument] = args;
  if (command === 'keygen' && argument !== undefined) {
    out(JSON.stringify(generateSigningKey(argument), null, 2));
    return 0;
  }
  if (command === 'compile') {
    const db = new ServerDb(env['FMP_DB_PATH'] ?? './findmyperson.db');
    try {
      const options = shardOptionsFromEnv(env, db, jsonLineLog(err));
      if (options === null) {
        err('FMP_SHARD_OUT_DIR is not set');
        return 2;
      }
      const result = await compileShards(options);
      out(JSON.stringify(result, null, 2));
      // A skipped report or an unconfirmed invalidation is a failure a cron job should see.
      return result.skipped.length > 0 || result.cdnPending.length > 0 ? 1 : 0;
    } finally {
      db.close();
    }
  }
  err(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2), process.env, console.log, console.error);
}
