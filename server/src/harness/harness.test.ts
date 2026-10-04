import { describe, expect, test } from 'vitest';
import { matchParamsAt } from '@findmyperson/shared';
import { render, runCli } from './cli';
import { DEFAULT_OPTIONS, runScenario, VARIANTS, type HarnessOptions } from './evaluate';
import {
  buildPopulation,
  HEALTHY_CAPTURE,
  isStill,
  SCENARIOS,
  SIM_END_SEC,
  SIM_START,
} from './mobility';

/**
 * THE OFFLINE MATCHING HARNESS, at a size small enough to run with the unit tests. The figures
 * the project quotes come from the full-size run (`pnpm --filter @findmyperson/server harness`)
 * and are recorded in server/README.md; the bands below are the same measurement on fewer phones
 * and reports, so they are noisier, and they exist to notice a change in the matcher or in the
 * model, not to be quoted.
 */
const SMALL: HarnessOptions = { ...DEFAULT_OPTIONS, devices: 1_000, reports: 100 };

const results = new Map(SCENARIOS.map((scenario) => [scenario.name, runScenario(scenario, SMALL)]));
const result = (scenario: string) => {
  const found = results.get(scenario);
  if (found === undefined) {
    throw new Error(`no scenario ${scenario}`);
  }
  return found;
};
const variant = (scenario: string, name: string) => {
  const found = result(scenario).variants.find((measured) => measured.name === name);
  if (found === undefined) {
    throw new Error(`no variant ${name}`);
  }
  return found;
};

describe('the synthetic population', () => {
  const population = buildPopulation(SCENARIOS[0] ?? raise(), 200, HEALTHY_CAPTURE, 7);

  test('every person is somewhere at every moment of the three days', () => {
    for (const person of population.people) {
      expect(person.segments[0]?.t0).toBe(0);
      expect(person.segments.at(-1)?.t1).toBe(SIM_END_SEC);
      person.segments.forEach((segment, index) => {
        expect(segment.t1).toBeGreaterThan(segment.t0);
        expect(segment.t0).toBe(person.segments[index - 1]?.t1 ?? 0);
      });
      // Home overnight, and out at some point.
      expect(isStill(person.segments[0] ?? raise())).toBe(true);
      expect(person.segments.some((segment) => !isStill(segment))).toBe(true);
    }
  });

  test('phones capture about the share of slots they are set to, and stays come out of it', () => {
    const slots = population.people.length * (SIM_END_SEC / 900);
    const fixes = population.phones.reduce((sum, phone) => sum + phone.samples.length, 0);
    expect(fixes / slots).toBeGreaterThan(0.75);
    expect(fixes / slots).toBeLessThan(0.85);
    for (const phone of population.phones) {
      expect(phone.stays.length).toBeGreaterThan(0);
      phone.samples.forEach((sample, index) => {
        expect(sample.ts_utc).toBeGreaterThan(phone.samples[index - 1]?.ts_utc ?? SIM_START - 1);
      });
    }
  });

  test('the same seed gives the same population, and another seed another', () => {
    const scenario = SCENARIOS[0] ?? raise();
    expect(buildPopulation(scenario, 200, HEALTHY_CAPTURE, 7)).toEqual(population);
    expect(buildPopulation(scenario, 200, HEALTHY_CAPTURE, 8)).not.toEqual(population);
    // Adding people does not change the people already there.
    const larger = buildPopulation(scenario, 300, HEALTHY_CAPTURE, 7);
    expect(larger.phones.slice(0, 200)).toEqual(population.phones);
  });
});

describe('a run', () => {
  test('is reproducible', () => {
    const scenario = SCENARIOS[2] ?? raise();
    const options = { ...SMALL, devices: 300, reports: 30 };
    expect(runScenario(scenario, options)).toEqual(runScenario(scenario, options));
  });

  test('the first variant is exactly what a device runs', () => {
    expect(VARIANTS[0]?.name).toBe('shipped');
    expect(VARIANTS[0]?.params(SIM_START)).toEqual(matchParamsAt(SIM_START));
  });

  test.each(SCENARIOS.map((scenario) => scenario.name))('%s: the counts add up', (name) => {
    const { variants, shippedByRadius, reports, devices } = result(name);
    expect(reports).toBe(SMALL.reports);
    for (const measured of variants) {
      const { counts } = measured;
      // The truth is the same whichever parameters are measured against it.
      expect(counts.crossers).toBe(variants[0]?.counts.crossers);
      expect(counts.crossers + counts.others).toBe(reports * (devices - 1));
      expect(counts.matchedCrossers).toBeLessThanOrEqual(counts.crossers);
      expect(counts.matchedCrossersStill).toBeLessThanOrEqual(counts.crossersStill);
      expect(counts.crossers).toBeGreaterThan(40);
    }
    const sum = (field: 'reports' | 'crossers' | 'matchedCrossers' | 'matchedOutside') =>
      shippedByRadius.reduce((total, measured) => total + measured.counts[field], 0);
    const shipped = variants[0]?.counts ?? raise();
    expect(sum('reports')).toBe(shipped.reports);
    expect(sum('crossers')).toBe(shipped.crossers);
    expect(sum('matchedCrossers')).toBe(shipped.matchedCrossers);
    expect(sum('matchedOutside')).toBe(shipped.matchedOutside);
  });

  test.each(SCENARIOS.map((scenario) => scenario.name))(
    '%s: a wider rule matches everybody a narrower one does',
    (name) => {
      // matchReport's monotonicity, seen across a whole population: reading the criteria on the
      // grid only adds matches, and so does doubling the allowance.
      const matched = (which: string) => {
        const { counts } = variant(name, which);
        return [counts.matchedCrossers, counts.matchedInArea, counts.matchedOutside];
      };
      const [half, written, shipped, double] = ['half', 'as-written', 'shipped', 'double'].map(
        matched,
      );
      for (const [narrow, wide] of [
        [written, shipped],
        [half, shipped],
        [shipped, double],
      ]) {
        narrow?.forEach((count, index) => {
          expect(count).toBeLessThanOrEqual(wide?.[index] ?? -1);
        });
      }
    },
  );

  // Recorded from this configuration. Recall within five points (a crosser or two either way
  // at this size), the other two within a tenth.
  test.each([
    [
      'dense-urban',
      { recall: 0.803, recallStill: 0.954, falsePositiveRate: 0.0868, notified: 4_388 },
    ],
    ['suburban', { recall: 0.868, recallStill: 0.96, falsePositiveRate: 0.0395, notified: 648 }],
    ['rural', { recall: 0.926, recallStill: 0.979, falsePositiveRate: 0.014, notified: 156 }],
  ])('%s: the shipped parameters measure what was recorded', (name, recorded) => {
    const shipped = variant(name, 'shipped');
    expect(Math.abs(shipped.recall - recorded.recall)).toBeLessThan(0.05);
    expect(Math.abs(shipped.recallStill - recorded.recallStill)).toBeLessThan(0.05);
    expect(shipped.falsePositiveRate / recorded.falsePositiveRate).toBeGreaterThan(0.9);
    expect(shipped.falsePositiveRate / recorded.falsePositiveRate).toBeLessThan(1.1);
    expect(shipped.notified / recorded.notified).toBeGreaterThan(0.9);
    expect(shipped.notified / recorded.notified).toBeLessThan(1.1);
  });
});

describe('the command line', () => {
  test('prints a table for one scenario', () => {
    const lines: string[] = [];
    const args = ['--scenario', 'rural', '--devices', '300', '--reports', '20'];
    expect(
      runCli(
        args,
        (line) => lines.push(line),
        () => undefined,
      ),
    ).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('rural: ');
    expect(text).not.toContain('suburban: ');
    for (const { name } of VARIANTS) {
      expect(text).toContain(name);
    }
    expect(render(result('rural')).join('\n')).toContain('1000 m');
  });

  test('prints JSON on request', () => {
    const lines: string[] = [];
    runCli(
      ['--json', '--scenario', 'rural', '--devices', '300', '--reports', '20'],
      (line) => lines.push(line),
      () => undefined,
    );
    expect(JSON.parse(lines.join('\n'))).toMatchObject([{ scenario: 'rural', devices: 300 }]);
  });

  test.each([[['--devices']], [['--devices', 'many']], [['--capture-rate', '2']], [['--what']]])(
    'refuses %j with the usage',
    (args) => {
      const errors: string[] = [];
      expect(
        runCli(
          args,
          () => undefined,
          (line) => errors.push(line),
        ),
      ).toBe(2);
      expect(errors.join()).toContain('usage:');
    },
  );
});

function raise(): never {
  throw new Error('missing fixture');
}
