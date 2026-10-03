# @findmyperson/encrypted-store

The on-device store, as a real encrypted file on a phone. Location samples, stays, cached reports and matches live here and nowhere else.

`@findmyperson/shared` defines what is in the store: the schema, the migrations, the SQLCipher parameters and one typed module per table. This package adds what turns that into a file: the key, the directory, the open-and-check sequence, backup exclusion, and "Delete all my data". It defines no table and no query of its own.

It has three halves that must agree, and tests that fail when they stop agreeing:

| Half       | Where      | What it does                                                                                                    |
| ---------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| TypeScript | `src/`     | Opens the file through op-sqlite, proves the cipher parameters, runs migrations, resets the store               |
| Kotlin     | `android/` | Holds the key (Android Keystore), names the no-backup directory, writes samples for the capture module          |
| Swift      | `ios/`     | Holds the key (Keychain), names the backup-excluded directory, writes samples and visits for the capture module |

## Importing

| Import                                  | Gives you                                                                 | Loads react-native |
| --------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| `@findmyperson/encrypted-store`         | `openStore`, `deleteAllData`, `StoreError`, constants and types           | no                 |
| `@findmyperson/encrypted-store/native`  | `NativeEncryptedStore` (the real native module) and `opSqliteDriver`      | yes                |
| `@findmyperson/encrypted-store/testing` | `createTestVault`, `nodeSqlcipherDriver`: a real SQLCipher store for Node | no                 |

Runtime exports of the root: `openStore`, `deleteAllData`, `StoreError`, `STORE_ERROR_CODES`, `STORE_BUSY_TIMEOUT_MS`, `STORE_DIRECTORY_NAME`, `STORE_FILE_SUFFIXES`, `NATIVE_MODULE_NAME`, `packageName`.

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

`getOrCreateStoreKeyHex` and `getStoreDirectory` exist on both the capture module and this package's own small Turbo Native Module (`NativeEncryptedStore`). Both answer from the class above, so they cannot disagree. This package has its own module because the app needs the key, the directory and the delete even if capture is never started.

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

**iOS.** The store is in `<Application Support>/fmp-store`, and that directory carries `isExcludedFromBackup`. iOS has no durable directory that is outside backups by location alone: `Library/Caches` and `tmp` are, but the system may empty them when storage runs low, and the history must not vanish that way. Excluding the directory covers the `-wal` and `-shm` files SQLite recreates and the database file that "Delete all my data" recreates. The flag is set and then read back on every open; a store whose directory is not excluded is not opened (`BACKUP_NOT_EXCLUDED`).

**What enforces it:**

| Check                                                             | Runs                                           | Fails when                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/policy.test.ts`                                              | every pull request (`pnpm test`)               | any manifest in the repo sets `allowBackup` to anything but `"false"`, removes it, or the rule files stop excluding a domain; the Android path stops being the no-backup directory; the iOS path, exclusion flag, file protection or Keychain class changes |
| `scripts/check-merged-manifest.ts`, from `build/build-android.sh` | every Android build, once `app/android` exists | the manifest Gradle actually merged allows backup. This is the one that sees third-party libraries                                                                                                                                                          |
| `StorePathsTest`, `EncryptedStoreTest`                            | every pull request (`store-android` job)       | a store file is outside the no-backup directory; a store opens in an app that allows backup                                                                                                                                                                 |
| `ios/HostCheck` through `src/iosHost.test.ts`                     | `pnpm test` on a Mac; the `ios` job on `main`  | the real Swift code leaves the directory without the exclusion flag, read back from the file system                                                                                                                                                         |

`src/backupPolicy.ts` is the rule itself; the first two checks share it.

## Delete all my data (plan 4.7)

```ts
store = await deleteAllData({ vault: NativeEncryptedStore, driver: opSqliteDriver }, store);
```

It closes the JavaScript connection; the native side closes its own, deletes the file with its `-wal` and `-shm` and deletes the key (on Android also the Keystore key that wrapped it); then the store is opened again, which makes a new key and a new file at the current schema. It then checks that the key really changed and that the new file really started empty, and throws `KEY_NOT_ROTATED` or `DELETE_INCOMPLETE` otherwise, so a Settings screen cannot report a delete that did not happen.

Pass `null` as the second argument when the store could not be opened at all. Call `LocationCapture.stop()` first if capture must not resume straight away: the capture module writes to the new store as soon as it exists. Between the native delete and the reopen, a native write is refused with `SCHEMA_MISMATCH`, so one fix can be lost there.

## The retention hook

The purge and the weekly `VACUUM` are a later task (C2.5). This package gives it one place to plug in and builds none of it:

```ts
const store = await openStore({ vault, driver, maintenance: purge }); // purge: (db, nowTs) => Promise<void>
await store.runMaintenance(nowSeconds); // the app calls this on every foreground
```

The plan also wants a purge on every capture wake. That runs natively and needs delete statements added to `native-writer.json`; it is not here.

## What SQLCipher does and does not protect (plan 4.3)

The key has to be readable by a background process while the phone is locked. So it protects the file when it is read outside the app: a backup that slipped through, a file-system dump, an image of a phone that is switched off. It does not protect against someone who has the phone unlocked or knows its PIN. "Encrypted on your device" is true; "safe from someone who knows your PIN" is not.

## Not verified

There is no phone, simulator or emulator in this work, and `app/android` and `app/ios` do not exist yet. Nothing below has been observed.

- **Anything on a device.** The Keychain item and the Keystore key surviving a reboot and being readable while locked; behaviour before the first unlock; `noBackupFilesDir` and `isExcludedFromBackup` actually keeping the files out of a real Google or iCloud backup; a phone maker's Keystore differing from AOSP.
- **op-sqlite itself.** `opSqliteDriver.ts` is type-checked against op-sqlite 18.2.5. op-sqlite cannot run SQLCipher under Node, so `openStore` is exercised through `@journeyapps/sqlcipher`, which is a different SQLCipher 4 build.
- **The Kotlin writer against real SQLCipher.** `SqlcipherDatabase.kt` compiles against Zetetic's library, which is an Android native library and cannot load on a JVM. Its logic is tested through a fake connection. The Swift writer is the same logic and does run.
- **Any iOS build of this package.** The podspec, the ObjC++ module (`RCTNativeEncryptedStore.mm`) and the link against op-sqlite's SQLCipher have never been through CocoaPods or Xcode. The Swift and C are compiled for macOS, run, and type-checked against the iPhone SDK. If the app links the system `libsqlite3` instead, the open fails with `NOT_SQLCIPHER` rather than writing plaintext.
- **The Android library inside the app.** Standalone it compiles at `compileSdk` 35, runs its tests, and its Turbo Native Module compiles against `react-android` 0.87.1 and the committed codegen output. It has not been autolinked into an app, merged its manifest with an app's, or been assembled (`sqlcipher-android` 4.19.0 requires `compileSdk` 37 for that, which the app supplies).
- **Where op-sqlite finds its SQLCipher flag in this monorepo.** The flag is set in both `app/package.json` and the root `package.json` because its Android and iOS builds look in different places. If it is missed, `openStore` fails with `NOT_SQLCIPHER`.
- **`scripts/check-merged-manifest.ts` on an app build.** It was run on the manifests the Android Gradle Plugin produced for this library and on fixtures, not on an app's merged manifest.

Verified here, on a Mac: 87 TypeScript tests (open, mismatch matrix, migrations and delete-all on real SQLCipher; the policy checks; codegen), 33 Kotlin JVM tests, and the Swift store's self-test and cross-language tests against SQLCipher 4.19.0 built from op-sqlite's source.

## Commands

```sh
pnpm exec vitest run packages/encrypted-store       # all TypeScript tests; on a Mac also builds and runs the Swift host check
pnpm exec vitest run packages/encrypted-store -u    # also rewrite StoreContract.kt, StoreContract.swift and contracts/
pnpm --filter @findmyperson/encrypted-store typecheck

# Kotlin unit tests, and a compile of the Turbo Native Module (JDK 17, Android SDK, Gradle 9.4)
gradle -p packages/encrypted-store/android -PfmpCompileReactGlue testDebugUnitTest

# The Swift host check by itself
packages/encrypted-store/ios/build-host-check.sh typecheck
```
