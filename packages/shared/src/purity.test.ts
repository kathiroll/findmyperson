import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

/**
 * This package runs on Node (server, tests) and on Hermes (the app). Hermes has no Node
 * built-ins, no Buffer, and on some versions no TextEncoder or atob. Test files and
 * src/testing/ may use Node freely; everything else may not, or the app breaks at import time
 * in a way no unit test here would otherwise notice.
 *
 * This test reads the package's own source files. It is the one test that touches the disk.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const shipped = sourceFiles(SRC).map((path) => ({
  name: relative(SRC, path),
  // Comments may mention Buffer or TextEncoder; only code is checked.
  code: readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''),
}));

test('there is shipped source to check', () => {
  expect(shipped.length).toBeGreaterThan(25);
  expect(shipped.map((file) => file.name)).toContain('index.ts');
});

test.each([
  ['a Node built-in module', /from\s+['"]node:|require\(/],
  ['the test-support directory', /from\s+['"][./]+\/testing\//],
  ['Buffer', /\bBuffer\b/],
  ['process', /\bprocess\./],
  ['TextEncoder or TextDecoder', /\bText(En|De)coder\b/],
  ['atob or btoa', /\b(atob|btoa)\(/],
  ['the global crypto object', /\bcrypto\./],
  ['a clock or random source', /\bDate\.now\(|\bnew Date\(|\bMath\.random\(/],
])('no shipped file uses %s', (_label, pattern) => {
  expect(shipped.filter((file) => pattern.test(file.code)).map((file) => file.name)).toEqual([]);
});
