import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the real entry points the way a deploy does: `node build.mjs`, then plain `node` on the
 * output with no flags. In-process tests cannot catch what broke before (Node could not load the
 * extensionless sources), because Vitest resolves them itself.
 */
const serverDir = join(import.meta.dirname, '..');
const node = process.execPath;
let tmp = '';

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fmp-entry-'));
  execFileSync(node, ['build.mjs'], { cwd: serverDir, stdio: 'pipe' });
}, 60_000);

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('built entry points under plain node', () => {
  it('cli.js keygen prints a signing key', () => {
    const out = execFileSync(node, ['dist/cli.js', 'keygen', 'k1'], { cwd: serverDir });
    expect(JSON.parse(out.toString())).toMatchObject({ key_id: 'k1' });
  });

  it('cli.js with no command prints usage and exits 2', () => {
    let status: number | null = null;
    try {
      execFileSync(node, ['dist/cli.js'], { cwd: serverDir, stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });

  it('match-harness.js runs a scenario and prints its table', () => {
    const args = ['--scenario', 'rural', '--devices', '200', '--reports', '10'];
    const out = execFileSync(node, ['dist/match-harness.js', ...args], { cwd: serverDir });
    expect(out.toString()).toMatch(/shipped\s+\d+\.\d%/);
  });

  it('main.js starts, listens and answers HTTP', async () => {
    const child = spawn(node, ['dist/main.js'], {
      cwd: serverDir,
      env: { PATH: process.env['PATH'] ?? '', FMP_PORT: '0', FMP_DB_PATH: join(tmp, 'server.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let log = '';
        const onData = (chunk: Buffer): void => {
          log += chunk.toString();
          const m = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(log);
          if (m?.[1] !== undefined) resolve(m[1]);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', (code) =>
          reject(new Error(`exited ${String(code)} before listening:\n${log}`)),
        );
      });
      const res = await fetch(`${url}/v1/reports/does-not-exist`);
      expect(res.status).toBeLessThan(500);
      // No FMP_OPERATOR_WEB_TOKEN in this environment, so the operator page refuses.
      const operatorPage = await fetch(`${url}/operator`);
      expect(operatorPage.status).toBe(403);
      expect(operatorPage.headers.get('content-type')).toContain('text/html');
    } finally {
      child.kill('SIGTERM');
    }
  }, 30_000);
});
