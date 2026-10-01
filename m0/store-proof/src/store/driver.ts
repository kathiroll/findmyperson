export type Row = Record<string, string | number | null>;

/** The only surface the store needs from a SQLite binding. */
export interface SqlDriver {
  /** True only if the underlying library was built with SQLCipher. */
  isSQLCipher(): boolean;
  execute(sql: string, params?: Array<string | number>): Promise<Row[]>;
  close(): Promise<void>;
}

/** Opens (creating if absent) the file at `path` and applies `key` as the SQLCipher key. */
export type DriverFactory = (opts: {
  path: string;
  key: string;
}) => Promise<SqlDriver>;
