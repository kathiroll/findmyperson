import { expect, test } from 'vitest';
import { contractJson } from '../testing/contractFile';
import { openMemoryDb } from '../testing/memoryDb';
import { migrate, SCHEMA_VERSION } from './migrations';
import { NATIVE_WRITER_CONTRACT } from './nativeWriter';

const CONTRACT_FILE = '../../contracts/native-writer.json';

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
  db.close();
});

test('the native statements touch only the two natively written tables', () => {
  const statements = [
    NATIVE_WRITER_CONTRACT.insertLocationSampleSql,
    NATIVE_WRITER_CONTRACT.insertVisitStaySql,
    NATIVE_WRITER_CONTRACT.closeVisitStaySql,
  ];
  for (const sql of statements) {
    expect(sql).toMatch(/^(INSERT INTO|UPDATE) (location_sample|stay) /);
    expect(sql).not.toMatch(/CREATE|ALTER|DROP|DELETE/i);
  }
});
