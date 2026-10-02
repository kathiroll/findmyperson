import { expect, test } from 'vitest';
import * as shared from '../index';
import { openMemoryDb } from '../testing/memoryDb';
import { migrate } from './migrations';
import { STORE_TABLES, TABLE_OWNERSHIP } from './ownership';

test('the ownership list covers exactly the tables the schema creates', async () => {
  const db = openMemoryDb();
  await migrate(db);
  const rows = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  db.close();
  const inSchema = rows.map((row) => String(row.name)).sort();
  expect([...STORE_TABLES].sort()).toEqual(inSchema);
  expect(Object.keys(TABLE_OWNERSHIP).sort()).toEqual(inSchema);
});

test('every table has at least one owned write path', () => {
  for (const table of STORE_TABLES) {
    expect(TABLE_OWNERSHIP[table].length).toBeGreaterThan(0);
    for (const path of TABLE_OWNERSHIP[table]) {
      expect(path.owner).not.toBe('');
      expect(path.writes).not.toBe('');
    }
  }
});

test('every function or statement the list names is a real export of this package', () => {
  // camelCase identifiers and SCREAMING_SNAKE constants in the `writes` text. Column names are
  // snake_case and plain words have no inner capital, so neither is picked up.
  const named = /\b(?:[a-z]+(?:[A-Z][a-z]+)+|[A-Z]+(?:_[A-Z]+)+)\b/g;
  const exported = new Set(Object.keys(shared));
  const mentioned = new Set<string>();
  for (const table of STORE_TABLES) {
    for (const path of TABLE_OWNERSHIP[table]) {
      for (const name of path.writes.match(named) ?? []) {
        mentioned.add(name);
      }
    }
  }
  expect(mentioned.size).toBeGreaterThan(25);
  expect([...mentioned].filter((name) => !exported.has(name))).toEqual([]);
});

test('every writing function of a table module is claimed by some owner', () => {
  const writers = Object.keys(shared).filter((name) =>
    /^(insert|update|delete|upsert|put|enqueue|mark|requeue|apply|set|save|advance|kvSet|kvDelete)/.test(
      name,
    ),
  );
  const claimed = Object.values(TABLE_OWNERSHIP)
    .flat()
    .map((path) => path.writes)
    .join(' ');
  // insertLocationSample is the documented test-only path; applyReportPatch is a pure function
  // over API shapes, not a store write.
  const exempt = new Set(['insertLocationSample', 'applyReportPatch']);
  const unclaimed = writers.filter((name) => !exempt.has(name) && !claimed.includes(name));
  expect(unclaimed).toEqual([]);
});
