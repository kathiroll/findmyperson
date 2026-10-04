# @findmyperson/native-location-capture

The one interface for background location capture. The Android module (Kotlin), the iOS module (Swift and ObjC++) and an in-memory fake all implement it, so the two platforms cannot drift apart without a test failing.

This package holds the interface, the codegen setup that turns it into native code, the fake, and the two native implementations. "For the native tasks" below says exactly what each platform implements and which files are its own.

- **Android:** `android/`, Kotlin. Start at [`android/README.md`](android/README.md).
- **iOS:** `ios/`, Swift and ObjC++. Start at [`ios/README.md`](ios/README.md).

## Map

| Path                                               | What it is                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/specs/NativeLocationCapture.ts`               | The interface. Also the input React Native's codegen reads. Start here: the comments are the contract |
| `src/constants.ts`                                 | Module name, error codes, diagnostic event names, health flags per platform, production defaults      |
| `src/fake.ts`                                      | `createFakeLocationCapture`: the same interface, in memory, for tests                                 |
| `src/native.ts`                                    | The real module (looks it up in React Native's registry)                                              |
| `package.json` → `codegenConfig`                   | Tells a React Native build to generate native interfaces from `src/specs`                             |
| `contracts/android/NativeLocationCaptureSpec.java` | Generated: the abstract class the Kotlin module extends                                               |
| `contracts/ios/NativeLocationCaptureSpec.h`        | Generated: the protocol and base class the iOS module uses                                            |
| `contracts/schema.json`                            | Generated: the parsed spec, with the exact strings of every union                                     |
| `ios/`, `FMPLocationCapture.podspec`               | The iOS module: Swift state machine, Core Location adapters, the Turbo Module shim, its XCTest suite  |

## Importing

| Import                                         | Gives you                                                                               | Loads react-native |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------ |
| `@findmyperson/native-location-capture`        | Types and constants                                                                     | no                 |
| `@findmyperson/native-location-capture/fake`   | `createFakeLocationCapture`                                                             | no                 |
| `@findmyperson/native-location-capture/native` | `NativeLocationCapture`, the real module. Throws on import if native code is not linked | yes                |

Runtime exports of the root: `NATIVE_MODULE_NAME`, `CAPTURE_DEFAULTS`, `CAPTURE_ERROR_CODES`, `captureErrorCode`, `DIAGNOSTIC_EVENTS`, `HEALTH_FLAGS`, `HEALTH_FLAG_PLATFORMS`, `packageName`.

Types of the root: `LocationCapture` (the interface; it is `Spec` in the spec file, the name codegen requires), `CaptureConfig`, `CaptureStatus`, `CaptureMode`, `CaptureTier`, `DeviceConditions`, `HealthFlag`, `PermissionState`, `PermissionStep`, `SettingsTarget`, `Accuracy`, `SampleWrittenEvent`, `DiagnosticEntry`, `CaptureErrorCode`, `CapturePlatform`.

Types of `/fake`: `FakeLocationCapture`, `FakeLocationCaptureOptions`, `FakeControls`, `FakeFix`, `FixOutcome`, `ConditionFlag`, `MechanismTransition`.

Write application code against `LocationCapture` and take the instance as an argument. Production passes `NativeLocationCapture`; a test passes the fake.

## The interface in brief

| Member                                                    | What it does                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `getOrCreateStoreKeyHex()`                                | The store key, created natively on first call. JavaScript needs it to open the store with op-sqlite     |
| `getStoreDirectory()`                                     | Directory of the store file. The file name is `STORE_FILE_NAME` from `@findmyperson/shared`             |
| `initStore()`                                             | Native check that the store opens with the pinned cipher parameters and has the expected schema version |
| `start(config)`                                           | Selects a capture mode and starts it. Also how the mode is switched (below)                             |
| `stop()`                                                  | Stops capture and clears the selection                                                                  |
| `getStatus()`                                             | Running or not, mode, tier, permission, health flags, capture-rate numbers                              |
| `requestPermission('foreground' \| 'background')`         | One permission step at a time                                                                           |
| `openSystemSettings('app' \| 'battery' \| 'hibernation')` | Opens a settings page; `false` if the platform has none                                                 |
| `getDiagnostics(sinceTsUtc)`                              | The local capture-health log                                                                            |
| `getDeviceConditions()`                                   | `{ charging, idle }`, read now: what the store's weekly VACUUM waits for. Never rejects                 |
| `debugInjectSample(lat, lon, tsUtc, accuracyM)`           | Debug builds only: store a synthetic fix                                                                |
| `onSampleWritten(handler)`                                | Event `{ tsUtc, accuracyM, source }`                                                                    |
| `onStatusChanged(handler)`                                | Event carrying the whole new `CaptureStatus`                                                            |

Two rules shape it (architecture plan, section 5.5):

1. **Coordinates never cross the bridge on the capture path.** The native module writes each fix into the encrypted store itself. No return value and no event has a latitude or longitude; a test fails if one is added. JavaScript reads coordinates only from the store.
2. **Health is observable.** Every way the platform can degrade capture is a `HealthFlag` in the status.

### Retention on a capture wake

The retention purge is TypeScript (`packages/shared`, `src/retention/`) and runs when the app does. A capture wake often has no JavaScript in it, so both native modules also purge: on a wake they delete the fixes and stays that are past retention, with the four purge statements of `packages/shared/contracts/native-writer.json` in one transaction, at most once an hour per process. Nothing in the interface starts or reports it; it shows as `retention_purge` (`samples=N,stays=N,trimmed=N`, only when something was removed) and `retention_purge_failed` in the diagnostics. The fake does the same on every stored fix. Neither module ever vacuums: that is the app's, and `getDeviceConditions` is the answer it waits for.

`getDeviceConditions` on each platform:

|            | Android                                                                                                        | iOS                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `charging` | `BatteryManager.isCharging`                                                                                    | `UIDevice.batteryState` is `.charging` or `.full` |
| `idle`     | the screen is off (`PowerManager.isInteractive`), or the app is not on it (`ActivityManager.getMyMemoryState`) | `UIApplication.applicationState` is not `.active` |

A fact the platform will not give counts as false, so the vacuum waits.

### Switching the Android mode at runtime

Android has two capture modes. `wm` (WorkManager, no notification) is the default. `fgs` (a foreground service with a permanent notification) is the alternative the user can choose in Settings. The choice is `useForegroundService` in the config passed to `start`, and it is a runtime setting:

- `start` with a different config while capture runs stops the active mechanism completely, then starts the new one. Both are never alive together.
- `start` with the same config does nothing and resets no schedule, so it is safe to call on every app launch.
- The selection is stored natively. After a reboot or a relaunch by the OS the module restarts the selected mode itself, with no JavaScript running.

iOS has one mode and ignores `useForegroundService`.

### Rejections

A rejected promise carries an error whose `code` is one of `CAPTURE_ERROR_CODES`: `invalid_argument`, `permission_denied`, `store_unusable`, `start_failed`, `not_available`. Read it with `captureErrorCode(error)`.

## The fake

```ts
import { CAPTURE_DEFAULTS } from '@findmyperson/native-location-capture';
import { createFakeLocationCapture } from '@findmyperson/native-location-capture/fake';

const capture = createFakeLocationCapture({
  platform: 'android',
  permission: 'always',
  now: () => clock,
});
await capture.start({
  ...CAPTURE_DEFAULTS,
  notificationTitle: 'findmyperson',
  notificationBody: '…',
});
await capture.controls.deliverFix({ lat: 12.9716, lon: 77.5946 }); // 'stored'
```

`capture` is a `LocationCapture`. `capture.controls` is what a real module does not have: it plays the user (`answerPermission`, `setPermission`), the operating system (`setCondition`, `setDeviceConditions`, `killMechanism`, `restartMechanism`, `refuseNextStart`, `setStoreFailure`, `deliverFix`) and lets a test look at what happened (`samples`, `transitions`, `selectedConfig`, `openedSettings`, `shownPermissionPrompts`).

Pass `db` (a migrated store, any `SqlExecutor` from `@findmyperson/shared`) and the fake inserts samples into `location_sample` with the shared `insertLocationSample`, cells included, so code that reads the store sees what a phone would have written. Without `db` samples stay in memory.

## Codegen

`codegenConfig` in `package.json`:

| Field                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| `name`                    | `NativeLocationCaptureSpec`                          |
| `jsSrcsDir`               | `src/specs`                                          |
| `android.javaPackageName` | `dev.findmyperson.locationcapture`                   |
| `ios.modulesProvider`     | `NativeLocationCapture` → `RCTNativeLocationCapture` |

A React Native build runs codegen from this by itself. `src/codegen.test.ts` runs the same generators in the unit tests and compares the result with the committed files in `contracts/`. When the spec changes on purpose, rewrite them from the repo root:

```sh
pnpm exec vitest run packages/native-location-capture -u
```

and review the diff: it is the change both native modules now have to make.

## For the native tasks

Each platform implements the spec and nothing else, in its own files, so the two tasks never touch the same file.

|                          | Android                                                                                                     | iOS                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Owns                     | `android/` in this package                                                                                  | `ios/` and the `.podspec` in this package                                                         |
| Implements               | `class … : NativeLocationCaptureSpec(reactContext)` (generated, package `dev.findmyperson.locationcapture`) | `@interface RCTNativeLocationCapture : NativeLocationCaptureSpecBase <NativeLocationCaptureSpec>` |
| Reference copy           | `contracts/android/NativeLocationCaptureSpec.java`                                                          | `contracts/ios/NativeLocationCaptureSpec.h`                                                       |
| Registers as             | `NativeLocationCapture`                                                                                     | `NativeLocationCapture`                                                                           |
| Emits events with        | `emitOnSampleWritten(map)`, `emitOnStatusChanged(map)`                                                      | `emitOnSampleWritten:`, `emitOnStatusChanged:`                                                    |
| `CaptureMode` it reports | `wm`, `fgs`, `stopped`                                                                                      | `ios`, `stopped`                                                                                  |

Neither task edits `src/`, `contracts/` or `codegenConfig`. A needed change to the interface is its own change, made here first.

Both platforms take from `packages/shared/contracts/` and do not restate: the SQL they may run and the schema version they require (`native-writer.json`), the cipher parameters (`cipher-params.json`), and the cell and distance vectors (`geo-vectors.json`). `contracts/schema.json` here gives the exact strings for every status field, for a native test to load. The behaviour each method must have is written on the method in the spec file; `src/fake.test.ts` shows it running.

## Where this differs from the plan's draft

Plan section 5.5 drafted this interface before the M0 store proof and the captain's capture-mode decision. Four things changed, each for a stated reason:

| Draft                                                    | Here                                                             | Why                                                                                                                                                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initStore(dbPath, keyHex)`: JavaScript supplies the key | `getOrCreateStoreKeyHex()`, `getStoreDirectory()`, `initStore()` | The OS relaunches the app in the background with no JavaScript running, so the native side must find the key and the file by itself. This is the shape `m0/store-proof` proved (`getOrCreateKeyHex`, `getDatabaseDirectory`) |
| `tier` only                                              | `mode` and `tier`, with tier `periodic_work` added               | The mode is now a user setting (plan addendum, 2026-10-02), so the Settings screen must be able to read it back, and WorkManager is a tier of its own                                                                        |
| Events through `addListener` / `removeListeners`         | `onSampleWritten`, `onStatusChanged` as typed event emitters     | The payload becomes part of the generated interface, so "no coordinates in an event" is checked by a test rather than by convention                                                                                          |
| `getDiagnostics` returns a JSON string                   | Returns `DiagnosticEntry[]`                                      | Two platforms writing free-form JSON would drift                                                                                                                                                                             |

Also added: the `store_unusable` health flag, which `packages/shared` requires ("reports the store as unusable in its status" when the schema version is not the expected one).

One reading of the plan is settled here because the two platforms must agree on it: a fix is stored when `minIntervalSec` has passed since the last stored sample **or** the phone has moved `minDistanceM`. Plan 5.2 lists a 100 m minimum update distance on the Android location request, which taken literally would store nothing from a phone that is sitting still, and stays are built from exactly those samples. The Android task should not pass the distance to the location provider as a hard filter.

## Not in this spec

- Rotating the store key for "Delete all my data" (plan 4.7). It needs a native method and belongs with that feature.
- The notification permission (Android 13+). It is not a location permission and the match notification needs it too, so it belongs to whatever owns notifications.

## What has and has not been verified

Verified here, on a Mac, with no phone: the spec parses with React Native 0.87.1's codegen for both platforms; the official entry point (`react-native/scripts/generate-codegen-artifacts.js`) driven by this `codegenConfig` produces the same iOS header as the committed copy, and the same Java class apart from its package name (that script uses a fixed package; the Gradle plugin applies `javaPackageName`, as it did for `m0/store-proof`); the fake passes its tests.

Not verified: any native build of this package inside an app, on either platform, and any behaviour on a device. What was checked for each native module, and what was not, is listed in its own README (`android/README.md`, `ios/README.md`).

## Commands

```sh
pnpm exec vitest run packages/native-location-capture       # unit tests; no device
pnpm exec vitest run packages/native-location-capture -u    # also rewrite contracts/
pnpm --filter @findmyperson/native-location-capture typecheck
(cd packages/native-location-capture/ios && swift test)     # the iOS module; more in ios/README.md
```

The Kotlin tests are a Gradle build of their own; the commands are in `android/README.md`.
