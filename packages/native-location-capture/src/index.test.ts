import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import * as fakeEntry from './fake';
import * as rootEntry from './index';

const getEnforcing = vi.hoisted(() => vi.fn((name: string) => ({ registeredAs: name })));
vi.mock('react-native', () => ({ TurboModuleRegistry: { getEnforcing } }));

test('workspace member is wired into the test runner', () => {
  expect(rootEntry.packageName).toBe('@findmyperson/native-location-capture');
});

test('the runtime export surface is deliberate', () => {
  // Other tasks reference these names exactly. Adding one is fine: update the list. Types are
  // not listed (they do not exist at runtime); README.md names them.
  expect(Object.keys(rootEntry).sort()).toEqual([
    'CAPTURE_DEFAULTS',
    'CAPTURE_ERROR_CODES',
    'DIAGNOSTIC_EVENTS',
    'HEALTH_FLAGS',
    'HEALTH_FLAG_PLATFORMS',
    'NATIVE_MODULE_NAME',
    'captureErrorCode',
    'packageName',
  ]);
  expect(Object.keys(fakeEntry)).toEqual(['createFakeLocationCapture']);
});

test('the package entry points are the three files other tasks import', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  expect(pkg.exports).toEqual({
    '.': './src/index.ts',
    './fake': './src/fake.ts',
    './native': './src/native.ts',
    './package.json': './package.json',
  });
});

test('the root and the fake load without react-native or the native module', () => {
  // Both were imported at the top of this file. Had either reached the spec's runtime code,
  // the registry would have been asked for the module by now.
  expect(getEnforcing).not.toHaveBeenCalled();
});

test('the native entry asks the registry for the module by its registered name', async () => {
  const { NativeLocationCapture } = await import('./native');
  expect(getEnforcing).toHaveBeenCalledExactlyOnceWith(rootEntry.NATIVE_MODULE_NAME);
  expect(NativeLocationCapture).toEqual({ registeredAs: 'NativeLocationCapture' });
});

test('the defaults are the plan cadence and the WorkManager mode', () => {
  expect(rootEntry.CAPTURE_DEFAULTS).toEqual({
    minIntervalSec: 900,
    minDistanceM: 100,
    accuracy: 'balanced',
    useForegroundService: false,
  });
});

test('every health flag belongs to at least one platform', () => {
  expect(rootEntry.HEALTH_FLAGS).toHaveLength(10);
  for (const flag of rootEntry.HEALTH_FLAGS) {
    expect(rootEntry.HEALTH_FLAG_PLATFORMS[flag].length).toBeGreaterThan(0);
  }
});
