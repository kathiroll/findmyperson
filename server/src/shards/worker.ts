import { readFileSync } from 'node:fs';
import type { ServerDb } from '../db';
import { compileShards, type CompileOptions, type CompileResult } from './compiler';
import { KeyRing } from './keys';
import { FileSystemObjectStore, createLoggingCdnInvalidator, type PublishLog } from './storage';

/**
 * Running the compiler: its configuration, and the loop that keeps the published files current.
 *
 * Configuration is environment only, like the rest of the server (main.ts):
 *   FMP_SHARD_OUT_DIR        directory the bundles and index.json are written to. Unset means
 *                            shard publishing is off.
 *   FMP_SHARD_KEYS           the signing keys as JSON (see keys.ts), or
 *   FMP_SHARD_KEYS_FILE      a file holding that JSON. Seeds are secrets: keep them out of the
 *                            repository and out of logs.
 *   FMP_RESPOND_ENDPOINT     https URL of POST /v1/responses as devices reach it.
 *   FMP_SHARD_INTERVAL_SEC   seconds between passes of the worker (default 60).
 *
 * The loop is a plain interval rather than a hook on release, edit and end: reports are rare, a
 * pass that finds nothing changed costs one listing, and expiry needs a timer anyway. So a
 * release reaches the store within one interval.
 */

export const DEFAULT_SHARD_INTERVAL_SEC = 60;

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required when FMP_SHARD_OUT_DIR is set`);
  }
  return value;
}

/** The compiler's options from the environment, or null if shard publishing is off. */
export function shardOptionsFromEnv(
  env: Env,
  db: ServerDb,
  log: PublishLog,
): (CompileOptions & { intervalSec: number }) | null {
  const outDir = env['FMP_SHARD_OUT_DIR'];
  if (outDir === undefined || outDir === '') {
    return null;
  }
  const keysFile = env['FMP_SHARD_KEYS_FILE'];
  const keysJson =
    keysFile !== undefined && keysFile !== ''
      ? readFileSync(keysFile, 'utf8')
      : required(env, 'FMP_SHARD_KEYS');
  let keysConfig: unknown;
  try {
    keysConfig = JSON.parse(keysJson);
  } catch {
    // The parser's own message can quote the input, which holds the seeds.
    throw new Error('the signing key config is not valid JSON');
  }
  const respondEndpoint = required(env, 'FMP_RESPOND_ENDPOINT');
  if (!/^https:\/\/[^\s]+$/.test(respondEndpoint)) {
    throw new Error('FMP_RESPOND_ENDPOINT must be an https URL');
  }
  const intervalSec = Number(env['FMP_SHARD_INTERVAL_SEC'] ?? DEFAULT_SHARD_INTERVAL_SEC);
  if (!Number.isFinite(intervalSec) || intervalSec < 1) {
    throw new Error('FMP_SHARD_INTERVAL_SEC must be a number of seconds, at least 1');
  }
  return {
    db,
    store: new FileSystemObjectStore(outDir),
    cdn: createLoggingCdnInvalidator(log),
    keys: new KeyRing(keysConfig),
    respondEndpoint,
    log,
    intervalSec,
  };
}

export interface ShardWorker {
  /** Runs a pass now, or straight after the one in progress. Resolves when it has finished. */
  run(): Promise<void>;
  /** Stops the timer and waits for a pass in progress. */
  stop(): Promise<void>;
}

/**
 * Compiles once at start and then every `intervalSec`. Passes never overlap. A failed pass is
 * logged and the next one starts from the same state; `onPublished` is where push fan-out
 * (B3.5) hears which shards changed.
 */
export function startShardWorker(
  options: CompileOptions & {
    intervalSec: number;
    onPublished?: (result: CompileResult) => void | Promise<void>;
  },
): ShardWorker {
  const log = options.log;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;

  async function pass(): Promise<void> {
    queued = false;
    try {
      const result = await compileShards(options);
      if (result.changed.length > 0 || result.removed.length > 0) {
        await options.onPublished?.(result);
      }
    } catch (error) {
      log?.error(
        { event: 'shards.pass_failed', err: (error as Error).message },
        'shard compile pass failed; the next pass will retry',
      );
    }
  }

  function run(): Promise<void> {
    // One pass may wait behind the one in progress; more than that would be the same work.
    if (!queued) {
      queued = true;
      chain = chain.then(pass);
    }
    return chain;
  }

  const timer = setInterval(() => void run(), options.intervalSec * 1000);
  void run();
  return {
    run,
    async stop() {
      clearInterval(timer);
      await chain;
    },
  };
}
