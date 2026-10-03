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
 *   - the SQLCipher the Kotlin writer links stops being the one op-sqlite compiles.
 *
 * They run on every pull request, on Linux, with no device. They check what the code says;
 * what the built app and a phone do is checked by scripts/check-merged-manifest.ts during the
 * Android build and by the fail-closed checks in StorePaths.kt and StoreLocation.swift.
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

  test('the Kotlin writer links the SQLCipher release op-sqlite compiles into the app', () => {
    const vendored = /#define CIPHER_VERSION_NUMBER (\d+\.\d+\.\d+)/.exec(
      read(opSqlite, 'cpp', 'sqlcipher', 'sqlite3.c'),
    )?.[1];
    const zetetic = /net\.zetetic:sqlcipher-android:(\d+\.\d+\.\d+)/.exec(gradle)?.[1];
    expect(vendored).toMatch(/^4\./);
    expect(zetetic).toBe(vendored);
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
