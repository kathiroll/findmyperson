import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CIPHER_PARAMS, NATIVE_WRITER_CONTRACT, SCHEMA_VERSION } from '@findmyperson/shared';
import { expect, test } from 'vitest';
import { nativeConstants, renderKotlin, renderSwift } from './nativeContract';

/**
 * The Kotlin and Swift constants are generated from the shared contracts, so the native halves
 * of the store cannot drift from what TypeScript opens and migrates. If one of the snapshot
 * tests fails, the shared contract (or location.ts) changed: review what the native code has
 * to do about it, then rewrite the files from the repo root with
 * `pnpm exec vitest run packages/encrypted-store -u`. CI never rewrites.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const { codegenConfig } = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  codegenConfig: { android: { javaPackageName: string } };
};
const KOTLIN_PACKAGE = codegenConfig.android.javaPackageName;
const KOTLIN_FILE = `../android/src/main/java/${KOTLIN_PACKAGE.replaceAll('.', '/')}/StoreContract.kt`;
const SWIFT_FILE = '../ios/StoreContract.swift';

test('android: StoreContract.kt is the committed copy of the shared contracts', async () => {
  await expect(renderKotlin(KOTLIN_PACKAGE)).toMatchFileSnapshot(KOTLIN_FILE);
});

test('ios: StoreContract.swift is the committed copy of the shared contracts', async () => {
  await expect(renderSwift()).toMatchFileSnapshot(SWIFT_FILE);
});

test('the native constants carry the schema version and every native statement', () => {
  const constants = new Map(nativeConstants());
  expect(constants.get('SCHEMA_VERSION')).toBe(SCHEMA_VERSION);
  expect(constants.get('STORE_FILE_NAME')).toBe(NATIVE_WRITER_CONTRACT.storeFileName);
  expect(constants.get('JOURNAL_MODE')).toBe(CIPHER_PARAMS.journalMode);
  const statements = Object.entries(NATIVE_WRITER_CONTRACT)
    .filter(([name]) => name.endsWith('Sql'))
    .map(([, sql]) => sql);
  expect(statements).toHaveLength(4);
  for (const sql of statements) {
    expect([...constants.values()]).toContain(sql);
  }
});

test('both languages get the same constants under the same names', () => {
  const kotlinNames = [...renderKotlin(KOTLIN_PACKAGE).matchAll(/^ {4}(?:const )?val (\w+)/gm)].map(
    ([, name]) => name?.replaceAll('_', '').toLowerCase(),
  );
  const swiftNames = [...renderSwift().matchAll(/^ {4}public static let (\w+)/gm)].map(([, name]) =>
    name?.toLowerCase(),
  );
  const shared = nativeConstants().map(([name]) => name.replaceAll('_', '').toLowerCase());
  expect(kotlinNames.slice(0, shared.length)).toEqual(shared);
  expect(swiftNames.slice(0, shared.length)).toEqual(shared);
  // The rest is where each platform keeps the key, which the other has no use for.
  expect(kotlinNames.slice(shared.length)).toEqual(['keyfilename', 'keystorealias']);
  expect(swiftNames.slice(shared.length)).toEqual(['keychainservice', 'keychainaccount']);
});

test('no generated string would be read as a template by Kotlin or Swift', () => {
  expect(renderKotlin(KOTLIN_PACKAGE)).not.toMatch(/[^\\]\$/);
  expect(renderSwift()).not.toContain('\\(');
});
