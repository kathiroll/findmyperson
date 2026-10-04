import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ENGINE_LIBRARY, JNI_LIBRARY } from './nativeLibsPolicy';
import {
  checkBackupRules,
  checkContributingManifest,
  checkFinalManifest,
  CLOUD_AND_TRANSFER_DOMAINS,
  elementAttributes,
  FULL_BACKUP_DOMAINS,
  isMergedManifestPath,
} from './backupPolicy';

/**
 * THE CI GATE for plan 4.4 and 4.5. These tests read the repository's own manifests, build
 * files and native sources and fail the build when:
 *
 *   - any Android manifest lets backup back in (android:allowBackup anything but "false");
 *   - the Android store stops living in the no-backup directory, or its Keystore key starts
 *     requiring an unlocked device or user authentication;
 *   - the iOS store moves to a directory that is backed up, stops excluding its directory, or
 *     its Keychain item gets any accessibility class but AfterFirstUnlockThisDeviceOnly;
 *   - anything in the Android build could put a second copy of SQLite in the process, or the
 *     Kotlin side stops being linked to the SQLCipher op-sqlite compiles.
 *
 * They run on every pull request, on Linux, with no device. They check what the code says;
 * what the built app and a phone do is checked by scripts/check-merged-manifest.ts and
 * scripts/check-native-libs.ts during the Android build and by the fail-closed checks in
 * StorePaths.kt, SqlcipherConnection.kt and StoreLocation.swift.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');
const read = (...path: string[]) => readFileSync(join(...path), 'utf8');
const json = (...path: string[]) => JSON.parse(read(...path)) as Record<string, unknown>;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'build', '.gradle', 'Pods', '.git']);

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesUnder(path);
    }
    return [path];
  });
}

/** Source with comments removed, so a comment may name what the code must not do. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

const manifest = (application: string) =>
  `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application ${application}><activity android:name=".Main" /></application></manifest>`;
const GOOD =
  'android:allowBackup="false" android:dataExtractionRules="@xml/fmp_store_data_extraction_rules" android:fullBackupContent="@xml/fmp_store_backup_rules"';

describe('the backup rule itself', () => {
  test('accepts a manifest that forbids backup and device transfer', () => {
    expect(checkFinalManifest(manifest(GOOD))).toEqual([]);
    expect(checkContributingManifest(manifest(GOOD))).toEqual([]);
  });

  test.each([
    ['true', GOOD.replace('"false"', '"true"')],
    ['a build placeholder', GOOD.replace('"false"', '"${allowBackup}"')],
    ['a resource reference', GOOD.replace('"false"', '"@bool/allow_backup"')],
    ['an upper-case False', GOOD.replace('"false"', '"False"')],
  ])('rejects android:allowBackup set to %s', (_label, application) => {
    expect(checkFinalManifest(manifest(application))).toEqual([
      expect.stringContaining('android:allowBackup must be "false"'),
    ]);
    expect(checkContributingManifest(manifest(application))).toHaveLength(1);
  });

  test('a final manifest must state all three attributes; Android defaults to backup on', () => {
    expect(checkFinalManifest(manifest('android:label="x"'))).toEqual([
      'android:allowBackup must be "false", found nothing',
      'android:dataExtractionRules must be "@xml/fmp_store_data_extraction_rules", found nothing',
      'android:fullBackupContent must be "@xml/fmp_store_backup_rules", found nothing',
    ]);
    expect(checkFinalManifest('<manifest />')).toEqual([
      'expected one <application> element, found 0',
    ]);
  });

  test('a contributing manifest may stay silent but may not disagree or remove', () => {
    expect(checkContributingManifest(manifest('android:label="x"'))).toEqual([]);
    expect(checkContributingManifest('<manifest />')).toEqual([]);
    expect(
      checkContributingManifest(manifest('android:dataExtractionRules="@xml/other_rules"')),
    ).toHaveLength(1);
    expect(
      checkContributingManifest(manifest('tools:remove="android:label, android:allowBackup"')),
    ).toEqual(['tools:remove must not name android:allowBackup']);
    expect(checkFinalManifest(manifest(`${GOOD} tools:node="replace"`))).toEqual([
      expect.stringContaining('tools:node="replace"'),
    ]);
    // Replacing with the same values is how a clash with a third-party library is settled.
    expect(checkFinalManifest(manifest(`${GOOD} tools:replace="android:allowBackup"`))).toEqual([]);
  });

  test('reads attributes whatever the quoting and layout, and ignores comments', () => {
    const xml = `<manifest>
      <!-- <application android:allowBackup="true" /> -->
      <application
          android:name='.App'
          android:label="a > b"
          android:allowBackup = "false" />
    </manifest>`;
    expect(elementAttributes(xml, 'application')).toEqual([
      { 'android:name': '.App', 'android:label': 'a > b', 'android:allowBackup': 'false' },
    ]);
  });

  test('a rule file must exclude every domain and include nothing', () => {
    const all = FULL_BACKUP_DOMAINS.map((domain) => `<exclude domain="${domain}" />`).join('');
    const sections = ['full-backup-content'];
    expect(
      checkBackupRules(
        `<full-backup-content>${all}</full-backup-content>`,
        sections,
        FULL_BACKUP_DOMAINS,
      ),
    ).toEqual([]);
    expect(
      checkBackupRules(
        `<full-backup-content>${all.replace('<exclude domain="database" />', '')}</full-backup-content>`,
        sections,
        FULL_BACKUP_DOMAINS,
      ),
    ).toEqual(['<full-backup-content> does not exclude domain "database"']);
    expect(
      checkBackupRules(
        `<full-backup-content>${all}<include domain="file" path="x" /></full-backup-content>`,
        sections,
        FULL_BACKUP_DOMAINS,
      ),
    ).toEqual(['a backup rule file must not <include> anything']);
    expect(checkBackupRules('<other />', sections, FULL_BACKUP_DOMAINS)).toEqual([
      'missing <full-backup-content> section',
    ]);
  });
});

describe('android: every manifest in the repository forbids backup', () => {
  const STORE_MANIFEST = join(PACKAGE_ROOT, 'android', 'src', 'main', 'AndroidManifest.xml');
  const APP_MANIFEST = join(
    REPO_ROOT,
    'app',
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml',
  );
  // m0/ is the finished spike: separate apps that are never part of the real build.
  const manifests = [join(REPO_ROOT, 'app'), join(REPO_ROOT, 'packages')]
    .flatMap(filesUnder)
    .filter((path) => path.endsWith('AndroidManifest.xml'));

  test("the store library's manifest states the rule, so it merges into the app", () => {
    expect(manifests).toContain(STORE_MANIFEST);
    expect(checkFinalManifest(read(STORE_MANIFEST))).toEqual([]);
  });

  test("the app's own manifest states the rule, once the Android project exists", () => {
    // Until a later task adds app/android there is no app manifest to check; the library
    // manifest above already forces the merged result or fails the merge. Once the project is
    // there the manifest must be at this path and must state all three attributes itself.
    if (!existsSync(join(REPO_ROOT, 'app', 'android'))) {
      expect(manifests.filter((path) => path.startsWith(join(REPO_ROOT, 'app')))).toEqual([]);
      return;
    }
    expect(existsSync(APP_MANIFEST)).toBe(true);
    expect(checkFinalManifest(read(APP_MANIFEST))).toEqual([]);
  });

  test('no other manifest sets a different value or removes the attributes', () => {
    const violations = manifests
      .filter((path) => path !== STORE_MANIFEST && path !== APP_MANIFEST)
      .flatMap((path) =>
        checkContributingManifest(read(path)).map(
          (violation) => `${relative(REPO_ROOT, path)}: ${violation}`,
        ),
      );
    expect(violations).toEqual([]);
  });

  test('the rule files the manifest points at exclude everything', () => {
    const rules = join(PACKAGE_ROOT, 'android', 'src', 'main', 'res', 'xml');
    expect(
      checkBackupRules(
        read(rules, 'fmp_store_data_extraction_rules.xml'),
        ['cloud-backup', 'device-transfer'],
        CLOUD_AND_TRANSFER_DOMAINS,
      ),
    ).toEqual([]);
    expect(
      checkBackupRules(
        read(rules, 'fmp_store_backup_rules.xml'),
        ['full-backup-content'],
        FULL_BACKUP_DOMAINS,
      ),
    ).toEqual([]);
  });
});

describe('android: the build-time check on the merged manifest', () => {
  const SCRIPT = join(PACKAGE_ROOT, 'scripts', 'check-merged-manifest.ts');
  // Where the Android Gradle Plugin 9 writes an app's merged manifest.
  const MERGED = ['merged_manifests', 'release', 'processReleaseManifest', 'AndroidManifest.xml'];

  function run(files: Record<string, string>) {
    const intermediates = mkdtempSync(join(tmpdir(), 'fmp-merged-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(intermediates, path)), { recursive: true });
      writeFileSync(join(intermediates, path), content);
    }
    const result = spawnSync(process.execPath, [SCRIPT, intermediates], { encoding: 'utf8' });
    rmSync(intermediates, { recursive: true, force: true });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  test('passes a merged manifest that forbids backup', () => {
    const result = run({ [MERGED.join('/')]: manifest(GOOD) });
    expect(result.output).toContain('1 merged manifest(s) forbid backup and device transfer');
    expect(result.status).toBe(0);
  });

  test('fails the build when a merge turned backup back on', () => {
    const result = run({ [MERGED.join('/')]: manifest(GOOD.replace('"false"', '"true"')) });
    expect(result.output).toContain('android:allowBackup must be "false", found "true"');
    expect(result.status).toBe(1);
  });

  test('fails the build when the merged manifest says nothing about backup', () => {
    expect(run({ [MERGED.join('/')]: manifest('android:label="x"') }).status).toBe(1);
  });

  test('fails when one of several variants is wrong', () => {
    const result = run({
      'merged_manifests/debug/processDebugManifest/AndroidManifest.xml': manifest(GOOD),
      [MERGED.join('/')]: manifest(GOOD.replace('"false"', '"true"')),
    });
    expect(result.status).toBe(1);
  });

  test('fails when there is no merged manifest to check, rather than passing on nothing', () => {
    const result = run({ 'packaged_manifests/release/AndroidManifest.xml': manifest(GOOD) });
    expect(result.output).toContain('nothing was checked');
    expect(result.status).toBe(1);
  });

  test('recognises the paths the Android Gradle Plugin uses', () => {
    expect(isMergedManifestPath(MERGED.join('/'))).toBe(true);
    expect(
      isMergedManifestPath('merged_manifest/debug/processDebugManifest/AndroidManifest.xml'),
    ).toBe(true);
    expect(isMergedManifestPath('packaged_manifests/release/AndroidManifest.xml')).toBe(false);
    expect(isMergedManifestPath('merged_manifests/release/output-metadata.json')).toBe(false);
  });

  test('build/build-android.sh runs it after every Gradle build', () => {
    const script = read(REPO_ROOT, 'build', 'build-android.sh');
    expect(script).toContain('packages/encrypted-store/scripts/check-merged-manifest.ts');
    const builds = script.split('\n').filter((line) => /^\s*\.\/gradlew /.test(line));
    const checks = script.split('\n').filter((line) => /^\s*check_backup_excluded$/.test(line));
    expect(builds).toHaveLength(2);
    expect(checks).toHaveLength(builds.length);
  });
});

describe('android: where the store and its key live', () => {
  const MAIN = join(PACKAGE_ROOT, 'android', 'src', 'main', 'java');
  const sources = filesUnder(join(PACKAGE_ROOT, 'android', 'src'))
    .filter((path) => path.endsWith('.kt') && !path.includes(`${join('src', 'test')}`))
    .map((path) => ({ name: relative(MAIN, path), code: code(path) }));
  const all = sources.map((source) => source.code).join('\n');

  test('there is source to check', () => {
    expect(sources.map((source) => source.name.split('/').at(-1))).toEqual(
      expect.arrayContaining(['StorePaths.kt', 'KeystoreKeyWrapper.kt', 'EncryptedStore.kt']),
    );
  });

  test('the only directory the store is ever given is the no-backup directory', () => {
    expect(all).toContain('StorePaths(context.noBackupFilesDir)');
    for (const backedUp of [
      'getDatabasePath',
      'filesDir',
      'getExternalFilesDir',
      'externalCacheDir',
      'cacheDir',
      'getSharedPreferences',
      'getDir(',
      'dataDir',
    ]) {
      expect(all.replaceAll('noBackupFilesDir', '')).not.toContain(backedUp);
    }
  });

  test('the Keystore key is usable while the phone is locked (plan 4.4)', () => {
    const wrapper = sources.find((source) => source.name.endsWith('KeystoreKeyWrapper.kt'))?.code;
    expect(wrapper).toContain('KeyGenParameterSpec.Builder');
    expect(wrapper).toContain('"AndroidKeyStore"');
    expect(all).not.toMatch(/setUnlockedDeviceRequired|setUserAuthenticationRequired/);
    expect(all).not.toMatch(/setUserAuthenticationParameters|setUserPresenceRequired/);
  });

  test('the store refuses to open in an app that allows backup', () => {
    expect(all).toContain('ApplicationInfo.FLAG_ALLOW_BACKUP');
    const store = sources.find((source) => source.name.endsWith('EncryptedStore.kt'))?.code;
    expect(store).toContain('StorePaths.requireBackupDisabled(applicationFlags())');
  });
});

describe('ios: where the store and its key live', () => {
  const IOS = join(PACKAGE_ROOT, 'ios');
  const sources = filesUnder(IOS)
    .filter((path) => path.endsWith('.swift') && !path.includes('HostCheck'))
    .map((path) => ({ name: relative(IOS, path), code: code(path) }));
  const all = sources.map((source) => source.code).join('\n');
  const location = sources.find((source) => source.name === 'StoreLocation.swift')?.code ?? '';
  const keychain = sources.find((source) => source.name === 'KeyStorage.swift')?.code ?? '';

  test('the store directory is in Application Support and nowhere else', () => {
    expect(location).toContain('for: .applicationSupportDirectory, in: .userDomainMask');
    // Documents is user-visible and backed up; Caches and tmp can be emptied by the system;
    // an app-group container is backed up and shared with extensions.
    for (const elsewhere of [
      '.documentDirectory',
      '.cachesDirectory',
      '.libraryDirectory',
      'NSTemporaryDirectory',
      'temporaryDirectory',
      'NSHomeDirectory',
      'forSecurityApplicationGroupIdentifier',
      'ubiquity',
    ]) {
      expect(all).not.toContain(elsewhere);
    }
    expect(
      [...all.matchAll(/FileManager\.default\.urls\(for: (\.\w+)/g)].map(([, d]) => d),
    ).toEqual(['.applicationSupportDirectory']);
  });

  test('the directory is excluded from backup, and the exclusion is read back', () => {
    expect(location).toContain('values.isExcludedFromBackup = true');
    expect(all).not.toMatch(/isExcludedFromBackup\s*=\s*false/);
    expect(location).toContain('forKeys: [.isExcludedFromBackupKey]');
    expect(location).toMatch(
      /func prepare\(\) throws \{[\s\S]*try requireExcludedFromBackup\(\)\s*\}/,
    );
    // Every way to the file goes through prepare().
    const store = sources.find((source) => source.name === 'EncryptedStore.swift')?.code ?? '';
    expect(store).toMatch(/func preparedLocation\(\)[\s\S]*?try location\.prepare\(\)/);
    expect(store).toMatch(/func open\(\)[\s\S]*?let location = try preparedLocation\(\)/);
    expect(store.match(/SqlcipherDatabase\(path:/g)).toHaveLength(1);
  });

  test('files are readable after first unlock, never only while unlocked', () => {
    expect(location).toContain('FileProtectionType.completeUntilFirstUserAuthentication');
    expect(all).not.toMatch(/FileProtectionType\.(complete|completeUnlessOpen|none)\b/);
  });

  test('the Keychain item is AfterFirstUnlockThisDeviceOnly and never synchronised (plan 4.4)', () => {
    expect([...all.matchAll(/kSecAttrAccessible[A-Z]\w+/g)].map(([name]) => name)).toEqual([
      'kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly',
    ]);
    expect(keychain).toContain(
      'attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly',
    );
    expect(keychain).toContain('kSecClass as String: kSecClassGenericPassword');
    expect([...all.matchAll(/kSecAttrSynchronizable as String: (\w+)/g)].map(([, v]) => v)).toEqual(
      ['false'],
    );
    expect(all).not.toContain('kSecAttrAccessGroup');
  });

  test('the key never reaches a log', () => {
    for (const source of [...sources, { name: 'android', code: androidCode() }]) {
      expect(source.code, source.name).not.toMatch(/\b(print|NSLog|os_log|Log\.[dievw]|println)\(/);
    }
  });

  function androidCode(): string {
    return filesUnder(join(PACKAGE_ROOT, 'android', 'src'))
      .filter((path) => path.endsWith('.kt') && !path.includes(join('src', 'test')))
      .map(code)
      .join('\n');
  }
});

describe('one SQLCipher on both sides of the file', () => {
  const resolve = createRequire(join(PACKAGE_ROOT, 'package.json')).resolve;
  const opSqlite = dirname(resolve('@op-engineering/op-sqlite/package.json'));
  const gradle = read(PACKAGE_ROOT, 'android', 'build.gradle');
  const storePackage = json(PACKAGE_ROOT, 'package.json');
  const appPackage = json(REPO_ROOT, 'app', 'package.json');
  const rootPackage = json(REPO_ROOT, 'package.json');
  const dependency = (pkg: Record<string, unknown>, group: string, name: string) =>
    (pkg[group] as Record<string, string> | undefined)?.[name];

  test('op-sqlite vendors SQLCipher 4, the only SQLCipher either side uses', () => {
    const vendored = /#define CIPHER_VERSION_NUMBER (\d+\.\d+\.\d+)/.exec(
      read(opSqlite, 'cpp', 'sqlcipher', 'sqlite3.c'),
    )?.[1];
    expect(vendored).toMatch(/^4\./);
  });

  test('op-sqlite is pinned to one exact version, the same in the app and here', () => {
    const version = dependency(storePackage, 'dependencies', '@op-engineering/op-sqlite');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dependency(appPackage, 'dependencies', '@op-engineering/op-sqlite')).toBe(version);
    expect(json(opSqlite, 'package.json').version).toBe(version);
  });

  test('op-sqlite is built with SQLCipher, wherever it looks for the setting', () => {
    // Its Android build reads the package.json beside the Android project (app/), its podspec
    // the first one above its own directory (the repo root). Without the flag it opens a
    // plaintext file; openStore refuses that at run time, this refuses it at build time.
    expect(appPackage['op-sqlite']).toEqual({ sqlcipher: true });
    expect(rootPackage['op-sqlite']).toEqual({ sqlcipher: true });
    // The link check is an Android project of its own, with its own package.json beside it.
    expect(json(PACKAGE_ROOT, 'android-linkcheck', 'package.json')['op-sqlite']).toEqual({
      sqlcipher: true,
    });
  });

  test('the app depends on this package directly, which is what autolinking follows', () => {
    expect(dependency(appPackage, 'dependencies', '@findmyperson/encrypted-store')).toBe(
      'workspace:*',
    );
  });

  test('the standalone compile check uses the React Native version the app builds with', () => {
    const reactNative = dependency(storePackage, 'devDependencies', 'react-native');
    expect(dependency(appPackage, 'dependencies', 'react-native')).toBe(reactNative);
    expect(gradle).toContain(`compileOnly("com.facebook.react:react-android:${reactNative}")`);
  });

  test('the podspec takes its SQLCipher header from op-sqlite and compiles every iOS source', () => {
    const podspec = read(PACKAGE_ROOT, 'FindMyPersonEncryptedStore.podspec');
    expect(podspec).toContain("require.resolve('@op-engineering/op-sqlite/package.json'");
    expect(podspec).toContain('File.join(op_sqlite, "cpp", "sqlcipher")');
    expect(podspec).toContain('s.dependency "op-sqlite"');
    expect(podspec).toContain('"ios/*.{h,c,m,mm,swift}"');
    // The module the ObjC++ file imports its Swift header from.
    expect(read(PACKAGE_ROOT, 'ios', 'RCTNativeEncryptedStore.mm')).toContain(
      'FindMyPersonEncryptedStore-Swift.h',
    );
  });
});

/**
 * ONE SQLITE IN THE ANDROID PROCESS. JavaScript uses the store through op-sqlite, Kotlin through
 * libfmp-store-jni.so, and SQLite's file locks only work between connections made by one copy
 * of the library. These tests hold the source to that; scripts/check-native-libs.ts holds the
 * built APK to it, and nativeLibsPolicy.test.ts tests that check.
 */
describe('android: one SQLite library, the one inside op-sqlite', () => {
  const resolve = createRequire(join(PACKAGE_ROOT, 'package.json')).resolve;
  const opSqlite = dirname(resolve('@op-engineering/op-sqlite/package.json'));
  const STORE_ANDROID = join(PACKAGE_ROOT, 'android');
  const CAPTURE_ANDROID = join(REPO_ROOT, 'packages', 'native-location-capture', 'android');
  const isTestSource = (path: string) =>
    /[\\/]src[\\/](test|androidTest)[\\/]/.test(path) || path.includes('HostCheck');

  // Every Gradle build file that takes part in the real app. m0/ is the finished spike.
  const buildFiles = [join(REPO_ROOT, 'app'), join(REPO_ROOT, 'packages')]
    .flatMap(filesUnder)
    .filter((path) => /\.gradle(\.kts)?$|libs\.versions\.toml$/.test(path));
  const kotlin = [STORE_ANDROID, CAPTURE_ANDROID]
    .flatMap((directory) => filesUnder(join(directory, 'src')))
    .filter((path) => /\.(kt|java)$/.test(path) && !isTestSource(path))
    .map((path) => ({ name: relative(REPO_ROOT, path), code: code(path) }));
  const cmake = read(STORE_ANDROID, 'src', 'main', 'cpp', 'CMakeLists.txt').replace(
    /^\s*#.*$/gm,
    '',
  );
  const jniSource = read(STORE_ANDROID, 'src', 'main', 'cpp', 'fmp_store_jni.c');

  test('there are build files and sources to check', () => {
    const names = buildFiles.map((path) => relative(REPO_ROOT, path));
    expect(names).toContain('packages/encrypted-store/android/build.gradle');
    expect(names).toContain('packages/native-location-capture/android/build.gradle');
    expect(names).toContain('packages/encrypted-store/android-linkcheck/android/app/build.gradle');
    expect(kotlin.length).toBeGreaterThan(20);
  });

  test('no build file depends on a library that carries its own SQLite', () => {
    // Zetetic's sqlcipher-android was the second copy. Any dependency with SQLite or SQLCipher
    // in its coordinates is refused unless it is test-only, where it never reaches the APK.
    const dependency =
      /^\s*(?!test|androidTest)\w*(?:implementation|api|compileOnly|runtimeOnly|classpath)\s*\(?\s*['"]([^'"]+:[^'"]+)['"]/i;
    const declared = buildFiles.flatMap((path) =>
      code(path)
        .split('\n')
        .flatMap((line) => dependency.exec(line)?.[1] ?? [])
        .map((coordinates) => `${relative(REPO_ROOT, path)}: ${coordinates}`),
    );
    expect(declared).toContain(
      'packages/native-location-capture/android/build.gradle: androidx.work:work-runtime:2.10.0',
    );
    expect(declared.filter((line) => /sqlite|sqlcipher|zetetic|requery/i.test(line))).toEqual([]);
    expect(buildFiles.map((path) => code(path)).join('\n')).not.toMatch(
      /net\.zetetic|sqlcipher-android/,
    );
  });

  test('no Kotlin source reaches a SQLite other than through SqlcipherConnection', () => {
    for (const source of kotlin) {
      // Zetetic's wrapper, and the framework's android.database.sqlite, which is the system's
      // libsqlite.so: a different copy again.
      expect(source.code, source.name).not.toMatch(
        /net\.zetetic|android\.database\.sqlite|androidx\.sqlite|androidx\.room|java\.sql\./,
      );
    }
    const loads = kotlin.flatMap((source) =>
      [...source.code.matchAll(/System\.load(?:Library)?\(([^)]*)\)/g)].map(
        ([, argument]) => `${source.name.split('/').at(-1)}: ${argument}`,
      ),
    );
    expect(loads).toEqual(['SqlcipherNative.kt: LIBRARY']);
  });

  test('the capture module opens the store through the store package', () => {
    const gradle = code(join(CAPTURE_ANDROID, 'build.gradle'));
    expect(gradle).toContain("implementation project(':findmyperson_encrypted-store')");
    const store = kotlin.find((source) => source.name.endsWith('SqlCipherSampleStore.kt'))?.code;
    expect(store).toContain('import dev.findmyperson.encryptedstore.SqlcipherConnection');
    expect(store?.match(/SqlcipherConnection\.open\(/g)).toHaveLength(1);
  });

  test('the JNI library is one C file with no SQLite in it, linked to op-sqlite', () => {
    expect(readdirSync(join(STORE_ANDROID, 'src', 'main', 'cpp')).sort()).toEqual([
      'CMakeLists.txt',
      'fmp_store_jni.c',
    ]);
    expect(cmake).toContain('add_library(fmp-store-jni SHARED fmp_store_jni.c)');
    expect(cmake).toContain(
      'target_link_libraries(fmp-store-jni PRIVATE op-engineering_op-sqlite::op-sqlite)',
    );
    expect(cmake).toContain('-Wl,--no-undefined');
    expect(cmake).not.toMatch(/sqlite3\.c|STATIC|add_subdirectory|target_sources/);
    expect([...jniSource.matchAll(/^#include [<"]([^>"]+)[>"]/gm)].map(([, file]) => file)).toEqual(
      ['sqlite3.h', 'dlfcn.h', 'jni.h', 'stdint.h', 'stdlib.h', 'string.h'],
    );

    const gradle = code(join(STORE_ANDROID, 'build.gradle'));
    expect(gradle).toContain('def opSqliteProject = ":op-engineering_op-sqlite"');
    expect(gradle).toContain('implementation project(opSqliteProject)');
    expect(gradle).toContain('path "src/main/cpp/CMakeLists.txt"');
    expect(gradle).toContain('prefab true');
  });

  test('the names the build, the Kotlin and this package use for the two libraries agree', () => {
    const native = kotlin.find((source) => source.name.endsWith('SqlcipherNative.kt'))?.code;
    const connection = kotlin.find((source) =>
      source.name.endsWith('SqlcipherConnection.kt'),
    )?.code;
    expect(JNI_LIBRARY).toBe('libfmp-store-jni.so');
    expect(native).toContain('const val LIBRARY = "fmp-store-jni"');
    expect(ENGINE_LIBRARY).toBe('libop-sqlite.so');
    expect(connection).toContain('const val ENGINE_LIBRARY_NAME = "libop-sqlite"');
    // Checked on every open, before anything is opened.
    expect(connection).toMatch(
      /fun open\([^)]*\): SqlcipherConnection \{\s*requireSharedEngine\(\)/,
    );
  });

  test('every native method Kotlin declares is defined in the C file, and no other', () => {
    const native = kotlin.find((source) => source.name.endsWith('SqlcipherNative.kt'))?.code ?? '';
    const declared = [...native.matchAll(/@JvmStatic external fun (\w+)\(/g)].map(
      ([, name]) => name,
    );
    const defined = [...jniSource.matchAll(/^FMP_JNI\(\w+, (\w+)\)/gm)].map(([, name]) => name);
    expect(declared.length).toBeGreaterThan(10);
    expect([...defined].sort()).toEqual([...declared].sort());
    expect(jniSource).toContain('Java_dev_findmyperson_encryptedstore_SqlcipherNative_##name');
    expect(read(STORE_ANDROID, 'consumer-rules.pro')).toContain(
      'class dev.findmyperson.encryptedstore.SqlcipherNative',
    );
  });

  test('op-sqlite still builds what the link relies on', () => {
    // One shared library named op-sqlite, with SQLCipher compiled in and its symbols visible,
    // published to other Gradle projects with its headers. A bump of op-sqlite that changes
    // any of this fails here instead of in the Android build.
    const opCmake = read(opSqlite, 'android', 'CMakeLists.txt');
    const opGradle = read(opSqlite, 'android', 'build.gradle');
    expect(opCmake).toContain('set (PACKAGE_NAME "op-sqlite")');
    expect(opCmake).toMatch(/add_library\(\s*\$\{PACKAGE_NAME\}\s*SHARED/);
    expect(opCmake).toContain('../cpp/sqlcipher/sqlite3.c');
    expect(opCmake + opGradle).not.toMatch(/fvisibility=hidden|SQLITE_API=/);
    expect(opGradle).toContain('prefabPublishing true');
    expect(opGradle).toContain('"op-sqlite" {');
    const header = read(opSqlite, 'cpp', 'sqlcipher', 'sqlite3.h');
    for (const name of [...jniSource.matchAll(/\b(sqlite3_\w+)\(/g)].map(
      ([, name]) => name ?? '',
    )) {
      expect(header, name).toMatch(new RegExp(`\\b${name}\\(`));
    }
  });

  test('every Android build runs the check on what it packaged', () => {
    const appBuild = read(REPO_ROOT, 'build', 'build-android.sh').split('\n');
    expect(appBuild.filter((line) => /^\s*\.\/gradlew /.test(line))).toHaveLength(2);
    expect(appBuild.filter((line) => /^\s*check_one_sqlite "/.test(line))).toHaveLength(2);
    expect(appBuild.join('\n')).toContain('packages/encrypted-store/scripts/check-native-libs.ts');

    const linkCheck = read(REPO_ROOT, 'build', 'android-linkcheck.sh');
    expect(linkCheck).toContain('./gradlew :app:assembleDebug');
    expect(linkCheck).toContain('scripts/check-native-libs.ts');
    expect(linkCheck).toContain('scripts/check-merged-manifest.ts');
  });

  test('CI builds the link check and runs the Kotlin store on real SQLCipher, on every pull request', () => {
    const workflow = read(REPO_ROOT, '.github', 'workflows', 'build.yml');
    expect(workflow).toMatch(/^on:\n {2}pull_request:/m);
    expect(workflow).toContain('run: build/android-linkcheck.sh');
    expect(workflow).toMatch(/gradle -p packages\/encrypted-store\/android .*-PfmpHostSqlcipher/);
  });
});
