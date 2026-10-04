import { base64UrlEncode } from '@findmyperson/shared';
import signing from '@findmyperson/shared/contracts/signing-vectors.json';
import { hexToBytes } from '@findmyperson/shared/src/testing/ed25519';
import { describe, expect, test } from 'vitest';
import { createHttpTransport } from './httpTransport';
import {
  configuredReportSource,
  REPORT_CDN_ORIGIN,
  REPORT_TRUSTED_KEYS,
  reportSourceOf,
} from './reportCdn';

const KEY = base64UrlEncode(new Uint8Array(32).fill(9));
const OTHER_KEY = base64UrlEncode(new Uint8Array(32).fill(10));

describe('what this build was given', () => {
  test('nothing yet: the CDN origin and the trusted keys wait for the storage and CDN decision', () => {
    // fmp-storage-cdn-provider. Filling in the two constants of reportCdn.ts is deliberate, and
    // this test then changes with them.
    expect(REPORT_CDN_ORIGIN).toBeNull();
    expect(REPORT_TRUSTED_KEYS).toEqual({});
    expect(configuredReportSource()).toBeNull();
  });

  test('whatever it is given must be usable, and must never be the published test key', () => {
    // Holds today and after the decision: a typo in either constant fails here, not on a phone.
    const source = reportSourceOf(REPORT_CDN_ORIGIN, REPORT_TRUSTED_KEYS);
    if (source !== null) {
      expect(() => createHttpTransport({ origin: source.origin })).not.toThrow();
    }
    // The seed of that key is printed in packages/shared/contracts/signing-vectors.json.
    const published = base64UrlEncode(hexToBytes(signing.public_key_hex));
    expect(Object.values(REPORT_TRUSTED_KEYS)).not.toContain(published);
    expect(Object.keys(REPORT_TRUSTED_KEYS)).not.toContain(signing.key_id);
  });
});

describe('a report source', () => {
  test('is an https origin and the keys decoded, by key id', () => {
    const source = reportSourceOf('https://cdn.example', {
      'pub-2026': KEY,
      'pub-2027': OTHER_KEY,
    });
    expect(source?.origin).toBe('https://cdn.example');
    expect(Object.keys(source?.trustedKeys ?? {})).toEqual(['pub-2026', 'pub-2027']);
    expect(source?.trustedKeys['pub-2026']).toEqual(new Uint8Array(32).fill(9));
    expect(source?.trustedKeys['pub-2027']).toEqual(new Uint8Array(32).fill(10));
  });

  test('is absent until there is both somewhere to fetch from and a key to check it with', () => {
    expect(reportSourceOf(null, {})).toBeNull();
    expect(reportSourceOf('https://cdn.example', {})).toBeNull();
    expect(reportSourceOf(null, { 'pub-2026': KEY })).toBeNull();
  });

  test('a value that is present and wrong is an error, not a quiet "absent"', () => {
    for (const origin of [
      'http://cdn.example',
      'https://cdn.example/',
      'https://cdn.example/reports',
      'cdn.example',
      '',
    ]) {
      expect(() => reportSourceOf(origin, { 'pub-2026': KEY })).toThrow(RangeError);
    }
    for (const keys of [
      { 'pub-2026': KEY.slice(1) },
      { 'pub-2026': `${KEY}A` },
      { 'pub-2026': base64UrlEncode(new Uint8Array(64)) },
      { 'pub-2026': 'not base64url!' },
      { 'pub-2026': '' },
      { 'Pub 2026': KEY },
      { 'pub-2026': KEY, 'pub-2027': 'AAAA' },
    ]) {
      expect(() => reportSourceOf('https://cdn.example', keys)).toThrow(RangeError);
      // Also with no origin yet: a bad key is caught when it is written, not when it is needed.
      expect(() => reportSourceOf(null, keys)).toThrow(RangeError);
    }
  });
});
