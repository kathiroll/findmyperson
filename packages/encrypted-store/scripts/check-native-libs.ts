/**
 * Fails the Android build if the app it produced holds more than one SQLite, or if the Kotlin
 * side is not linked to the one inside op-sqlite's library.
 *
 *   node packages/encrypted-store/scripts/check-native-libs.ts <apk, aab or directory>...
 *
 * Each argument is an APK or app bundle, or a directory searched for them. The native
 * libraries packaged in each are read (symbol tables and contents, nothing is executed) and
 * judged by checkNativeLibraries. It is run by build/build-android.sh after Gradle, so it sees
 * what really ships: every library of every dependency, which is where a second SQLite would
 * come from.
 *
 * Exits 0 only if at least one archive was found and all of them pass. Finding none is a
 * failure, so a changed output path cannot turn this into a check that checks nothing.
 * Plain `node` runs this file as it is (Node 24 strips the types).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  checkNativeLibraries,
  describeNativeLibrary,
  ENGINE_LIBRARY,
  JNI_LIBRARY,
  nativeLibraryPath,
  type NativeLibrary,
} from '../src/nativeLibsPolicy.ts';

const isArchive = (path: string) => /\.(apk|aab)$/.test(path);

function archivesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) {
    return [path];
  }
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? archivesUnder(child) : isArchive(child) ? [child] : [];
  });
}

/** The entries of a zip archive whose name passes `wanted`, uncompressed. No zip64, as in APKs. */
function readZip(archive: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const END_OF_DIRECTORY = 0x06054b50;
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== END_OF_DIRECTORY) {
    end -= 1;
  }
  if (end < 0) {
    throw new Error('not a zip archive');
  }
  const entries = new Map<string, Buffer>();
  let at = archive.readUInt32LE(end + 16);
  for (let index = 0; index < archive.readUInt16LE(end + 10); index += 1) {
    if (archive.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('damaged zip directory');
    }
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    if (wanted(name)) {
      const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
      const stored = archive.subarray(data, data + compressedSize);
      if (method !== 0 && method !== 8) {
        throw new Error(`${name}: unsupported zip compression method ${method}`);
      }
      entries.set(name, method === 0 ? stored : inflateRawSync(stored));
    }
    at += 46 + nameLength + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  }
  return entries;
}

function librariesOf(archive: string): NativeLibrary[] {
  const entries = readZip(readFileSync(archive), (name) => nativeLibraryPath(name) !== undefined);
  return [...entries].map(([path, bytes]) => {
    const { abi, name } = nativeLibraryPath(path) ?? { abi: '', name: path };
    try {
      return describeNativeLibrary(abi, name, bytes);
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
    }
  });
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error('usage: check-native-libs.ts <apk, aab or directory>...');
  process.exit(64);
}

let archives: string[];
try {
  archives = paths.flatMap(archivesUnder);
} catch (error) {
  console.error(`native library check: ${(error as Error).message}`);
  process.exit(1);
}
if (archives.length === 0) {
  console.error(
    `native library check: no .apk or .aab under ${paths.join(', ')}; nothing was checked`,
  );
  process.exit(1);
}

let failed = false;
for (const archive of archives) {
  let violations: string[];
  let summary = '';
  try {
    const libraries = librariesOf(archive);
    violations = checkNativeLibraries(libraries);
    const abis = [...new Set(libraries.map((library) => library.abi))].sort();
    summary = `${libraries.length} libraries, ${abis.join(' ')}`;
  } catch (error) {
    violations = [(error as Error).message];
  }
  for (const violation of violations) {
    console.error(`native library check: ${archive}: ${violation}`);
  }
  if (violations.length === 0) {
    console.log(
      `native library check: ${archive}: one SQLite, in ${ENGINE_LIBRARY}, and ${JNI_LIBRARY} is linked to it (${summary})`,
    );
  }
  failed ||= violations.length > 0;
}
if (failed) {
  console.error(
    'native library check: FAILED. The built app would run two copies of SQLite on one file, or the Kotlin store is not linked to op-sqlite\'s. See packages/encrypted-store/README.md, "One SQLite library in the Android process".',
  );
  process.exit(1);
}
