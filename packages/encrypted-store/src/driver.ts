import type { SqlDatabase } from '@findmyperson/shared';

/**
 * The SQLite binding under the store. The app passes the op-sqlite one (./opSqliteDriver.ts);
 * tests pass real SQLCipher for Node (./testing/nodeSqlcipherDriver.ts). Everything above this
 * interface, the checks in openStore included, is the code that runs on a phone.
 */
export interface StoreConnection extends SqlDatabase {
  /**
   * True only if the binding was built with SQLCipher. op-sqlite built without it accepts a
   * key, ignores it and opens a plaintext file (found in m0/store-proof), so openStore asks.
   */
  isSQLCipher(): boolean;
  close(): Promise<void>;
}

export interface StoreDriverOptions {
  /** Absolute path of the directory, without a trailing slash. */
  directory: string;
  fileName: string;
  /** The SQLCipher raw-key literal, x'<64 hex>'. */
  key: string;
}

/** Opens the file, creating it if absent, and sets the key before anything is read. */
export type StoreDriver = (options: StoreDriverOptions) => Promise<StoreConnection>;
