import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  insertLocationSample,
  keyLiteral,
  kvGet,
  kvSet,
  listSamplesAfterId,
  readSchemaVersion,
  STORE_FILE_NAME,
  STORE_TABLES,
} from '@findmyperson/shared';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { deleteAllData } from './deleteAllData';
import { StoreError } from './errors';
import { openStore, type EncryptedStore, type OpenStoreOptions } from './openStore';
import { createTestVault, nodeSqlcipherDriver, type TestVault } from './testing';

/** "Delete all my data" (plan 4.7) against real SQLCipher files. */

let directory: string;
let vault: TestVault;
let options: OpenStoreOptions;
const opened: EncryptedStore[] = [];
const driver = nodeSqlcipherDriver();
const storeFile = () => join(directory, STORE_FILE_NAME);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'fmp-store-'));
  vault = createTestVault(directory);
  options = { vault, driver };
});
afterEach(async () => {
  for (const store of opened.splice(0)) {
    await store.close().catch(() => undefined);
  }
  rmSync(directory, { recursive: true, force: true });
});

async function seeded(): Promise<EncryptedStore> {
  const store = await openStore(options);
  opened.push(store);
  await insertLocationSample(store.db, {
    ts_utc: 1_700_000_000,
    lat: 12.9716,
    lon: 77.5946,
    accuracy_m: 12,
    source: 'manual',
  });
  await kvSet(store.db, 'a', '1');
  return store;
}

async function rowCounts(store: EncryptedStore): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of STORE_TABLES) {
    const [row] = await store.db.execute(`SELECT count(*) AS n FROM "${table}"`);
    counts[table] = Number(row?.n);
  }
  return counts;
}

test('drops every row, recreates the schema and rotates the key', async () => {
  const old = await seeded();
  const oldKey = vault.currentKeyHex();
  const oldBytes = readFileSync(storeFile());

  const fresh = await deleteAllData(options, old);
  opened.push(fresh);

  expect(fresh.migration).toEqual({ from: 0, to: 1 });
  expect(await readSchemaVersion(fresh.db)).toBe(1);
  expect(Object.values(await rowCounts(fresh)).every((count) => count === 0)).toBe(true);
  expect(Object.keys(await rowCounts(fresh))).toEqual([...STORE_TABLES]);
  expect(await kvGet(fresh.db, 'a')).toBeNull();
  expect(await listSamplesAfterId(fresh.db, 0)).toEqual([]);

  expect(vault.currentKeyHex()).toMatch(/^[0-9a-f]{64}$/);
  expect(vault.currentKeyHex()).not.toBe(oldKey);
  expect(readFileSync(storeFile()).equals(oldBytes)).toBe(false);
});

test('the old handle is closed and the old key no longer opens anything', async () => {
  const old = await seeded();
  const oldKey = vault.currentKeyHex() ?? '';

  opened.push(await deleteAllData(options, old));

  await expect(old.db.execute('SELECT 1')).rejects.toThrow();
  const withOldKey = openStore({ vault: createTestVault(directory, { keyHex: oldKey }), driver });
  await expect(withOldKey).rejects.toMatchObject({ code: 'BAD_KEY_OR_PARAMS' });
});

test('the new store is usable straight away and survives a restart with the new key', async () => {
  const fresh = await deleteAllData(options, await seeded());
  await kvSet(fresh.db, 'b', '2');
  await fresh.close();

  const restarted = createTestVault(directory, { keyHex: vault.currentKeyHex() ?? '' });
  const again = await openStore({ vault: restarted, driver });
  opened.push(again);
  expect(again.migration).toEqual({ from: 1, to: 1 });
  expect(await kvGet(again.db, 'b')).toBe('2');
});

test('removes the WAL and SHM files of the old store', async () => {
  const old = await seeded();
  // An open WAL-mode store with a write in it has both side files.
  expect(existsSync(`${storeFile()}-wal`)).toBe(true);
  let sideFilesAfterNativeDelete: boolean[] = [];
  const watching: OpenStoreOptions = {
    driver,
    vault: {
      ...vault,
      async deleteAllData() {
        await vault.deleteAllData();
        sideFilesAfterNativeDelete = ['', '-wal', '-shm'].map((suffix) =>
          existsSync(storeFile() + suffix),
        );
      },
    },
  };
  opened.push(await deleteAllData(watching, old));
  expect(sideFilesAfterNativeDelete).toEqual([false, false, false]);
});

test('recovers a store that can no longer be opened', async () => {
  await (await seeded()).close();
  // The key was lost: the file is there and nothing can read it.
  vault = createTestVault(directory, { keyHex: 'ab'.repeat(32) });
  options = { vault, driver };
  await expect(openStore(options)).rejects.toMatchObject({ code: 'BAD_KEY_OR_PARAMS' });

  const fresh = await deleteAllData(options, null);
  opened.push(fresh);
  expect(fresh.migration).toEqual({ from: 0, to: 1 });
  expect(vault.currentKeyHex()).not.toBe('ab'.repeat(32));
});

test('recovers when the key itself cannot be read', async () => {
  await (await seeded()).close();
  let locked = true;
  const unreadable: OpenStoreOptions = {
    driver,
    vault: {
      ...vault,
      async getOrCreateStoreKeyHex() {
        if (locked) {
          throw Object.assign(new Error('keystore lost its key'), { code: 'key_unavailable' });
        }
        return vault.getOrCreateStoreKeyHex();
      },
      async deleteAllData() {
        await vault.deleteAllData();
        locked = false;
      },
    },
  };
  const fresh = await deleteAllData(unreadable, null);
  opened.push(fresh);
  expect(fresh.migration).toEqual({ from: 0, to: 1 });
});

test('refuses to report success when the native side did not rotate the key', async () => {
  const old = await seeded();
  const keyHex = vault.currentKeyHex() ?? '';
  const lazy: OpenStoreOptions = {
    driver,
    vault: { ...vault, getOrCreateStoreKeyHex: async () => keyHex, deleteAllData: async () => {} },
  };
  const attempt = deleteAllData(lazy, old);
  await expect(attempt).rejects.toBeInstanceOf(StoreError);
  await expect(attempt).rejects.toMatchObject({ code: 'KEY_NOT_ROTATED' });
});

test('refuses to report success when the old file survived', async () => {
  const old = await seeded();
  // Rotates the key but leaves the file, re-encrypted so that it still opens: the worst case,
  // old rows readable under the new key.
  const leaky: OpenStoreOptions = {
    driver,
    vault: {
      ...vault,
      async deleteAllData() {
        const oldKey = keyLiteral(vault.currentKeyHex() ?? '');
        const newKeyHex = 'cd'.repeat(32);
        const connection = await driver({ directory, fileName: STORE_FILE_NAME, key: oldKey });
        await connection.execute(`PRAGMA rekey = "${keyLiteral(newKeyHex)}"`);
        await connection.close();
        vault = createTestVault(directory, { keyHex: newKeyHex });
      },
      getOrCreateStoreKeyHex: () => vault.getOrCreateStoreKeyHex(),
    },
  };
  await expect(deleteAllData(leaky, old)).rejects.toMatchObject({ code: 'DELETE_INCOMPLETE' });
});
