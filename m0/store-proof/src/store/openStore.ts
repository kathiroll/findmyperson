import { CIPHER_PARAMS } from '../generated/cipherParams.generated';
import type { DriverFactory, Row, SqlDriver } from './driver';
import { StoreOpenError } from './errors';
import {
  PINNED,
  buildApplyPragmas,
  buildReadBack,
  keyLiteral,
} from './pragmas';

export interface ProbeRow {
  id: number;
  tsUtc: number;
  label: string;
}

export interface Store {
  readRows(): Promise<ProbeRow[]>;
  close(): Promise<void>;
}

export interface OpenStoreOptions {
  /** Absolute path of the database file (the same file the native module writes). */
  path: string;
  /** 64 hex characters (32 bytes). */
  keyHex: string;
  driver: DriverFactory;
  /**
   * TEST SEAM. Pragmas applied instead of the pinned ones, to simulate a writer that drifted.
   * Verification below always compares against the pinned constant, never against this.
   */
  _pragmasForTest?: string[];
}

const PINNED_JOURNAL: string = CIPHER_PARAMS.journalMode;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const firstValue = (rows: Row[]): string | undefined => {
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  const v = Object.values(row)[0];
  return v == null ? undefined : String(v);
};

/**
 * Opens the encrypted store and proves, before returning, that it really is SQLCipher with the
 * pinned parameters and that the file decrypts. Any failure throws StoreOpenError; the function
 * never returns a handle that might read empty or garbage data.
 */
export async function openStore(opts: OpenStoreOptions): Promise<Store> {
  const key = keyLiteral(opts.keyHex);
  let db: SqlDriver;
  try {
    db = await opts.driver({ path: opts.path, key });
  } catch (e) {
    throw new StoreOpenError(
      'OPEN_FAILED',
      `could not open ${opts.path}: ${msg(e)}`,
    );
  }
  try {
    await verifyAndPrepare(
      db,
      opts._pragmasForTest ?? buildApplyPragmas(PINNED),
    );
  } catch (e) {
    await db.close().catch(() => undefined);
    throw e;
  }
  return {
    async readRows() {
      const rows = await db.execute(CIPHER_PARAMS.selectSql);
      return rows.map(r => ({
        id: Number(r.id),
        tsUtc: Number(r.ts_utc),
        label: String(r.label),
      }));
    },
    close: () => db.close(),
  };
}

async function verifyAndPrepare(
  db: SqlDriver,
  pragmas: string[],
): Promise<void> {
  // op-sqlite ignores the key silently when built without SQLCipher; refuse a plaintext store.
  if (!db.isSQLCipher()) {
    throw new StoreOpenError(
      'NOT_SQLCIPHER',
      'op-sqlite was built without SQLCipher: set "op-sqlite": {"sqlcipher": true} in package.json and rebuild',
    );
  }
  for (const p of pragmas) {
    await db.execute(p);
  }
  const version = firstValue(await db.execute('PRAGMA cipher_version'));
  if (!version || !version.startsWith(`${PINNED.sqlcipherMajor}.`)) {
    throw new StoreOpenError(
      'NOT_SQLCIPHER',
      `expected SQLCipher ${
        PINNED.sqlcipherMajor
      }.x, PRAGMA cipher_version returned ${version ?? 'nothing'}`,
    );
  }

  // Effective values must equal the pinned constant. This is the only check that catches a
  // kdf_iter mismatch: with a raw key, SQLCipher decrypts the file regardless of kdf_iter.
  const mismatches: string[] = [];
  for (const [pragma, expected] of buildReadBack(PINNED)) {
    const actual = firstValue(await db.execute(`PRAGMA ${pragma}`));
    if (actual !== expected) {
      mismatches.push(
        `${pragma}: pinned ${expected}, effective ${actual ?? 'unreadable'}`,
      );
    }
  }
  if (mismatches.length > 0) {
    throw new StoreOpenError(
      'PARAM_MISMATCH',
      `cipher parameters differ from the pinned constant (${mismatches.join(
        '; ',
      )})`,
    );
  }

  // First real read: this is where a wrong key or a page-size / HMAC / KDF-algorithm mismatch
  // surfaces ("file is not a database"). Report it as such instead of passing the raw error up.
  try {
    await db.execute('SELECT count(*) AS n FROM sqlite_master');
  } catch (e) {
    throw new StoreOpenError(
      'BAD_KEY_OR_PARAMS',
      `store did not decrypt with the pinned parameters (wrong key, or the writer used different cipher parameters): ${msg(
        e,
      )}`,
    );
  }

  const mode = firstValue(
    await db.execute(`PRAGMA journal_mode = ${PINNED_JOURNAL}`),
  );
  if (mode?.toLowerCase() !== PINNED_JOURNAL) {
    throw new StoreOpenError(
      'PARAM_MISMATCH',
      `journal_mode is ${mode ?? 'unreadable'}, pinned ${PINNED_JOURNAL}`,
    );
  }
  await db.execute(CIPHER_PARAMS.createTableSql);
}
