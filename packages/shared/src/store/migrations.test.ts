import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openMemoryDb } from '../testing/memoryDb';
import type { SqlExecutor } from './driver';
import {
  migrate,
  MIGRATION_V1,
  MIGRATIONS,
  readSchemaVersion,
  renderMigrationSql,
  SCHEMA_VERSION,
  SchemaTooNewError,
  type Migration,
} from './migrations';
import { STORE_TABLES } from './ownership';

let db: ReturnType<typeof openMemoryDb>;
beforeEach(() => {
  db = openMemoryDb();
});
afterEach(() => {
  db.close();
});

async function names(executor: SqlExecutor, type: 'table' | 'index'): Promise<string[]> {
  const rows = await executor.execute(
    "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    [type],
  );
  return rows.map((row) => String(row.name));
}

const SYNTHETIC_V2: Migration = {
  version: 2,
  name: 'synthetic, for tests only',
  statements: [
    'ALTER TABLE kv ADD COLUMN updated_at INTEGER',
    'CREATE TABLE synthetic (id INTEGER PRIMARY KEY)',
  ],
};

describe('migrate', () => {
  test('an empty database comes up at version 1 with exactly the contract tables', async () => {
    expect(await readSchemaVersion(db)).toBe(0);
    expect(await migrate(db)).toEqual({ from: 0, to: 1 });
    expect(await readSchemaVersion(db)).toBe(1);
    expect(await names(db, 'table')).toEqual([...STORE_TABLES].sort());
  });

  test('creates the indexes the matcher and the purge rely on', async () => {
    await migrate(db);
    expect(await names(db, 'index')).toEqual([
      'ix_received_response_query',
      'ix_report_cache_expires',
      'ix_sample_cell',
      'ix_sample_ts',
      'ix_stay_cell',
      'ix_stay_end',
    ]);
  });

  test('running it again changes nothing', async () => {
    await migrate(db);
    await db.execute("INSERT INTO kv (k, v) VALUES ('a', '1')");
    expect(await migrate(db)).toEqual({ from: 1, to: 1 });
    expect(await db.execute('SELECT k, v FROM kv')).toEqual([{ k: 'a', v: '1' }]);
  });

  test('version 1 then a synthetic version 2, keeping the data', async () => {
    await migrate(db);
    await db.execute("INSERT INTO kv (k, v) VALUES ('a', '1')");
    expect(await migrate(db, [MIGRATION_V1, SYNTHETIC_V2])).toEqual({ from: 1, to: 2 });
    expect(await readSchemaVersion(db)).toBe(2);
    expect(await db.execute('SELECT k, v, updated_at FROM kv')).toEqual([
      { k: 'a', v: '1', updated_at: null },
    ]);
    expect(await names(db, 'table')).toContain('synthetic');
  });

  test('an empty database goes straight to the newest version', async () => {
    expect(await migrate(db, [MIGRATION_V1, SYNTHETIC_V2])).toEqual({ from: 0, to: 2 });
    expect(await readSchemaVersion(db)).toBe(2);
  });

  test('a migration that fails part-way leaves the store at the previous whole version', async () => {
    await migrate(db);
    const broken: Migration = {
      version: 2,
      name: 'broken',
      statements: ['CREATE TABLE half_done (id INTEGER PRIMARY KEY)', 'THIS IS NOT SQL'],
    };
    await expect(migrate(db, [MIGRATION_V1, broken])).rejects.toThrow();
    expect(await readSchemaVersion(db)).toBe(1);
    expect(await names(db, 'table')).not.toContain('half_done');
  });

  test('refuses a store written by a newer app', async () => {
    await migrate(db, [MIGRATION_V1, SYNTHETIC_V2]);
    const attempt = migrate(db);
    await expect(attempt).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(attempt).rejects.toMatchObject({ found: 2, supported: 1 });
    expect(await readSchemaVersion(db)).toBe(2);
  });

  test('refuses a migration list whose versions are not 1, 2, 3, ...', async () => {
    await expect(migrate(db, [{ ...MIGRATION_V1, version: 2 }])).rejects.toThrow(/version 1/);
    await expect(migrate(db, [MIGRATION_V1, { ...SYNTHETIC_V2, version: 3 }])).rejects.toThrow(
      /version 2/,
    );
  });
});

describe('the migration list', () => {
  test('is consecutive and ends at SCHEMA_VERSION', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
    expect(MIGRATIONS.at(-1)?.version).toBe(SCHEMA_VERSION);
  });
});

describe('contracts/migration-v1.sql', () => {
  test('is the committed copy of migration 1', async () => {
    // A released migration is frozen. If this fails because version 1 was edited, undo the
    // edit and add a new migration instead. Only before first release: rerun with `-u`.
    await expect(renderMigrationSql(MIGRATION_V1)).toMatchFileSnapshot(
      '../../contracts/migration-v1.sql',
    );
  });

  test('runs as a script, split on the documented separator, to the same schema', async () => {
    const script = renderMigrationSql(MIGRATION_V1);
    for (const statement of script.split('\n;\n')) {
      if (statement.trim() !== '') {
        await db.execute(statement);
      }
    }
    expect(await readSchemaVersion(db)).toBe(1);
    const fromScript = await db.execute('SELECT name, sql FROM sqlite_master ORDER BY name');

    const reference = openMemoryDb();
    await migrate(reference);
    const fromRunner = await reference.execute('SELECT name, sql FROM sqlite_master ORDER BY name');
    reference.close();
    expect(fromScript).toEqual(fromRunner);
  });
});
