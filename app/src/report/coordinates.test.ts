import { describe, expect, test } from 'vitest';
import {
  COORDINATES_FORMAT_ERROR,
  LATITUDE_RANGE_ERROR,
  LONGITUDE_RANGE_ERROR,
  formatPoint,
  parseCoordinates,
} from './coordinates';

const point = { lat: 28.6139, lon: 77.209 };

describe('parseCoordinates', () => {
  test.each([
    ['a normal paste', '28.6139, 77.2090'],
    ['no space after the comma', '28.6139,77.2090'],
    ['extra whitespace', '  28.6139 ,   77.2090  '],
    ['a space separator', '28.6139 77.2090'],
    ['degree signs', '28.6139°, 77.2090°'],
    ['degree signs with spaces', '28.6139 ° 77.2090 °'],
  ])('accepts %s', (_name, input) => {
    expect(parseCoordinates(input)).toEqual({ ok: true, point });
  });

  test('accepts negatives, signs and whole numbers', () => {
    expect(parseCoordinates('-33.8688, +151')).toEqual({
      ok: true,
      point: { lat: -33.8688, lon: 151 },
    });
    expect(parseCoordinates('-90, -180')).toEqual({ ok: true, point: { lat: -90, lon: -180 } });
  });

  test('refuses a latitude out of range, as when the pair is swapped', () => {
    expect(parseCoordinates('77.2090, 128.6139')).toEqual({
      ok: true,
      point: { lat: 77.209, lon: 128.6139 },
    });
    expect(parseCoordinates('120.5, 30')).toEqual({ ok: false, error: LATITUDE_RANGE_ERROR });
    expect(parseCoordinates('90.0001, 0')).toEqual({ ok: false, error: LATITUDE_RANGE_ERROR });
  });

  test('refuses a longitude out of range', () => {
    expect(parseCoordinates('28.6, 190')).toEqual({ ok: false, error: LONGITUDE_RANGE_ERROR });
    expect(parseCoordinates('0, -180.5')).toEqual({ ok: false, error: LONGITUDE_RANGE_ERROR });
  });

  test.each([
    ['empty', ''],
    ['blank', '   '],
    ['a single number', '28.6139'],
    ['garbage text', 'near the old bridge'],
    ['three numbers', '1, 2, 3'],
    ['numbers with trailing text', '28.6, 77.2 N'],
    ['a lone separator', ','],
    ['exponent notation', '1e2, 5'],
  ])('refuses %s', (_name, input) => {
    expect(parseCoordinates(input)).toEqual({ ok: false, error: COORDINATES_FORMAT_ERROR });
  });
});

test('formatPoint shows five decimals', () => {
  expect(formatPoint(point)).toBe('28.61390, 77.20900');
});
