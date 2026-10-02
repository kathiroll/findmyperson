import { describe, expect, test } from 'vitest';
import origin from '../../../../m0/store-proof/shared/cipher-params.json';
import mirror from '../../contracts/cipher-params.json';
import {
  buildApplyPragmas,
  buildReadBack,
  CIPHER_KEY_VECTOR,
  CIPHER_PARAMS,
  keyLiteral,
  STORE_FILE_NAME,
} from './cipher';

/** The cipher fields this package mirrors from the m0 store proof. */
const MIRRORED = [
  'sqlcipherMajor',
  'cipherCompatibility',
  'pageSizeBytes',
  'kdfIterations',
  'kdfAlgorithm',
  'hmacAlgorithm',
  'keyFormat',
  'keyBytes',
  'journalMode',
  'keyVector',
] as const;

describe('pinned cipher parameters', () => {
  test('equal the m0 store-proof original, field for field', () => {
    // m0/store-proof proved these values on real SQLCipher builds. If either file changes, this
    // fails until the other follows, so the real build cannot drift from what was proven.
    for (const field of MIRRORED) {
      expect(mirror[field]).toEqual(origin[field]);
    }
  });

  test('the mirror carries no field the original lacks', () => {
    const mirrored = Object.keys(mirror).filter((key) => key !== '_comment');
    expect(mirrored.sort()).toEqual([...MIRRORED].sort());
  });

  test('are the SQLCipher 4 defaults the plan names', () => {
    expect(CIPHER_PARAMS).toEqual({
      sqlcipherMajor: 4,
      cipherCompatibility: 4,
      pageSizeBytes: 4096,
      kdfIterations: 256000,
      kdfAlgorithm: 'PBKDF2_HMAC_SHA512',
      hmacAlgorithm: 'HMAC_SHA512',
      keyFormat: 'raw-hex-literal',
      keyBytes: 32,
      journalMode: 'wal',
    });
  });

  test('the real store does not reuse the spike file name', () => {
    expect(STORE_FILE_NAME).toBe('findmyperson.db');
    expect(STORE_FILE_NAME).not.toBe(origin.dbFileName);
  });
});

describe('pragmas', () => {
  test('the apply list is the one the m0 native writers were generated with', () => {
    expect(buildApplyPragmas()).toEqual([
      'PRAGMA cipher_compatibility = 4',
      'PRAGMA cipher_page_size = 4096',
      'PRAGMA kdf_iter = 256000',
      'PRAGMA cipher_kdf_algorithm = PBKDF2_HMAC_SHA512',
      'PRAGMA cipher_hmac_algorithm = HMAC_SHA512',
    ]);
  });

  test('the read-back list covers every tunable that a raw key would not catch', () => {
    expect(buildReadBack()).toEqual([
      ['cipher_page_size', '4096'],
      ['kdf_iter', '256000'],
      ['cipher_kdf_algorithm', 'PBKDF2_HMAC_SHA512'],
      ['cipher_hmac_algorithm', 'HMAC_SHA512'],
    ]);
  });

  test('both lists follow the parameters they are given', () => {
    const drifted = { ...CIPHER_PARAMS, kdfIterations: 64000, pageSizeBytes: 1024 };
    expect(buildApplyPragmas(drifted)).toContain('PRAGMA kdf_iter = 64000');
    expect(buildReadBack(drifted)).toContainEqual(['cipher_page_size', '1024']);
  });
});

describe('keyLiteral', () => {
  test('golden vector', () => {
    expect(keyLiteral(CIPHER_KEY_VECTOR.hex)).toBe(CIPHER_KEY_VECTOR.literal);
    expect(keyLiteral(CIPHER_KEY_VECTOR.hex.toUpperCase())).toBe(CIPHER_KEY_VECTOR.literal);
  });

  test.each(['', 'zz'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), `${'ab'.repeat(32)}'`])(
    'rejects malformed key %#',
    (bad) => {
      expect(() => keyLiteral(bad)).toThrow(/64 hex characters/);
    },
  );
});
