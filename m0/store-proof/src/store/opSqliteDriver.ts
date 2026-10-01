import { open, isSQLCipher } from '@op-engineering/op-sqlite';
import type { DriverFactory } from './driver';

/**
 * Production driver: op-sqlite built with `"op-sqlite": {"sqlcipher": true}` (package.json).
 * op-sqlite passes `encryptionKey` straight to sqlite3_key_v2, so an `x'..'` literal selects
 * SQLCipher raw-key mode. If the key is empty or op-sqlite was built without SQLCipher it
 * silently opens a plaintext file, hence the isSQLCipher() guard that openStore enforces.
 */
export const opSqliteDriver: DriverFactory = async ({ path, key }) => {
  const slash = path.lastIndexOf('/');
  const db = open({
    name: path.slice(slash + 1),
    location: path.slice(0, slash),
    encryptionKey: key,
  });
  return {
    isSQLCipher: () => isSQLCipher(),
    execute: async (sql, params) => {
      const res = await db.execute(sql, params);
      return res.rows as never;
    },
    close: async () => db.closeAsync(),
  };
};
