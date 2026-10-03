import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  buildApplyPragmas,
  CIPHER_PARAMS,
  keyLiteral,
  kvGet,
  kvSet,
  listSamplesAfterId,
  MIGRATION_V1,
  NATIVE_WRITER_CONTRACT,
  readSchemaVersion,
  sampleCells,
  SchemaTooNewError,
  STORE_FILE_NAME,
  STORE_TABLES,
  type Migration,
  type SqlExecutor,
} from '@findmyperson/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { StoreConnection, StoreDriver } from './driver';
import { StoreError } from './errors';
import { openStore, STORE_BUSY_TIMEOUT_MS, type EncryptedStore } from './openStore';
import { createTestVault, nodeSqlcipherDriver, type TestVault } from './testing';

/**
 * openStore against real SQLCipher (testing/nodeSqlcipherDriver.ts): the file on disk is
 * encrypted with the pinned parameters. What this cannot show is op-sqlite itself, which only
 * runs on a phone; README.md lists that as unverified.
 */

let directory: string;
let vault: TestVault;
const opened: Array<{ close(): Promise<void> }> = [];
const driver = nodeSqlcipherDriver();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fmp-store-'));
  vault = createTestVault(directory);
});
afterEach(async () => {
  for (const handle of opened.splice(0)) {
    await handle.close().catch(() => undefined);
  }
  rmSync(directory, { recursive: true, force: true });
});

async function open(options: Partial<Parameters<typeof openStore>[0]> = {}) {
  const store = await openStore({ vault, driver, ...options });
  opened.push(store);
  return store;
}

/** A second connection to the same file: what the native capture module holds. */
async function nativeWriterStandIn(): Promise<StoreConnection> {
  const connection = await driver({
    directory,
    fileName: STORE_FILE_NAME,
    key: keyLiteral(await vault.getOrCreateStoreKeyHex()),
  });
  opened.push(connection);
  for (const pragma of buildApplyPragmas()) {
    await connection.execute(pragma);
  }
  await connection.execute(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
  return connection;
}

async function tableNames(db: SqlExecutor): Promise<string[]> {
  const rows = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => String(row.name));
}

const storeFile = () => join(directory, STORE_FILE_NAME);

const SYNTHETIC_V2: Migration = {
  version: 2,
  name: 'synthetic, for tests only',
  statements: [
    'ALTER TABLE kv ADD COLUMN updated_at INTEGER',
    'CREATE TABLE synthetic (id INTEGER PRIMARY KEY)',
  ],
};

describe('a new store', () => {
  test('comes up at schema version 1 with exactly the contract tables', async () => {
    const store = await open();
    expect(store.migration).toEqual({ from: 0, to: 1 });
    expect(await readSchemaVersion(store.db)).toBe(1);
    expect(await tableNames(store.db)).toEqual([...STORE_TABLES].sort());
    expect(store.directory).toBe(directory);
  });

  test('is SQLCipher 4 in WAL mode with the busy timeout set', async () => {
    const store = await open();
    const value = async (pragma: string) =>
      Object.values((await store.db.execute(`PRAGMA ${pragma}`))[0] ?? {})[0];
    expect(String(await value('cipher_version'))).toMatch(/^4\./);
    expect(await value('journal_mode')).toBe(CIPHER_PARAMS.journalMode);
    expect(await value('cipher_page_size')).toBe(String(CIPHER_PARAMS.pageSizeBytes));
    expect(await value('busy_timeout')).toBe(STORE_BUSY_TIMEOUT_MS);
  });

  test('is not readable as a plain SQLite file, and holds no plaintext', async () => {
    const store = await open();
    await kvSet(store.db, 'canary', 'a-recognisable-plaintext-value');
    await store.close();

    const bytes = readFileSync(storeFile());
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    expect(bytes.includes('a-recognisable-plaintext-value')).toBe(false);
    expect(bytes.includes('location_sample')).toBe(false);

    const plain = new DatabaseSync(storeFile());
    expect(() => plain.prepare('SELECT count(*) FROM sqlite_master').all()).toThrow(
      /not a database/,
    );
    plain.close();
  });
});

describe('an existing store', () => {
  test('survives an app restart: same key, same rows, nothing re-migrated', async () => {
    const first = await open();
    await kvSet(first.db, 'a', '1');
    await first.close();

    // A restart: nothing in memory survives; the Keychain or Keystore still has the key.
    vault = createTestVault(directory, { keyHex: vault.currentKeyHex() ?? '' });
    const second = await open();
    expect(second.migration).toEqual({ from: 1, to: 1 });
    expect(await kvGet(second.db, 'a')).toBe('1');
  });

  test('reads what a second connection wrote with the native statements, while open', async () => {
    const store = await open();
    const native = await nativeWriterStandIn();
    expect(await native.execute(NATIVE_WRITER_CONTRACT.readSchemaVersionSql)).toEqual([
      { user_version: NATIVE_WRITER_CONTRACT.schemaVersion },
    ]);

    const fix = { lat: 12.9716, lon: 77.5946 };
    const cells = sampleCells(fix);
    await native.execute(NATIVE_WRITER_CONTRACT.insertLocationSampleSql, [
      1_700_000_000,
      fix.lat,
      fix.lon,
      12,
      'wm',
      cells.h3_r7,
      cells.h3_r5,
    ]);

    expect(await listSamplesAfterId(store.db, 0)).toEqual([
      { id: 1, ts_utc: 1_700_000_000, ...fix, accuracy_m: 12, source: 'wm', ...cells },
    ]);
  });
});

describe('migrations on real SQLCipher', () => {
  test('empty, then version 1, then a synthetic version 2, keeping the data', async () => {
    const v1 = await open();
    await kvSet(v1.db, 'a', '1');
    await v1.close();

    const v2 = await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] });
    expect(v2.migration).toEqual({ from: 1, to: 2 });
    expect(await readSchemaVersion(v2.db)).toBe(2);
    expect(await v2.db.execute('SELECT k, v, updated_at FROM kv')).toEqual([
      { k: 'a', v: '1', updated_at: null },
    ]);
    expect(await tableNames(v2.db)).toContain('synthetic');
  });

  test('an empty store goes straight to the newest version', async () => {
    const store = await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] });
    expect(store.migration).toEqual({ from: 0, to: 2 });
  });

  test('a migration that fails part-way leaves version 1 intact and the store closed', async () => {
    await (await open()).close();
    const broken: Migration = {
      version: 2,
      name: 'broken',
      statements: ['CREATE TABLE half_done (id INTEGER PRIMARY KEY)', 'THIS IS NOT SQL'],
    };
    await expect(open({ migrations: [MIGRATION_V1, broken] })).rejects.toThrow(/syntax error/);

    const store = await open();
    expect(store.migration).toEqual({ from: 1, to: 1 });
    expect(await tableNames(store.db)).not.toContain('half_done');
  });

  test('a store written by a newer app is refused and left untouched', async () => {
    await (await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] })).close();
    await expect(open()).rejects.toBeInstanceOf(SchemaTooNewError);

    const newer = await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] });
    expect(newer.migration).toEqual({ from: 2, to: 2 });
  });

  test('the native version check refuses a schema it was not built for', async () => {
    // TypeScript owns migrations; a native module only compares this number and, on a
    // mismatch, writes nothing (EncryptedStore.kt / EncryptedStore.swift do the same check).
    await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] });
    const native = await nativeWriterStandIn();
    const [row] = await native.execute(NATIVE_WRITER_CONTRACT.readSchemaVersionSql);
    expect(row?.user_version).toBe(2);
    expect(row?.user_version).not.toBe(NATIVE_WRITER_CONTRACT.schemaVersion);
  });
});

describe('a store that must not be opened fails loudly', () => {
  const failure = async (attempt: Promise<EncryptedStore>) => {
    const error = await attempt.then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(StoreError);
    return error as StoreError;
  };

  test('wrong key', async () => {
    await (await open()).close();
    vault = createTestVault(directory, { keyHex: 'ab'.repeat(32) });
    const error = await failure(open());
    expect(error.code).toBe('BAD_KEY_OR_PARAMS');
    expect(error.message).not.toContain('ab'.repeat(32));
  });

  test('a plaintext file in place of the store', async () => {
    const plain = new DatabaseSync(storeFile());
    plain.exec('CREATE TABLE t (id INTEGER)');
    plain.close();
    expect((await failure(open())).code).toBe('BAD_KEY_OR_PARAMS');
  });

  test('a file that is not a database at all', async () => {
    writeFileSync(storeFile(), 'not a database, and longer than one byte of it');
    expect((await failure(open())).code).toBe('BAD_KEY_OR_PARAMS');
  });

  test.each([
    ['page size', { pageSizeBytes: 1024 }],
    ['HMAC algorithm', { hmacAlgorithm: 'HMAC_SHA1' }],
    ['KDF algorithm', { kdfAlgorithm: 'PBKDF2_HMAC_SHA1' }],
  ])('a reader that drifted on the %s', async (_label, drift) => {
    await (await open()).close();
    const error = await failure(
      open({ applyPragmas: buildApplyPragmas({ ...CIPHER_PARAMS, ...drift }) }),
    );
    expect(error.code).toBe('PARAM_MISMATCH');
  });

  test('a reader that drifted on kdf_iter, which SQLCipher alone would not notice', async () => {
    await (await open()).close();
    const drifted = buildApplyPragmas({ ...CIPHER_PARAMS, kdfIterations: 1000 });

    // The silent case: with a raw key the file decrypts whatever kdf_iter is.
    const raw = await driver({
      directory,
      fileName: STORE_FILE_NAME,
      key: keyLiteral(vault.currentKeyHex() ?? ''),
    });
    opened.push(raw);
    for (const pragma of drifted) {
      await raw.execute(pragma);
    }
    expect(await tableNames(raw)).toEqual([...STORE_TABLES].sort());
    await raw.close();

    const error = await failure(open({ applyPragmas: drifted }));
    expect(error.code).toBe('PARAM_MISMATCH');
    expect(error.message).toContain('kdf_iter: pinned 256000, effective 1000');
  });

  test('a binding built without SQLCipher', async () => {
    const error = await failure(open({ driver: nodeSqlcipherDriver({ isSQLCipher: false }) }));
    expect(error.code).toBe('NOT_SQLCIPHER');
  });

  test('a binding that cannot open the file', async () => {
    const broken: StoreDriver = async () => {
      throw new Error('disk full');
    };
    const error = await failure(open({ driver: broken }));
    expect(error.code).toBe('OPEN_FAILED');
    expect(error.message).toContain('disk full');
  });

  test('a malformed key never reaches the driver', async () => {
    vault = createTestVault(directory, { keyHex: 'not-a-key' });
    const spy = vi.fn(driver);
    await expect(open({ driver: spy })).rejects.toThrow(/64 hex characters/);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a failed check closes the connection it opened', async () => {
    await (await open()).close();
    const closes: number[] = [];
    const counting: StoreDriver = async (options) => {
      const connection = await driver(options);
      return {
        ...connection,
        close: async () => {
          closes.push(1);
          await connection.close();
        },
      };
    };
    await failure(
      open({
        driver: counting,
        applyPragmas: buildApplyPragmas({ ...CIPHER_PARAMS, kdfIterations: 1000 }),
      }),
    );
    expect(closes).toHaveLength(1);
  });
});

describe('the maintenance hook', () => {
  test('runs with the open database and the time it is given', async () => {
    const maintenance = vi.fn(async (db: SqlExecutor, nowTs: number) => {
      await kvSet(db, 'ran_at', String(nowTs));
    });
    const store = await open({ maintenance });
    expect(maintenance).not.toHaveBeenCalled();

    await store.runMaintenance(1_700_000_000);
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(await kvGet(store.db, 'ran_at')).toBe('1700000000');
  });

  test('is optional', async () => {
    await expect((await open()).runMaintenance(1_700_000_000)).resolves.toBeUndefined();
  });
});
