/**
 * The only surface the store code needs from a SQLite binding. The app adapts op-sqlite to it;
 * tests adapt Node's built-in SQLite. Nothing in this package opens a file or imports a driver.
 */

/** Values that go into and come out of the store. There are no BLOB columns. */
export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, SqlValue>>;

/** Runs one statement. Rows are returned for SELECT and for statements with RETURNING. */
export interface SqlExecutor {
  execute(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
}

/** A database handle: an executor that can also run a group of statements atomically. */
export interface SqlDatabase extends SqlExecutor {
  /** Commits if `work` resolves and rolls everything back if it rejects. */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** A stored row did not have the shape the schema promises. Indicates a bug or a foreign writer. */
export class StoreRowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreRowError';
  }
}

/** Reads a NOT NULL INTEGER or REAL column. */
export function num(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new StoreRowError(`column ${column}: expected a number, got ${typeof value}`);
  }
  return value;
}

/** Reads a NOT NULL TEXT column. */
export function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new StoreRowError(`column ${column}: expected text, got ${typeof value}`);
  }
  return value;
}

/** Reads a nullable INTEGER or REAL column. */
export function numOrNull(row: SqlRow, column: string): number | null {
  return row[column] == null ? null : num(row, column);
}

/** Reads a nullable TEXT column. */
export function textOrNull(row: SqlRow, column: string): string | null {
  return row[column] == null ? null : text(row, column);
}

/** Reads a TEXT column that must hold one of a fixed set of values. */
export function oneOf<T extends string>(row: SqlRow, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new StoreRowError(`column ${column}: unexpected value ${JSON.stringify(value)}`);
  }
  return value as T;
}

/** "?, ?, ?" for an IN list of the given length. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}
