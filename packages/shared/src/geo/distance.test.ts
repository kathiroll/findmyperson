import { greatCircleDistance } from 'h3-js';
import { describe, expect, test } from 'vitest';
import vectors from '../../contracts/geo-vectors.json';
import { EARTH_RADIUS_M, haversineMeters, isValidLatLon } from './distance';

describe('haversineMeters', () => {
  test('the fixture pins the radius native code must use', () => {
    expect(vectors.earth_radius_m).toBe(EARTH_RADIUS_M);
  });

  test.each(vectors.distances)('golden vector: $name', ({ from, to, meters }) => {
    expect(Math.abs(haversineMeters(from, to) - meters)).toBeLessThanOrEqual(
      vectors.distance_tolerance_m,
    );
  });

  test('matches values derived analytically, independent of the fixture', () => {
    const quarterCircle = (Math.PI / 2) * EARTH_RADIUS_M;
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(
      quarterCircle / 90,
      6,
    );
    expect(haversineMeters({ lat: 90, lon: 0 }, { lat: 0, lon: 123 })).toBeCloseTo(
      quarterCircle,
      6,
    );
    // A degree of longitude shrinks by cos(latitude): exactly half at 60 degrees, for a chord
    // short enough that the arc and the parallel agree to well under a metre.
    const atEquator = haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 });
    const at60 = haversineMeters({ lat: 60, lon: 0 }, { lat: 60, lon: 0.001 });
    expect(at60 / atEquator).toBeCloseTo(0.5, 9);
  });

  test("agrees with h3's independent haversine once the radius is factored out", () => {
    for (const { from, to } of vectors.distances) {
      const reference =
        greatCircleDistance([from.lat, from.lon], [to.lat, to.lon], 'rads') * EARTH_RADIUS_M;
      expect(Math.abs(haversineMeters(from, to) - reference)).toBeLessThan(1e-6);
    }
  });

  test('is zero for identical points and symmetric', () => {
    const a = { lat: 12.9716, lon: 77.5946 };
    const b = { lat: 19.076, lon: 72.8777 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBe(haversineMeters(b, a));
  });

  test('takes the short way across the antimeridian', () => {
    const d = haversineMeters({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 });
    expect(d).toBeCloseTo((Math.PI / 180) * EARTH_RADIUS_M, 6);
  });

  test('stays finite for antipodal points, where rounding could exceed the asin domain', () => {
    const half = Math.PI * EARTH_RADIUS_M;
    expect(haversineMeters({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(half, 3);
    expect(haversineMeters({ lat: 90, lon: 0 }, { lat: -90, lon: 0 })).toBeCloseTo(half, 3);
    expect(haversineMeters({ lat: 37.5, lon: -122.3 }, { lat: -37.5, lon: 57.7 })).toBeCloseTo(
      half,
      0,
    );
  });
});

describe('isValidLatLon', () => {
  test.each([
    [{ lat: 0, lon: 0 }, true],
    [{ lat: 90, lon: 180 }, true],
    [{ lat: -90, lon: -180 }, true],
    [{ lat: 90.0001, lon: 0 }, false],
    [{ lat: 0, lon: -180.0001 }, false],
    [{ lat: Number.NaN, lon: 0 }, false],
    [{ lat: 0, lon: Number.POSITIVE_INFINITY }, false],
  ])('%j -> %s', (point, expected) => {
    expect(isValidLatLon(point)).toBe(expected);
  });
});
