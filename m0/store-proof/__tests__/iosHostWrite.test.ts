/** @jest-environment node */
// Runs the REAL iOS Swift writer (ios/StoreProof/Store/*.swift) on this Mac, built against
// SQLCipher compiled from op-sqlite's vendored C source, and reads its output with the TS store
// (and the reverse). It is not an iPhone: no Keychain, no iOS file protection, no background
// launch, and CommonCrypto instead of OpenSSL as the crypto provider (same algorithms and file
// format). Needs macOS + Xcode command line tools; elsewhere the suite is skipped, loudly.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openStore } from '../src/store/openStore';
import { StoreOpenError } from '../src/store/errors';
import { nodeSqlcipherDriver } from '../test-support/nodeSqlcipherDriver';
import { nativeWrite } from '../test-support/nativeWriterStandIn';

const root = resolve(__dirname, '..');
const bin = join(root, 'ios/build/host-check');
const KEY = 'ab'.repeat(32);

const canBuild = (() => {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

if (!canBuild) {
  console.warn(
    'SKIPPED iosHostWrite: needs macOS with Xcode command line tools (swiftc)',
  );
}

(canBuild ? describe : describe.skip)('iOS Swift writer on the host', () => {
  let dir: string;
  beforeAll(() => {
    execFileSync(join(root, 'ios/build-host-check.sh'), { stdio: 'pipe' });
  }, 300_000);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fmp-ios-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('Swift self-test (constants vs shared JSON, key handling, mismatch checks)', () => {
    const out = execFileSync(
      bin,
      ['selftest', join(root, 'shared/cipher-params.json')],
      { encoding: 'utf8' },
    );
    expect(out).toMatch(/different KDF iteration count throws PARAM_MISMATCH/);
  });

  test('Swift writes a row, TypeScript reads it back', async () => {
    const path = join(dir, 'storeproof.db');
    const before = Math.floor(Date.now() / 1000);
    execFileSync(bin, ['write', path, KEY, 'from-swift']);
    const store = await openStore({
      path,
      keyHex: KEY,
      driver: nodeSqlcipherDriver(),
    });
    const rows = await store.readRows();
    await store.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('from-swift');
    expect(rows[0].tsUtc).toBeGreaterThanOrEqual(before);
  });

  test('TypeScript-side file is readable by Swift (same parameters both ways)', async () => {
    const path = join(dir, 'storeproof.db');
    await nativeWrite({
      platform: 'ios',
      path,
      keyHex: KEY,
      label: 'from-ts-standin',
      tsUtc: 42,
    });
    const out = execFileSync(bin, ['read', path, KEY], { encoding: 'utf8' });
    expect(out.trim()).toBe('1\t42\tfrom-ts-standin');
  });

  test('Swift refuses a wrong key loudly, and TS refuses a Swift file opened with the wrong key', async () => {
    const path = join(dir, 'storeproof.db');
    execFileSync(bin, ['write', path, KEY, 'x']);
    let stderr = '';
    try {
      execFileSync(bin, ['read', path, 'cd'.repeat(32)], { stdio: 'pipe' });
    } catch (e) {
      stderr = String((e as { stderr: Buffer }).stderr);
    }
    expect(stderr).toMatch(/BAD_KEY_OR_PARAMS/);
    await expect(
      openStore({
        path,
        keyHex: 'cd'.repeat(32),
        driver: nodeSqlcipherDriver(),
      }),
    ).rejects.toBeInstanceOf(StoreOpenError);
  });
});
