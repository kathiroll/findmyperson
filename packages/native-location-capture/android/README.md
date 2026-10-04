# Android implementation of the capture module

Kotlin implementing `../src/specs/NativeLocationCapture.ts`. The module class extends the class React Native's codegen generates from that spec (`NativeLocationCaptureSpec`), so a method missing or mistyped here is a compile error, not a runtime surprise.

It is the M0 Android trial app (`m0/android`) hardened: the same two mechanisms, boot receiver and hourly watchdog, with the trial's single screen replaced by the spec, its CSV log by structured diagnostics, and everything the trial left to a person watching the phone turned into a state machine with tests.

**Nothing here has run on a phone.** It compiles against React Native 0.87.1 and the Android SDK, passes Android lint, and its logic is unit-tested on the JVM. What that does and does not prove is listed under "Verified and not verified".

## Commands

```sh
source build/env.sh                                  # from the repo root: JDK 17 and the Android SDK
cd packages/native-location-capture/android
./gradlew testDebugUnitTest lintDebug assembleDebug  # what CI runs
```

This directory builds by itself (Gradle 8.9 wrapper, Android Gradle Plugin 8.7.3, Kotlin 2.2.0), with no React Native build: it compiles the committed copy of the generated class (`../contracts/android`) against `react-android` from Maven. Inside the app the same `build.gradle` is an autolinked library and React Native generates that class itself.

## Map

| Path under `src/main/java/dev/findmyperson/locationcapture/` | What it is                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `core/CaptureEngine.kt`                                      | The state machine: every decision of the module. Start here                                                         |
| `core/Ports.kt`                                              | What the engine needs from Android, as interfaces                                                                   |
| `core/Model.kt`                                              | The spec's types and wire strings, the diagnostic event names                                                       |
| `core/Rules.kt`                                              | Pure rules: which fix is stored, the permission state, the missed-wake heuristic                                    |
| `core/CaptureState.kt`, `core/FileDiagnosticsLog.kt`         | What is kept between processes, and the files it is kept in                                                         |
| `core/Geo.kt`, `core/H3.kt`                                  | Haversine and the two H3 cells of a sample, in plain Kotlin                                                         |
| `platform/`                                                  | Android: the foreground service, the two WorkManager workers, the boot receiver, location providers, settings pages |
| `store/`                                                     | **Stand-in** for the encrypted store (see "The store")                                                              |
| `NativeLocationCaptureModule.kt`                             | The Turbo Module: converts and forwards to the engine                                                               |

`core` has no Android type in it. That is the design: Android can only be tested on a phone, so everything that is a decision lives where a unit test can run it, behind fakes that play the operating system (`src/test/.../core/Fakes.kt`).

## How it runs

Android starts this process in five ways, and only one of them has React Native in it:

| Who wakes the process          | Class                         | What it tells the engine           |
| ------------------------------ | ----------------------------- | ---------------------------------- |
| The app is opened              | `NativeLocationCaptureModule` | `restore(APP_LAUNCH)`, then calls  |
| WorkManager, every 15 minutes  | `platform/CaptureWorker`      | `onWorkWake`                       |
| WorkManager, hourly            | `platform/WatchdogWorker`     | `onWatchdog`                       |
| A reboot, or an app update     | `platform/BootReceiver`       | `restore(BOOT / PACKAGE_REPLACED)` |
| Android recreating the service | `platform/CaptureService`     | `servicePlan`, `onServiceRevived`  |

All of them get the same engine from `platform/CaptureRuntime`. The selection made by `start` is written to a file, so every one of these paths knows which mode to run with no JavaScript running.

### The two modes

|                 | `wm` (default)                                                                    | `fgs`                                                                                          |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mechanism       | WorkManager periodic job, unique name `fmp_capture`                               | Foreground service of type `location`, sticky                                                  |
| Notification    | none                                                                              | permanent; title and body are `notificationTitle` / `notificationBody` of the config           |
| One fix         | `getCurrentLocation`, 30 s; else the cached last fix if recent and new; else none | every batch the provider delivers                                                              |
| Cadence         | `minIntervalSec`, but never under WorkManager's 15 minutes (`interval_clamped`)   | `minIntervalSec`; fixes other apps caused are accepted from a fifth of it; batched up to twice |
| Sample `source` | `wm`                                                                              | `fgs`                                                                                          |
| Alive means     | the job is queued or running                                                      | the service is in the foreground and subscribed, in this process                               |

`start` with a different config stops whatever is alive and only then starts the other, so the two are never alive together (`CaptureEngineTest`, including overlapping calls from eight threads). `start` with the same config is a no-op and does not reset the schedule. The hourly watchdog (`fmp_capture_watchdog`) exists whenever a mode is selected.

No minimum distance is given to the location provider: it would be a hard filter, and a phone sitting still would store nothing. The rule "interval passed **or** moved `minDistanceM`" is applied in `core/Rules.kt` instead.

### Lifecycle hardening

- **The process is killed.** The service is sticky, so Android recreates it; it reads the selection from disk and carries on. If Android does not, the watchdog restarts it within the hour, and the next app launch does at once. WorkManager persists its own jobs.
- **Reboot, app update.** `BootReceiver` restores the selected mode on `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`.
- **A permission arrives late.** Every answered permission request restarts a mechanism that is not alive (the trial app did the same).
- **Leftovers.** A job or a service that runs with nothing selected removes itself.

### Tier fallback

Two ways capture degrades instead of stopping:

1. **No background permission.** The selected mechanism still runs. The status says `tier: throttled` and `background_permission_missing`. The trial showed mode `wm` gets almost nothing in this state (3% on one phone), so the permission step must be hard to skip; that is the permission screens' job.
2. **Mode `fgs` and Android will not run the service.** Android 12+ refuses a foreground service started from the background, Android 14+ refuses a location service when the permission cannot be used from where the app is, and a vendor can kill it. The engine then schedules the periodic job as a fallback, keeps retrying the service from the watchdog and on app launch, and cancels the fallback the moment the service is back. Fallback samples carry source `wm`.

The status is honest about case 2, in the spec's own terms: the selected mechanism is not alive, so `running` is false, `tier` is `stopped` and `service_not_running` is raised, while `samplesLast24h` shows the fallback's samples arriving. There is no fallback from `wm` to `fgs`: that would show a notification the user chose not to have.

## Health flags

Each flag is computed in `CaptureEngine.computeStatus` from one fact, read in `platform/AndroidDeviceConditions.kt`. `HealthFlagTest` produces every one of them by its condition and clears it again.

| Flag                            | Raised when                                                                         | Android call                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `background_permission_missing` | permission is not `always`                                                          | `checkSelfPermission(ACCESS_BACKGROUND_LOCATION)` (Android 10+)                         |
| `precise_location_off`          | coarse location granted, fine not                                                   | `checkSelfPermission` on both                                                           |
| `location_services_off`         | the phone-wide location switch is off                                               | `LocationManagerCompat.isLocationEnabled`                                               |
| `service_not_running`           | a mode is selected and its mechanism is not alive                                   | WorkManager work info; the service's own liveness                                       |
| `store_unusable`                | the last store check or write failed                                                | see "The store"                                                                         |
| `battery_optimisation_active`   | the app is not exempt from battery optimisation, or its battery use is "Restricted" | `PowerManager.isIgnoringBatteryOptimizations`, `ActivityManager.isBackgroundRestricted` |
| `hibernation_not_exempt`        | "Pause app activity if unused" is on                                                | `PackageManagerCompat.getUnusedAppRestrictionsStatus`                                   |
| `oem_restriction_suspected`     | under a third of the expected capture wakes happened (below)                        | none: the module's own record of when it was woken                                      |

`permission` is `restricted` when `UserManager.DISALLOW_SHARE_LOCATION` is set.

**`oem_restriction_suspected`.** The trial's main finding was that real phones fail by silent starvation: no crash, no restart, the phone just stops running the app. Missing wakes are the only trace. The module records each time it is woken to capture (a job run, a watchdog run, a delivery to the service, the service's heartbeat), and `WakeHeuristic` in `core/Rules.kt` raises the flag when, over the time a mode has been selected (at most 24 hours, never reaching before the last boot, at least 6 hours), fewer than a third of the wake periods contain a wake. An ordinary night in Doze stays well above a third. The thresholds are constants there, with the reasoning; they come from three trial phones, not from a study.

A default Android phone raises `battery_optimisation_active` and `hibernation_not_exempt` until the user changes both. That is accurate, and it is for the capture-health screens to decide how loudly to say so.

## Permission

`requestPermission` follows `PermissionRules` in `core/Rules.kt`:

| Step         | Shown                                                                                     | When                         |
| ------------ | ----------------------------------------------------------------------------------------- | ---------------------------- |
| `foreground` | the system dialog for fine and coarse location                                            | only while `undetermined`    |
| `background` | Android 11+: the app's page in system settings; resolves when the user returns to the app | only while `foreground_only` |
| `background` | Android 10: the system dialog                                                             | only while `foreground_only` |

Android has no "never asked" state, so the module records that it showed the foreground prompt and reports `undetermined` before and `denied` after. This is stricter than Android, which would show its dialog a second time, and it means a permission reset by hibernation is reported as `denied` (settings are the way back). It matches the spec and iOS, so the permission screens have one flow.

`openSystemSettings('battery')` opens Android's battery-optimisation list while the app is battery-optimised, and the phone maker's page once it is not (`BatteryPages` in `platform/SystemSettings.kt`). The module never requests the exemption directly: Google Play restricts apps that do.

## Diagnostics

`getDiagnostics` reads a text log in the app's `noBackupFilesDir`, bounded by rotation to 3000 to 6000 entries. No entry holds a coordinate. The first five events are shared with iOS (`DIAGNOSTIC_EVENTS` in `../src/constants.ts`).

| Event                                  | `detail`                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `mode_changed`                         | the new mode, or `stopped`                                                                          |
| `capture_started`, `capture_stopped`   | the mode                                                                                            |
| `start_failed`                         | the reason, usually the exception class Android threw                                               |
| `store_unusable`                       | the failed step                                                                                     |
| `store_usable`                         | empty: a later check passed                                                                         |
| `capture_wake`                         | `wm:stored:current`, `wm:filtered:last_known`, `wm:no_fix`, `fallback:…`, `fgs:stored=2,filtered=1` |
| `fallback_started`, `fallback_stopped` | empty                                                                                               |
| `watchdog_ok`, `watchdog_restart`      | the mode                                                                                            |
| `boot_restart`                         | empty for a reboot, `package_replaced` for an update                                                |
| `service_destroyed`                    | empty: Android destroyed the service and the engine had not asked                                   |
| `process_started`                      | `location=fused` or `location=platform`                                                             |
| `health_changed`                       | the new flags, comma-separated                                                                      |
| `permission_changed`                   | the new state                                                                                       |
| `standby_bucket`                       | `active`, `working_set`, `frequent`, `rare`, `restricted`, `exempted`                               |
| `permission_prompt`                    | `foreground` or `background`                                                                        |
| `settings_opened`                      | target and the page that opened, e.g. `battery:samsung_battery`                                     |
| `interval_clamped`                     | the period WorkManager will use                                                                     |
| `state_reset`, `internal_error`        | what went wrong                                                                                     |
| `retention_purge`                      | `samples=N,stays=N,trimmed=N`: what a wake's purge removed. Not written when it removed nothing     |
| `retention_purge_failed`               | why the purge could not run; it is tried again at the next wake                                     |

## Retention

The full purge is TypeScript and runs when the app does. A phone on which the app is never opened is woken only by this module, so its wakes purge too: the periodic job (with or without a fix), a delivery to the service, and the hourly watchdog call `purgeIfDue` in the engine, which asks the store to delete the fixes and stays past retention. `StorePurge` in `store/StoreRules.kt` runs the four purge statements of `native-writer.json` in one transaction, with the cutoff `retentionSec` behind the clock.

- **At most once an hour per process.** The time of the last purge is kept in memory only and never decides what is deleted, so a new process purges on its first wake, and a purge after a long gap or a changed clock deletes exactly what one at that moment should.
- **A failed purge changes nothing** (one transaction), is logged, and is tried at the next wake. It does not raise `store_unusable`. A store that is already unusable is not purged.
- **Nothing is derived and nothing is vacuumed here.** Both are TypeScript's.
- **With nothing selected there is no wake**, so a phone on which capture was stopped is purged when the app is next opened.

`getDeviceConditions` is `MaintenanceRules` in `core/Rules.kt` over three facts read in `platform/AndroidDeviceConditions.kt`: `BatteryManager.isCharging`, `PowerManager.isInteractive`, and whether one of the app's activities is on screen (`ActivityManager.getMyMemoryState`). `charging` is the first; `idle` is the screen off or the app not on it. The app does not vacuum on Android yet whatever this answers (`ANDROID_VACUUM_ENABLED` in `app/src/store/retention.ts`, and item 2 under "For whoever owns the spec and the store").

`RetentionTest` covers when the purge is asked for and every combination of the three facts; `StoreContractTest` runs the purge on the real schema.

## Privacy

A coordinate exists in two types (`Fix`, `StoredSample`), neither of which prints it, and leaves them in one direction: into the encrypted store. `PrivacyTest` drives every path a fix can take, then searches every event, status, diagnostics entry and file the module wrote outside the store for the coordinates and for the H3 cells (a res-7 cell is a place too). It also checks the event payloads have exactly the fields of `../contracts/schema.json`. Leaking a longitude into one diagnostics line on purpose makes it fail.

What the module keeps outside the store is the selection, and times: when samples were stored, when it was woken. The status numbers (`lastSampleTsUtc`, `samplesLast24h`) are counted from that ledger, because the store contract gives a native module an insert and no query.

## The store

`store/` is a **stand-in**. Plan task C2.3 (fmp-encrypted-store) owns key management and the native store wiring, and its Android side had not landed when this was written. The seam is `SampleStore` in `core/Ports.kt`: replace `store/` with C2.3's store behind it.

The stand-in is the M0 store proof with the real contract:

- The SQL and the cipher parameters are generated at build time from `packages/shared/contracts/native-writer.json` and `cipher-params.json` (the `generateStoreContract` Gradle task). Nothing in `src/` restates them.
- It opens the existing file read-write in WAL mode with the pinned parameters, reads each back, and requires the schema version of the contract. It never creates the file (TypeScript does) and never deletes it (a wrong key looks like corruption).
- The key is 32 random bytes wrapped by an Android Keystore AES-GCM key with no unlock requirement, kept in `noBackupFilesDir/fmp-store/`, which is also `getStoreDirectory()`.
- The two cells of a row are computed by `core/H3.kt`, a Kotlin port of H3's `latLngToCell` and `cellToParent`, so the write path loads no native library of its own. `GeoContractTest` holds it to `packages/shared`'s golden vectors and to the reference library (h3-java, a test-only dependency) on 60,000 random points, every resolution, the poles, the antimeridian and all twelve pentagons.

## What the app has to do

- Pass `notificationTitle` and `notificationBody` in the config for mode `fgs`. The channel's name and description are string resources here (`fmp_capture_channel_name`, `fmp_capture_channel_description`), which the app may override and translate.
- Ask for `POST_NOTIFICATIONS` (Android 13+) if the `fgs` notification should be visible. This module does not declare it; the service runs without it.
- Keep `android:allowBackup="false"`. This module's own files are in `noBackupFilesDir` either way.
- Open the store with op-sqlite in the directory `getStoreDirectory()` returns, migrate it, then call `initStore()` and `start()`.
- Call into the module on launch (any call). That creates it, and creation repairs the selected mode while the app is in the foreground, the one moment Android always allows a foreground service to start.

## For whoever owns the spec and the store

Three things this task ran into that are not its to change:

1. **The store contract has no read.** The distance rule needs the position of the last stored sample. A process that did not store it cannot know it (positions are never kept outside the store), so the first fix after a process start is held to the interval alone. Adding a "last sample" query to `native-writer.json` would close that, and would let the status be counted from the store instead of a ledger.
2. **Two SQLite libraries in one process.** op-sqlite and `sqlcipher-android` each carry their own SQLCipher. SQLite's documentation warns that two copies of the library using one database file in one process defeat its file locking (POSIX locks are per process). While the app is open, JavaScript reads the file through one copy and capture writes through the other. The M0 proof showed they can open the same file; it did not test them concurrently. The store's owner should decide: one library for both sides, or a rule that serialises access. Until then the app does not run the weekly `VACUUM` on Android, and the purge above is one more small native write of the kind an insert already is.
3. **The spec has no word for the fallback.** While mode `fgs` captures through the periodic job, the status can only say "not running" plus a rising sample count. A tier for it would be a spec change.

## Verified and not verified

Verified here, on a Mac, with no phone:

- `./gradlew testDebugUnitTest lintDebug assembleDebug` passes: 146 JVM tests, lint with no issues, a debug AAR.
- The module class compiles against the committed generated spec and `react-android` 0.87.1, so it implements every spec method with the generated signatures.
- The state machine behaves as the spec's comments and `../src/fake.test.ts` say (`CaptureEngineTest`), survives the S0.2 scenarios as far as its own behaviour goes (`M0ScenarioTest`), raises each health flag by its condition (`HealthFlagTest`) and keeps coordinates out of everything but the store (`PrivacyTest`).
- The contract's insert statement, bound as this module binds it, writes the expected row into the real v1 schema on a real SQLite; the generated constants equal the contract files; the cells match the golden vectors and the reference library.
- The contract's purge statements, run as this module runs them on that schema, delete the fixes and stays past retention, cut a stay that straddles the cutoff, pull the derivation cursor back, touch no other table, and delete nothing when one of them fails. Forty days of wakes with no JavaScript leave thirty days of fixes (`RetentionTest`, on the fake store).

Not verified, because it needs a phone or the app's build:

- **Any behaviour on a device.** Whether the service starts, how often WorkManager runs the job, what each vendor does. The unit tests prove what the module does when Android behaves a given way, not that Android behaves that way.
- **The build inside the app.** `app/android` does not exist yet, so the autolinked path (the React Native Gradle plugin generating the spec, versions from the root project, the manifest merge) has not run. The first task that adds `app/android` should build with this library and fix what differs.
- **The purge and the power facts on a phone.** That `compileStatement` and `beginTransaction` of `sqlcipher-android` behave as the JDBC stand-in in the tests does; that `isCharging`, `isInteractive` and the process importance read what this README says they do on a real device, and off the main thread.
- **SQLCipher on Android.** `SqlCipherSampleStore` and `KeystoreStoreKey` compile and have never run: `libsqlcipher.so` cannot load on a JVM. Open questions from the M0 proof stand: that the Keystore key is readable while locked after first unlock, and that the two SQLCipher copies coexist.
- **Foreground-service rules per Android version.** Whether a `location` service may start from the boot receiver and from the watchdog on each version (Android 12 restricted background starts, Android 15 changed boot-time rules). If it may not, the module logs `start_failed` and runs the fallback; that path is unit-tested, the rule itself is not.
- **The Android 10 background-permission dialog**, and resolving `requestPermission('background')` on return from settings on Android 11+.
- **The vendor settings pages.** From the trial: `samsung_battery` opened on a Galaxy S24 Ultra; every OnePlus name failed on a Nord and fell through to the fallback; the Xiaomi names are untried.
- **`PlatformBackend`**, the location path for phones without Google Play services. The trial ran only on the fused provider.
- **The missed-wake thresholds** against real traces.
- The Gradle job in CI (`android-module` in `.github/workflows/ci.yml`) is validated by its first run.
