import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeModuleSchema, SchemaType } from '@react-native/codegen/lib/CodegenSchema';
import type * as RNCodegen from '@react-native/codegen/lib/generators/RNCodegen';
import { expect, test } from 'vitest';
import { NATIVE_MODULE_NAME } from './index';
import { createTestVault } from './testing';

/**
 * Runs React Native's own codegen (the version the app builds with) over the spec, as
 * `codegenConfig` in package.json tells a real build to, and checks what comes out. Same
 * method as packages/native-location-capture/src/codegen.test.ts.
 *
 * The files under contracts/ are committed copies of that output: the class
 * android/src/reactnative/.../EncryptedStoreModule.kt extends and the protocol
 * ios/RCTNativeEncryptedStore.mm adopts. If a test here fails after an edit to the spec, both
 * native modules have to change: review the difference, then rewrite the files from the repo
 * root with `pnpm exec vitest run packages/encrypted-store -u`. CI never rewrites. The files
 * are written exactly as codegen emits them, which is why .prettierignore lists the directory.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const SCHEMA_FILE = '../contracts/schema.json';
const JAVA_FILE = '../contracts/android/NativeEncryptedStoreSpec.java';
const OBJC_FILE = '../contracts/ios/NativeEncryptedStoreSpec.h';

interface CodegenConfig {
  name: string;
  type: string;
  jsSrcsDir: string;
  android: { javaPackageName: string };
  ios: { modulesProvider: Record<string, string> };
}

const { codegenConfig } = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
  codegenConfig: CodegenConfig;
};

// The codegen package is CommonJS and types only part of itself.
const load = createRequire(import.meta.url);
const { allGenerators } = load(
  '@react-native/codegen/lib/generators/RNCodegen',
) as typeof RNCodegen;
const { combineSchemasInFileList } = load(
  '@react-native/codegen/lib/cli/combine/combine-js-to-schema',
) as {
  combineSchemasInFileList(
    fileList: string[],
    platform: string | null,
    exclude: RegExp | null,
    libraryName: string,
  ): SchemaType;
};

function schemaFor(platform: 'android' | 'ios'): SchemaType {
  return combineSchemasInFileList(
    [join(PACKAGE_ROOT, codegenConfig.jsSrcsDir)],
    platform,
    null,
    codegenConfig.name,
  );
}

function only(files: Map<string, string>, suffix: string): string {
  const matches = [...files].filter(([name]) => name.endsWith(suffix));
  expect(matches.map(([name]) => name)).toHaveLength(1);
  return matches[0]?.[1] ?? '';
}

const schema = schemaFor('android');
const moduleSchema = schema.modules[NATIVE_MODULE_NAME] as NativeModuleSchema;
const methods = moduleSchema.spec.methods.map((method) => method.name);

const javaSpec = only(
  allGenerators.generateModuleJavaSpec(
    codegenConfig.name,
    schema,
    codegenConfig.android.javaPackageName,
    false,
  ),
  `${codegenConfig.name}.java`,
);
const objcHeader = only(
  allGenerators.generateModuleObjCpp(codegenConfig.name, schemaFor('ios'), undefined, true),
  `${codegenConfig.name}.h`,
);

test('codegenConfig names what the two native modules implement', () => {
  expect(codegenConfig).toEqual({
    name: 'NativeEncryptedStoreSpec',
    type: 'modules',
    jsSrcsDir: 'src/specs',
    android: { javaPackageName: 'dev.findmyperson.encryptedstore' },
    ios: { modulesProvider: { NativeEncryptedStore: 'RCTNativeEncryptedStore' } },
  });
  expect(Object.keys(codegenConfig.ios.modulesProvider)).toEqual([NATIVE_MODULE_NAME]);
});

test('codegen finds exactly this one module, and the same one on both platforms', () => {
  expect(Object.keys(schema.modules)).toEqual([NATIVE_MODULE_NAME]);
  expect(moduleSchema.type).toBe('NativeModule');
  expect(schemaFor('ios')).toEqual(schema);
});

test('the module is the three native methods of the store and nothing else', () => {
  expect(methods).toEqual(['getOrCreateStoreKeyHex', 'getStoreDirectory', 'deleteAllData']);
  // Nothing takes an argument: JavaScript never names a path or supplies a key.
  for (const method of moduleSchema.spec.methods) {
    expect((method.typeAnnotation as unknown as { params: unknown[] }).params).toEqual([]);
  }
  expect(moduleSchema.spec.eventEmitters).toEqual([]);
});

test('the test vault has exactly the methods of the spec', () => {
  const vault = createTestVault('/nowhere');
  expect(
    Object.keys(vault)
      .filter((key) => key !== 'directory' && key !== 'currentKeyHex')
      .sort(),
  ).toEqual([...methods].sort());
});

test('contracts/schema.json is the committed copy of the parsed spec', async () => {
  await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(SCHEMA_FILE);
});

test('contracts/android holds the class the Kotlin module extends', async () => {
  await expect(javaSpec).toMatchFileSnapshot(JAVA_FILE);
  expect(javaSpec).toContain(`package ${codegenConfig.android.javaPackageName};`);
  expect(javaSpec).toContain(`public static final String NAME = "${NATIVE_MODULE_NAME}";`);
  for (const method of methods) {
    expect(javaSpec).toContain(`public abstract void ${method}(Promise promise);`);
  }
});

test('contracts/ios holds the protocol the ObjC++ module adopts', async () => {
  await expect(objcHeader).toMatchFileSnapshot(OBJC_FILE);
  for (const method of methods) {
    expect(objcHeader).toContain(`- (void)${method}:(RCTPromiseResolveBlock)resolve`);
  }
});
