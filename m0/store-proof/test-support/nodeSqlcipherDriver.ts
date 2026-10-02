/**
 * Jest stand-in for op-sqlite. op-sqlite's own Node build ignores the encryption key (it only
 * logs a warning; see node/dist/index.js in the package), so it cannot exercise SQLCipher in
 * Jest. @journeyapps/sqlcipher is real SQLCipher 4.x for Node; the store code above the
 * SqlDriver interface is identical to what runs on a phone.
 */
import type { DriverFactory, Row, SqlDriver } from '../src/store/driver';

const sqlite3 = require('@journeyapps/sqlcipher');

type Db = {
  all(
    sql: string,
    params: unknown[],
    cb: (e: Error | null, rows: Row[]) => void,
  ): void;
  close(cb: (e: Error | null) => void): void;
  once(ev: 'open' | 'error', cb: (e?: Error) => void): void;
};

export function nodeSqlcipherDriver(
  opts: { isSQLCipher?: boolean } = {},
): DriverFactory {
  return async ({ path, key }) => {
    const db: Db = new sqlite3.Database(path);
    await new Promise<void>((resolve, reject) => {
      db.once('open', () => resolve());
      db.once('error', e => reject(e));
    });
    const exec = (sql: string, params: Array<string | number> = []) =>
      new Promise<Row[]>((resolve, reject) =>
        db.all(sql, params, (e, rows) => (e ? reject(e) : resolve(rows))),
      );
    // Same effect as op-sqlite's sqlite3_key_v2(db, "main", key): key is set before any read.
    if (key) {
      await exec(`PRAGMA key = "${key}"`);
    }
    const driver: SqlDriver = {
      isSQLCipher: () => opts.isSQLCipher ?? true,
      execute: exec,
      close: () =>
        new Promise<void>((resolve, reject) =>
          db.close(e => (e ? reject(e) : resolve())),
        ),
    };
    return driver;
  };
}
