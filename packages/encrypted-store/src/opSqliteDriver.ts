import type { SqlRow, SqlValue } from '@findmyperson/shared';
import { isSQLCipher, open } from '@op-engineering/op-sqlite';
import type { StoreDriver } from './driver';

/**
 * The production driver: op-sqlite built with `"op-sqlite": {"sqlcipher": true}`.
 *
 * op-sqlite hands `encryptionKey` to sqlite3_key_v2 as given, so the x'..' literal selects
 * SQLCipher's raw-key mode. It sets no cipher pragma itself and, built without SQLCipher,
 * opens a plaintext file without complaint; openStore applies and checks all of that.
 *
 * Type-checked against op-sqlite's own types. It cannot run under Node (op-sqlite's Node build
 * ignores the key), so the tests drive openStore through testing/nodeSqlcipherDriver.ts.
 */
export const opSqliteDriver: StoreDriver = async ({ directory, fileName, key }) => {
  const db = open({ name: fileName, location: directory, encryptionKey: key });
  const rowsOf = (result: { rows: unknown }) => result.rows as SqlRow[];
  return {
    isSQLCipher: () => isSQLCipher(),
    execute: async (sql, params) => rowsOf(await db.execute(sql, params as SqlValue[])),
    async transaction(work) {
      // op-sqlite commits when the callback resolves and rolls back when it rejects, and it
      // queues transactions, so two never interleave on this connection.
      let outcome: { value: Awaited<ReturnType<typeof work>> } | undefined;
      await db.transaction(async (tx) => {
        const value = await work({
          execute: async (sql, params) => rowsOf(await tx.execute(sql, params as SqlValue[])),
        });
        outcome = { value };
      });
      if (outcome === undefined) {
        throw new Error('op-sqlite finished a transaction without running it');
      }
      return outcome.value;
    },
    close: async () => db.close(),
  };
};
