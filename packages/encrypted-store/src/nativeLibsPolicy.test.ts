import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import {
  checkNativeLibraries,
  containsSqliteHeader,
  describeNativeLibrary,
  ENGINE_LIBRARY,
  JNI_LIBRARY,
  nativeLibraryPath,
  readElfDynamicInfo,
  type NativeLibrary,
} from './nativeLibsPolicy';

/**
 * The one-SQLite rule on built native libraries. The libraries here are made by hand, small
 * ELF files with only the tables the check reads, so the tests run anywhere with no NDK. The
 * same reader was run on the real libraries of a built APK; the README says where.
 */

type Shape = {
  wide: boolean;
  needed?: string[];
  defined?: string[];
  undefined?: string[];
  /** Bytes placed in the file as a library's code and constants would be. */
  payload?: string;
};

/** A shared library with a dynamic string table, a dynamic symbol table and a dynamic section. */
function elf({ wide, needed = [], defined = [], undefined: imported = [], payload = '' }: Shape) {
  const names = [...needed, ...defined, ...imported];
  const offsets = new Map<string, number>();
  let strings = '\0';
  for (const name of names) {
    offsets.set(name, strings.length);
    strings += `${name}\0`;
  }
  const header = wide ? 64 : 52;
  const symbolSize = wide ? 24 : 16;
  const dynamicSize = wide ? 16 : 8;
  const sectionSize = wide ? 64 : 40;
  const symbols = [...defined.map((name) => [name, 1]), ...imported.map((name) => [name, 0])] as [
    string,
    number,
  ][];

  const stringsAt = header;
  const symbolsAt = stringsAt + strings.length;
  const dynamicAt = symbolsAt + (symbols.length + 1) * symbolSize;
  const payloadAt = dynamicAt + (needed.length + 1) * dynamicSize;
  const sectionsAt = payloadAt + payload.length;
  const bytes = Buffer.alloc(sectionsAt + 4 * sectionSize);
  const address = (at: number, value: number) =>
    wide ? bytes.writeBigUInt64LE(BigInt(value), at) : bytes.writeUInt32LE(value, at);

  bytes.write('\x7fELF', 0, 'latin1');
  bytes[4] = wide ? 2 : 1;
  bytes[5] = 1;
  address(wide ? 0x28 : 0x20, sectionsAt);
  bytes.writeUInt16LE(sectionSize, wide ? 0x3a : 0x2e);
  bytes.writeUInt16LE(4, wide ? 0x3c : 0x30);

  bytes.write(strings, stringsAt, 'latin1');
  symbols.forEach(([name, section], index) => {
    const at = symbolsAt + (index + 1) * symbolSize;
    bytes.writeUInt32LE(offsets.get(name) ?? 0, at);
    bytes.writeUInt16LE(section, at + (wide ? 6 : 14));
  });
  needed.forEach((name, index) => {
    const at = dynamicAt + index * dynamicSize;
    address(at, 1);
    address(at + dynamicSize / 2, offsets.get(name) ?? 0);
  });
  bytes.write(payload, payloadAt, 'latin1');

  const section = (index: number, type: number, offset: number, size: number, link: number) => {
    const at = sectionsAt + index * sectionSize;
    bytes.writeUInt32LE(type, at + 4);
    address(at + (wide ? 0x18 : 0x10), offset);
    address(at + (wide ? 0x20 : 0x14), size);
    bytes.writeUInt32LE(link, at + (wide ? 0x28 : 0x18));
  };
  section(1, 3, stringsAt, strings.length, 0);
  section(2, 11, symbolsAt, (symbols.length + 1) * symbolSize, 1);
  section(3, 6, dynamicAt, (needed.length + 1) * dynamicSize, 1);
  return bytes;
}

const SQLITE_API = ['sqlite3_open_v2', 'sqlite3_prepare_v2', 'sqlite3_step', 'sqlite3_key_v2'];
const SQLITE_TEXT = 'xxSQLite format 3\0xx';

const engine = (wide: boolean) =>
  elf({ wide, needed: ['libcrypto.so'], defined: SQLITE_API, payload: SQLITE_TEXT });
const jni = (wide: boolean) =>
  elf({
    wide,
    needed: [ENGINE_LIBRARY, 'libc.so'],
    defined: ['Java_dev_findmyperson_encryptedstore_SqlcipherNative_open'],
    undefined: ['sqlite3_open_v2', 'sqlite3_key_v2', 'sqlite3_step', 'malloc'],
  });
const other = (wide: boolean) =>
  elf({ wide, needed: ['libc.so'], defined: ['JNI_OnLoad'], undefined: ['malloc'] });

/** The libraries of a healthy app, for the two ABIs phones run. */
function healthy(): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const [abi, wide] of [
    ['arm64-v8a', true],
    ['armeabi-v7a', false],
  ] as const) {
    files[`lib/${abi}/${ENGINE_LIBRARY}`] = engine(wide);
    files[`lib/${abi}/${JNI_LIBRARY}`] = jni(wide);
    files[`lib/${abi}/libreactnative.so`] = other(wide);
    files[`lib/${abi}/libcrypto.so`] = other(wide);
  }
  return files;
}

const describeAll = (files: Record<string, Buffer>): NativeLibrary[] =>
  Object.entries(files).map(([path, bytes]) => {
    const { abi, name } = nativeLibraryPath(path) ?? { abi: '', name: '' };
    return describeNativeLibrary(abi, name, bytes);
  });

describe('reading a shared library', () => {
  test.each([
    ['64-bit', true],
    ['32-bit', false],
  ])('finds what a %s library needs, exports and imports', (_label, wide) => {
    expect(readElfDynamicInfo(jni(wide))).toEqual({
      needed: [ENGINE_LIBRARY, 'libc.so'],
      defined: ['Java_dev_findmyperson_encryptedstore_SqlcipherNative_open'],
      undefined: ['sqlite3_open_v2', 'sqlite3_key_v2', 'sqlite3_step', 'malloc'],
    });
    expect(readElfDynamicInfo(engine(wide)).defined).toEqual(SQLITE_API);
  });

  test('refuses what is not a little-endian ELF library', () => {
    expect(() => readElfDynamicInfo(Buffer.from('not a library at all, only some text'))).toThrow(
      'not an ELF file',
    );
    expect(() => readElfDynamicInfo(Buffer.alloc(8))).toThrow('not an ELF file');
    const bigEndian = jni(true);
    bigEndian[5] = 2;
    expect(() => readElfDynamicInfo(bigEndian)).toThrow('little-endian');
  });

  test('finds the SQLite database header wherever it is in the file', () => {
    expect(containsSqliteHeader(engine(true))).toBe(true);
    expect(containsSqliteHeader(jni(true))).toBe(false);
    expect(containsSqliteHeader(Buffer.from('SQLite format 3'))).toBe(true);
    expect(containsSqliteHeader(Buffer.from('SSQLite format 3'))).toBe(true);
    expect(containsSqliteHeader(Buffer.from('SQLite format 2, SQLite forma'))).toBe(false);
    expect(containsSqliteHeader(Buffer.alloc(0))).toBe(false);
  });

  test('recognises native library paths in an APK and in an app bundle', () => {
    expect(nativeLibraryPath('lib/arm64-v8a/libop-sqlite.so')).toEqual({
      abi: 'arm64-v8a',
      name: 'libop-sqlite.so',
    });
    expect(nativeLibraryPath('base/lib/armeabi-v7a/libfmp-store-jni.so')).toEqual({
      abi: 'armeabi-v7a',
      name: 'libfmp-store-jni.so',
    });
    expect(nativeLibraryPath('classes.dex')).toBeUndefined();
    expect(nativeLibraryPath('assets/lib/notes.so.txt')).toBeUndefined();
    expect(nativeLibraryPath('lib/arm64-v8a/nested/libx.so')).toBeUndefined();
  });
});

describe('the one-SQLite rule', () => {
  test('passes an app whose only SQLite is op-sqlite and whose Kotlin side is linked to it', () => {
    expect(checkNativeLibraries(describeAll(healthy()))).toEqual([]);
  });

  test('a second library that exports SQLite is a violation: the old sqlcipher-android', () => {
    const files = healthy();
    files['lib/arm64-v8a/libsqlcipher.so'] = elf({
      wide: true,
      defined: SQLITE_API,
      payload: SQLITE_TEXT,
    });
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      'arm64-v8a: libsqlcipher.so exports 4 sqlite3_* symbols: a second SQLite in the process',
    ]);
  });

  test('a second SQLite with its symbols hidden is found by its contents', () => {
    const files = healthy();
    files['lib/armeabi-v7a/libvendor.so'] = elf({
      wide: false,
      defined: ['vendor_init'],
      payload: SQLITE_TEXT,
    });
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      'armeabi-v7a: libvendor.so contains a copy of SQLite: a second SQLite in the process',
    ]);
  });

  test('the Kotlin library must hold no SQLite and must be linked to op-sqlite', () => {
    const files = healthy();
    // SQLite compiled into the JNI library instead of imported.
    files[`lib/arm64-v8a/${JNI_LIBRARY}`] = elf({
      wide: true,
      needed: ['libc.so'],
      defined: SQLITE_API,
      payload: SQLITE_TEXT,
    });
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      `arm64-v8a: ${JNI_LIBRARY} exports 4 sqlite3_* symbols: a second SQLite in the process`,
      `arm64-v8a: ${JNI_LIBRARY} is not linked against ${ENGINE_LIBRARY} (needs libc.so)`,
      `arm64-v8a: ${JNI_LIBRARY} does not import its SQLite from another library`,
    ]);
  });

  test('op-sqlite built without SQLCipher is a violation', () => {
    const files = healthy();
    files[`lib/arm64-v8a/${ENGINE_LIBRARY}`] = elf({
      wide: true,
      defined: SQLITE_API.filter((name) => name !== 'sqlite3_key_v2'),
      payload: SQLITE_TEXT,
    });
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      `arm64-v8a: ${ENGINE_LIBRARY} does not export sqlite3_key_v2: op-sqlite was built without SQLCipher`,
      `arm64-v8a: ${ENGINE_LIBRARY} does not export sqlite3_key_v2, which ${JNI_LIBRARY} needs`,
    ]);
  });

  test('a missing library is a violation, in the ABI that lacks it', () => {
    const files = healthy();
    delete files[`lib/armeabi-v7a/${JNI_LIBRARY}`];
    delete files[`lib/arm64-v8a/${ENGINE_LIBRARY}`];
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      `arm64-v8a: ${ENGINE_LIBRARY} is missing`,
      `arm64-v8a: ${JNI_LIBRARY} cannot load: ${ENGINE_LIBRARY}, needed by ${JNI_LIBRARY}, is neither in the app nor part of Android`,
      `armeabi-v7a: ${JNI_LIBRARY} is missing`,
    ]);
  });

  test('everything the Kotlin library needs to load must be in the app or in Android', () => {
    // libop-sqlite.so needs libcrypto.so, which needs only what Android supplies.
    const files = healthy();
    files['lib/arm64-v8a/libcrypto.so'] = elf({ wide: true, needed: ['libvendor_private.so'] });
    delete files['lib/armeabi-v7a/libcrypto.so'];
    expect(checkNativeLibraries(describeAll(files))).toEqual([
      `arm64-v8a: ${JNI_LIBRARY} cannot load: libvendor_private.so, needed by libcrypto.so, is neither in the app nor part of Android`,
      `armeabi-v7a: ${JNI_LIBRARY} cannot load: libcrypto.so, needed by ${ENGINE_LIBRARY}, is neither in the app nor part of Android`,
    ]);
  });

  test('no libraries at all is a violation, not a pass', () => {
    expect(checkNativeLibraries([])).toEqual(['no native libraries found; nothing was checked']);
  });
});

describe('android: the build-time check on the packaged libraries', () => {
  const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-native-libs.ts');

  /** A zip archive, every other entry deflated, as an APK mixes stored and deflated entries. */
  function zip(files: Record<string, Buffer>): Buffer {
    const locals: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    Object.entries(files).forEach(([name, content], index) => {
      const deflate = index % 2 === 1;
      const data = deflate ? deflateRawSync(content) : content;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(deflate ? 8 : 0, 8);
      local.writeUInt32LE(crc32(content), 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(content.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(deflate ? 8 : 0, 10);
      central.writeUInt32LE(crc32(content), 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(content.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      locals.push(local, Buffer.from(name), data);
      directory.push(central, Buffer.from(name));
      offset += 30 + name.length + data.length;
    });
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(Buffer.concat(directory).length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...directory, end]);
  }

  function run(archives: Record<string, Buffer>, argument = '.') {
    const outputs = mkdtempSync(join(tmpdir(), 'fmp-libs-'));
    for (const [path, content] of Object.entries(archives)) {
      mkdirSync(dirname(join(outputs, path)), { recursive: true });
      writeFileSync(join(outputs, path), content);
    }
    const result = spawnSync(process.execPath, [SCRIPT, join(outputs, argument)], {
      encoding: 'utf8',
    });
    rmSync(outputs, { recursive: true, force: true });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  const apk = (files: Record<string, Buffer>) =>
    zip({ 'AndroidManifest.xml': Buffer.from('<manifest />'), ...files });

  test('passes an APK with one SQLite, found under the outputs directory', () => {
    const result = run({ 'apk/debug/app-debug.apk': apk(healthy()) });
    expect(result.output).toContain(
      `one SQLite, in ${ENGINE_LIBRARY}, and ${JNI_LIBRARY} is linked to it (8 libraries, arm64-v8a armeabi-v7a)`,
    );
    expect(result.status).toBe(0);
  });

  test('passes an app bundle, whose libraries are under base/', () => {
    const bundle = Object.fromEntries(
      Object.entries(healthy()).map(([path, bytes]) => [`base/${path}`, bytes]),
    );
    expect(run({ 'app-release.aab': zip(bundle) }, 'app-release.aab').status).toBe(0);
  });

  test('fails the build when a dependency brought a second SQLite', () => {
    const files = healthy();
    files['lib/arm64-v8a/libsqlcipher.so'] = engine(true);
    const result = run({ 'apk/release/app-release.apk': apk(files) });
    expect(result.output).toContain('libsqlcipher.so exports 4 sqlite3_* symbols');
    expect(result.output).toContain('FAILED');
    expect(result.status).toBe(1);
  });

  test('fails when one of several archives is wrong', () => {
    const files = healthy();
    delete files[`lib/arm64-v8a/${JNI_LIBRARY}`];
    const result = run({ 'apk/debug/app-debug.apk': apk(healthy()), 'bundle/app.aab': apk(files) });
    expect(result.output).toContain(`${JNI_LIBRARY} is missing`);
    expect(result.status).toBe(1);
  });

  test('fails when there is nothing to check, rather than passing on nothing', () => {
    const none = run({ 'apk/debug/output-metadata.json': Buffer.from('{}') });
    expect(none.output).toContain('nothing was checked');
    expect(none.status).toBe(1);

    const noLibraries = run({ 'app.apk': apk({}) });
    expect(noLibraries.output).toContain('no native libraries found');
    expect(noLibraries.status).toBe(1);

    expect(run({}, 'absent').status).toBe(1);
    expect(
      run({ 'app.apk': Buffer.from('not a zip archive, whatever its name says') }).status,
    ).toBe(1);
  });
});
