import { describe, expect, test } from 'vitest';
import { MAX_SEARCH_RADIUS_M, REPORT_TTL_SEC, RETENTION_SEC } from '../constants';
import { searchAreaCells } from '../geo/h3';
import { rawQuery, rawQueryWithUnknownField } from '../testing/fixtures';
import { BroadcastQuerySchema, parseBroadcastQuery } from './query';

const invalidWith = (changes: Record<string, unknown>) =>
  parseBroadcastQuery({ ...rawQuery(), ...changes });

describe('parseBroadcastQuery', () => {
  test('reads the sample query', () => {
    const result = parseBroadcastQuery(rawQuery());
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.query.person.name).toBe('Alex Rivera');
      expect(result.query.reporter_phone).toBe('+15550000000');
      expect(result.query.cells).toEqual(
        searchAreaCells(result.query.center, result.query.radius_m),
      );
    }
  });

  test('never changes the value it reads', () => {
    const raw = rawQuery();
    const before = JSON.stringify(raw);
    parseBroadcastQuery(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  test('ignores members it does not know, at any depth', () => {
    const raw = rawQueryWithUnknownField();
    (raw.person as Record<string, unknown>).nickname = 'Al';
    const result = parseBroadcastQuery(raw);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect('future_field' in result.query).toBe(false);
      expect('nickname' in result.query.person).toBe(false);
    }
  });

  test('accepts a report without a photo', () => {
    const raw = rawQuery();
    delete (raw.person as Record<string, unknown>).photo;
    const result = parseBroadcastQuery(raw);
    expect(result.status === 'ok' && result.query.person.photo).toBe(undefined);
  });

  test.each<[string, unknown]>([
    ['a newer version', { ...rawQuery(), v: 2 }],
    ['version zero', { ...rawQuery(), v: 0 }],
    ['a version given as text', { ...rawQuery(), v: '1' }],
    ['no version', Object.fromEntries(Object.entries(rawQuery()).filter(([k]) => k !== 'v'))],
    ['null', null],
    ['a string', 'query'],
    ['an array', [rawQuery()]],
  ])('reports %s as an unsupported version and parses nothing', (_label, raw) => {
    expect(parseBroadcastQuery(raw)).toEqual({ status: 'unsupported_version' });
  });

  test('a newer version is skipped even when the rest would not parse', () => {
    expect(parseBroadcastQuery({ v: 2, anything: 'at all' })).toEqual({
      status: 'unsupported_version',
    });
  });

  test.each<[string, Record<string, unknown>, string]>([
    ['a lowercase query id', { query_id: '01jb3z6q7w8x9y0zabcdefghjk' }, 'query_id'],
    ['a query id with an excluded letter', { query_id: '01JB3Z6Q7W8X9Y0ZABCDEFGHIL' }, 'query_id'],
    ['revision zero', { revision: 0 }, 'revision'],
    ['a fractional revision', { revision: 1.5 }, 'revision'],
    ['a bad key id', { key_id: 'Key One' }, 'key_id'],
    ['a fractional timestamp', { issued_at: 1789900000.5 }, 'issued_at'],
    ['a latitude out of range', { center: { lat: 90.5, lon: 0 } }, 'center.lat'],
    ['a longitude out of range', { center: { lat: 0, lon: 181 } }, 'center.lon'],
    ['a negative radius', { radius_m: -1 }, 'radius_m'],
    ['a fractional radius', { radius_m: 10.5 }, 'radius_m'],
    ['a radius over the cap', { radius_m: MAX_SEARCH_RADIUS_M + 1 }, 'radius_m'],
    ['a reversed window', { window: { from: 200, to: 100 } }, 'window'],
    ['a window longer than retention', { window: { from: 0, to: RETENTION_SEC + 1 } }, 'window'],
    ['no cells', { cells: [] }, 'cells'],
    ['a res-5 cell in cells', { cells: ['8560145bfffffff'] }, 'cells.0'],
    ['an uppercase cell', { cells: ['8760145B4FFFFFF'] }, 'cells.0'],
    ['a phone without a plus', { reporter_phone: '15550000000' }, 'reporter_phone'],
    ['a phone with spaces', { reporter_phone: '+1 555 000 0000' }, 'reporter_phone'],
    ['no phone', { reporter_phone: undefined }, 'reporter_phone'],
    ['a plain-http endpoint', { respond: { endpoint: 'http://example.org/v1' } }, 'respond'],
    ['a malformed signature', { sig: 'ed25519:short' }, 'sig'],
    ['expiry before issue', { expires_at: 1789900000, issued_at: 1789900000 }, 'expires_at'],
    [
      'a lifetime longer than retention',
      { issued_at: 1789900000, expires_at: 1789900000 + REPORT_TTL_SEC + 1 },
      'lifetime',
    ],
  ])('rejects %s', (_label, changes, mentions) => {
    const result = invalidWith(changes);
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.issues.join('\n')).toContain(mentions);
    }
  });

  test.each<[string, Record<string, unknown>]>([
    ['an empty name', { name: '' }],
    ['a name over the cap', { name: 'x'.repeat(121) }],
    ['a description over the cap', { description: 'x'.repeat(1001) }],
    ['an unsupported image type', { photo: { mime: 'image/png', w: 1, h: 1, b64: 'AAAA' } }],
    ['an oversized image', { photo: { mime: 'image/webp', w: 257, h: 1, b64: 'AAAA' } }],
    ['base64url in the photo', { photo: { mime: 'image/webp', w: 1, h: 1, b64: 'AA-_' } }],
    ['unpadded base64', { photo: { mime: 'image/webp', w: 1, h: 1, b64: 'AAAAAA' } }],
  ])('rejects a person with %s', (_label, personChanges) => {
    const person = { ...(rawQuery().person as object), ...personChanges };
    expect(invalidWith({ person }).status).toBe('invalid');
  });

  test('the lifetime may be exactly the retention period', () => {
    const result = invalidWith({
      issued_at: 1789900000,
      expires_at: 1789900000 + REPORT_TTL_SEC,
    });
    expect(result.status).toBe('ok');
  });

  test('a window may be a single instant', () => {
    expect(invalidWith({ window: { from: 100, to: 100 } }).status).toBe('ok');
  });
});

describe('BroadcastQuerySchema', () => {
  test('parsing does not transform: the typed view equals the known members of the input', () => {
    const raw = rawQuery();
    expect(BroadcastQuerySchema.parse(raw)).toEqual(raw);
  });
});
