/** @jest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store/openStore';
import { StoreOpenError } from '../src/store/errors';
import { PINNED, buildApplyPragmas, keyLiteral } from '../src/store/pragmas';
import { nodeSqlcipherDriver } from '../test-support/nodeSqlcipherDriver';
import {
  nativePragmas,
  nativeWrite,
} from '../test-support/nativeWriterStandIn';

const KEY = 'ab'.repeat(32);
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fmp-store-'));
  path = join(dir, 'storeproof.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (over: Partial<Parameters<typeof openStore>[0]> = {}) =>
  openStore({ path, keyHex: KEY, driver: nodeSqlcipherDriver(), ...over });

const expectOpenError = async (
  p: Promise<unknown>,
  code: StoreOpenError['code'],
) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(StoreOpenError);
  expect((err as StoreOpenError).code).toBe(code);
  return err as StoreOpenError;
};

describe('native write, TypeScript read', () => {
  test.each(['android', 'ios'] as const)(
    'row written with the %s constant reads back',
    async platform => {
      await nativeWrite({
        platform,
        path,
        keyHex: KEY,
        label: 'bg-launch',
        tsUtc: 1_780_000_000,
      });
      const store = await open();
      expect(await store.readRows()).toEqual([
        { id: 1, tsUtc: 1_780_000_000, label: 'bg-launch' },
      ]);
      await store.close();
    },
  );

  test('a second native write after TS closed the store is visible on the next open', async () => {
    const store = await open();
    await store.close();
    await nativeWrite({
      platform: 'android',
      path,
      keyHex: KEY,
      label: 'second',
      tsUtc: 2,
    });
    const again = await open();
    expect((await again.readRows()).map(r => r.label)).toEqual(['second']);
    await again.close();
  });
});

describe('deliberate parameter mismatch fails loudly', () => {
  beforeEach(() =>
    nativeWrite({
      platform: 'android',
      path,
      keyHex: KEY,
      label: 'x',
      tsUtc: 1,
    }),
  );

  const drifted = (statement: string, replacement: string) =>
    buildApplyPragmas(PINNED).map(s =>
      s.startsWith(statement) ? replacement : s,
    );

  test('writer used a different page size -> BAD_KEY_OR_PARAMS', async () => {
    rmSync(path);
    await nativeWrite({
      platform: 'android',
      path,
      keyHex: KEY,
      label: 'x',
      tsUtc: 1,
      pragmas: drifted(
        'PRAGMA cipher_page_size',
        'PRAGMA cipher_page_size = 1024',
      ),
    });
    const err = await expectOpenError(open(), 'BAD_KEY_OR_PARAMS');
    expect(err.message).toMatch(/file is not a database/);
  });

  test('writer used a different HMAC algorithm -> BAD_KEY_OR_PARAMS', async () => {
    rmSync(path);
    await nativeWrite({
      platform: 'android',
      path,
      keyHex: KEY,
      label: 'x',
      tsUtc: 1,
      pragmas: drifted(
        'PRAGMA cipher_hmac_algorithm',
        'PRAGMA cipher_hmac_algorithm = HMAC_SHA1',
      ),
    });
    await expectOpenError(open(), 'BAD_KEY_OR_PARAMS');
  });

  test('writer used SQLCipher 3 compatibility -> BAD_KEY_OR_PARAMS', async () => {
    rmSync(path);
    await nativeWrite({
      platform: 'android',
      path,
      keyHex: KEY,
      label: 'x',
      tsUtc: 1,
      pragmas: ['PRAGMA cipher_compatibility = 3'],
    });
    await expectOpenError(open(), 'BAD_KEY_OR_PARAMS');
  });

  test('wrong key -> BAD_KEY_OR_PARAMS', async () => {
    await expectOpenError(
      open({ keyHex: 'cd'.repeat(32) }),
      'BAD_KEY_OR_PARAMS',
    );
  });

  test('reader with a different KDF iteration count -> PARAM_MISMATCH', async () => {
    const err = await expectOpenError(
      open({
        _pragmasForTest: drifted('PRAGMA kdf_iter', 'PRAGMA kdf_iter = 1000'),
      }),
      'PARAM_MISMATCH',
    );
    expect(err.message).toMatch(/kdf_iter: pinned 256000, effective 1000/);
  });

  test('reader with a different page size -> PARAM_MISMATCH', async () => {
    await expectOpenError(
      open({
        _pragmasForTest: drifted(
          'PRAGMA cipher_page_size',
          'PRAGMA cipher_page_size = 1024',
        ),
      }),
      'PARAM_MISMATCH',
    );
  });

  test('why the read-back exists: SQLCipher alone does NOT notice a raw-key kdf_iter mismatch', async () => {
    const db = await nodeSqlcipherDriver()({ path, key: keyLiteral(KEY) });
    await db.execute('PRAGMA kdf_iter = 1000');
    // opens and reads without any error, silently using a parameter the native side does not use
    expect(await db.execute('SELECT count(*) AS n FROM sqlite_master')).toEqual(
      [{ n: 1 }],
    );
    await db.close();
  });

  test('plaintext (unencrypted) file is rejected, not read as empty', async () => {
    rmSync(path);
    // a driver that never sets the key creates a plaintext database
    const plain = await nodeSqlcipherDriver()({ path, key: '' });
    await plain.execute('CREATE TABLE t (a)');
    await plain.close();
    await expectOpenError(open(), 'BAD_KEY_OR_PARAMS');
  });

  test('library built without SQLCipher -> NOT_SQLCIPHER', async () => {
    await expectOpenError(
      open({ driver: nodeSqlcipherDriver({ isSQLCipher: false }) }),
      'NOT_SQLCIPHER',
    );
  });

  test('malformed key is refused before any file is touched', async () => {
    await expect(open({ keyHex: 'short' })).rejects.toThrow(
      /64 hex characters/,
    );
  });

  test('every native constant is the pinned one (control: no drift opens cleanly)', async () => {
    expect(nativePragmas('android')).toEqual(nativePragmas('ios'));
    const store = await open();
    expect(await store.readRows()).toHaveLength(1);
    await store.close();
  });
});
