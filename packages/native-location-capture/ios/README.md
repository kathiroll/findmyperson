# iOS capture module

The Swift implementation of `../src/specs/NativeLocationCapture.ts`: background location capture on an iPhone, written into the encrypted store without a coordinate ever reaching JavaScript. It replaces the M0 trial app (`m0/ios`) as the production code. The interface and its rules are in the spec file and `../README.md`; this file covers what is specific to iOS.

**Nothing here has run on a phone or a simulator.** "Verified and not verified" at the end says exactly what was checked and how.

## Map

| Path                                             | What it is                                                                             | Tested by `swift test` |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------- |
| `Sources/CaptureCore/CaptureEngine.swift`        | The state machine: every spec method, every Core Location callback. Start here         | yes                    |
| `Sources/CaptureCore/Ports.swift`                | What the engine needs from the phone, as protocols                                     | yes                    |
| `Sources/CaptureCore/FixFilter.swift`            | The interval-or-distance rule                                                          | yes                    |
| `Sources/CaptureCore/SQLiteCaptureStore.swift`   | Host-test opener only; excluded from the production pod                                | yes                    |
| `Sources/CaptureCore/Geo.swift`                  | H3 cells and haversine distance, matching `packages/shared/src/geo`                    | yes                    |
| `Sources/CaptureCore/PersistedState.swift`       | What survives a process death (no coordinates), as a JSON file                         | yes                    |
| `Sources/CaptureCore/FileDiagnosticsLog.swift`   | The local capture-health log                                                           | yes                    |
| `Sources/CaptureCore/Contracts.generated.swift`  | Generated from `packages/shared/contracts` by `scripts/gen-contracts.mjs`. Do not edit | yes                    |
| `Sources/Platform/CoreLocationSystem.swift`      | The engine's `LocationSystem` over three `CLLocationManager` objects                   | no, compiled only      |
| `Sources/Platform/SystemAdapters.swift`          | Low Power Mode, Background App Refresh and device/network conditions                   | no, compiled only      |
| `Sources/Platform/EncryptedCaptureStore.swift`   | Thin ports to `EncryptedStore.shared`, the sole key/path/connection owner              | host integration       |
| `Sources/Platform/FMPCaptureBridge.swift`        | The singleton that builds the engine, and the Objective-C face the Turbo Module calls  | no, compiled only      |
| `Sources/Bridge/RCTNativeLocationCapture.{h,mm}` | The Turbo Native Module: a shim over `FMPCaptureBridge`                                | no, compiled only      |
| `Sources/Bridge/FMPCaptureLaunchObserver.m`      | Restarts capture on every app launch                                                   | no, compiled only      |
| `Sources/CH3/`                                   | The H3 C library 4.5.0, vendored unmodified by `scripts/vendor-h3.sh` (Apache-2.0)     | yes                    |
| `Sources/FMPSQLite/`                             | Declarations of the SQLite C functions the store calls                                 | yes                    |
| `Tests/CaptureCoreTests/`                        | XCTest. `Support/Fakes.swift` is the phone a test drives                               |                        |
| `Package.swift`                                  | Exists only for `swift test`. The app builds from `../FMPLocationCapture.podspec`      |                        |
| `scripts/`                                       | `check-ios.sh`, `test-sqlcipher.sh`, `gen-contracts.mjs`, `vendor-h3.sh`               |                        |

The split is the point of the design. Everything that decides something is in `CaptureCore`, which imports only Foundation and is tested on a Mac or on Linux. `Platform` and `Bridge` translate between that and iOS and hold no decisions, because nothing in this project can run them (no simulators, no phone on CI).

## How capture works

Four Core Location services, as chosen in the architecture plan (section 5.3) and tried on a real iPhone 13 in M0:

| Service                     | Role                                                                                 | Survives the process dying | Needs  | Sample `source` |
| --------------------------- | ------------------------------------------------------------------------------------ | -------------------------- | ------ | --------------- |
| Continuous updates          | The sampler. About one fix a second while it runs                                    | no                         | any    | `continuous`    |
| Significant location change | iOS relaunches the app after roughly 500 m of movement                               | yes                        | Always | `slc`           |
| Visits (`CLVisit`)          | Relaunches the app, and is the dwell source: each visit becomes a `stay` row         | yes                        | Always | none, see below |
| Exit region                 | A circle around the last stored sample. iOS relaunches the app when the phone leaves | yes                        | Always | `region`        |

"The mechanism is alive" (`CaptureStatus.running`) means continuous updates are running.

**Storing a fix.** A fix is stored when `minIntervalSec` has passed since the last stored sample or the phone is `minDistanceM` from it (`FixFilter`). Core Location is given no distance filter, so a phone that is sitting still keeps producing fixes and one is stored per interval; stays are built from those. The distance is measured from the last sample this process stored. A fresh process has not stored one, and the position of the last sample is in the encrypted store, which the module never reads. So until it stores a sample, a new process measures from the first fix it sees, and relies on the exit region: iOS remembers that circle across process deaths, and leaving it stores the next fix (source `region`) whatever the interval says.

**Visits become stays (plan 5.4).** An arrival inserts an open `stay` row with source `visit`; the departure closes it; a visit iOS reports only at departure is inserted closed. The statements are `insertVisitStaySql` and `closeVisitStaySql` from `packages/shared/contracts/native-writer.json`, and the row contract is in `packages/shared/src/store/tables/stay.ts`. Visits are not also written as samples and emit no `onSampleWritten`: the M0 trial showed a visit is reported minutes to hours after the fact, so it is a dwell interval and not a fresh fix. iOS can report the same visit again after a relaunch; the arrival and departure times seen last are kept so it is written once.

**Relaunch.** iOS never restarts continuous updates. When it relaunches the dead app for a significant change, a visit or a region exit, the only code that runs is the launch. `FMPCaptureLaunchObserver.m` hooks `UIApplicationDidFinishLaunchingNotification` and calls `FMPCaptureBridge.resume`, which reads the stored selection and starts everything again with no JavaScript. An app can also call `FMPCaptureBridge.resume(launchOptions:)` from `application(_:didFinishLaunchingWithOptions:)`; whichever comes first acts.

**After a restart of the phone.** Until the first unlock, the Keychain and the module's files cannot be read. The engine does not treat an unreadable state file as "nothing selected": it waits, reports `store_unusable`, writes nothing, and resumes when iOS announces that protected data is available.

**The watchdog.** iOS runs no timer for a suspended app. `reconcile` in the engine is called on every wake path (launch, permission change, return to the foreground, unlock) and makes what is running match what is selected, which is how a mechanism iOS refused comes back.

## Retention

The full purge is TypeScript and runs when the app does. A phone on which the app is never opened only ever runs this module, so storing a sample or a visit, and every launch with capture selected, also purges: `purgeIfDue` in the engine asks the store to delete the fixes and stays past retention, and `EncryptedCaptureStore` delegates to the store package, whose `EncryptedStore.purgeExpired` runs the four purge statements of `native-writer.json` in one `BEGIN IMMEDIATE` transaction, with the cutoff `retentionSec` behind the clock.

- **At most once an hour per process** (`Tunables.purgeIntervalSec`): a phone on the move stores a fix every few seconds. The time of the last purge is kept in memory only and never decides what is deleted, so a relaunched process purges at once, and a purge after a long gap or a changed clock deletes exactly what one at that moment should.
- **A failed purge changes nothing**, is logged as `retention_purge_failed`, and is tried at the next wake. It does not raise `store_unusable`. A store that is already unusable is not purged.
- **`retention_purge`** in the diagnostics carries `samples=N,stays=N,trimmed=N`, and is written only when something was removed.
- **Nothing is derived and nothing is vacuumed here.** Both are TypeScript's. The vacuum runs in the app when `getDeviceConditions` says charging and idle.

`getDeviceConditions`: `charging` is `UIDevice.batteryState` being `.charging` or `.full` (battery monitoring is switched on when the module is built), and `idle` is `UIApplication.applicationState` not being `.active`, which covers the background, a locked phone and a dark screen alike.

`getNetworkConditions` answers the bundle fetcher (TypeScript, `packages/shared`, `src/fetch/`), which puts a cycle off on a metered connection. `SystemDeviceConditions` runs one `NWPathMonitor` for the life of the process, on the main queue, and keeps the path it last reported; the engine calls a satisfied path metered when it is expensive (mobile data, a personal hotspot) or constrained (Low Data Mode). With no satisfied path, or before the monitor's first report, the answer is metered, so the fetcher waits. `NetworkTests` covers the answers against the fake phone. Not verified on a phone: what the path reports on each kind of connection, and that the first report has arrived by the time JavaScript first asks.

`RetentionTests` covers when the purge is asked for and the getter; `StoreTests` runs the purge on the real schema, and under `scripts/test-sqlcipher.sh` on an encrypted one.

## Health flags

Each is produced by its real condition and tested (`EngineTests`, `CaptureFlowTests`, `RelaunchTests`).

| Flag                            | Raised when                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `background_permission_missing` | Authorization is anything but Always                                                                              |
| `precise_location_off`          | The user allowed approximate location only (`accuracyAuthorization`)                                              |
| `location_services_off`         | Location Services is off for the whole phone                                                                      |
| `service_not_running`           | Capture is selected and continuous updates are not running: no permission, services off, or Core Location refused |
| `store_unusable`                | The last store check failed, or the phone has not been unlocked since it restarted                                |
| `background_refresh_off`        | Background App Refresh is off or restricted. iOS then relaunches the app for nothing                              |
| `low_power_mode`                | Low Power Mode is on                                                                                              |

Tier: `background_updates` with Always, `throttled` with "While Using", `stopped` otherwise. Mode: `ios` or `stopped`.

## What the app has to provide

The module cannot add these itself. The real `app/ios` supplies them; see `docs/BUILDING.md`.

| Where                   | What                                                                                     | Without it                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Info.plist`            | `UIBackgroundModes` containing `location`                                                | Capture runs only while the app is on screen               |
| `Info.plist`            | `NSLocationWhenInUseUsageDescription` and `NSLocationAlwaysAndWhenInUseUsageDescription` | iOS shows no permission prompt                             |
| `app/package.json`      | `"op-sqlite": { "sqlcipher": true }`                                                     | No SQLCipher in the app: `store_unusable`, nothing written |
| App delegate (optional) | `FMPCaptureBridge.resume(launchOptions:)` in `didFinishLaunchingWithOptions`             | The launch observer does it anyway                         |

## Files on the phone

All in `Application Support/findmyperson-store/`, which is excluded from backups and has the protection class `completeUntilFirstUserAuthentication`.

| File                        | Holds                                                                         | Coordinates |
| --------------------------- | ----------------------------------------------------------------------------- | ----------- |
| `findmyperson.db`           | The encrypted store. Created and migrated by TypeScript, never by this module | yes         |
| `capture-state.json`        | The selection, sample times of the last 24 hours, visit times, prompt flags   | never       |
| `capture-diagnostics.jsonl` | The capture-health log `getDiagnostics` returns                               | never       |

The encrypted-store package owns the Keychain key (`AfterFirstUnlockThisDeviceOnly`), directory and live connection. `FMPCaptureBridge` asks it for the capture-file directory and constructs only `EncryptedCaptureStore`/`EncryptedStoreKeySource` adapters. Capture never opens a database or makes a key. The vault closes the exact native writer connection before delete/key rotation; resuming the same engine writes the new file. The directory can be resolved before first unlock without reading protected files; database opens still require successful backup exclusion/key/schema checks. iOS itself holds one position for the module: the centre of the exit region. `stop()` removes it.

## Tests

```sh
cd packages/native-location-capture/ios
swift test                     # the state machine, 155 tests; Mac or Linux, no simulator
sh scripts/test-sqlcipher.sh   # the same on an encrypted store, against real SQLCipher, 159 tests; Mac
sh scripts/check-ios.sh        # production sources/dependency for arm64 iOS, Turbo Module shim included; Mac
sh scripts/test-store-integration.sh # production adapter + engine, host SQLCipher delete/resume; Mac
```

`swift test` runs in CI on every pull request (Linux). The other two need a Mac and run in the iOS job on `main`.

The scenarios the M0 trial checked by hand on a phone (plan S0.3), and the tests that now hold the module to them:

| M0 scenario                        | Tests in `RelaunchTests`                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Backgrounding                      | `testCaptureContinuesWhenTheAppLeavesTheScreen`                                                                                                 |
| Force-quit, then 500 m of movement | `testAfterAForceQuitIosCanStillRelaunchTheApp`, `testARelaunchForALocationEventRestartsCaptureWithNoJavaScript`, and the other `Relaunch` tests |
| Restart, then first unlock         | `testBeforeTheFirstUnlockNothingIsForgottenAndNothingIsWritten`, `testTheFirstUnlockAfterARestartResumesCapture`                                |
| Low Power Mode                     | `testLowPowerModeIsFlaggedAndCaptureKeepsRunning`                                                                                               |
| Background App Refresh off         | `testBackgroundAppRefreshOffIsFlaggedBecauseIosWillNotRelaunchTheApp`                                                                           |
| What `CLVisit` contributes         | `VisitTests`, and `StoreTests.testCaptureWritesSamplesAndVisitStaysIntoTheRealSchema`                                                           |

These tests fix what the module does when iOS behaves as the trial observed. They cannot show that iOS still behaves that way: that needs a phone.

**Coordinates.** `PrivacyTests` runs every path that handles a position with real files, then searches every event, status, diagnostic entry and both files for the coordinates' digits, and checks that the store did receive them.

**Contracts.** `ContractTests` and `GeoTests` compare the Swift side with `../contracts/schema.json`, `../src/constants.ts` and `packages/shared/contracts` (statements, cipher parameters, cell and distance vectors). After a contract changes, run `node scripts/gen-contracts.mjs`.

## Decisions made here

- **The spec's methods run on the main queue.** Core Location calls back there and the engine has no locks. Each call is short; the store is opened once and kept.
- **One store owner.** Production capture writes through `EncryptedStore.shared`, linked to op-sqlite's SQLCipher. `SQLiteCaptureStore` and its SQLite C front remain only for historical Foundation/SPM tests; the pod excludes the opener/front. The standalone SDK compile builds the encrypted-store Swift module before capture, matching the cross-pod dependency.
- **`start_failed` on iOS** is the case where Location Services is off although the app's permission is granted. The selection is kept and `reconcile` retries.
- **A fix timed more than one interval before the last sample is stored.** The interval rule uses the size of the gap, so setting the clock back cannot stop capture until the clock catches up. The fake applies only the distance rule to such a fix.

## Known limits

- **A visit whose departure iOS never reports stays open** in the store (`closed = 0`, `end_ts = start_ts`). Its departure is not known, and `closed = 1` would claim it is. Stay reconciliation in TypeScript (plan C2.4) must expect more than one open `visit` row.
- **A fix or visit that arrives while the store is unusable is dropped**, as the spec requires. It is logged, not queued.
- **The Always prompt is treated as spent once iOS has shown it.** iOS shows it once per install; `requestPermission('background')` then resolves with the unchanged state and only Settings can grant it.
- **`openSystemSettings('battery')` and `('hibernation')` resolve false.** iOS has no public page for either.

## Verified and not verified

Verified on a Mac, with no phone or simulator:

- The real RN 0.87.1 `app/ios` unsigned arm64 archive built on October 7, 2026 (Xcode 16.2/iPhoneOS 18.2); its artifact inspection passes for the compiled capture/store/random modules, one op-sqlite SQLCipher symbol owner, Hermes bundle/framework, fonts and location declarations. This is build evidence, not runtime permission/background proof.

- The state machine, with fakes for the phone: `swift test`, 155 tests.
- The store against real SQLCipher built from the C source op-sqlite vendors: opens an encrypted file with the pinned parameters, writes samples and visit stays into the real schema (`migration-v1.sql`), purges what is past retention from it, refuses a wrong key, other cipher parameters and a plaintext file, and leaves no plaintext on disk (`scripts/test-sqlcipher.sh`, 159 tests). That build uses CommonCrypto where the app uses OpenSSL.
- The **production** adapter and engine against real host SQLCipher (`test-store-integration.sh`): JS-first/native-first schema initialization, capture A → stop/delete/key rotation/reopen → capture B in the same process, separate reader sees only B, old key refuses the new file, native retention trims a visit and rewinds the derivation cursor. The reader plays JS's lifecycle with Swift SQLCipher; hardware op-sqlite concurrency remains unverified.
- Cells and distances against `geo-vectors.json`, with the same H3 version h3-js bundles.
- Every source file compiles for arm64 iOS 15.1 against the iPhoneOS 18.2 SDK: Swift, the vendored C, the launch observer, and the Turbo Module shim against React Native 0.87.1's headers and the committed codegen header (`scripts/check-ios.sh`).

Not verified on a physical iPhone: signing/install, offline launch, permission dialogs, background/locked writes and op-sqlite reading the same rows, same-process delete/resume with real callbacks, visit delivery/reconciliation, reboot/before-first-unlock recovery, long unattended capture. `app/ios` now exists and the shared build script exercises CocoaPods/linking; source/host checks alone do not close these device cases. Record exact device/OS/build/time and failures using `m0/ios/README.md`.
