import { join } from 'node:path';
import type { SqlExecutor, SqlRow, SqlValue } from '@findmyperson/shared';
import sqlcipher from '@journeyapps/sqlcipher';
import type { StoreDriver } from '../driver';

/**
 * TEST SUPPORT. Real SQLCipher 4 for Node behind the StoreDriver interface, standing in for
 * op-sqlite, whose own Node build ignores the encryption key (found in m0/store-proof).
 *
 * Unlike the in-memory SQLite in @findmyperson/shared's tests, this proves the encryption: the
 * file it writes is a SQLCipher file, opened with the pinned parameters and a raw key. It is
 * @journeyapps/sqlcipher's SQLCipher build, not the one op-sqlite compiles into the app.
 */
export function nodeSqlcipherDriver(options: { isSQLCipher?: boolean } = {}): StoreDriver {
  return async ({ directory, fileName, key }) => {
    const db = await new Promise<sqlcipher.Database>((resolve, reject) => {
      const opened = new sqlcipher.Database(join(directory, fileName), (error) =>
        error === null ? resolve(opened) : reject(error),
      );
    });
    const execute: SqlExecutor['execute'] = (sql, params = []) =>
      new Promise<SqlRow[]>((resolve, reject) => {
        db.all(sql, params as SqlValue[], (error, rows: SqlRow[]) =>
          error === null ? resolve(rows) : reject(error),
        );
      });
    // What op-sqlite does with `encryptionKey`: the key is set before anything is read.
    await execute(`PRAGMA key = "${key}"`);

    // One transaction at a time on the connection, as op-sqlite's queue guarantees.
    let queue: Promise<unknown> = Promise.resolve();
    return {
      isSQLCipher: () => options.isSQLCipher ?? true,
      execute,
      transaction(work) {
        const run = async () => {
          await execute('BEGIN');
          try {
            const result = await work({ execute });
            await execute('COMMIT');
            return result;
          } catch (error) {
            await execute('ROLLBACK');
            throw error;
          }
        };
        const result = queue.then(run, run);
        queue = result.catch(() => undefined);
        return result;
      },
      close: () =>
        new Promise<void>((resolve, reject) => {
          db.close((error) => (error === null ? resolve() : reject(error)));
        }),
    };
  };
}
