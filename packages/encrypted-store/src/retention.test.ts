import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApplyPragmas,
  createRetentionMaintenance,
  insertLocationSample,
  keyLiteral,
  KV_KEYS,
  kvGet,
  listSamplesAfterId,
  NATIVE_WRITER_CONTRACT,
  RETENTION_SEC,
  sampleCells,
  STORE_FILE_NAME,
  type DeviceConditions,
  type SqlExecutor,
} from '@findmyperson/shared';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { openStore, STORE_BUSY_TIMEOUT_MS, type EncryptedStore } from './openStore';
import { createTestVault, nodeSqlcipherDriver, type TestVault } from './testing';

/**
 * The retention purge and the weekly VACUUM through the hook they plug into, `maintenance` of
 * openStore, on a real SQLCipher file. The rules themselves are tested in @findmyperson/shared
 * (src/retention); what only a file can show is here: its size on disk before and after.
 */

const driver = nodeSqlcipherDriver();
const directories: string[] = [];
const opened: Array<{ close(): Promise<void> }> = [];
let device: DeviceConditions;

beforeEach(() => {
  device = { charging: false, idle: false };
});
afterEach(async () => {
  for (const handle of opened.splice(0)) {
    await handle.close().catch(() => undefined);
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function newVault(): TestVault {
  const directory = mkdtempSync(join(tmpdir(), 'fmp-retention-'));
  directories.push(directory);
  return createTestVault(directory);
}

/** A store opened the way the app opens it: with the retention maintenance plugged in. */
async function openWithRetention(vault: TestVault): Promise<EncryptedStore> {
  const store = await openStore({
    vault,
    driver,
    maintenance: createRetentionMaintenance({ deviceConditions: async () => device }),
  });
  opened.push(store);
  return store;
}

const DAY = 86_400;
const NOW = 1_791_000_000;
const CUTOFF = NOW - RETENTION_SEC;
const home = { lat: 12.9716, lon: 77.5946 };
const office = { lat: 12.9916, lon: 77.6146 };
/** About what a report with its inline photo weighs (plan 6.3). */
const REPORT_PAYLOAD = JSON.stringify({ photo: 'x'.repeat(12_000) });

/** `days` days of history ending at NOW: a fix every 15 minutes, and a report a day. */
async function seed(db: EncryptedStore['db'], days: number) {
  await db.transaction(async (tx) => {
    for (let ts = NOW - days * DAY; ts <= NOW; ts += 900) {
      const place = Math.floor(ts / (8 * 3600)) % 2 === 0 ? home : office;
      await insertLocationSample(tx, { ts_utc: ts, ...place, accuracy_m: 20, source: 'wm' });
    }
    for (let day = 0; day < days; day++) {
      const received = NOW - (day + 1) * DAY;
      await tx.execute(
        `INSERT INTO report_cache (query_id, payload_json, version, received_at, expires_at, revision)
         VALUES (?, ?, 1, ?, ?, 1)`,
        [`report-${day}`, REPORT_PAYLOAD, received, received + RETENTION_SEC],
      );
    }
  });
}

const scalar = async (db: SqlExecutor, sql: string) =>
  Number(Object.values((await db.execute(sql))[0] ?? {})[0]);

/** Size of the store file once everything written so far is in it and not in the WAL. */
async function sizeOnDisk(store: EncryptedStore): Promise<number> {
  await store.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  return statSync(join(store.directory, STORE_FILE_NAME)).size;
}

test('60 days of data: the purge leaves nothing past retention, and the vacuum returns the file to the size of 30 days', async () => {
  // What a store that never held more than 30 days weighs.
  const reference = await openWithRetention(newVault());
  await seed(reference.db, 30);
  await reference.runMaintenance(NOW);
  const expected = await sizeOnDisk(reference);

  const vault = newVault();
  const { directory } = vault;
  const store = await openWithRetention(vault);
  await seed(store.db, 60);
  const seeded = await sizeOnDisk(store);
  expect(seeded).toBeGreaterThan(expected * 1.8);

  // On battery: the purge runs, the vacuum waits, and the file gives nothing back.
  await store.runMaintenance(NOW);
  expect(await scalar(store.db, 'SELECT min(ts_utc) FROM location_sample')).toBe(CUTOFF);
  expect(await scalar(store.db, 'SELECT min(start_ts) FROM stay')).toBe(CUTOFF);
  expect(await scalar(store.db, 'SELECT min(expires_at) FROM report_cache')).toBeGreaterThan(NOW);
  expect(await scalar(store.db, 'SELECT count(*) FROM location_sample')).toBe(30 * 96 + 1);
  // The report received exactly 30 days ago expires at this very second, and goes.
  expect(await scalar(store.db, 'SELECT count(*) FROM report_cache')).toBe(29);
  expect(await kvGet(store.db, KV_KEYS.vacuumLastRunAt)).toBeNull();
  expect(await sizeOnDisk(store)).toBeGreaterThanOrEqual(seeded);

  // Charging and idle, with the native writer connected as it is on a phone.
  const native = await driver({
    directory,
    fileName: STORE_FILE_NAME,
    key: keyLiteral(await vault.getOrCreateStoreKeyHex()),
  });
  opened.push(native);
  for (const pragma of buildApplyPragmas()) {
    await native.execute(pragma);
  }
  await native.execute(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
  expect(await scalar(native, 'SELECT count(*) FROM location_sample')).toBe(30 * 96 + 1);

  device = { charging: true, idle: true };
  await store.runMaintenance(NOW);
  expect(await kvGet(store.db, KV_KEYS.vacuumLastRunAt)).toBe(String(NOW));
  const vacuumed = statSync(join(directory, STORE_FILE_NAME)).size;
  expect(vacuumed).toBeLessThanOrEqual(expected * 1.05);
  expect(vacuumed).toBeLessThan(seeded * 0.6);
  // The rewritten copy is not left sitting in the WAL either; only the note of the run is.
  expect(statSync(join(directory, `${STORE_FILE_NAME}-wal`)).size).toBeLessThan(vacuumed / 20);
  expect(await scalar(store.db, 'PRAGMA freelist_count')).toBe(0);

  // The file was rewritten under the native writer; it goes on writing to it.
  const cells = sampleCells(home);
  await native.execute(NATIVE_WRITER_CONTRACT.insertLocationSampleSql, [
    NOW + 900,
    home.lat,
    home.lon,
    20,
    'wm',
    cells.h3_r7,
    cells.h3_r5,
  ]);
  expect((await listSamplesAfterId(store.db, 0)).at(-1)?.ts_utc).toBe(NOW + 900);
  expect(await scalar(store.db, 'SELECT count(*) FROM location_sample')).toBe(30 * 96 + 2);
}, 60_000);

test('opened weeks later: the first maintenance run catches up, whatever was recorded before', async () => {
  const vault = newVault();
  const store = await openWithRetention(vault);
  await seed(store.db, 20);
  await store.runMaintenance(NOW);
  expect(await scalar(store.db, 'SELECT count(*) FROM location_sample')).toBe(20 * 96 + 1);
  await store.close();

  // The app is not opened for five weeks. Nothing ran in between.
  const later = NOW + 35 * DAY;
  const reopened = await openWithRetention(vault);
  await reopened.runMaintenance(later);
  expect(await scalar(reopened.db, 'SELECT count(*) FROM location_sample')).toBe(0);
  expect(await scalar(reopened.db, 'SELECT count(*) FROM stay')).toBe(0);
  expect(await scalar(reopened.db, 'SELECT count(*) FROM report_cache')).toBe(0);
  expect(await kvGet(reopened.db, KV_KEYS.purgeLastRunAt)).toBe(String(later));
}, 60_000);
