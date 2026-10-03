import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  kvSet,
  listSamplesAfterId,
  listStaysOverlapping,
  MIGRATION_V1,
  STORE_FILE_NAME,
  type Migration,
} from '@findmyperson/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { deleteAllData } from './deleteAllData';
import { STORE_DIRECTORY_NAME, STORE_FILE_SUFFIXES } from './location';
import { openStore, type EncryptedStore, type OpenStoreOptions } from './openStore';
import { createTestVault, nodeSqlcipherDriver, type TestVault } from './testing';

/**
 * The iOS half of the store, run on a Mac.
 *
 * ios/build-host-check.sh compiles the real ios/*.swift and FMPSqlcipher.c against SQLCipher
 * built from the C source op-sqlite compiles into the app, and type-checks the same Swift
 * against the iPhone SDK. The tests then pass one encrypted file back and forth between that
 * Swift code and the TypeScript store, which is what happens on a phone: Swift writes while
 * the app is in the background, TypeScript reads on the next foreground.
 *
 * It is not an iPhone. The Keychain is not exercised (the key is in memory), and neither are
 * op-sqlite, CocoaPods or the ObjC++ module; README.md lists those as unverified.
 *
 * macOS only: there is no Swift toolchain with Apple's Foundation on the Linux CI runner. On
 * Linux the suite is skipped, and the iOS job in .github/workflows/build.yml runs it instead.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const BUILD_SCRIPT = join(PACKAGE_ROOT, 'ios', 'build-host-check.sh');
const HOST_CHECK = join(PACKAGE_ROOT, 'ios', 'build', 'host-check');
const MIGRATION_SQL = join(PACKAGE_ROOT, '..', 'shared', 'contracts', 'migration-v1.sql');

const SYNTHETIC_V2: Migration = {
  version: 2,
  name: 'synthetic, for tests only',
  statements: ['CREATE TABLE synthetic (id INTEGER PRIMARY KEY)'],
};

function host(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(HOST_CHECK, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe.skipIf(process.platform !== 'darwin')('the Swift store on real SQLCipher', () => {
  // What a phone has: the app's Application Support directory, and the store directory in it.
  let applicationSupport: string;
  let vault: TestVault;
  let options: OpenStoreOptions;
  const opened: EncryptedStore[] = [];
  const keyHex = () => vault.currentKeyHex() ?? '';

  async function open(extra: Partial<OpenStoreOptions> = {}): Promise<EncryptedStore> {
    const store = await openStore({ ...options, ...extra });
    opened.push(store);
    return store;
  }

  beforeAll(() => {
    // The first build compiles SQLCipher, about a minute; later ones reuse the object file.
    const build = spawnSync('sh', [BUILD_SCRIPT, 'typecheck'], { encoding: 'utf8' });
    expect(build.stderr + build.stdout).toContain('type-checked against');
    expect(build.status).toBe(0);
  }, 600_000);

  beforeEach(async () => {
    applicationSupport = mkdtempSync(join(tmpdir(), 'fmp-ios-'));
    vault = createTestVault(join(applicationSupport, STORE_DIRECTORY_NAME));
    options = { vault, driver: nodeSqlcipherDriver() };
    await vault.getOrCreateStoreKeyHex();
  });
  afterEach(async () => {
    for (const store of opened.splice(0)) {
      await store.close().catch(() => undefined);
    }
    rmSync(applicationSupport, { recursive: true, force: true });
  });

  test('its own self-test passes: keys, vault, backup exclusion, cipher checks, delete', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'fmp-ios-selftest-'));
    const result = host('selftest', scratch, MIGRATION_SQL);
    rmSync(scratch, { recursive: true, force: true });
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('selftest passed');
    expect(result.stdout).toContain(
      'ok: prepare leaves the directory excluded from backup, read back from the file system',
    );
    expect(result.stdout).not.toMatch(/^FAIL/m);
    expect(result.status).toBe(0);
  });

  test('Swift writes into the store TypeScript migrated, and TypeScript reads it back', async () => {
    const store = await open();
    expect(host('check', applicationSupport, keyHex())).toMatchObject({ status: 0 });

    const sample = host('write-sample', applicationSupport, keyHex(), '1700000000', 'slc');
    expect(sample).toMatchObject({ status: 0, stdout: 'row=1\n' });
    expect(await listSamplesAfterId(store.db, 0)).toEqual([
      {
        id: 1,
        ts_utc: 1_700_000_000,
        lat: 12.9716,
        lon: 77.5946,
        accuracy_m: 12,
        source: 'slc',
        h3_r7: '8760145b4ffffff',
        h3_r5: '8560145bfffffff',
      },
    ]);

    const visit = host('write-visit', applicationSupport, keyHex(), '1700000100', '1700000900');
    expect(visit).toMatchObject({ status: 0, stdout: 'row=1 closed=true\n' });
    expect(await listStaysOverlapping(store.db, 1_700_000_000, 1_700_001_000)).toMatchObject([
      { start_ts: 1_700_000_100, end_ts: 1_700_000_900, closed: true, source: 'visit' },
    ]);
  });

  test('TypeScript opens and migrates a file that Swift created', async () => {
    // Swift gets there first, as on a background launch straight after install: it creates
    // the encrypted file, finds no schema and writes nothing.
    const early = host('write-sample', applicationSupport, keyHex(), '1700000000', 'slc');
    expect(early.status).toBe(2);
    expect(early.stderr).toMatch(/^SCHEMA_MISMATCH\n/);
    expect(existsSync(join(vault.directory, STORE_FILE_NAME))).toBe(true);

    const store = await open();
    expect(store.migration).toEqual({ from: 0, to: 1 });
    expect(await listSamplesAfterId(store.db, 0)).toEqual([]);
    expect(host('check', applicationSupport, keyHex())).toMatchObject({ status: 0 });
  });

  test('empty, then version 1, then a synthetic version 2: Swift stops writing at 2', async () => {
    const v1 = await open();
    expect(host('write-sample', applicationSupport, keyHex(), '1700000000', 'slc').status).toBe(0);
    await v1.close();

    const v2 = await open({ migrations: [MIGRATION_V1, SYNTHETIC_V2] });
    expect(v2.migration).toEqual({ from: 1, to: 2 });
    const refused = host('write-sample', applicationSupport, keyHex(), '1700000900', 'slc');
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/^SCHEMA_MISMATCH\n.*version 2, this build writes version 1/);
    // The version-1 row survived the migration, and nothing was added at version 2.
    expect((await listSamplesAfterId(v2.db, 0)).map((row) => row.ts_utc)).toEqual([1_700_000_000]);
  });

  test('Swift refuses a store opened with the wrong key', async () => {
    await open();
    const wrong = host('check', applicationSupport, 'ab'.repeat(32));
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/^BAD_KEY_OR_PARAMS\n/);
    expect(wrong.stderr).not.toContain('ab'.repeat(32));
  });

  test('delete all data end to end: Swift deletes and TypeScript recreates', async () => {
    const store = await open();
    await kvSet(store.db, 'a', '1');
    expect(host('write-sample', applicationSupport, keyHex(), '1700000000', 'slc').status).toBe(0);
    const oldKey = keyHex();

    let nativeDelete = { status: null as number | null, stdout: '', stderr: '' };
    const filesAfterNativeDelete: boolean[] = [];
    const withSwiftDelete: OpenStoreOptions = {
      ...options,
      vault: {
        ...vault,
        async deleteAllData() {
          nativeDelete = host('delete-all', applicationSupport, oldKey);
          for (const suffix of STORE_FILE_SUFFIXES) {
            filesAfterNativeDelete.push(
              existsSync(join(vault.directory, STORE_FILE_NAME + suffix)),
            );
          }
          // The test vault forgets its key as the Keychain item is deleted on a phone.
          await vault.deleteAllData();
        },
      },
    };
    const fresh = await deleteAllData(withSwiftDelete, store);
    opened.push(fresh);

    expect(nativeDelete.status).toBe(0);
    expect(nativeDelete.stdout).toContain('deleted key=gone');
    expect(filesAfterNativeDelete).toEqual([false, false, false]);
    expect(fresh.migration).toEqual({ from: 0, to: 1 });
    expect(keyHex()).not.toBe(oldKey);
    expect(await listSamplesAfterId(fresh.db, 0)).toEqual([]);
    // Swift writes to the recreated store with the rotated key, and the old key is dead.
    expect(host('write-sample', applicationSupport, keyHex(), '1700001800', 'slc').status).toBe(0);
    expect(host('check', applicationSupport, oldKey).stderr).toMatch(/^BAD_KEY_OR_PARAMS\n/);
  });
});
