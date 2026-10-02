# M0 store proof (S0.4): native writes, TypeScript reads, one encrypted file

A React Native app skeleton (TypeScript, New Architecture, React Native 0.87.1) that proves the part of the
architecture plan most likely to fail quietly: **a Kotlin / Swift module and op-sqlite + SQLCipher can open the
same encrypted SQLite file with the same cipher parameters** (plan section 4 and section 5.5, task S0.4). It is a
plumbing proof. The table has a timestamp and a label, never a location.

## What this proves, and how far

| Claim | Evidence in this repo | Needs a device? |
|---|---|---|
| The cipher parameters are one shared constant, not three copies | `shared/cipher-params.json` generates the TS, Kotlin and Swift constants; Jest fails if any is stale or if the native pragma lists differ from the TS ones | no |
| Swift writer opens the file with the pinned parameters, writes a row, and TS reads it back (and the reverse) | `__tests__/iosHostWrite.test.ts` runs the real `ios/StoreProof/Store/*.swift` on the Mac against SQLCipher 4.19.0 compiled from op-sqlite's own C source | the iPhone behaviour: yes |
| Kotlin writer compiles against the SQLCipher Android library and its pure logic is unit tested | Gradle build + `CipherParamsTest`, `ParamCheckTest` | running it: yes (needs the Android native library) |
| TypeScript read path works against real SQLCipher | `__tests__/store.test.ts` (28 Jest tests in 4 suites in total) | op-sqlite itself on a phone: yes |
| A deliberate parameter mismatch fails loudly, never silently | `store.test.ts` "deliberate parameter mismatch fails loudly" (below) | no |
| Native write while backgrounded and locked, TS read on next foreground | not provable here | yes, see "Device checks" |

## The pinned constant

One file is edited by hand: [`shared/cipher-params.json`](shared/cipher-params.json). `npm run gen:cipher` writes:

| Language | Generated file |
|---|---|
| TypeScript | `src/generated/cipherParams.generated.ts` |
| Kotlin | `android/app/src/main/java/com/storeproof/store/CipherParams.kt` |
| Swift | `ios/StoreProof/Store/CipherParams.swift` |

`npm run check:cipher` (also run by Jest) exits non-zero if a generated file is stale.

| Parameter | Pinned value | Why this value |
|---|---|---|
| SQLCipher major / `cipher_compatibility` | 4 / 4 | op-sqlite 18.2.5 vendors SQLCipher **4.19.0** (`CIPHER_VERSION_NUMBER` in its `cpp/sqlcipher/sqlite3.c`); the Android writer uses `net.zetetic:sqlcipher-android:4.19.0`. Bump op-sqlite and the Android dependency together |
| `cipher_page_size` | 4096 | SQLCipher 4 default |
| `kdf_iter` | 256000 | SQLCipher 4 default (see the raw-key note below: it does not change decryption here) |
| `cipher_kdf_algorithm` | `PBKDF2_HMAC_SHA512` | SQLCipher 4 default |
| `cipher_hmac_algorithm` | `HMAC_SHA512` | SQLCipher 4 default |
| Key format | 32 random bytes passed as the raw literal `x'<64 hex>'` | no PBKDF2 on every open, which matters in a background launch |
| Journal mode | `wal` | plan section 4 |

The pinned values are the SQLCipher 4 defaults on purpose, but they are still applied explicitly on every open
(`PRAGMA ...` lists in the generated constants), because op-sqlite 18.2.5 does not set any cipher pragma itself and a
future default change must not silently split the two sides.

Every open, in TypeScript, Kotlin and Swift alike, does the same steps in the same order: set key, apply the pragmas,
check `PRAGMA cipher_version` is 4.x, **read every pragma back and compare with the pinned constant**, do a first real
read (`SELECT count(*) FROM sqlite_master`), set WAL, create the table. Any failure throws (`StoreOpenError` /
`StoreOpenException` / Swift `StoreOpenError`) with a code: `NOT_SQLCIPHER`, `PARAM_MISMATCH`, `BAD_KEY_OR_PARAMS`,
`OPEN_FAILED`.

### Things this work found that the plan did not say

1. **A raw key makes `kdf_iter` irrelevant to decryption.** Tested against real SQLCipher: a file written with the
   default `kdf_iter` opens and reads cleanly with `kdf_iter = 1000` and a raw key. SQLCipher alone would not notice a
   KDF iteration mismatch, which is why the read-back of every pinned pragma exists (`PARAM_MISMATCH`). Page size, HMAC
   algorithm, KDF algorithm and `cipher_compatibility` mismatches do make the file unreadable and surface as
   `file is not a database` at the first read (`BAD_KEY_OR_PARAMS`). If you prefer passphrase mode, `kdf_iter`
   then matters, at the cost of 256000 PBKDF2 rounds on every open; changing it is a one-line edit of the JSON plus
   the key helpers. Raw key was chosen here as a judgment call, to keep background launches cheap.
2. **op-sqlite silently ignores a missing key and a missing SQLCipher build.** `cpp/OPBridge.cpp` only calls
   `sqlite3_key_v2` when the key is non-empty, and a build without `"op-sqlite": {"sqlcipher": true}` opens a plaintext
   file with no error. `openStore` therefore refuses to continue unless `isSQLCipher()` is true and `cipher_version` is 4.x.
3. **op-sqlite's Node build cannot run SQLCipher.** `node/dist/index.js` in the package only logs a warning when given
   an encryption key and opens plaintext. The Jest tests therefore use `@journeyapps/sqlcipher` (SQLCipher 4.14.0
   community) behind the small `SqlDriver` interface in `src/store/driver.ts`. Everything above that interface (open,
   verify, read) is the code that runs on a phone; the op-sqlite adapter itself (`src/store/opSqliteDriver.ts`) is
   type-checked but could not be executed.

## Why the native module writes directly, not through JS

Plan section 5.5, rule 1, and the comment at the top of `NativeStoreWriter.kt` / `NativeStoreWriter.swift`: when the OS
starts the app for a background wake there is no React instance and no JS thread, so nothing could receive a sample
and hand it to op-sqlite. The native side must open the encrypted file and commit by itself. It also keeps coordinates
off the JS bridge, where a crash report or a stray `console.log` could capture them.

## Layout

| Path | What |
|---|---|
| `shared/cipher-params.json`, `scripts/gen-cipher-params.mjs` | the single pinned constant and its generator / drift check |
| `src/specs/NativeStoreProof.ts` | Turbo Native Module spec (codegen input): `getOrCreateKeyHex`, `writeProbeRow(dbPath, label, delaySeconds)`, `getDatabaseDirectory` |
| `src/store/` | TS store: `pragmas.ts`, `openStore.ts` (open + verify + read), `opSqliteDriver.ts` (production driver), `driver.ts`, `errors.ts` |
| `App.tsx` | three buttons: write natively (now / in 20 s), read in TypeScript |
| `android/app/src/main/java/com/storeproof/` | `StoreProofModule` / `StoreProofPackage` (Turbo module), `store/NativeStoreWriter`, `KeystoreKeyProvider`, `ParamCheck`, `StoreKeys` |
| `android/app/src/debug/` | debug-only `WriteRowReceiver` (JS-free trigger for the device check) |
| `android/app/src/test/` | JVM unit tests |
| `ios/StoreProof/Store/`, `StoreProofBridge.swift`, `RCTNativeStoreProof.mm` | Swift writer, Keychain key, ObjC++ Turbo module shim |
| `ios/HostCheck/`, `ios/build-host-check.sh` | macOS harness that runs the Swift writer against real SQLCipher |
| `__tests__/`, `test-support/` | Jest tests and the Node SQLCipher driver / native-writer stand-in |

Key storage (plan section 4.4): iOS Keychain `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; Android Keystore AES-GCM
key (no `setUnlockedDeviceRequired`, no user authentication) wrapping the database key in app-private SharedPreferences.
This differs from the plan in one respect: plain SharedPreferences instead of `EncryptedSharedPreferences` (which is
deprecated), the key is wrapped by the Keystore key either way. Both native sides read the key themselves; JS gets it
through `getOrCreateKeyHex()` only because op-sqlite takes the key as a string. Android `allowBackup` is `false`; the iOS
database and its WAL / SHM files get `NSFileProtectionCompleteUntilFirstUserAuthentication` and are excluded from backup
after each write.

## Running the checks

Prerequisites: Node 22+, `npm install` once in this directory. Android needs the toolchain from `m0/env.sh`
(`source m0/env.sh`, JDK 17) and the Android SDK packages that React Native 0.87 asks for (platform `android-37.0`, build tools
37.0.0 and 36.0.0, NDK 27.1.12297006, CMake 3.22.1; the machine-wide SDK from the M0 tooling task only has platform 35, so
install these with `sdkmanager`, into the same SDK or a separate `--sdk_root`) plus `android/local.properties` with
`sdk.dir=...` (git-ignored). iOS checks need Xcode 16 command line tools. A real iOS build additionally needs CocoaPods
(`bundle install && cd ios && bundle exec pod install`), which is not installed here.

    cd m0/store-proof
    npm install
    npm run check:cipher      # generated TS/Kotlin/Swift constants match shared/cipher-params.json
    npm run typecheck         # tsc: app, store, spec, tests
    npm test                  # Jest: store, mismatch matrix, cipher drift, Swift-on-the-Mac round trip, App render

    # iOS: type-check every Swift file against the iPhone SDK (no signing, no simulator)
    cd ios && xcrun --sdk iphoneos swiftc -typecheck -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
      -target arm64-apple-ios15.1 -swift-version 5 -module-name StoreProof \
      -import-objc-header StoreProof/StoreProof-Bridging-Header.h \
      -Xcc -I../node_modules/@op-engineering/op-sqlite/cpp/sqlcipher \
      StoreProof/Store/*.swift StoreProof/StoreProofBridge.swift

    # iOS: build and run the Swift writer on the Mac (first build compiles SQLCipher, about a minute)
    ./build-host-check.sh && build/host-check selftest ../shared/cipher-params.json

    # Android: compile everything (debug) and run the JVM tests
    cd ../android && ./gradlew :app:testDebugUnitTest :app:assembleDebug

### The deliberate mismatch tests (`__tests__/store.test.ts`)

| Scenario | Result |
|---|---|
| Writer used page size 1024 / HMAC_SHA1 / `cipher_compatibility = 3` | TS open throws `StoreOpenError` `BAD_KEY_OR_PARAMS` ("file is not a database") |
| Wrong key | `BAD_KEY_OR_PARAMS` |
| Reader (TS) applies `kdf_iter = 1000` | `PARAM_MISMATCH`: "kdf_iter: pinned 256000, effective 1000" |
| Reader applies page size 1024 | `PARAM_MISMATCH` |
| Control: SQLCipher alone with `kdf_iter = 1000` and a raw key | opens and reads without error (the silent case the read-back exists for) |
| Plaintext file, or a library built without SQLCipher | `BAD_KEY_OR_PARAMS` / `NOT_SQLCIPHER`, never an empty result |
| Malformed key | thrown before any file is touched |

The native writers' mismatch logic (`ParamCheck`) is covered on the JVM by `ParamCheckTest` and in Swift by
`host-check selftest` with a fake pragma reader.

## Build verification (what was actually run)

Run on the Mac that built this, no phone, no simulator, no emulator:

| Check | Result |
|---|---|
| `npm run check:cipher`, `npm run typecheck`, ESLint on `App.tsx src __tests__ test-support` | pass |
| `npm test` | 28 tests, 4 suites, pass (store and mismatch matrix against SQLCipher 4.14.0 for Node; cipher drift; Swift writer on the Mac against SQLCipher 4.19.0 source; App render with the native modules mocked) |
| `xcrun --sdk iphoneos swiftc -typecheck ...` (command above) against iPhoneOS 18.2 SDK, target arm64-apple-ios15.1 | all Swift files type-check, including the Keychain provider and the UIKit bridge |
| `ios/build-host-check.sh` then `host-check selftest`, `write`, `read` | Swift writer builds, passes its self-test, writes a row that TypeScript reads back, reads a file TypeScript-side tooling wrote, and throws `BAD_KEY_OR_PARAMS` on a wrong key |
| `./gradlew :app:testDebugUnitTest` (Gradle 9.4.1, JDK 17, compileSdk 37, NDK 27.1.12297006) | builds, 10 JVM tests pass (`CipherParamsTest` 6, `ParamCheckTest` 4) |
| `./gradlew :app:assembleDebug` | builds a debug APK (React Native 0.87.1 New Architecture, Hermes, codegen for the Turbo spec, op-sqlite compiled with the SQLCipher flag). The APK contains `libop-sqlite.so`, `libcrypto.so` (op-sqlite's OpenSSL), `libsqlcipher.so` (Zetetic, for the Kotlin writer), the debug-only `WriteRowReceiver`, and `allowBackup=false`. The APK was not installed or signed for release |
| `xcodebuild -list -project ios/StoreProof.xcodeproj` | project parses and lists target and configurations; no build |

Android ends up with two copies of SQLCipher in one process: op-sqlite's (statically inside `libop-sqlite.so`, for JS) and Zetetic's
`libsqlcipher.so` (for the Kotlin writer). Both are 4.19.0 and live in separate `.so` files; whether they coexist without symbol
clashes on a device is a device check. On iOS there is only op-sqlite's copy, shared with Swift through the bridging header
(plan section 4's "native writer must link a compatible SQLCipher build" is satisfied by linking the very same one).

## Device checks (what still needs a real phone)

Nothing below ran. Each is a yes / no for the captain's test phones.

1. **Background write while locked.** Does a real background-launched native write complete before the OS kills the
   process? Procedure: install a debug build, open the app, tap "Read in TypeScript" once (creates the database).
   *Android, JS-free:* lock the phone, run `adb shell am broadcast -n com.storeproof/.WriteRowReceiver` from the Mac,
   check `adb logcat -s FmpStoreProof` for `WROTE`, unlock, open the app, tap "Read in TypeScript", expect a row labelled
   `broadcast-no-js`. *iOS and Android, in-app proxy:* tap "Write natively in 20 s", background the app, lock the phone,
   wait a minute, unlock, reopen, tap "Read in TypeScript". On iOS the 20 s write is held by a background-task assertion
   (the OS grants about 30 s), which is a proxy for a location-triggered relaunch and not the same thing; the real test
   is the S0.2 / S0.3 relaunch.
2. **Keychain / Keystore accessibility.** Does the iOS Keychain item with `AfterFirstUnlockThisDeviceOnly`, and the Android
   Keystore key without unlock requirements, actually behave as AfterFirstUnlock-equivalent in practice? That means the
   write above works with the phone locked, and fails with a clear error (not a silently regenerated key) before the first
   unlock after a reboot. Reboot the phone, do not unlock, trigger the write, expect a failure; unlock once, expect success.
   Some Android OEMs have shipped Keystore behaviour that differs from AOSP; this has not been tried on the Xiaomi or OnePlus.
3. **op-sqlite on a phone.** `npm install` + a real build of both apps (see below), then the app's "Read in TypeScript" shows
   the rows the native side wrote. This confirms the op-sqlite SQLCipher build (OpenSSL provider) and the native writer
   (Zetetic's Android library, or the OPSQLite pod's symbols on iOS) agree on the file format on real hardware.
4. **WAL files across processes.** A background write leaves `-wal` / `-shm` files; confirm TS reads them on next open and
   that the iOS file-protection class applied to them behaves (a locked, unlocked-once phone can still write).
5. **Android process death during a write**, and whether a delayed write (`Thread.sleep`) in a cached background process
   survives long enough; this is a proxy only, the debug receiver is the cleaner test.

## What could NOT be verified here (no phone, no emulator, no simulator)

- Anything on a device: items 1 to 5 above. No code in this directory has run on an iPhone or an Android phone.
- **The iOS React Native build.** The Android app builds end to end (see "Build verification"); the iOS app was not built. The
  Xcode project and the ObjC++ Turbo module shim (`RCTNativeStoreProof.mm`) were not compiled, because CocoaPods is not
  installed on this machine and `pod install` is a prerequisite for any build of an RN iOS app. The pbxproj edit
  (new files, bridging header, header search path) is checked only as a valid property list that `xcodebuild -list` accepts.
  The `.mm` was written against the protocol that RN's codegen emitted for the spec (method signatures compared by hand).
- **That the Swift writer binds to op-sqlite's SQLCipher and not the system `libsqlite3`** in the linked app. The design
  relies on the bridging header coming from op-sqlite's `cpp/sqlcipher` and on the app never linking `libsqlite3` itself.
  If the link picks the system library instead, `PRAGMA cipher_version` returns nothing and the open throws
  `NOT_SQLCIPHER` rather than writing a plaintext file, but a link-time conflict is possible and only a real build shows it.
- **op-sqlite's own code path.** `opSqliteDriver.ts` type-checks against op-sqlite 18.2.5's types, but op-sqlite cannot
  run SQLCipher under Node (finding 3), so the TS read path was exercised through the Node SQLCipher stand-in
  (SQLCipher 4.14.0, not the 4.19.0 op-sqlite vendors) and the iOS host build (4.19.0 source, CommonCrypto instead of OpenSSL).
- **The Android writer against real SQLCipher.** `libsqlcipher.so` is an Android native library; there is no JVM-side
  run of `NativeStoreWriter`. The Swift writer is the same logic and does run (on a Mac), which is the closest evidence.
- Android `sqlcipher-android` hook semantics (`postKey` applying the `PRAGMA`s before the first read) are taken from
  the library's API and documentation, not observed.
- Whether `enableWriteAheadLogging()` on Zetetic's wrapper leaves `journal_mode` as `wal` at the pragma level (checked in
  code and fails loudly if not, but unobserved).
