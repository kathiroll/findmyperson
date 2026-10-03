import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { NativeModuleSchema, SchemaType } from '@react-native/codegen/lib/CodegenSchema';
import type * as RNCodegen from '@react-native/codegen/lib/generators/RNCodegen';
import { expect, test } from 'vitest';
import { HEALTH_FLAGS, NATIVE_MODULE_NAME } from './constants';
import { createFakeLocationCapture } from './fake';

/**
 * Runs React Native's own codegen (the version the app builds with) over the spec, exactly as
 * `codegenConfig` in package.json tells a real build to, and checks what comes out.
 *
 * The three files under contracts/ are committed copies of that output. If one of these tests
 * fails after an edit to the spec, the interface both native modules implement has changed:
 * review the difference, then rewrite the files from the repo root with
 * `pnpm exec vitest run packages/native-location-capture -u`. CI never rewrites. The files are
 * written exactly as codegen emits them, which is why .prettierignore lists the directory.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const SCHEMA_FILE = '../contracts/schema.json';
const JAVA_FILE = '../contracts/android/NativeLocationCaptureSpec.java';
const OBJC_FILE = '../contracts/ios/NativeLocationCaptureSpec.h';

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

/** What a build for one platform reads out of `jsSrcsDir`. */
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
const methods = moduleSchema.spec.methods;
const emitters = moduleSchema.spec.eventEmitters;

// The same calls a build makes: the Gradle plugin passes javaPackageName, and assumeNonnull is
// set for iOS only (react-native/scripts/codegen/generate-specs-cli-executor.js).
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
  // The Android and iOS tasks reference these names. Changing one breaks their build.
  expect(codegenConfig).toEqual({
    name: 'NativeLocationCaptureSpec',
    type: 'modules',
    jsSrcsDir: 'src/specs',
    android: { javaPackageName: 'dev.findmyperson.locationcapture' },
    ios: { modulesProvider: { NativeLocationCapture: 'RCTNativeLocationCapture' } },
  });
  expect(Object.keys(codegenConfig.ios.modulesProvider)).toEqual([NATIVE_MODULE_NAME]);
});

test('codegen finds exactly this one module, and the same one on both platforms', () => {
  expect(Object.keys(schema.modules)).toEqual([NATIVE_MODULE_NAME]);
  expect(moduleSchema.moduleName).toBe(NATIVE_MODULE_NAME);
  expect(moduleSchema.type).toBe('NativeModule');
  expect(schemaFor('ios')).toEqual(schema);
});

test('contracts/schema.json is the committed copy of the parsed spec', async () => {
  // Carries what the Java and ObjC output cannot: the exact strings of every union (health
  // flags, tiers, modes, permission states), for native tests to load.
  await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(SCHEMA_FILE);
});

test('contracts/android holds the class the Kotlin module extends', async () => {
  await expect(javaSpec).toMatchFileSnapshot(JAVA_FILE);
});

test('contracts/ios holds the protocol the Swift/ObjC++ module adopts', async () => {
  await expect(objcHeader).toMatchFileSnapshot(OBJC_FILE);
});

test('every spec method is an abstract method of the Android class', () => {
  expect(javaSpec).toContain(`package ${codegenConfig.android.javaPackageName};`);
  expect(javaSpec).toContain(`public abstract class ${codegenConfig.name} `);
  expect(javaSpec).toContain(`public static final String NAME = "${NATIVE_MODULE_NAME}";`);

  const generated = [...javaSpec.matchAll(/public abstract void (\w+)\(([^)]*)\);/g)].map(
    ([, name, params = '']) => ({ name, arity: params.split(',').length }),
  );
  // Every method returns a promise, which Java takes as one trailing parameter.
  expect(generated).toEqual(
    methods.map((method) => ({
      name: method.name,
      arity: functionOf(method.typeAnnotation).params.length + 1,
    })),
  );
  expect(javaSpec).toContain('public abstract void start(ReadableMap config, Promise promise);');
  expect(javaSpec).toContain(
    'public abstract void requestPermission(String step, Promise promise);',
  );
});

test('every spec method is a method of the iOS protocol', () => {
  const protocol = objcHeader.slice(
    objcHeader.indexOf(`@protocol ${codegenConfig.name} `),
    objcHeader.indexOf('@end', objcHeader.indexOf(`@protocol ${codegenConfig.name} `)),
  );
  const generated = [...protocol.matchAll(/^- \(void\)(\w+):/gm)].map(([, name]) => name);
  expect(generated).toEqual(methods.map((method) => method.name));
  // Every one takes the promise as a resolve block and a reject block.
  expect(protocol.match(/:\(RCTPromiseResolveBlock\)resolve$/gm)).toHaveLength(methods.length);
  expect(protocol.match(/reject:\(RCTPromiseRejectBlock\)reject;$/gm)).toHaveLength(methods.length);
  expect(objcHeader).toContain(`- (void)start:(JS::${NATIVE_MODULE_NAME}::CaptureConfig &)config`);
});

test('both platforms get an emit method for each event', () => {
  expect(emitters.map((emitter) => emitter.name)).toEqual(['onSampleWritten', 'onStatusChanged']);
  for (const { name } of emitters) {
    const emit = `emit${name[0]?.toUpperCase()}${name.slice(1)}`;
    expect(javaSpec).toContain(`protected final void ${emit}(ReadableMap value)`);
    expect(objcHeader).toContain(`- (void)${emit}:(NSDictionary *)value;`);
  }
  expect(objcHeader).toContain(`@interface ${codegenConfig.name}Base : NSObject`);
});

test('the fake has every method and event of the spec, and nothing else', () => {
  const fake = createFakeLocationCapture();
  const specNames = [...methods, ...emitters].map((member) => member.name).sort();
  expect(
    Object.keys(fake)
      .filter((key) => key !== 'controls')
      .sort(),
  ).toEqual(specNames);
  for (const name of specNames) {
    expect(typeof (fake as unknown as Record<string, unknown>)[name]).toBe('function');
  }
});

test('nothing that crosses the bridge carries a coordinate', () => {
  const coordinate = /^(lat|lon|lng|long|latitude|longitude|coord\w*|location|position)$/i;

  // Rule 1 of the spec. Every object type the module declares is checked, whichever direction
  // it travels, so a coordinate cannot be added to a status, an event or a diagnostic entry.
  const fields = Object.entries(moduleSchema.aliasMap).flatMap(([alias, type]) =>
    type.properties.map((property) => `${alias}.${property.name}`),
  );
  expect(fields).toContain('SampleWrittenEvent.tsUtc');
  expect(fields.filter((field) => coordinate.test(field.split('.')[1] ?? ''))).toEqual([]);

  // Every object that crosses is one of those declared types, not an anonymous one.
  expect(JSON.stringify(moduleSchema.spec)).not.toContain('ObjectTypeAnnotation');
  expect(JSON.stringify(moduleSchema.spec)).not.toContain('GenericObjectTypeAnnotation');

  // The one way in: a debug build injecting a synthetic fix.
  const withCoordinates = methods
    .filter((method) =>
      functionOf(method.typeAnnotation).params.some((param) => coordinate.test(param.name)),
    )
    .map((method) => method.name);
  expect(withCoordinates).toEqual(['debugInjectSample']);
});

test('an event carries exactly the fields the spec comments promise', () => {
  const sampleWritten = moduleSchema.aliasMap.SampleWrittenEvent;
  expect(sampleWritten?.properties.map((property) => property.name)).toEqual([
    'tsUtc',
    'accuracyM',
    'source',
  ]);
  expect(JSON.stringify(emitters)).toContain('"name":"SampleWrittenEvent"');
  expect(JSON.stringify(emitters)).toContain('"name":"CaptureStatus"');
});

test('HEALTH_FLAGS lists the HealthFlag union, in its order', () => {
  const health = moduleSchema.aliasMap.CaptureStatus?.properties.find(
    (property) => property.name === 'health',
  );
  const union = JSON.parse(JSON.stringify(health?.typeAnnotation)) as {
    elementType: { types: Array<{ value: string }> };
  };
  expect(union.elementType.types.map((member) => member.value)).toEqual(HEALTH_FLAGS);
});

test('the Android mode is chosen by a field of the start config, at runtime', () => {
  const config = moduleSchema.aliasMap.CaptureConfig;
  const toggle = config?.properties.find((property) => property.name === 'useForegroundService');
  expect(toggle).toEqual({
    name: 'useForegroundService',
    optional: false,
    typeAnnotation: { type: 'BooleanTypeAnnotation' },
  });
  const start = methods.find((method) => method.name === 'start');
  expect(functionOf(start?.typeAnnotation).params).toEqual([
    {
      name: 'config',
      optional: false,
      typeAnnotation: { type: 'TypeAliasTypeAnnotation', name: 'CaptureConfig' },
    },
  ]);
});

/** A method's type, with nullability unwrapped. The spec has no nullable methods. */
function functionOf(annotation: unknown): { params: ReadonlyArray<{ name: string }> } {
  const type = annotation as { type?: string; params?: ReadonlyArray<{ name: string }> };
  expect(type.type).toBe('FunctionTypeAnnotation');
  return { params: type.params ?? [] };
}
