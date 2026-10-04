import { pathToFileURL } from 'node:url';
import {
  ADOPTION_REFERENCE,
  DEFAULT_OPTIONS,
  runScenario,
  VARIANTS,
  type HarnessOptions,
  type Measured,
  type ScenarioResult,
} from './evaluate';
import { SCENARIOS } from './mobility';

/**
 * Command line for the offline matching harness (evaluate.ts): runs matchReport over a synthetic
 * population for each scenario and prints recall and false-positive figures.
 *
 *   pnpm --filter @findmyperson/server harness
 *   node dist/match-harness.js [--devices N] [--reports N] [--seed N]
 *                              [--capture-rate 0..1] [--outage-min N]
 *                              [--scenario NAME] [--json]
 *
 * The same options and seed always print the same numbers. The defaults take about a minute.
 */

const USAGE =
  'usage: match-harness.js [--devices N] [--reports N] [--seed N] [--capture-rate 0..1] ' +
  '[--outage-min N] [--scenario dense-urban|suburban|rural] [--json]';

interface CliOptions {
  harness: HarnessOptions;
  scenario: string | null;
  json: boolean;
}

function parse(args: readonly string[]): CliOptions | null {
  const options: CliOptions = {
    harness: { ...DEFAULT_OPTIONS, capture: { ...DEFAULT_OPTIONS.capture } },
    scenario: null,
    json: false,
  };
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (flag === '--json') {
      options.json = true;
      continue;
    }
    const value = args[++at];
    if (flag === '--scenario' && SCENARIOS.some((scenario) => scenario.name === value)) {
      options.scenario = value ?? null;
      continue;
    }
    const number = Number(value);
    if (value === undefined || !Number.isFinite(number) || number < 0) {
      return null;
    }
    if (flag === '--devices' && number >= 2) {
      options.harness.devices = Math.floor(number);
    } else if (flag === '--reports') {
      options.harness.reports = Math.floor(number);
    } else if (flag === '--seed') {
      options.harness.seed = Math.floor(number);
    } else if (flag === '--capture-rate' && number > 0 && number <= 1) {
      options.harness.capture.rate = number;
    } else if (flag === '--outage-min' && number > 0) {
      options.harness.capture.meanOutageMin = number;
    } else {
      return null;
    }
  }
  return options;
}

const percent = (share: number, digits = 1) => `${(share * 100).toFixed(digits)}%`;
const count = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(1));

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = rows.reduce<number[]>(
    (sofar, row) => row.map((cell, column) => Math.max(sofar[column] ?? 0, cell.length)),
    [],
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd(),
  );
}

const HEADER = [
  '',
  'recall',
  'still',
  'moving',
  'false-pos rate',
  'precision',
  'notified',
  'crossed',
  'in area',
  'outside',
  'by stay',
];

const row = (m: Measured): string[] => [
  m.name,
  percent(m.recall),
  percent(m.recallStill),
  percent(m.recallMoving),
  percent(m.falsePositiveRate, 2),
  percent(m.precision),
  count(m.notified),
  count(m.crossed),
  count(m.inArea),
  count(m.outside),
  percent(m.byStay, 0),
];

export function render(result: ScenarioResult): string[] {
  return [
    `${result.scenario}: ${result.describes}`,
    `  ${result.devices} phones in ${result.areaKm2} km2 (${percent(result.simulatedAdoption, 2)} ` +
      `of residents), ${result.reports} reports, capture ${percent(result.capture.rate, 0)} of ` +
      `slots with outages of ${result.capture.meanOutageMin} min`,
    `  per report at ${percent(ADOPTION_REFERENCE, 0)} of residents carrying the app: ` +
      `${count(result.crossersPerReport)} people crossed the missing person's path`,
    '',
    ...table([HEADER, ...result.variants.map(row)]).map((line) => `  ${line}`),
    '',
    '  shipped parameters, by the radius the reporter stated:',
    ...table([HEADER, ...result.shippedByRadius.map(row)]).map((line) => `  ${line}`),
    '',
  ];
}

/** Returns the process exit code. */
export function runCli(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const options = parse(args);
  if (options === null) {
    err(USAGE);
    return 2;
  }
  const results = SCENARIOS.filter(
    (scenario) => options.scenario === null || scenario.name === options.scenario,
  ).map((scenario) => runScenario(scenario, options.harness));
  if (options.json) {
    out(JSON.stringify(results, null, 2));
    return 0;
  }
  out('Offline matching harness: matchReport over synthetic populations (server/README.md).');
  out('"notified" and the three columns it is the sum of are phones per report.');
  out('');
  for (const variant of VARIANTS) {
    out(`  ${variant.name.padEnd(10)}  ${variant.describes}`);
  }
  out('');
  for (const result of results) {
    render(result).forEach(out);
  }
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(
    process.argv.slice(2),
    (line) => console.log(line),
    (line) => console.error(line),
  );
}
