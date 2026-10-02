import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlExecutor, SqlRow, SqlValue } from '../store/driver';

/**
 * TEST SUPPORT, not exported from the package. An in-memory SQLite database behind the store's
 * SqlDatabase interface, using Node's built-in SQLite, so the migration and every table module
 * run against a real SQL engine with no file, device or network.
 *
 * It is plain SQLite, not SQLCipher: it proves the SQL, not the encryption. The cipher
 * parameters are covered by store/cipher.test.ts and, on a device, by m0/store-proof.
 */
export function openMemoryDb(): SqlDatabase & { close(): void } {
  const db = new DatabaseSync(':memory:');
  const execute: SqlExecutor['execute'] = async (sql, params = []) =>
    db.prepare(sql).all(...(params as SqlValue[])) as SqlRow[];
  return {
    execute,
    async transaction(work) {
      db.exec('BEGIN');
      try {
        const result = await work({ execute });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
