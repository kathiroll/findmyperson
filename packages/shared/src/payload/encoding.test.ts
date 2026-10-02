import { describe, expect, test } from 'vitest';
import { base64UrlDecode, base64UrlEncode, utf8Encode } from './encoding';

describe('utf8Encode', () => {
  test.each([
    ['empty', ''],
    ['ascii', 'findmyperson.query.v1\n{"a":1}'],
    ['two-byte', 'ö é ñ \u0080 ߿'],
    ['three-byte', '€ दिल्ली ࠀ ￿'],
    ['four-byte', '😀 𝄞 \u{10000} \u{10ffff}'],
    ['mixed', 'Aö€😀Z'],
  ])('matches the platform encoder: %s', (_label, text) => {
    expect([...utf8Encode(text)]).toEqual([...new TextEncoder().encode(text)]);
  });

  test.each([
    ['high surrogate at the end', 'a\ud83d'],
    ['high surrogate followed by a non-surrogate', '\ud83dx'],
    ['low surrogate on its own', '\ude00'],
  ])('throws on a lone surrogate: %s', (_label, text) => {
    expect(() => utf8Encode(text)).toThrow(RangeError);
  });
});

describe('base64url', () => {
  test('round-trips every length and agrees with the platform encoder', () => {
    for (let length = 0; length <= 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length * 11) & 0xff);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64UrlDecode(encoded)).toEqual(bytes);
    }
  });

  test('uses the URL-safe alphabet and no padding', () => {
    expect(base64UrlEncode(Uint8Array.from([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect(base64UrlEncode(Uint8Array.from([0xff]))).toBe('_w');
  });

  test.each([
    ['padding', '_w=='],
    ['the standard alphabet', '+/+/'],
    ['whitespace', 'AA AA'],
    ['an impossible length', 'AAAAA'],
    // "_w" is the only encoding of 0xff. "_x" has the same first byte and stray low bits.
    ['stray trailing bits', '_x'],
  ])('rejects %s', (_label, text) => {
    expect(base64UrlDecode(text)).toBeNull();
  });

  test('decodes the empty string to no bytes', () => {
    expect(base64UrlDecode('')).toEqual(new Uint8Array(0));
  });
});
