import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  matchCellAt,
  readShardBundle,
  readShardIndex,
  shardBundlePath,
  shardCellOf,
} from '@findmyperson/shared';
import { ServerDb } from '../db';
import { runCli } from './cli';
import { compileShards, type CompileResult } from './compiler';
import { KeyRing, ed25519Verify } from './keys';
import {
  BUNDLE_CACHE_CONTROL,
  FileSystemObjectStore,
  JSON_CONTENT_TYPE,
  createLoggingCdnInvalidator,
  type ObjectStore,
} from './storage';
import { BANGALORE, ENDPOINT, NOW, RecordingCdn, addReport, testKey } from './testSupport';
import { shardOptionsFromEnv, startShardWorker } from './worker';

const PUT = { contentType: JSON_CONTENT_TYPE, cacheControl: BUNDLE_CACHE_CONTROL };
const bytes = (text: string) => Uint8Array.from(Buffer.from(text));
const shard = shardCellOf(matchCellAt(BANGALORE));
const quiet = { info() {}, warn() {}, error() {} };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fmp-shards-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FileSystemObjectStore', () => {
  test('puts, gets, lists by prefix and deletes', async () => {
    const store: ObjectStore = new FileSystemObjectStore(join(root, 'out'));
    expect(await store.list('')).toEqual([]);
    await store.put('index.json', bytes('{}'), PUT);
    await store.put('shards/8560145bfffffff/1.json', bytes('one'), PUT);
    await store.put('shards/8560145bfffffff/2.json', bytes('two'), PUT);
    expect(await store.list('')).toEqual([
      'index.json',
      'shards/8560145bfffffff/1.json',
      'shards/8560145bfffffff/2.json',
    ]);
    expect(await store.list('shards/')).toHaveLength(2);
    expect(Buffer.from((await store.get('index.json')) as Uint8Array).toString()).toBe('{}');
    expect(await store.get('shards/8560145bfffffff/3.json')).toBeNull();

    await store.delete('shards/8560145bfffffff/1.json');
    await store.delete('shards/8560145bfffffff/1.json');
    expect(await store.list('shards/')).toEqual(['shards/8560145bfffffff/2.json']);
    // The shard's directory goes with its last bundle.
    await store.delete('shards/8560145bfffffff/2.json');
    expect(await readdir(join(root, 'out', 'shards'))).toEqual([]);
  });

  test('a put replaces the file whole and leaves no temporary file behind', async () => {
    const store: ObjectStore = new FileSystemObjectStore(root);
    await store.put('index.json', bytes('first'), PUT);
    await store.put('index.json', bytes('second'), PUT);
    expect(await readFile(join(root, 'index.json'), 'utf8')).toBe('second');
    expect(await readdir(root)).toEqual(['index.json']);
    // A file a killed put left behind is not an object.
    await writeFile(join(root, '.0123456789abcdef.tmp'), 'partial');
    expect(await store.list('')).toEqual(['index.json']);
  });

  test('refuses a key that could leave the root', async () => {
    const store: ObjectStore = new FileSystemObjectStore(join(root, 'out'));
    for (const key of ['../escape.json', '/etc/passwd', 'shards/../../x', 'shards//x', '', '.x']) {
      await expect(store.put(key, bytes('x'), PUT)).rejects.toThrow(/not a valid object key/);
      await expect(store.get(key)).rejects.toThrow(/not a valid object key/);
      await expect(store.delete(key)).rejects.toThrow(/not a valid object key/);
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe('publishing to a directory', () => {
  test('the files a device fetches are at the shared paths and verify', async () => {
    const db = new ServerDb();
    const keys = new KeyRing([testKey('k1', 1)]);
    const queryId = addReport(db);
    const result = await compileShards({
      db,
      store: new FileSystemObjectStore(root),
      cdn: new RecordingCdn(),
      keys,
      respondEndpoint: ENDPOINT,
      now: () => NOW,
    });
    db.close();

    const trusted = keys.trustedAt(NOW);
    const index = await readShardIndex(
      JSON.parse(await readFile(join(root, 'index.json'), 'utf8')),
      trusted,
      ed25519Verify,
    );
    expect(index?.shards).toEqual(result.shards);
    const bundle = await readShardBundle(
      JSON.parse(await readFile(join(root, shardBundlePath(shard, 1)), 'utf8')),
      trusted,
      ed25519Verify,
    );
    expect(bundle?.queries.map((entry) => entry.query.query_id)).toEqual([queryId]);
  });
});

describe('configuration', () => {
  const env = (extra: Record<string, string> = {}) => ({
    FMP_SHARD_OUT_DIR: root,
    FMP_SHARD_KEYS: JSON.stringify([testKey('k1', 1)]),
    FMP_RESPOND_ENDPOINT: ENDPOINT,
    ...extra,
  });

  test('shard publishing is off unless an output directory is set', () => {
    const db = new ServerDb();
    expect(shardOptionsFromEnv({}, db, quiet)).toBeNull();
    expect(shardOptionsFromEnv(env(), db, quiet)).toMatchObject({
      respondEndpoint: ENDPOINT,
      intervalSec: 60,
    });
    db.close();
  });

  test('keys can come from a file', async () => {
    const db = new ServerDb();
    const file = join(root, 'keys.json');
    await writeFile(file, JSON.stringify([testKey('from-file', 4)]));
    const options = shardOptionsFromEnv(
      { ...env(), FMP_SHARD_KEYS: undefined, FMP_SHARD_KEYS_FILE: file },
      db,
      quiet,
    );
    expect(options?.keys.signerAt(NOW).keyId).toBe('from-file');
    db.close();
  });

  test('a bad configuration is refused before anything is published', () => {
    const db = new ServerDb();
    const seed = testKey('k1', 1).seed as string;
    expect(() => shardOptionsFromEnv({ FMP_SHARD_OUT_DIR: root }, db, quiet)).toThrow(
      /FMP_SHARD_KEYS is required/,
    );
    expect(() =>
      shardOptionsFromEnv(env({ FMP_RESPOND_ENDPOINT: 'http://insecure' }), db, quiet),
    ).toThrow(/https/);
    expect(() => shardOptionsFromEnv(env({ FMP_SHARD_INTERVAL_SEC: '0' }), db, quiet)).toThrow(
      /FMP_SHARD_INTERVAL_SEC/,
    );
    let message = '';
    try {
      shardOptionsFromEnv(env({ FMP_SHARD_KEYS: `[{"seed":"${seed}"` }), db, quiet);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('the signing key config is not valid JSON');
    db.close();
  });

  test('the CDN stub says plainly that nothing was purged', async () => {
    const events: Record<string, unknown>[] = [];
    const cdn = createLoggingCdnInvalidator({
      ...quiet,
      warn: (object) => void events.push(object),
    });
    await cdn.invalidate(['/index.json']);
    expect(events).toEqual([{ event: 'shards.cdn_invalidate', paths: ['/index.json'] }]);
  });
});

describe('the command line', () => {
  test('compile runs one pass against the database and directory in the environment', async () => {
    const dbPath = join(root, 'server.db');
    const db = new ServerDb(dbPath);
    addReport(db, { created_at: Math.floor(Date.now() / 1000) - 600 });
    db.close();

    const out: string[] = [];
    const env = {
      FMP_DB_PATH: dbPath,
      FMP_SHARD_OUT_DIR: join(root, 'public'),
      FMP_SHARD_KEYS: JSON.stringify([testKey('k1', 1)]),
      FMP_RESPOND_ENDPOINT: ENDPOINT,
    };
    expect(
      await runCli(
        ['compile'],
        env,
        (line) => out.push(line),
        () => undefined,
      ),
    ).toBe(0);
    const result = JSON.parse(out.join('\n')) as CompileResult;
    expect(result.shards[shard]).toBe(1);
    expect(await readdir(join(root, 'public'))).toEqual(['index.json', 'shards']);

    // A second run is a no-op with the same generations.
    out.length = 0;
    expect(
      await runCli(
        ['compile'],
        env,
        (line) => out.push(line),
        () => undefined,
      ),
    ).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ shards: result.shards, written: [] });
  });

  test('keygen prints a key the ring accepts; anything else is a usage error', async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runCli(
        ['keygen', 'k2026a'],
        {},
        (line) => out.push(line),
        () => undefined,
      ),
    ).toBe(0);
    const key = JSON.parse(out.join('\n')) as { key_id: string };
    expect(new KeyRing([key]).signerAt(NOW).keyId).toBe('k2026a');
    expect(
      await runCli(
        ['publish'],
        {},
        () => undefined,
        (line) => err.push(line),
      ),
    ).toBe(2);
    expect(
      await runCli(
        ['compile'],
        { FMP_DB_PATH: ':memory:' },
        () => undefined,
        () => 0,
      ),
    ).toBe(2);
    expect(err.join('\n')).toMatch(/usage/);
  });
});

describe('the worker', () => {
  test('compiles at start, reports the shards that changed, and never overlaps a pass', async () => {
    const db = new ServerDb();
    addReport(db);
    const published: CompileResult[] = [];
    const store = new FileSystemObjectStore(root);
    const worker = startShardWorker({
      db,
      store,
      cdn: new RecordingCdn(),
      keys: new KeyRing([testKey('k1', 1)]),
      respondEndpoint: ENDPOINT,
      now: () => NOW,
      intervalSec: 3_600,
      onPublished: (result) => void published.push(result),
    });
    // Asked three times before the first pass has run: one pass, not three.
    await Promise.all([worker.run(), worker.run(), worker.run()]);
    expect(published).toHaveLength(1);
    expect(published[0]?.changed).toContain(shard);
    expect(await store.list('')).toContain('index.json');

    addReport(db);
    await worker.run();
    expect(published).toHaveLength(2);
    expect(published[1]?.shards[shard]).toBe(2);
    await worker.stop();
    db.close();
  });

  test('a failed pass is logged and the next pass still runs', async () => {
    const db = new ServerDb();
    addReport(db);
    const errors: Record<string, unknown>[] = [];
    let broken = true;
    const inner: ObjectStore = new FileSystemObjectStore(root);
    const worker = startShardWorker({
      db,
      store: {
        put: (key, body, options) => inner.put(key, body, options),
        get: (key) => inner.get(key),
        delete: (key) => inner.delete(key),
        list: (prefix) =>
          broken ? Promise.reject(new Error('store unavailable')) : inner.list(prefix),
      },
      cdn: new RecordingCdn(),
      keys: new KeyRing([testKey('k1', 1)]),
      respondEndpoint: ENDPOINT,
      now: () => NOW,
      intervalSec: 3_600,
      log: { ...quiet, error: (object) => void errors.push(object) },
    });
    await worker.run();
    expect(errors[0]).toMatchObject({ event: 'shards.pass_failed', err: 'store unavailable' });
    expect(await inner.list('')).toEqual([]);

    broken = false;
    await worker.run();
    // The generation reserved by the failed pass is the one published: still 1.
    expect(await inner.list('shards/')).toContain(`shards/${shard}/1.json`);
    await worker.stop();
    db.close();
  });
});
