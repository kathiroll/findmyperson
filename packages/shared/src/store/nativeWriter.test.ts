import { expect, test } from 'vitest';
import { RETENTION_SEC } from '../constants';
import { purgeExpired } from '../retention/purge';
import { contractJson } from '../testing/contractFile';
import { openMemoryDb } from '../testing/memoryDb';
import { DAY, seedHistory } from '../testing/retentionSeed';
import { writeSamples } from '../testing/stayVectors';
import type { SqlExecutor } from './driver';
import { migrate, SCHEMA_VERSION } from './migrations';
import { NATIVE_WRITER_CONTRACT } from './nativeWriter';
import { KV_KEYS, kvGet, kvSet } from './tables/kv';

const CONTRACT_FILE = '../../contracts/native-writer.json';

/** The retention purge exactly as a native module runs it: these statements, this order. */
async function nativePurge(tx: SqlExecutor, nowTs: number): Promise<void> {
  const cutoff = nowTs - NATIVE_WRITER_CONTRACT.retentionSec;
  await tx.execute(NATIVE_WRITER_CONTRACT.deleteSamplesBeforeSql, [cutoff]);
  await tx.execute(NATIVE_WRITER_CONTRACT.deleteStaysEndedBeforeSql, [cutoff]);
  await tx.execute(NATIVE_WRITER_CONTRACT.trimStaysStartedBeforeSql, [cutoff, cutoff, cutoff]);
  await tx.execute(NATIVE_WRITER_CONTRACT.rewindStayCursorSql);
}

test('contracts/native-writer.json is the committed copy of the native writer contract', async () => {
  // Kotlin and Swift read this file. If it fails, the TypeScript side changed: review what the
  // native modules must change too, then rewrite the file with `-u`.
  const file = new URL(CONTRACT_FILE, import.meta.url);
  await expect(await contractJson(NATIVE_WRITER_CONTRACT, file)).toMatchFileSnapshot(CONTRACT_FILE);
});

test('the version check a native module runs reads the migrated version', async () => {
  const db = openMemoryDb();
  await migrate(db);
  const rows = await db.execute(NATIVE_WRITER_CONTRACT.readSchemaVersionSql);
  expect(rows).toEqual([{ user_version: NATIVE_WRITER_CONTRACT.schemaVersion }]);
  expect(NATIVE_WRITER_CONTRACT.schemaVersion).toBe(SCHEMA_VERSION);
  db.close();
});

test('every native statement runs against the migrated schema', async () => {
  const db = openMemoryDb();
  await migrate(db);
  const cell7 = '8760145b4ffffff';
  const cell5 = '8560145bfffffff';
  await db.execute(NATIVE_WRITER_CONTRACT.insertLocationSampleSql, [
    1000,
    12.9716,
    77.5946,
    12,
    NATIVE_WRITER_CONTRACT.sampleSources[0],
    cell7,
    cell5,
  ]);
  await db.execute(NATIVE_WRITER_CONTRACT.insertVisitStaySql, [
    1000,
    1000,
    12.9716,
    77.5946,
    50,
    cell7,
    0,
  ]);
  await db.execute(NATIVE_WRITER_CONTRACT.closeVisitStaySql, [2000, 1000]);
  expect(await db.execute('SELECT count(*) AS n FROM location_sample')).toEqual([{ n: 1 }]);
  expect(await db.execute('SELECT end_ts, closed, source FROM stay')).toEqual([
    { end_ts: 2000, closed: 1, source: 'visit' },
  ]);

  // The purge: a cutoff between the visit's two ends shortens the stay and deletes the fix.
  await nativePurge(db, 1500 + NATIVE_WRITER_CONTRACT.retentionSec);
  expect(await db.execute('SELECT count(*) AS n FROM location_sample')).toEqual([{ n: 0 }]);
  expect(await db.execute('SELECT start_ts, end_ts FROM stay')).toEqual([
    { start_ts: 1500, end_ts: 2000 },
  ]);
  db.close();
});

test('a native module writes only where the contract says it may', () => {
  const { retentionSec, ...contract } = NATIVE_WRITER_CONTRACT;
  expect(retentionSec).toBe(RETENTION_SEC);
  const statements = Object.entries(contract)
    .filter(([name]) => name.endsWith('Sql') && name !== 'readSchemaVersionSql')
    .map(([name, sql]) => [name, String(sql)] as const);
  expect(statements.map(([name]) => name)).toEqual([
    'insertLocationSampleSql',
    'insertVisitStaySql',
    'closeVisitStaySql',
    'deleteSamplesBeforeSql',
    'deleteStaysEndedBeforeSql',
    'trimStaysStartedBeforeSql',
    'rewindStayCursorSql',
  ]);
  for (const [, sql] of statements) {
    expect(sql).not.toMatch(/CREATE|ALTER|DROP|VACUUM|PRAGMA/i);
  }
  // Capture: inserts, and the one update that closes a visit.
  for (const [, sql] of statements.slice(0, 3)) {
    expect(sql).toMatch(/^(INSERT INTO|UPDATE) (location_sample|stay) /);
    expect(sql).not.toMatch(/DELETE/i);
  }
  // The purge: the two tables that hold location history, each bounded by a time...
  for (const [, sql] of statements.slice(3, 6)) {
    expect(sql).toMatch(
      /^(DELETE FROM|UPDATE) (location_sample|stay) .*WHERE (ts_utc|end_ts|start_ts) < \?/,
    );
  }
  // ...and the one cursor that points into them.
  expect(statements[6]?.[1]).toMatch(/^UPDATE kv SET v = .* WHERE k = '[\w.]+' AND /);
  expect(statements[6]?.[1]).toContain(`'${KV_KEYS.stayDerivationLastSampleId}'`);
});

test('the native purge leaves the location tables as the TypeScript purge leaves them', async () => {
  const now = 1_791_000_000 - (1_791_000_000 % DAY) + 2 * 3600;
  const locationTables = async (db: SqlExecutor) => ({
    samples: await db.execute('SELECT * FROM location_sample ORDER BY id'),
    stays: await db.execute('SELECT * FROM stay ORDER BY id'),
    cursor: await kvGet(db, KV_KEYS.stayDerivationLastSampleId),
  });

  const byTypeScript = openMemoryDb();
  await migrate(byTypeScript);
  await seedHistory(byTypeScript, now);
  await purgeExpired(byTypeScript, now);

  const byNative = openMemoryDb();
  await migrate(byNative);
  await seedHistory(byNative, now);
  const other = async () => ({
    reports: await byNative.execute('SELECT * FROM report_cache ORDER BY query_id'),
    matches: await byNative.execute('SELECT * FROM "match" ORDER BY id'),
    tips: await byNative.execute('SELECT * FROM outbound_response ORDER BY id'),
  });
  const before = await other();
  await byNative.transaction((tx) => nativePurge(tx, now));

  const left = await locationTables(byNative);
  expect(left).toEqual(await locationTables(byTypeScript));
  expect(left.samples).toHaveLength(30 * 96 + 1);
  expect(left.samples[0]?.ts_utc).toBe(now - RETENTION_SEC);
  // The rest is the TypeScript purge's to delete.
  expect(await other()).toEqual(before);

  // Running it again deletes nothing more.
  await byNative.transaction((tx) => nativePurge(tx, now));
  expect(await locationTables(byNative)).toEqual(left);
  byTypeScript.close();
  byNative.close();
});

test('the native purge pulls the derivation cursor back when it deletes the newest fixes', async () => {
  const db = openMemoryDb();
  await migrate(db);
  const now = 1_791_000_000;
  const home = { lat: 12.9716, lon: 77.5946 };
  // Capture was off for longer than retention: every stored fix is past it.
  await writeSamples(db, [
    { ts_utc: now - 40 * DAY, ...home },
    { ts_utc: now - 40 * DAY + 900, ...home },
    { ts_utc: now - 40 * DAY + 1800, ...home },
  ]);
  await kvSet(db, KV_KEYS.stayDerivationLastSampleId, '3');

  await db.transaction((tx) => nativePurge(tx, now));
  expect(await db.execute('SELECT count(*) AS n FROM location_sample')).toEqual([{ n: 0 }]);
  // New fixes start again from id 1, so a cursor left at 3 would skip the next three.
  expect(await kvGet(db, KV_KEYS.stayDerivationLastSampleId)).toBe('0');

  // A cursor that is not ahead of the stored fixes is left alone, and so is every other key.
  await writeSamples(db, [{ ts_utc: now, ...home }]);
  await kvSet(db, KV_KEYS.purgeLastRunAt, '999999');
  await db.transaction((tx) => nativePurge(tx, now));
  expect(await kvGet(db, KV_KEYS.stayDerivationLastSampleId)).toBe('0');
  expect(await kvGet(db, KV_KEYS.purgeLastRunAt)).toBe('999999');
  db.close();
});
