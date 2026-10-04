# @findmyperson/encrypted-store

The on-device store, as a real encrypted file on a phone. Location samples, stays, cached reports and matches live here and nowhere else.

`@findmyperson/shared` defines what is in the store: the schema, the migrations, the SQLCipher parameters and one typed module per table. This package adds what turns that into a file: the key, the directory, the open-and-check sequence, backup exclusion, and "Delete all my data". It defines no table and no query of its own.

It has three halves that must agree, and tests that fail when they stop agreeing:

| Half       | Where      | What it does                                                                                                                                                      |
| ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript | `src/`     | Opens the file through op-sqlite, proves the cipher parameters, runs migrations, resets the store                                                                 |
| Kotlin     | `android/` | Holds the key (Android Keystore), names the no-backup directory, writes samples for the capture module, and is the only way native code reaches SQLite on Android |
| Swift      | `ios/`     | Holds the key (Keychain), names the backup-excluded directory, writes samples and visits for the capture module                                                   |

## Importing

| Import                                  | Gives you                                                                 | Loads react-native |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| `@findmyperson/encrypted-store`         | `openStore`, `deleteAllData`, `StoreError`, constants and types           | no                 |
| `@findmyperson/encrypted-store/native`  | `NativeEncryptedStore` (the real native module) and `opSqliteDriver`      | yes                |
| `@findmyperson/encrypted-store/testing` | `createTestVault`, `nodeSqlcipherDriver`: a real SQLCipher store for Node | no                 |

Runtime exports of the root: `openStore`, `deleteAllData`, `StoreError`, `STORE_ERROR_CODES`, `STORE_BUSY_TIMEOUT_MS`, `ANDROID_STORE_DIRECTORY_NAME`, `IOS_STORE_DIRECTORY_NAME`, `STORE_FILE_SUFFIXES`, `NATIVE_MODULE_NAME`, `packageName`.

Types of the root: `EncryptedStore`, `OpenStoreOptions`, `StoreVault`, `StoreMaintenance`, `StoreDriver`, `StoreDriverOptions`, `StoreConnection`, `StoreErrorCode`.

### TypeScript: reading and writing the store

The app opens the store once and keeps the handle:

```ts
import { openStore } from '@findmyperson/encrypted-store';
import { NativeEncryptedStore, opSqliteDriver } from '@findmyperson/encrypted-store/native';
import { listStaysInCells } from '@findmyperson/shared';

const store = await openStore({ vault: NativeEncryptedStore, driver: opSqliteDriver });
const stays = await listStaysInCells(store.db, cells, fromTs, toTs);
```

`store.db` is a `SqlDatabase` from `@findmyperson/shared`. Every read and write goes through the table functions of that package (`listSamplesBetween`, `insertStay`, `insertMatchIfAbsent`, …), following `packages/shared/src/store/ownership.ts`. Take the `EncryptedStore` or its `db` as an argument, so a test can pass one built with `/testing`:

```ts
import { openStore } from '@findmyperson/encrypted-store';
import { createTestVault, nodeSqlcipherDriver } from '@findmyperson/encrypted-store/testing';

const vault = createTestVault(mkdtempSync(join(tmpdir(), 'fmp-')));
const store = await openStore({ vault, driver: nodeSqlcipherDriver() });
```

That is real SQLCipher with the pinned parameters, on a temporary directory. The in-memory database in `packages/shared/src/testing/` is faster and enough when only the SQL matters.

| Member                            | What it does                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `openStore(options)`              | Opens, checks and migrates the store. Throws `StoreError` or `SchemaTooNewError`; never returns a half-open store |
| `store.db`                        | The `SqlDatabase` to pass to the shared table functions                                                           |
| `store.migration`                 | `{ from, to }`: what this open did to the schema. `from` is 0 for a new file                                      |
| `store.runMaintenance(nowTs)`     | Runs the retention hook given at open (below)                                                                     |
| `store.close()`                   | Closes the connection                                                                                             |
| `deleteAllData(options, current)` | "Delete all my data": drops the file, rotates the key, returns a new empty store                                  |

### Kotlin and Swift: the writer for the capture modules

The capture module writes each fix itself, with no JavaScript running, through one object per process. This is the whole native interface:

| Kotlin: `EncryptedStore.get(context)`           | Swift: `EncryptedStore.shared`                            | Use                                                                            |
| ----------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `keyHex(): String`                              | `keyHex() throws -> String`                               | Implements `getOrCreateStoreKeyHex` of the capture spec                        |
| `directory(): File`                             | `directory() throws -> String`                            | Implements `getStoreDirectory`                                                 |
| `check()`                                       | `check() throws`                                          | Implements `initStore`, and the check repeated on every wake                   |
| `insertLocationSample(LocationSampleRow): Long` | `insertLocationSample(LocationSampleRow) throws -> Int64` | Stores a fix; the caller computes `h3R7` and `h3R5`                            |
| not on Android                                  | `insertVisitStay(VisitStayRow) throws -> Int64`           | A `CLVisit` arrival, or a whole visit seen only at departure                   |
| not on Android                                  | `closeVisitStay(startTs:endTs:) throws -> Bool`           | The departure. `false` means no open row: insert a closed one instead          |
| `readScalar(sql, args): String?`                | `readScalar(_:_:) throws -> String?`                      | One `SELECT` value, for the module's own status (newest sample, count in 24 h) |
| `deleteAllData()`                               | `deleteAllData() throws`                                  | The native half of "Delete all my data"                                        |
| `close()`                                       | `close()`                                                 | Closes the connection; the next call reopens it                                |

Failures are `StoreException` (Kotlin) and `StoreError` (Swift) with a `code`: `NOT_SQLCIPHER`, `PARAM_MISMATCH`, `BAD_KEY_OR_PARAMS`, `OPEN_FAILED`, `SCHEMA_MISMATCH`, `KEY_UNAVAILABLE`, `BACKUP_NOT_EXCLUDED`, `DELETE_FAILED`. The capture module reports any of them as its `store_unusable` health flag.

To depend on it: on Android add `implementation project(':findmyperson_encrypted-store')` (the name React Native's autolinking gives the project) and use package `dev.findmyperson.encryptedstore`; on iOS add `s.dependency "FindMyPersonEncryptedStore"` to the podspec and `import FindMyPersonEncryptedStore`.

On Android one more class is public: `SqlcipherConnection`, a single connection to a SQLCipher file with the key set and nothing else done (`open(file, keyLiteral, create)`, then `scalar`, `execute`, `insert`, `update`, `busyTimeout`, `close`). `EncryptedStore` is built on it, and it is public because the capture module's stand-in store, below, opens its own connection. Native Android code must reach SQLite through this class and through nothing else; "One SQLite library in the Android process" says why.

`getOrCreateStoreKeyHex` and `getStoreDirectory` exist on both the capture module and this package's own small Turbo Native Module (`NativeEncryptedStore`). This package has its own module because the app needs the key, the directory and the delete even if capture is never started.

### The capture modules still carry their own copy

Both capture modules in `packages/native-location-capture` were merged while this package was being written, each with a stand-in for it: its own key code, directory and SQLCipher open (`android/.../store/`, and `KeychainKeySource`, `StoreLocation` and `SQLiteCaptureStore` on iOS). The Android stand-in opens its connection with this package's `SqlcipherConnection`, so it uses the same SQLite as everything else; the rest of it is still its own. Their READMEs say so and name the seam. Replacing those stand-ins with the class above is the remaining step, and it belongs to those modules:

| Their seam                                                                       | Becomes                                                                             |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Android `SampleStore.check()` / `insert(sample)`                                 | `EncryptedStore.get(context).check()` / `insertLocationSample(...)`                 |
| Android `KeystoreStoreKey`, `StoreLocation`                                      | `keyHex()`, `directory()`                                                           |
| iOS `CaptureStore.check` / `insertSample` / `insertVisitStay` / `closeVisitStay` | the methods of the same names on `EncryptedStore.shared`                            |
| iOS `StoreKeySource`, `StoreLocation.prepare()`                                  | `keyHex()`, `directory()`                                                           |
| The status ledger kept because "the store contract has no read"                  | can stay, or be replaced by `readScalar("SELECT max(ts_utc) FROM location_sample")` |
| Android `SampleStore.purgeExpired`, iOS `CaptureStore.purgeExpired`              | not on `EncryptedStore` yet: the swap adds it, from the purge constants below       |

The retention purge of a capture wake is in those stand-ins too (`StorePurge` in Kotlin, `SQLiteCaptureStore.purgeExpired` in Swift). `StoreContract.kt` and `StoreContract.swift` here already carry the four purge statements and `RETENTION_SEC`, so the swap has the same SQL to run; `EncryptedStore` has no method for it until then, and needs a transaction on its connection to get one.

Until that is done the two implementations run side by side, so this package uses exactly the names and formats the stand-ins use: the same Keychain item, the same Android Keystore alias, key file name and key file format, and the same directory on each platform (`src/location.ts`). Both therefore find one key and one file. What the stand-ins lack is what is new here: the backup guard at open, the fail-closed check of the exclusion flag on iOS, and any part in "Delete all my data". On Android the stand-in opens the file for each write and re-reads the key file, so it follows a delete by itself. On iOS it keeps its connection open, so after a delete it goes on writing to the removed file until the app restarts. The swap has to land before a Settings screen offers the delete.

## One SQLite library in the Android process

On Android the store file is used from two sides of one process. TypeScript reads and writes it through op-sqlite, whose SQLCipher is compiled into `libop-sqlite.so`. Kotlin writes it with no JavaScript running: `EncryptedStore` here, and the capture module's stand-in store. Until this was built the Kotlin side had a SQLCipher of its own, Zetetic's `sqlcipher-android` (`libsqlcipher.so`), and that was a real fault, not an untidiness.

SQLite protects a database with POSIX file locks, which belong to the process, not to the library copy. Two copies in one process do not see each other's locks, so they do not exclude each other, and when one closes its handle the operating system drops the other's locks too (sqlite.org, "How To Corrupt An SQLite Database File", section 2.2.1). One copy keeps its own record of which of its connections holds what, and that is what makes two connections in one process safe. So the rule is one copy, and the decision (the captain's, from the three options this section used to list) was to make the Kotlin side use op-sqlite's, as Swift already does through `FMPSqlcipher.c`.

How it is built:

- `android/src/main/cpp/fmp_store_jni.c` is the whole native side: one C file of JNI functions over the `sqlite3_*` calls the store needs. It contains no SQLite. It is compiled against op-sqlite's SQLCipher header and linked against `libop-sqlite.so`, which op-sqlite's Gradle project publishes to other projects as a prefab package. The result is `libfmp-store-jni.so`, about 13 KB, whose `sqlite3_*` symbols are all imports.
- `SqlcipherConnection` is the Kotlin over it, and the only way to SQLite for native Android code: `EncryptedStore` and the capture module both open their connection there. Neither Gradle build has a SQLCipher or SQLite dependency any more.
- Loading `libfmp-store-jni.so` makes the dynamic linker load `libop-sqlite.so`, once per process, whether or not React Native has started. JavaScript's op-sqlite then uses the same loaded library.

What enforces it:

| Check                                      | Runs                                                                                     | Fails when                                                                                                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy.test.ts`, "one SQLite library" | every pull request (`pnpm test`)                                                         | a Gradle file of the app or a package gains a dependency with SQLite or SQLCipher in its name; Kotlin reaches for Zetetic's, the framework's or androidx's SQLite; the JNI library gains a source file; op-sqlite stops building what the link relies on |
| `scripts/check-native-libs.ts`             | every Android build (`build/build-android.sh`), and the link check on every pull request | the APK or bundle holds a second library that exports or contains SQLite; `libfmp-store-jni.so` holds one, is not linked to `libop-sqlite.so`, or needs a library that is neither packaged nor part of Android; op-sqlite was built without SQLCipher    |
| `SqlcipherHostTest`                        | every pull request (`store-android` job, `-PfmpHostSqlcipher`)                           | the real Kotlin and C, run on the JVM against SQLCipher built from op-sqlite's source, stop working, or two connections through the one library stop excluding each other                                                                                |
| `SqlcipherConnection.open`, on the phone   | every open                                                                               | the dynamic linker reports that the SQLite calls are bound to a library other than `libop-sqlite`. Nothing is opened; the capture module shows it as `store_unusable`                                                                                    |

`src/nativeLibsPolicy.ts` is the rule the second check applies; it reads the symbol tables and contents of the packaged libraries and executes nothing.

**The link check.** `android-linkcheck/` is a React Native Android app with no screen and no JavaScript that links op-sqlite, this package and the capture module the way the app does. It gave the check a real APK on every pull request before `app/android` existed (`build/android-linkcheck.sh`, CI job `android-linkcheck`). See its README. `build/build-android.sh` now makes the same check on the real APK, so the link check can go once that job has been green on `main`.

What changes for a consumer:

- **The two sides now wait for each other.** With one SQLite, a native write that meets a TypeScript write waits for it, up to the busy timeout (5 s, `STORE_BUSY_TIMEOUT_MS`), and fails with `SQLITE_BUSY` after that. Before, it did not wait at all and both wrote. A long TypeScript transaction is therefore now something a fix can time out on.
- **A capture wake loads more.** With no JavaScript running, the first store use loads `libop-sqlite.so` and the libraries it is linked against (`libreactnative.so`, `libjsi.so`, `libfbjni.so`, `libc++_shared.so`, `libcrypto.so`). React Native does not start; the libraries are mapped. It is the cost of removing the second 4 MB library.

### Before the Android vacuum is switched on

The weekly `VACUUM` is still off on Android (`ANDROID_VACUUM_ENABLED` in `app/src/store/retention.ts`). It was switched off because of the two libraries. The build no longer has two, but nothing here has run on a phone, and each of these can only be seen on one:

1. **The library loads with no React Native in the process.** On a capture wake with the app closed (WorkManager job, boot receiver), `store_unusable` is not raised and a fix is stored. This is `System.loadLibrary("fmp-store-jni")` bringing in `libop-sqlite.so` and everything it needs through the system linker instead of React Native's loader. The build check confirms that every library in that chain is in the APK; that they also initialise with no React Native running is what the phone shows. Try a release build as well as a debug one.
2. **React Native still starts afterwards, in the same process**, and the reverse order: open the app, read the store in TypeScript, let a capture wake write, read again.
3. **The run-time check agrees.** A store that opens at all has passed it. If it fails, the message names the library SQLite was bound to.
4. **Both sides at once.** With the app open and maintenance running, capture writes land and none is lost; no `SQLITE_BUSY` reaches the diagnostics.
5. **How long a `VACUUM` of a full 30-day store takes on the slowest test phone.** A fix that arrives during it waits, and gives up after 5 s. If the vacuum can take longer than that, the busy timeout or the native retry has to change before the flag does.

Then set the flag. iOS is not affected by any of this: there is one SQLCipher in the app and Swift binds to it.

## What happens on open

The same steps run in TypeScript, Kotlin and Swift, in this order. `m0/store-proof` found each of them necessary.

1. Get the key (made on first use) and the directory.
2. Open the file and set the key as a raw-key literal, `x'<64 hex>'`.
3. Apply the pinned cipher pragmas.
4. Require SQLCipher 4 (`PRAGMA cipher_version`). op-sqlite built without SQLCipher accepts a key, ignores it and opens a plaintext file; this is where that is refused.
5. Read every pinned pragma back and compare. With a raw key SQLCipher decrypts the file whatever `kdf_iter` is, so this is the only check that notices a side that drifted on it.
6. Do a first real read. A wrong key, another page size, HMAC or KDF algorithm, and a plaintext file all fail here.
7. Set WAL and a 5-second busy timeout: the native writer and the TypeScript reader each hold a connection to the one file.
8. TypeScript runs the migrations. Native code compares `PRAGMA user_version` with the version it was built for and writes nothing if they differ.

The pinned values are `packages/shared/contracts/cipher-params.json`. Kotlin and Swift get them, and the SQL they may run, from `StoreContract.kt` and `StoreContract.swift`, which are generated from the shared package and checked by a test.

## Migrations

TypeScript owns the schema; `openStore` runs `migrate` from the shared package on every open. To change the schema, append a migration there. Native code never creates or alters a table. A native module built for version 1 that meets version 2 stops writing and reports `SCHEMA_MISMATCH`; it does not guess.

Empty → version 1 → a synthetic version 2 is tested on real SQLCipher in TypeScript (`src/openStore.test.ts`), against the Swift writer (`src/iosHost.test.ts`, `ios/HostCheck`) and against the Kotlin writer's version gate (`EncryptedStoreTest.kt`).

## The key (plan 4.4)

32 bytes from the platform's random generator, made on first use.

|                    | iOS                                                           | Android                                                                              |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Kept in            | Keychain, generic password                                    | A file in the store directory, wrapped by an AES-256-GCM key in the Android Keystore |
| Readable           | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`            | The Keystore key has no unlocked-device and no user-authentication requirement       |
| Why                | Capture must work while the phone is locked in a pocket       | Same                                                                                 |
| Leaves the device? | No: `ThisDeviceOnly`, and not synchronised to iCloud Keychain | No: a Keystore key cannot be exported, and the wrapped file is outside backups       |

The plan names `EncryptedSharedPreferences` for the Android blob. That library is deprecated, and shared preferences are part of what Android backs up, so the blob is a plain file in the no-backup directory instead. It is wrapped by the Keystore key either way. `m0/store-proof` made the same substitution.

A key that exists but cannot be read is reported (`KEY_UNAVAILABLE`), never replaced. That happens before the first unlock after a reboot on iOS, and if a phone's Keystore loses its key. Making a new key there would silently orphan every stored row. The way out is "Delete all my data".

## Backup exclusion (plan 4.5)

Both platforms back app data up to the vendor's cloud by default. That would take 30 days of location history off the phone.

**Android.** Three layers, because the usual way this regresses is a dependency's manifest merging the default back in:

1. The store and the wrapped key are in `noBackupFilesDir`, which Android leaves out of Auto Backup and of device-to-device transfer whatever the manifest says.
2. `android/src/main/AndroidManifest.xml` declares `android:allowBackup="false"` and two rule files that exclude every domain from cloud backup and from device transfer. `allowBackup="false"` alone does not stop a device-to-device transfer on Android 12 and later; the rule files do. These attributes merge into the app's manifest. If the app or another library declares a different value, the merge fails and the build stops.
3. `StorePaths.requireBackupDisabled` refuses to open the store on a phone whose installed app allows backup.

**iOS.** The store is in `<Application Support>/findmyperson-store`, and that directory carries `isExcludedFromBackup`. iOS has no durable directory that is outside backups by location alone: `Library/Caches` and `tmp` are, but the system may empty them when storage runs low, and the history must not vanish that way. Excluding the directory covers the `-wal` and `-shm` files SQLite recreates and the database file that "Delete all my data" recreates. The flag is set and then read back on every open; a store whose directory is not excluded is not opened (`BACKUP_NOT_EXCLUDED`).

**What enforces it:**

| Check                                                             | Runs                                                      | Fails when                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy.test.ts`                                              | every pull request (`pnpm test`)                          | any manifest in the repo sets `allowBackup` to anything but `"false"`, removes it, or the rule files stop excluding a domain; the Android path stops being the no-backup directory; the iOS path, exclusion flag, file protection or Keychain class changes |
| `scripts/check-merged-manifest.ts`, from `build/build-android.sh` | every Android build; the link check on every pull request | the manifest Gradle actually merged allows backup. This is the one that sees third-party libraries                                                                                                                                                          |
| `StorePathsTest`, `EncryptedStoreTest`                            | every pull request (`store-android` job)                  | a store file is outside the no-backup directory; a store opens in an app that allows backup                                                                                                                                                                 |
| `ios/HostCheck` through `src/iosHost.test.ts`                     | `pnpm test` on a Mac; `ios-capture-module` on `main`      | the real Swift code leaves the directory without the exclusion flag, read back from the file system                                                                                                                                                         |

`src/backupPolicy.ts` is the rule itself; the first two checks share it.

## Delete all my data (plan 4.7)

```ts
store = await deleteAllData({ vault: NativeEncryptedStore, driver: opSqliteDriver }, store);
```

It closes the JavaScript connection; the native side closes its own, deletes the file with its `-wal` and `-shm` and deletes the key (on Android also the Keystore key that wrapped it); then the store is opened again, which makes a new key and a new file at the current schema. It then checks that the key really changed and that the new file really started empty, and throws `KEY_NOT_ROTATED` or `DELETE_INCOMPLETE` otherwise, so a Settings screen cannot report a delete that did not happen.

Pass `null` as the second argument when the store could not be opened at all. Call `LocationCapture.stop()` first if capture must not resume straight away: the capture module writes to the new store as soon as it exists. Between the native delete and the reopen, a native write is refused with `SCHEMA_MISMATCH`, so one fix can be lost there.

## The retention hook

The purge and the weekly `VACUUM` live in `@findmyperson/shared` (`src/retention/`, and "Retention" in its README). This package gives them one place to plug in and builds none of it:

```ts
import { createRetentionMaintenance } from '@findmyperson/shared';

const store = await openStore({
  vault,
  driver,
  maintenance: createRetentionMaintenance({ deviceConditions }), // (db, nowTs) => Promise<void>
});
await store.runMaintenance(nowSeconds); // on every foreground, and every capture wake that runs JavaScript
```

One run derives stays, deletes everything past retention and, once a week while the phone is charging and idle, vacuums the file. `src/retention.test.ts` runs it on a real SQLCipher file: 60 days of data, nothing past 30 days left, and the file back to the size of a store that only ever held 30 days, with a second connection open as the native writer's is.

The app does exactly this (`createDataStore` and `StoreMaintenance` in `app/src/store/`): it opens the store at its first maintenance run and keeps the handle, with `deviceConditions` answered by the capture module. On Android it passes `vacuum: 'disabled'` until the checks under "Before the Android vacuum is switched on" have been made on a phone (`ANDROID_VACUUM_ENABLED` in `app/src/store/retention.ts`).

That purge is TypeScript and runs when JavaScript runs. On a capture wake with no JavaScript the capture modules purge fixes and stays themselves, with the purge statements of `native-writer.json`; see "Retention" in `packages/shared/README.md`. They never vacuum.

## What SQLCipher does and does not protect (plan 4.3)

The key has to be readable by a background process while the phone is locked. So it protects the file when it is read outside the app: a backup that slipped through, a file-system dump, an image of a phone that is switched off. It does not protect against someone who has the phone unlocked or knows its PIN. "Encrypted on your device" is true; "safe from someone who knows your PIN" is not.

## Not verified

There is no phone, simulator or emulator in this work, and `app/ios` does not exist yet. Nothing below has been observed.

- **Anything on a device.** The Keychain item and the Keystore key surviving a reboot and being readable while locked; behaviour before the first unlock; `noBackupFilesDir` and `isExcludedFromBackup` actually keeping the files out of a real Google or iCloud backup; a phone maker's Keystore differing from AOSP.
- **op-sqlite itself.** `opSqliteDriver.ts` is type-checked against op-sqlite 18.2.5. op-sqlite cannot run SQLCipher under Node, so `openStore` is exercised through `@journeyapps/sqlcipher`, which is a different SQLCipher 4 build.
- **The Kotlin writer on Android.** `SqlcipherHostTest` runs the real Kotlin store and the real JNI code on a JVM, against SQLCipher built from op-sqlite's source for the machine the tests run on. That is the same C and Kotlin as on a phone, with another compiler, another linker and (on a Mac) another crypto provider. The Android build of it is compiled, linked and read, never executed. The five checks under "Before the Android vacuum is switched on" are what is missing.
- **Any iOS build of this package.** The podspec, the ObjC++ module (`RCTNativeEncryptedStore.mm`) and the link against op-sqlite's SQLCipher have never been through CocoaPods or Xcode. The Swift and C are compiled for macOS, run, and type-checked against the iPhone SDK. If the app links the system `libsqlite3` instead, the open fails with `NOT_SQLCIPHER` rather than writing plaintext.
- **The Android library inside the real app, on a phone.** In `app/android`, as in the link check, it is autolinked beside op-sqlite and the capture module, its Turbo Native Module is generated and compiled by React Native's plugin, its manifest is merged and a debug APK is assembled for arm64-v8a and armeabi-v7a (`compileSdk` 37, NDK 27.1). Neither APK has been installed, and a release build with R8 has not been made.
- **Where op-sqlite finds its SQLCipher flag in this monorepo.** The flag is set in both `app/package.json` and the root `package.json` because its Android and iOS builds look in different places. If it is missed, `openStore` fails with `NOT_SQLCIPHER`.
- **`scripts/check-merged-manifest.ts` and `scripts/check-native-libs.ts` on a release build of the real app.** Both run on the app's debug build (`build/build-android.sh debug`), on the link check's merged manifest and APK, and on fixtures. `check-native-libs.ts` was also run on the M0 store proof's APK, which has both libraries, and refuses it.
- **16 KB pages.** `libfmp-store-jni.so` is built with `ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES`, as op-sqlite is. No such phone has loaded it.

Verified here, on a Mac: 117 TypeScript tests (open, mismatch matrix, migrations, retention and delete-all on real SQLCipher; the policy checks; the native-library check; codegen), 46 Kotlin JVM tests of which 11 run the store and the JNI code on SQLCipher 4.19.0 built from op-sqlite's source, the link check's APK built and read (one SQLite, in `libop-sqlite.so`; the NDK's `llvm-readelf` agrees with the reader here), and the Swift store's self-test and cross-language tests against the same SQLCipher. The Linux halves of these run in CI.

## Commands

```sh
pnpm exec vitest run packages/encrypted-store       # all TypeScript tests; on a Mac also builds and runs the Swift host check
pnpm exec vitest run packages/encrypted-store -u    # also rewrite StoreContract.kt, StoreContract.swift and contracts/
pnpm --filter @findmyperson/encrypted-store typecheck

# Kotlin unit tests, a compile of the Turbo Native Module, and the Kotlin store on real SQLCipher
# (JDK 17, Android SDK, Gradle 9.4; -PfmpHostSqlcipher also needs a C compiler and `pnpm install`)
gradle -p packages/encrypted-store/android -PfmpCompileReactGlue -PfmpHostSqlcipher testDebugUnitTest

# The link check: build the APK with the NDK and read its native libraries and merged manifest
build/android-linkcheck.sh

# The Swift host check by itself
packages/encrypted-store/ios/build-host-check.sh typecheck
```
