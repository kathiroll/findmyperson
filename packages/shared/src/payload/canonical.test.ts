import { describe, expect, test } from 'vitest';
import fixture from '../../contracts/canonical-json-vectors.json';
import { canonicalJson, CanonicalJsonError } from './canonical';

describe('canonicalJson', () => {
  test.each(fixture.vectors)('golden vector: $name', ({ value, canonical }) => {
    expect(canonicalJson(value)).toBe(canonical);
  });

  test('every golden output is itself valid JSON for the same value', () => {
    for (const { value, canonical } of fixture.vectors) {
      expect(JSON.parse(canonical)).toEqual(value);
    }
  });

  test('does not depend on the order members were inserted', () => {
    const forwards = { a: 1, b: { c: [1, 2], d: null }, e: 'x' };
    const backwards = { e: 'x', b: { d: null, c: [1, 2] }, a: 1 };
    expect(canonicalJson(forwards)).toBe(canonicalJson(backwards));
  });

  test('writes negative zero as 0, which JSON cannot tell apart from zero', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  test('accepts an object with no prototype, as some parsers produce', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse: unknown[] = [];
  sparse[2] = 1;

  test.each<[string, unknown]>([
    ['undefined', undefined],
    ['an undefined member', { a: undefined }],
    ['NaN', Number.NaN],
    ['Infinity', { n: Number.POSITIVE_INFINITY }],
    ['a bigint', 1n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a class instance', new (class Point {})()],
    ['a typed array', new Uint8Array(2)],
    ['a hole in an array', sparse],
    ['a lone surrogate in a value', ['\ud83d']],
    ['a lone surrogate in a key', { '\ude00': 1 }],
    ['a cycle', cyclic],
  ])('throws for %s, which is not JSON data', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  test('allows the same object twice when it is not a cycle', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  test('names the offending path', () => {
    expect(() => canonicalJson({ a: [1, { b: Number.NaN }] })).toThrow('$.a[1].b');
  });
});
