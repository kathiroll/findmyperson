import { expect, test } from 'vitest';
import * as store from './index';
import * as testing from './testing';

test('workspace member is wired into the test runner', () => {
  expect(store.packageName).toBe('@findmyperson/encrypted-store');
});

test('the runtime export surface is deliberate', () => {
  // Other tasks reference these names exactly. Adding one is fine: update the list. Renaming or
  // removing one breaks every importer. Types are not listed; README.md names them.
  expect(Object.keys(store).sort()).toEqual([
    'NATIVE_MODULE_NAME',
    'STORE_BUSY_TIMEOUT_MS',
    'STORE_DIRECTORY_NAME',
    'STORE_ERROR_CODES',
    'STORE_FILE_SUFFIXES',
    'StoreError',
    'deleteAllData',
    'openStore',
    'packageName',
  ]);
  expect(Object.keys(testing).sort()).toEqual(['createTestVault', 'nodeSqlcipherDriver']);
});

test('the package root loads without react-native or op-sqlite', async () => {
  // `/native` is the only entry that needs the native code linked in; this file imported the
  // root above, in Node, and that worked.
  await expect(import('./native')).rejects.toThrow();
});
