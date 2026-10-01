/** @jest-environment node */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CIPHER_PARAMS } from '../src/generated/cipherParams.generated';
import { PINNED, buildApplyPragmas, keyLiteral } from '../src/store/pragmas';
import { nativePragmas } from '../test-support/nativeWriterStandIn';

const root = resolve(__dirname, '..');
const shared = JSON.parse(
  readFileSync(resolve(root, 'shared/cipher-params.json'), 'utf8'),
);

describe('shared cipher constant', () => {
  test('generated TS/Kotlin/Swift files are up to date with shared/cipher-params.json', () => {
    // exits non-zero (and execFileSync throws) if any generated file is stale
    execFileSync('node', ['scripts/gen-cipher-params.mjs', '--check'], {
      cwd: root,
      stdio: 'pipe',
    });
  });

  test('pinned values are the SQLCipher 4 defaults the plan names', () => {
    expect(PINNED).toMatchObject({
      sqlcipherMajor: 4,
      cipherCompatibility: 4,
      pageSizeBytes: 4096,
      kdfIterations: 256000,
      kdfAlgorithm: 'PBKDF2_HMAC_SHA512',
      hmacAlgorithm: 'HMAC_SHA512',
    });
    expect(CIPHER_PARAMS.pageSizeBytes).toBe(shared.pageSizeBytes);
  });

  test.each(['android', 'ios'] as const)(
    '%s native pragma list equals the TypeScript one',
    platform => {
      expect(nativePragmas(platform)).toEqual(buildApplyPragmas(PINNED));
    },
  );

  test('key literal golden vector', () => {
    expect(keyLiteral(shared.keyVector.hex)).toBe(shared.keyVector.literal);
    expect(keyLiteral(shared.keyVector.hex.toUpperCase())).toBe(
      shared.keyVector.literal,
    );
  });

  test.each(['', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33)])(
    'rejects malformed key %#',
    bad => {
      expect(() => keyLiteral(bad)).toThrow(/64 hex characters/);
    },
  );
});
