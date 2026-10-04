/**
 * The one-SQLite rule for Android, as a check that can be run on the native libraries of any
 * built APK or app bundle.
 *
 * On Android the store file is used from two sides of one process: JavaScript through
 * op-sqlite, and Kotlin (the store and the capture module) through libfmp-store-jni.so. SQLite's
 * file locks belong to the process, so two copies of the library in one process do not exclude
 * each other. The rule: the app contains exactly one copy of SQLite, the SQLCipher inside
 * libop-sqlite.so, and the Kotlin side's library holds none, imports its SQLite from that
 * one, and can be loaded by the dynamic linker alone, with everything it needs packaged.
 *
 * It is enforced three times:
 *   - policy.test.ts checks the build files and sources of the repository on every pull
 *     request: no dependency that carries a SQLite, and a JNI library that compiles none;
 *   - scripts/check-native-libs.ts runs checkNativeLibraries on the libraries the Android build
 *     actually packaged, and fails the build;
 *   - SqlcipherConnection.kt asks the dynamic linker, on the phone, which library its SQLite
 *     calls are bound to, and refuses to open the store if it is not libop-sqlite.
 *
 * This file uses no Node API and only erasable TypeScript, so the build script can run it
 * with plain `node`.
 */

/** The library that holds the one SQLite of the app, and the one the Kotlin side loads. */
export const ENGINE_LIBRARY = 'libop-sqlite.so';
export const JNI_LIBRARY = 'libfmp-store-jni.so';

/** What the dynamic section and the dynamic symbol table of a shared library say. */
export type ElfDynamicInfo = {
  /** DT_NEEDED: the libraries the dynamic linker loads with this one, by file name. */
  needed: string[];
  /** Names this library exports. */
  defined: string[];
  /** Names this library needs another one to supply. */
  undefined: string[];
};

/** One `.so` of one ABI, as packaged. */
export type NativeLibrary = ElfDynamicInfo & {
  abi: string;
  name: string;
  /** Whether the file contains the header text every SQLite database starts with. */
  holdsSqlite: boolean;
};

/**
 * The libraries Android itself supplies to an app's native code (the NDK's stable list).
 * Anything else a library needs has to be packaged with the app.
 */
export const ANDROID_SYSTEM_LIBRARIES: readonly string[] = [
  'libEGL.so',
  'libGLESv1_CM.so',
  'libGLESv2.so',
  'libGLESv3.so',
  'libOpenMAXAL.so',
  'libOpenSLES.so',
  'libaaudio.so',
  'libamidi.so',
  'libandroid.so',
  'libbinder_ndk.so',
  'libc.so',
  'libcamera2ndk.so',
  'libdl.so',
  'libicu.so',
  'libjnigraphics.so',
  'liblog.so',
  'libm.so',
  'libmediandk.so',
  'libnativehelper.so',
  'libnativewindow.so',
  'libneuralnetworks.so',
  'libstdc++.so',
  'libsync.so',
  'libvulkan.so',
  'libz.so',
];

const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;
const DT_NEEDED = 1;
const SQLITE_HEADER = 'SQLite format 3';

/**
 * Reads the dynamic section and dynamic symbol table of a little-endian ELF shared library
 * (every Android ABI is little-endian), 32-bit or 64-bit. Throws on anything else.
 */
export function readElfDynamicInfo(bytes: Uint8Array): ElfDynamicInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 52 || view.getUint32(0, false) !== 0x7f454c46) {
    throw new Error('not an ELF file');
  }
  const wide = bytes[4] === 2;
  if ((bytes[4] !== 1 && !wide) || bytes[5] !== 1) {
    throw new Error('not a little-endian ELF32 or ELF64 file');
  }
  const word = (offset: number) => view.getUint32(offset, true);
  const address = (offset: number) =>
    wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);

  const sectionTable = address(wide ? 0x28 : 0x20);
  const sectionSize = view.getUint16(wide ? 0x3a : 0x2e, true);
  const sectionCount = view.getUint16(wide ? 0x3c : 0x30, true);
  const section = (index: number) => {
    const at = sectionTable + index * sectionSize;
    return {
      type: word(at + 4),
      offset: address(at + (wide ? 0x18 : 0x10)),
      size: address(at + (wide ? 0x20 : 0x14)),
      link: word(at + (wide ? 0x28 : 0x18)),
    };
  };
  const sections = Array.from({ length: sectionCount }, (_, index) => section(index));
  const text = (table: { offset: number; size: number }, at: number) => {
    let name = '';
    for (let i = table.offset + at; i < table.offset + table.size && bytes[i] !== 0; i += 1) {
      name += String.fromCharCode(bytes[i] ?? 0);
    }
    return name;
  };

  const info: ElfDynamicInfo = { needed: [], defined: [], undefined: [] };
  for (const current of sections) {
    const strings = sections[current.link];
    if (strings === undefined) {
      continue;
    }
    if (current.type === SHT_DYNAMIC) {
      const entry = wide ? 16 : 8;
      for (let at = current.offset; at + entry <= current.offset + current.size; at += entry) {
        if (address(at) === DT_NEEDED) {
          info.needed.push(text(strings, address(at + entry / 2)));
        }
      }
    }
    if (current.type === SHT_DYNSYM) {
      const entry = wide ? 24 : 16;
      // The first entry of a symbol table is the reserved null symbol.
      for (
        let at = current.offset + entry;
        at + entry <= current.offset + current.size;
        at += entry
      ) {
        const name = text(strings, word(at));
        const sectionIndex = view.getUint16(at + (wide ? 6 : 14), true);
        if (name !== '') {
          (sectionIndex === 0 ? info.undefined : info.defined).push(name);
        }
      }
    }
  }
  return info;
}

/** Whether the bytes contain the header text of a SQLite database file, as every SQLite does. */
export function containsSqliteHeader(bytes: Uint8Array): boolean {
  const first = SQLITE_HEADER.charCodeAt(0);
  for (
    let at = bytes.indexOf(first);
    at !== -1 && at + SQLITE_HEADER.length <= bytes.length;
    at = bytes.indexOf(first, at + 1)
  ) {
    let length = 1;
    while (
      length < SQLITE_HEADER.length &&
      bytes[at + length] === SQLITE_HEADER.charCodeAt(length)
    ) {
      length += 1;
    }
    if (length === SQLITE_HEADER.length) {
      return true;
    }
  }
  return false;
}

/** Reads one packaged `.so`. `path` is its path in the archive: `lib/<abi>/<name>`. */
export function describeNativeLibrary(abi: string, name: string, bytes: Uint8Array): NativeLibrary {
  return { abi, name, holdsSqlite: containsSqliteHeader(bytes), ...readElfDynamicInfo(bytes) };
}

/** `lib/arm64-v8a/libx.so` in an APK, `base/lib/arm64-v8a/libx.so` in an app bundle. */
export function nativeLibraryPath(path: string): { abi: string; name: string } | undefined {
  const match = /(?:^|\/)lib\/([^/]+)\/([^/]+\.so)$/.exec(path);
  return match === null ? undefined : { abi: match[1] ?? '', name: match[2] ?? '' };
}

const isSqliteSymbol = (name: string) => name.startsWith('sqlite3_');

/**
 * The violations of the one-SQLite rule among the native libraries of one archive, as
 * sentences; empty when it holds. Each ABI is judged by itself, since a phone loads one.
 */
export function checkNativeLibraries(libraries: readonly NativeLibrary[]): string[] {
  const violations: string[] = [];
  const abis = [...new Set(libraries.map((library) => library.abi))].sort();
  if (abis.length === 0) {
    return ['no native libraries found; nothing was checked'];
  }
  for (const abi of abis) {
    const ofAbi = libraries.filter((library) => library.abi === abi);
    const say = (violation: string) => violations.push(`${abi}: ${violation}`);
    const engine = ofAbi.find((library) => library.name === ENGINE_LIBRARY);
    const jni = ofAbi.find((library) => library.name === JNI_LIBRARY);

    // A copy of SQLite is recognised two ways: it exports the SQLite API, or it contains the
    // database header text, which also finds a copy linked in with its symbols hidden.
    for (const library of ofAbi) {
      if (library.name === ENGINE_LIBRARY) {
        continue;
      }
      const exported = library.defined.filter(isSqliteSymbol);
      if (exported.length > 0) {
        say(
          `${library.name} exports ${exported.length} sqlite3_* symbols: a second SQLite in the process`,
        );
      } else if (library.holdsSqlite) {
        say(`${library.name} contains a copy of SQLite: a second SQLite in the process`);
      }
    }

    if (engine === undefined) {
      say(`${ENGINE_LIBRARY} is missing`);
    } else {
      if (!engine.holdsSqlite || !engine.defined.includes('sqlite3_open_v2')) {
        say(`${ENGINE_LIBRARY} does not contain and export SQLite`);
      }
      if (!engine.defined.includes('sqlite3_key_v2')) {
        say(
          `${ENGINE_LIBRARY} does not export sqlite3_key_v2: op-sqlite was built without SQLCipher`,
        );
      }
    }

    if (jni === undefined) {
      say(`${JNI_LIBRARY} is missing`);
    } else {
      const imported = jni.undefined.filter(isSqliteSymbol);
      if (!jni.needed.includes(ENGINE_LIBRARY)) {
        say(
          `${JNI_LIBRARY} is not linked against ${ENGINE_LIBRARY} (needs ${jni.needed.join(', ')})`,
        );
      }
      if (!imported.includes('sqlite3_open_v2') || !imported.includes('sqlite3_key_v2')) {
        say(`${JNI_LIBRARY} does not import its SQLite from another library`);
      }
      const unsupplied = imported.filter(
        (name) => engine !== undefined && !engine.defined.includes(name),
      );
      if (unsupplied.length > 0) {
        say(
          `${ENGINE_LIBRARY} does not export ${unsupplied.join(', ')}, which ${JNI_LIBRARY} needs`,
        );
      }

      // The Kotlin side loads its library with no React Native running, so the dynamic linker
      // alone has to find everything it needs, and everything those need: in the app, or in
      // Android itself.
      const seen = new Set([jni.name]);
      const queue = [jni];
      for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
        for (const name of current.needed.filter((needed) => !seen.has(needed))) {
          seen.add(name);
          const packaged = ofAbi.find((library) => library.name === name);
          if (packaged !== undefined) {
            queue.push(packaged);
          } else if (!ANDROID_SYSTEM_LIBRARIES.includes(name)) {
            say(
              `${JNI_LIBRARY} cannot load: ${name}, needed by ${current.name}, is neither in the app nor part of Android`,
            );
          }
        }
      }
    }
  }
  return violations;
}
