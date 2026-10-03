import {
  buildApplyPragmas,
  buildReadBack,
  CIPHER_PARAMS,
  keyLiteral,
  migrate,
  MIGRATIONS,
  STORE_FILE_NAME,
  type Migration,
  type SqlDatabase,
  type SqlRow,
} from '@findmyperson/shared';
import type { StoreConnection, StoreDriver } from './driver';
import { StoreError } from './errors';
import type { Spec } from './specs/NativeEncryptedStore';

/**
 * Where the key and the files come from: the three native methods of
 * src/specs/NativeEncryptedStore.ts. The app passes the real module
 * (`@findmyperson/encrypted-store/native`), tests pass `createTestVault`.
 */
export type StoreVault = Pick<
  Spec,
  'getOrCreateStoreKeyHex' | 'getStoreDirectory' | 'deleteAllData'
>;

/**
 * How long a statement waits for the other connection's write lock before failing. The native
 * capture module and TypeScript each hold their own connection to the one file, so a write
 * can meet a write. Both sides set this value (the native constants are generated from it).
 */
export const STORE_BUSY_TIMEOUT_MS = 5000;

/**
 * THE RETENTION HOOK POINT (plan 4.7). The purge and the weekly VACUUM are task C2.5, not this
 * package: that task writes one function of this type and passes it as `maintenance` at the
 * app's single openStore call. The app then calls `store.runMaintenance(now)` on every
 * foreground. `nowTs` is Unix seconds, supplied by the caller so the hook stays testable.
 */
export type StoreMaintenance = (db: SqlDatabase, nowTs: number) => Promise<void>;

export interface OpenStoreOptions {
  vault: StoreVault;
  driver: StoreDriver;
  /** See StoreMaintenance. Without it `runMaintenance` does nothing. */
  maintenance?: StoreMaintenance;
  /** TEST SEAM. The migration list to bring the store up to; production uses MIGRATIONS. */
  migrations?: readonly Migration[];
  /**
   * TEST SEAM. Pragmas applied instead of the pinned ones, to play a reader that drifted. The
   * read-back below always compares against the pinned constant, never against this.
   */
  applyPragmas?: readonly string[];
}

/** The open store. Read and write it with the table functions of @findmyperson/shared. */
export interface EncryptedStore {
  /** Pass this to listSamplesBetween, listStaysInCells, insertMatchIfAbsent and the rest. */
  readonly db: SqlDatabase;
  /** The backup-excluded directory holding the file; for diagnostics, never for other files. */
  readonly directory: string;
  /** What this open did to the schema. `from` is 0 when the file was new. */
  readonly migration: { readonly from: number; readonly to: number };
  /** Runs the `maintenance` hook given at open. See StoreMaintenance. */
  runMaintenance(nowTs: number): Promise<void>;
  /** Closes the connection. The handle must not be used afterwards. */
  close(): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function firstValue(rows: readonly SqlRow[]): string | undefined {
  const row = rows[0];
  const value = row === undefined ? undefined : Object.values(row)[0];
  return value == null ? undefined : String(value);
}

/**
 * Opens the encrypted store and brings it to the current schema.
 *
 * Before it returns it has proved that the binding is SQLCipher 4, that every pinned cipher
 * parameter is in effect, that the file decrypts with the key, and that the journal is WAL;
 * then it runs the migrations. Any failure closes the connection and throws StoreError
 * (or SchemaTooNewError from the migration runner): there is no half-open store.
 *
 * Call it once at app start and keep the handle. The native capture module opens the same file
 * by itself, with the same key and parameters, whenever the OS wakes it.
 */
export async function openStore(options: OpenStoreOptions): Promise<EncryptedStore> {
  const { vault } = options;
  const key = keyLiteral(await vault.getOrCreateStoreKeyHex());
  const directory = await vault.getStoreDirectory();

  let connection: StoreConnection;
  try {
    connection = await options.driver({ directory, fileName: STORE_FILE_NAME, key });
  } catch (error) {
    throw new StoreError('OPEN_FAILED', `could not open the store: ${message(error)}`);
  }
  try {
    await verify(connection, options.applyPragmas ?? buildApplyPragmas());
    await connection.execute(`PRAGMA busy_timeout = ${STORE_BUSY_TIMEOUT_MS}`);
    const migration = await migrate(connection, options.migrations ?? MIGRATIONS);
    return {
      db: connection,
      directory,
      migration,
      runMaintenance: async (nowTs) => {
        await options.maintenance?.(connection, nowTs);
      },
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

/** The checks m0/store-proof found necessary, in the order it proved them. */
async function verify(db: StoreConnection, pragmas: readonly string[]): Promise<void> {
  if (!db.isSQLCipher()) {
    throw new StoreError(
      'NOT_SQLCIPHER',
      'op-sqlite was built without SQLCipher: package.json needs "op-sqlite": {"sqlcipher": true}',
    );
  }
  for (const pragma of pragmas) {
    await db.execute(pragma);
  }
  const version = firstValue(await db.execute('PRAGMA cipher_version'));
  if (version === undefined || !version.startsWith(`${CIPHER_PARAMS.sqlcipherMajor}.`)) {
    throw new StoreError(
      'NOT_SQLCIPHER',
      `expected SQLCipher ${CIPHER_PARAMS.sqlcipherMajor}.x, cipher_version is ${version ?? 'unreadable'}`,
    );
  }

  // With a raw key SQLCipher decrypts the file whatever kdf_iter is, so reading each pragma
  // back is the only check that notices a side that drifted on it.
  const mismatches: string[] = [];
  for (const [pragma, expected] of buildReadBack()) {
    const actual = firstValue(await db.execute(`PRAGMA ${pragma}`));
    if (actual !== expected) {
      mismatches.push(`${pragma}: pinned ${expected}, effective ${actual ?? 'unreadable'}`);
    }
  }
  if (mismatches.length > 0) {
    throw new StoreError(
      'PARAM_MISMATCH',
      `cipher parameters differ from the pinned constant (${mismatches.join('; ')})`,
    );
  }

  // The first real read. A wrong key, a page-size, HMAC or KDF-algorithm mismatch and a
  // plaintext file all surface here as "file is not a database".
  try {
    await db.execute('SELECT count(*) AS n FROM sqlite_master');
  } catch (error) {
    throw new StoreError(
      'BAD_KEY_OR_PARAMS',
      `the store did not decrypt with the stored key and the pinned parameters: ${message(error)}`,
    );
  }

  const mode = firstValue(await db.execute(`PRAGMA journal_mode = ${CIPHER_PARAMS.journalMode}`));
  if (mode?.toLowerCase() !== CIPHER_PARAMS.journalMode) {
    throw new StoreError(
      'PARAM_MISMATCH',
      `journal_mode is ${mode ?? 'unreadable'}, pinned ${CIPHER_PARAMS.journalMode}`,
    );
  }
}
