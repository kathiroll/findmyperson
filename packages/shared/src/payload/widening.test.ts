import { describe, expect, test } from 'vitest';
import fixture from '../../contracts/widening-vectors.json';
import { EDIT_CENTER_TOLERANCE_M } from '../constants';
import { haversineMeters } from '../geo/distance';
import { sampleQuery } from '../testing/fixtures';
import type { MatchCriteria } from './query';
import {
  classifyCriteriaEdit,
  isWideningEdit,
  minRadiusForCenterMove,
  type EditVerdict,
} from './widening';

const base: MatchCriteria = {
  center: { lat: 12.9716, lon: 77.5946 },
  radius_m: 100,
  window: { from: 1789880000, to: 1789881800 },
};

describe('golden vectors', () => {
  test('the fixture was worked out for the tolerance the code uses', () => {
    expect(fixture.edit_center_tolerance_m).toBe(EDIT_CENTER_TOLERANCE_M);
  });

  test.each(fixture.vectors)('$name', ({ previous, next, expect: expected }) => {
    expect(classifyCriteriaEdit(previous, next)).toEqual(expected as EditVerdict);
    expect(isWideningEdit(previous, next)).toBe(expected.kind !== 'narrowed');
  });
});

describe('classifyCriteriaEdit', () => {
  test('takes whole broadcast queries; descriptive fields play no part', () => {
    const query = sampleQuery();
    const renamed = { ...query, person: { ...query.person, name: 'Alexandra Rivera' } };
    expect(classifyCriteriaEdit(query, renamed)).toEqual({ kind: 'unchanged' });
  });

  test.each([
    ['radius', { ...base, radius_m: Number.NaN }],
    ['latitude', { ...base, center: { lat: Number.NaN, lon: 77.5946 } }],
    ['window start', { ...base, window: { from: Number.NaN, to: base.window.to } }],
    ['window end', { ...base, window: { from: base.window.from, to: Number.NaN } }],
  ])('a NaN %s is refused, never waved through', (_label, next) => {
    expect(isWideningEdit(base, next)).toBe(false);
    expect(isWideningEdit(next, base)).toBe(false);
  });

  test('no chain of permitted edits ever uncovers the original search area', () => {
    // The property the coverage rule exists for: a per-edit distance allowance would let the
    // centre walk away, one small step at a time. Here every accepted step must keep the
    // original disc inside the current one, up to the tolerance spent per edit.
    let state = 0x2026;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    let current = base;
    let accepted = 0;
    for (let i = 0; i < 2_000; i++) {
      const proposal: MatchCriteria = {
        center: {
          lat: current.center.lat + (random() - 0.5) * 0.0004,
          lon: current.center.lon + (random() - 0.5) * 0.0004,
        },
        radius_m: Math.max(0, current.radius_m + Math.round((random() - 0.3) * 30)),
        window: {
          from: current.window.from - Math.round((random() - 0.3) * 600),
          to: current.window.to + Math.round((random() - 0.3) * 600),
        },
      };
      if (!isWideningEdit(current, proposal)) {
        continue;
      }
      accepted++;
      current = proposal;
      const drift = haversineMeters(base.center, current.center);
      expect(drift + base.radius_m).toBeLessThanOrEqual(
        current.radius_m + accepted * EDIT_CENTER_TOLERANCE_M + 1e-6,
      );
      expect(current.window.from).toBeLessThanOrEqual(base.window.from);
      expect(current.window.to).toBeGreaterThanOrEqual(base.window.to);
      expect(current.radius_m).toBeGreaterThanOrEqual(base.radius_m);
    }
    // The walk must actually exercise both outcomes to mean anything.
    expect(accepted).toBeGreaterThan(50);
    expect(accepted).toBeLessThan(1_950);
  });
});

describe('minRadiusForCenterMove', () => {
  const targets = [
    { lat: 12.9716, lon: 77.5946 },
    { lat: 12.971605, lon: 77.5946 },
    { lat: 12.9717, lon: 77.5946 },
    { lat: 12.975, lon: 77.6 },
    { lat: 13.1, lon: 77.4 },
  ];

  test.each(targets)('gives the smallest radius that permits a move to %j', (newCenter) => {
    const radius = minRadiusForCenterMove(base, newCenter);
    expect(Number.isInteger(radius)).toBe(true);
    expect(radius).toBeGreaterThanOrEqual(base.radius_m);
    expect(isWideningEdit(base, { ...base, center: newCenter, radius_m: radius })).toBe(true);
    if (radius > base.radius_m) {
      expect(isWideningEdit(base, { ...base, center: newCenter, radius_m: radius - 1 })).toBe(
        false,
      );
    }
  });

  test('a move inside the tolerance needs no extra radius', () => {
    expect(minRadiusForCenterMove(base, { lat: 12.971605, lon: 77.5946 })).toBe(base.radius_m);
  });
});
