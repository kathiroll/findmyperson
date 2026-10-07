# Decisions

What was decided in findmyperson, why, and by whom. Entries D-001 to D-051 are the decisions the project already carried when this record was set up; D-052 onward were inferred from the code in T-000. A decision is never deleted: if it changes it is marked `Superseded by D-XXX` and the replacement is linked. This file is a reading aid, not a source of authority: the README or source file named under `Source` in each entry is where the decision actually lives.

It describes `main` at commit `88c8a6c` (2026-10-08, pull request #39). [ARCHITECTURE.md](ARCHITECTURE.md) describes what was built; this file is about why. What is waiting on the captain is listed at the top of [TASKS.md](TASKS.md).

## Entry format

```
## D-007 Short title
- Date:
- Status: Proposed | Accepted | Superseded by D-XXX
- Decided by: Captain | Claude (proposed) | Claude (inferred from existing code)
- Decision:
- Why:
- Alternatives considered:
```

Two fields were added to the entries that existed before T-000, so that none of their content was lost:

- **Source** keeps the old "Status" line: where in the repository the decision and its reasoning are written down. **Documented (README / PR #n / source)** means the reasoning is in the repository, in the place named. **Documented (plan)** means it is in the architecture plan and its addenda, a planning record kept outside this repository, so the entry summarises it and the code comments citing "plan" sections refer to it. **Inferred from code** means nothing states the reason, and the "why" is a reading of the code and history that may be wrong.
- **Note (T-000)** appears where the entry has gone out of date; the original text is left as it was.

How the other fields were filled for D-001 to D-051:

- **Status** is `Accepted` where the decision is written down in the repository and has been in force on `main` since it merged, and `Proposed` where the reasoning is only inferred (D-015, D-038, D-040). `Accepted` here means "in force and documented", not that the captain has been asked; the entries marked "Not recorded" under `Decided by` are listed as one item in "Needs you" so the captain can ratify them in a batch.
- **Decided by** names the captain only where the repository or the plan addenda says so. Where nobody is named it says `Not recorded`; it does not guess.
- **Date** is the day the introducing pull request merged (or the addendum's date), not the day the choice was first thought of.
- **Alternatives considered** lists what else existed. "Considered" in the text means the record shows it was weighed; otherwise it is simply an option that was available.

## Index by area

| Area                    | Entries                                                                     |
| ----------------------- | --------------------------------------------------------------------------- |
| Workspace and tooling   | D-001 to D-006                                                              |
| App platform            | D-007 to D-017                                                              |
| On-device store         | D-018 to D-025                                                              |
| Matching                | D-026 to D-029                                                              |
| Distribution of reports | D-030 to D-038                                                              |
| Backend                 | D-039 to D-047                                                              |
| Cross-cutting           | D-048 to D-051                                                              |
| Inferred in T-000       | D-052 to D-062 (all Proposed; each has a matching `[!]` item in `TASKS.md`) |

## D-001 One pnpm workspace, with a hoisted `node_modules`

- Date: 2026-10-03 (PR #8)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The app, the shared package, the two native-module packages and the server are members of one pnpm workspace (pnpm 12.8.1, pinned in `packageManager`), linked with `workspace:*`. `.npmrc` sets `node-linker=hoisted`.
- Why: The app and the server must import the same payload types and matching code with no publishing step and no version drift. pnpm is strict about undeclared dependencies and has first-class workspace links. The hoisted linker gives up some of that strictness on purpose: React Native's Metro bundler and native autolinking expect a flat `node_modules` and do not follow pnpm's default symlinked layout reliably.
- Alternatives considered: npm or Yarn workspaces (flat by default, less strict). pnpm's default isolated linker with Metro configured to follow symlinks. Separate repositories with a published shared package. A build orchestrator (Turborepo, Nx), which the size of the repo does not yet need.
- Source: Documented (README): [WORKSPACE.md](../WORKSPACE.md), and the comment in `.npmrc`. Introduced in PR #8.
- Note (T-000): the `.npmrc` line is no longer in effect. `AGENTS.md` records that `node_modules` is pnpm's isolated layout and that Gradle and Metro were pointed at React Native's parts explicitly in PR #33 (`docs/BUILDING.md`, "The Android project"); the installed tree has no top-level `react-native`. `WORKSPACE.md` still describes the hoisted linker. The decision to use one pnpm workspace stands; the linker half is out of date and needs the captain's confirmation (see "Needs you" in `TASKS.md`).

## D-002 One test runner (Vitest), with React Native stubbed in component tests

- Date: 2026-10-03 (PR #8)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Vitest runs every member from one root config (`projects`). App component tests run against JavaScript stubs of react-native and of the navigators, not against the real library or Jest's React Native preset.
- Why: TypeScript works with no extra setup and one command covers the repo. Stubbing react-native keeps the tests in plain Node, which matters because no native project exists and nothing can run on a device (decision 5).
- Alternatives considered: Jest with `@react-native/jest-preset`, the conventional choice, which M0's store proof used. Device or simulator tests (Detox, Maestro), which decision 5 rules out for now.
- Source: Documented (README): WORKSPACE.md and the "App UI" and "App navigation" notes in [AGENTS.md](../AGENTS.md).
- Note (T-000): the reason "no native project exists" is out of date since PR #33 added `app/android`. Tests still run against stubs, and nothing has run on a phone.

## D-003 Strict TypeScript everywhere, configured once

- Date: 2026-10-03 (PR #8)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: One `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`; one flat ESLint config and one Prettier config at the root.
- Why: Inferred: the contracts package is the single source of types for three runtimes, so loose optional and index typing would leak into every consumer.
- Alternatives considered: Per-package configs; default `strict` only.
- Source: Documented (README): WORKSPACE.md. The specific flags are inferred from `tsconfig.base.json`.

## D-004 M0 research code stays in the repository, outside the workspace

- Date: 2026-10-03 (PR #8)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `m0/` holds the trial apps and the store proof. It is not a workspace member, and lint, format and tests skip it. One file is still load-bearing: the cipher parameters there are pinned by a test to the real build's copy.
- Why: M0 is the evidence for several later decisions (capture modes, the store open sequence), so it is kept readable, but it has its own toolchains (Gradle, Xcode, npm) that should not slow or break the workspace.
- Alternatives considered: A separate repository or an archived branch. Folding it into the workspace.
- Source: Documented (README): WORKSPACE.md, `m0/README.md`, the SQLCipher note in AGENTS.md.

## D-005 No simulators or emulators; decisions live where a unit test can reach them

- Date: Not recorded; in force by 2026-10-03 (PR #13)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Nothing is claimed about device behaviour unless it was verified from source or build output; everything else is listed as unverified in the relevant README. To make that workable, both native modules are split into a platform-free core that holds every decision and is unit-tested (JVM for Kotlin, `swift test` for Swift) and thin platform adapters that are only compiled.
- Why: Background location capture behaves differently on a real phone than on any simulator, and M0 was run on live phones only. Rather than trust a simulator, the design moves logic to where it can be tested for certain and is honest about the rest.
- Alternatives considered: Simulator and emulator runs in CI. Instrumented device tests on a device farm. Both cost money or give false confidence for this particular problem.
- Source: Documented (README): AGENTS.md, and the "Verified and not verified" sections of the package READMEs.

## D-006 Build scripts are the single build path; Android on every pull request, iOS only on `main` and tags

- Date: 2026-10-03 (PR #9)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `build/*.sh` is used by both local builds and CI. Signing comes only from environment variables, injected on Android by a Gradle init script so the app's own build file never mentions secrets. A fork builds unsigned with no secrets.
- Why: A local build is then a faithful rehearsal of CI. macOS runners cost roughly ten times a Linux runner, so iOS does not build on pull requests.
- Alternatives considered: Fastlane or EAS Build. iOS on every pull request. Signing config in the Gradle and Xcode projects.
- Source: Documented (README): [BUILDING.md](BUILDING.md). Introduced in PR #9.

## D-007 React Native (New Architecture) for the app, with native code only where the OS requires it

- Date: Not recorded; first React Native code merged 2026-10-03 (PR #10)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The UI, matching, storage access and networking are TypeScript on React Native 0.87.1. Background capture and key handling are Kotlin and Swift.
- Why: One language for the app, the matching engine and the server means one definition of the broadcast payload. The plan states that background location APIs cannot be reached from JavaScript, so the native part is unavoidable, and that the New Architecture is the default since 0.76 with the legacy bridge being removed.
- Alternatives considered: Two fully native apps (the M0 trial apps are exactly this). Flutter or Kotlin Multiplatform. Expo with config plugins; nothing in the repo uses Expo, which is inferred to follow from needing custom native modules and a custom SQLCipher build.
- Source: Documented (plan), and WORKSPACE.md for the version.

## D-008 A Turbo Native Module spec with codegen is the one capture interface

- Date: 2026-10-03 (PR #13)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `packages/native-location-capture/src/specs/NativeLocationCapture.ts` is the single interface. The Kotlin module, the Swift module and an in-memory fake all implement it. The generated native interfaces are committed under `contracts/` and a test fails when they drift.
- Why: A method missing or mistyped on one platform becomes a compile error instead of a runtime surprise. Typed event emitters make "no coordinates in an event" something a test checks rather than a convention. The fake lets every screen be tested without a phone.
- Alternatives considered: A legacy bridge module with `addListener` events and JSON strings (the plan's first draft returned diagnostics as a JSON string; rejected because two platforms writing free-form JSON would drift). A community library such as a background-geolocation package. Two unrelated native APIs behind a TypeScript adapter.
- Source: Documented (README): [packages/native-location-capture/README.md](../packages/native-location-capture/README.md). Introduced in PR #13.

## D-009 Coordinates never cross from native to JavaScript on the capture path

- Date: 2026-10-03 (PR #13)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The native module writes each fix straight into the encrypted store. No return value or event carries a latitude or longitude. JavaScript reads positions only from the store.
- Why: The OS relaunches the app in the background with no JavaScript running, so the native side has to be able to store a fix by itself. Keeping coordinates off the bridge also removes a whole class of accidental leaks into logs and events.
- Alternatives considered: Deliver fixes to JavaScript and write from there, which loses every fix taken while JavaScript is not running. A native staging store drained by TypeScript: considered in the plan and rejected because it doubles the encrypted-data and purge surface, and a crash could strand a staging file past retention.
- Source: Documented (README): the capture package README, citing plan section 5.5.

## D-010 The native side finds the key and the file by itself

- Date: 2026-10-03 (PR #13)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The interface has `getOrCreateStoreKeyHex()`, `getStoreDirectory()` and `initStore()` rather than `initStore(dbPath, keyHex)` with JavaScript supplying the key.
- Why: Same root cause as decision 9: a background relaunch has no JavaScript to hand over a key. This is the shape the M0 store proof showed to work.
- Alternatives considered: The plan's draft, with JavaScript owning the key (for example through a keychain library) and passing it in.
- Source: Documented (README): "Where this differs from the plan's draft" in the capture package README.

## D-011 Android capture: WorkManager by default, foreground service as a user-selectable mode

- Date: 2026-10-02 (addendum); built 2026-10-04 (PR #16)
- Status: Accepted
- Decided by: Captain (plan addendum 2026-10-02; the plan is kept outside this repository and was not seen when this was written)
- Decision: Two modes. `wm` (a periodic WorkManager job, no notification) is the default. `fgs` (a foreground service with a permanent notification) is the alternative, selected at run time through `useForegroundService` in the `start` config. The selection is stored natively and restored after a reboot. If the service cannot run, the module falls back to the periodic job; it never falls back the other way.
- Why: A permanent notification is a real cost to the user, and a location foreground service for passive, always-on capture is a poor fit for the use cases Google Play approves, so it is a store-review risk. Making it a setting needed no new architecture because the spec already carried the flag. There is no fallback from `wm` to `fgs` because that would show a notification the user chose not to have.
- Alternatives considered: Foreground service as the default (more reliable, per the trial). A build-time choice. Exact alarms. One mode only.
- Source: Documented (plan): addendum of 2026-10-02. Documented (README): the capture package README and its `android/README.md`.

## D-012 iOS capture: four Core Location services and relaunch on launch

- Date: 2026-10-03 (PR #15)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Continuous updates are the sampler; significant-location-change, visits and an exit region around the last sample exist to get the dead app relaunched. Every launch restarts capture natively. `CLVisit` arrivals and departures are written as `stay` rows, not as samples.
- Why: iOS never restarts continuous updates for a terminated app, so the three relaunching services are what make capture survive a process death. A visit is reported minutes to hours late, so it is a dwell interval and not a fresh fix.
- Alternatives considered: Significant-change only (coarse, roughly 500 m). Background fetch or silent push as the wake source. Treating visits as samples.
- Source: Documented (README): `packages/native-location-capture/ios/README.md`, citing plan section 5.3 and the M0 trial on a real iPhone.

## D-013 The two capture implementations are separate codebases with one contract

- Date: 2026-10-03 (PR #15)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Kotlin and Swift implementations share no code. They share the spec, the SQL they may run (`native-writer.json`), the cipher parameters and the geometry vectors, all from `packages/shared/contracts/`. Each owns its own directory so the two never touch the same file.
- Why: The platforms' background models have almost nothing in common (decisions 11 and 12). What must agree is behaviour at the edges, and that is pinned by generated constants and golden vectors rather than by shared source.
- Alternatives considered: Kotlin Multiplatform or a C++ core shared through JSI. A third-party cross-platform location library.
- Source: Documented (README): "For the native tasks" in the capture package README.

## D-014 A fix is stored when the interval has passed or the phone has moved

- Date: 2026-10-03 (PR #15)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: No minimum distance is given to the OS location provider. The rule "interval passed or moved `minDistanceM`" is applied in the module's own code on both platforms.
- Why: A hard distance filter stores nothing from a phone that is sitting still, and stays are built from exactly those samples.
- Alternatives considered: The plan's literal 100 m minimum update distance on the Android location request.
- Source: Documented (README): the capture package README, which notes this settles a reading of the plan.

## D-015 No state library; the store and the capture module are the state

- Date: Not recorded; visible by 2026-10-04 (PR #19)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The app uses React context for three injected dependencies (capture module, data store, report services) and `useState` for what is on screen. Durable state is rows in the encrypted store, reached through a small `DataStore` facade with a serial work queue.
- Why: Inferred: nearly everything the app shows is already persisted either in the store or natively by the capture module, so a client cache would be a second copy to keep in sync. Injecting the three dependencies through props and context is what lets every screen be tested against the fake module and a real SQLCipher file under Node.
- Alternatives considered: Redux or Zustand with persistence. A query library over the store. AsyncStorage or MMKV for small values, which would put data outside the encrypted file and outside "Delete all my data".
- Source: Inferred from code (`app/src/store/DataStoreContext.tsx`, `app/src/permissions/CaptureContext.tsx`, `app/src/report/services.tsx`).

## D-016 Route names, params and deep links have one definition

- Date: 2026-10-03 (PR #14)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `app/src/navigation/routes.ts` defines every route and deep link. A screen task replaces a stub in `screens.tsx` and keeps the route name. React Navigation 7 with a native stack and bottom tabs.
- Why: Screens were built by separate tasks in parallel; a fixed route table let each one land without touching the others, and notification links can be built from the same file.
- Alternatives considered: Expo Router or file-based routing. Per-screen route declarations. Note that `theme.ts` records the v2 mockups dropping the tab bar for a hamburger menu, which the navigator has not followed yet.
- Source: Documented (README): `app/src/navigation/README.md` and AGENTS.md. Introduced in PR #14.
- Note (T-000): the tab bar was removed in PR #36 (2026-10-05) and Home's hamburger menu is now the app's navigation; the remark above that the navigator had not followed the mockups yet is out of date. See D-054.

## D-017 Design tokens come from the mockups; fonts are bundled as static instances

- Date: 2026-10-03 (PR #10)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Tokens live only in `app/src/design-system/theme.ts`, extracted from the v2 mockups, which outrank older design notes. Fonts are static cuts of two variable families.
- Why: One source for colours and type stops screens drifting. React Native on Android cannot select variable-font axes, so static instances are required.
- Alternatives considered: A component library (Paper, Tamagui). System fonts. Variable fonts on iOS only.
- Source: Documented (source and README): the header of `theme.ts`, `app/assets/fonts/README.md`, AGENTS.md.

## D-018 One encrypted SQLite file: SQLCipher through op-sqlite

- Date: 2026-10-03 (proof, PR #7); 2026-10-04 (built, PR #17)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: All on-device data is in one SQLCipher 4 database. TypeScript opens it through op-sqlite 18.2.5 with its SQLCipher flag; Kotlin and Swift open the same file with the same pinned parameters. The parameters are one JSON file from which native constants are generated.
- Why: One schema and one query layer in TypeScript, with a native writer that can run without JavaScript. The plan named the risk: both sides must link a compatible SQLCipher and use identical parameters or the file will not open, in the background, with no debugger. Hence the pinned parameters, the read-back check on every open, and the M0 proof before anything was built on it.
- Alternatives considered: Realm or WatermelonDB. Plain SQLite relying on OS file protection only. A native-only store with a query API over the bridge. An encrypted key-value store, which does not fit time-and-cell range queries.
- Source: Documented (plan) and Documented (README): [packages/encrypted-store/README.md](../packages/encrypted-store/README.md). Proved in M0 (PR #7), built in PR #17.

## D-019 TypeScript owns the schema; native code only checks the version

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The schema version is `PRAGMA user_version`. Migrations live in `packages/shared` and are frozen once released. Native code never creates or alters a table: it compares the version with the one it was built for and writes nothing if they differ. The two natively written tables carry no constraints beyond `NOT NULL`.
- Why: One owner for the schema avoids three implementations of each migration. `user_version` is readable before any table exists and changes in the same transaction as the schema. Constraints are left off the native tables because a failed constraint in the background would drop a fix where nothing can report it.
- Alternatives considered: A schema-version row in a table. Native code running its own migrations. An ORM or migration tool.
- Source: Documented (source): the header of `packages/shared/src/store/migrations.ts`.

## D-020 One list says which task may write which table

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `packages/shared/src/store/ownership.ts` names the owner of every write path. Writes go only through the functions in `store/tables/`.
- Why: Eight separate tasks read or write these tables. The list stops two of them both assuming a write is theirs, and a test checks it covers exactly the tables the migration creates.
- Alternatives considered: A repository class per feature. Convention only.
- Source: Documented (source): the header of `ownership.ts`.

## D-021 The store key: random, device-bound, readable while the phone is locked

- Date: 2026-10-04 (PR #17)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: A 32-byte random key made on first use. iOS: a Keychain generic password with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Android: a file in the no-backup directory, wrapped by an AES-256-GCM key in the Android Keystore that requires neither an unlocked device nor user authentication. A key that exists but cannot be read is reported, never replaced.
- Why: Capture has to write while the phone is locked in a pocket, so the key must be readable then. The cost is stated plainly in the same README: the encryption protects the file when it is read outside the app, not against someone who has the phone unlocked. Replacing an unreadable key would silently orphan every stored row. `EncryptedSharedPreferences`, which the plan named for Android, is deprecated and lives in a location Android backs up, so a plain wrapped file is used instead.
- Alternatives considered: A key that needs the device unlocked or biometric authentication (stronger, and breaks background capture). A passphrase-derived key. `EncryptedSharedPreferences`. A key held in JavaScript through a keychain library.
- Source: Documented (README): "The key" in the encrypted-store README.

## D-022 Location history is kept out of cloud backups, in three layers, enforced by tests

- Date: 2026-10-04 (PR #17)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Android: the store and wrapped key are in `noBackupFilesDir`; the manifest sets `allowBackup="false"` plus rule files excluding every domain from cloud backup and device transfer; and the store refuses to open in an app that allows backup. iOS: the store directory carries `isExcludedFromBackup`, set and read back on every open. A policy test reads the manifests and native sources on every pull request, and the Android build checks the merged manifest.
- Why: Both platforms back app data up to the vendor's cloud by default, which would take 30 days of location history off the phone. The usual way this regresses is a dependency's manifest merging the default back in, which is why there are layers and why a failing policy test means a rule was broken rather than a fixture to refresh.
- Alternatives considered: Relying on encryption alone (the key is device-bound, so a backup would be unreadable elsewhere, but the promise made is that history stays on the device). `allowBackup="false"` only, which does not stop device-to-device transfer on Android 12 and later. `Library/Caches` on iOS, which the system may empty.
- Source: Documented (README): "Backup exclusion" in the encrypted-store README, and AGENTS.md.

## D-023 "Delete all my data" drops the file and rotates the key

- Date: 2026-10-04 (PR #17)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Deleting closes both connections, removes the file with its `-wal` and `-shm`, deletes the key (and on Android the Keystore key that wrapped it), reopens, then checks that the key changed and the new file started empty.
- Why: A per-table delete leaves ciphertext pages in the file and misses any table added later. Verifying the result means a Settings screen cannot report a delete that did not happen.
- Alternatives considered: `DELETE` from each table followed by `VACUUM`. Deleting the key only (crypto-shredding).
- Source: Documented (README): "Delete all my data" in the encrypted-store README.

## D-024 One SQLCipher in the Android process

- Date: 2026-10-04 (PR #31)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: On Android the Kotlin side uses the SQLCipher inside op-sqlite's library through a small JNI shim, instead of a second copy from Zetetic's library.
- Why: SQLite's file locks belong to the process, so two library copies in one process do not see each other's locks and can both believe they hold the write lock. One copy removes the problem and makes Android match iOS.
- Alternatives considered: Both were weighed before the choice: run capture in its own process (`android:process`), where file locks work but the module's link to JavaScript changes; or a lock that both sides take, with TypeScript opening the store per unit of work.
- Source: Documented (README, PR #31): "One SQLite library in the Android process" in the encrypted-store README. Built, checked on the packaged libraries of an APK and run on a JVM; not run on a phone, so the weekly `VACUUM` is still switched off on Android (`ANDROID_VACUUM_ENABLED`) until the device checks that section lists have been made.

## D-025 Retention is one stateless purge that runs in three places

- Date: 2026-10-04 (PRs #23, #25)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: History older than 30 days is deleted by `purgeExpired`, which computes its cutoff from the time it is given on every run and remembers nothing. It runs in the app (start, foreground, each stored sample) and natively in both capture modules on a wake with no JavaScript, using the same statements. A weekly `VACUUM` runs only when the phone is charging and idle.
- Why: A purge that depends on its own last-run state can be skipped by a clock change or a long gap; a stateless one cannot. A phone on which the app is never opened only ever runs the capture module, so the purge has to exist there too. `VACUUM` rewrites the whole file, so it waits for a moment when that is cheap.
- Alternatives considered: A scheduled OS job for the purge (noted as still missing for the case where nothing wakes). Purging in TypeScript only. Per-row expiry timestamps.
- Source: Documented (README): "Retention" in [packages/shared/README.md](../packages/shared/README.md), and AGENTS.md. Built in PRs #23 and #25.

## D-026 Matching happens on the device, against stays first

- Date: 2026-10-04 (PRs #21, #27)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `matchReport` is a pure function over a device's own stays and samples. Evidence is a stay that overlaps, or a sample inside, the report's window widened by 30 minutes, within the report's radius plus 150 m. Stays are derived in TypeScript from stored fixes (150 m, 15 minutes); on iOS, `CLVisit` rows cover their interval.
- Why: The product's privacy claim is that location history never leaves the phone, so the comparison has to run there. Dwell-based matching fits what background capture reliably delivers (on Android's default mode, a fix about every 15 minutes): the harness finds 96 to 97 percent of people who were stopped near the missing person and far fewer of those moving past.
- Alternatives considered: Server-side matching on uploaded history. Private set intersection or similar cryptographic matching. Sample-only matching with no stay derivation. Bluetooth proximity, as exposure-notification systems used.
- Source: Documented (README): "Matching" and "Stay derivation" in the shared package README. The constants are marked DECIDED in `packages/shared/src/constants.ts`.

## D-027 Match criteria are read on a 150 m and 30 minute grid

- Date: 2026-10-04 (PR #27)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Before the rule is applied, the radius is rounded up to a multiple of 150 m and both ends of the window are rounded outward to 30-minute marks. Rows are selected with `matchBounds`, never with the criteria as written.
- Why: It is a security property. The plan relies on a reporter gaining nothing from precision finer than the two constants, and the rule as first written did not give that: a 5 m and a 140 m radius reach different people. On the grid they are the same report, so two reports that agree on the grid return identical results on any history. Rounding is outward only, so nothing the written rule finds is lost.
- Alternatives considered: The rule as written, with no rounding. Rounding at intake on the server instead (noted in the README as something that would also close a small gap in the widen-only rule, and not done). Adding random noise. The measured cost of the grid is 25 to 29 percent more notifications (`server/README.md`).
- Source: Documented (README and source): the shared package README, the header of `packages/shared/src/match/matchReport.ts`, AGENTS.md. Built in PR #27.

## D-028 Edits to a report may only widen it

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: A `PATCH` is accepted only if the new window contains the old one, the radius is not smaller, and the new search disc covers the old one (`distance + old radius <= new radius + 1 m`). The server, the reporter's app and the device all call the same function.
- Why: A reporter who could narrow a report and watch whether tips keep arriving could binary-search for where a specific person was. The centre rule is a coverage test rather than "may move up to N metres" because a per-edit allowance can be spent again on every edit, walking the centre across a city.
- Alternatives considered: A per-edit distance allowance: considered and rejected for the reason above. No edits at all. Free edits with a re-review.
- Source: Documented (source): the header of `packages/shared/src/payload/widening.ts`.

## D-029 The match parameters are measured, offline, on synthetic populations

- Date: 2026-10-04 (PR #27)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `server/src/harness/` runs the unchanged `matchReport` over simulated populations and reports recall, false-positive rate and notifications per report. A smaller run is part of the unit tests and holds its figures within a band.
- Why: There are no real users to measure against, and the constants trade recall against how many people are notified. The harness makes that trade visible and guards it against accidental change.
- Alternatives considered: Tuning on field data only. No measurement.
- Source: Documented (README): [server/README.md](../server/README.md). Built in PR #27.

## D-030 Reports reach phones as signed static files, sharded by H3 cell

- Date: 2026-10-04 (PR #22)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Released reports are compiled into signed bundles, one per H3 shard at res 5 and again at res 3 (the coarser level a device falls back to when it has been in too many res-5 cells), plus a signed index. Devices fetch them from a CDN. A bundle path never changes its bytes: a change is a new generation at a new path, and the generation table is never reset. Matching pre-filters on res-7 cells; a shard is the parent of a res-7 cell.
- Why: The server must not learn which device is interested in which report, so reports are pushed out to everyone in a region rather than queried. Static, cacheable files are also what lets a small project serve a large population cheaply; the plan cites exposure-notification export files as the precedent. Immutable paths make caching safe and make a half-finished publish repeatable.
- Alternatives considered: A query API ("reports near me"), which tells the server where each device is. Push delivery of full report content. Geohash or S2 cells instead of H3. One global file.
- Source: Documented (README and source): `server/README.md`, the header of `server/src/shards/compiler.ts`, AGENTS.md. Built in PR #22.

## D-031 The cover of a search area is computed one way, on both sides

- Date: 2026-10-04 (PR #22)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The compiler files a report under every shard its search disc touches using `searchAreaCells` and `shardKeysForCells` from the shared package, not h3's `polygonToCells` with `compactCells`.
- Why: `polygonToCells` keeps only cells whose centre is inside the shape, so it can leave out a cell the disc touches, and devices derive their shards as parents of res-7 cells. Using the shared helpers gives one definition both sides agree on.
- Alternatives considered: The plan's `polygonToCells` plus `compactCells`.
- Source: Documented (README): "Open points for review" in `server/README.md`, and the compiler header.

## D-032 Everything a match screen needs is inside the broadcast payload

- Date: 2026-10-03 (PR #11); photo cap 2026-10-05 (PR #37)
- Status: Accepted
- Decided by: Captain for the photo cap (2026-10-05, as the entry records); not recorded for the rest
- Decision: The photo thumbnails (at most two a report, `MAX_PERSON_PHOTOS`, decided by the captain on 2026-10-05; each at most 256 px, inline base64) and the reporter's phone number are part of the signed query. Nothing is fetched lazily.
- Why: A fetch made only by devices that matched would tell the server who matched.
- Alternatives considered: A photo URL, which is smaller but leaks the match. The cost is recorded in `server/README.md`: the photos are nearly all of a bundle's size, a report with two typical ones is about 18 KB over the wire against the plan's 15 KB, and a device re-downloads a whole bundle when any report in its shard changes.
- Source: Documented (source): the header of `packages/shared/src/payload/query.ts`, citing plan section 6.2.

## D-033 Ed25519 signatures over canonical JSON, with keys pinned in the app

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Queries, bundles and the index are each signed over `findmyperson.<kind>.v1` plus canonical JSON. Readers verify on the raw value before applying a schema. Devices trust the public keys built into the binary. Several keys can be valid at once, each with `sign_from` and `verify_until`, so rotation has an overlap. The curve arithmetic is passed in by each runtime.
- Why: The files are served by a third-party CDN, so the device must be able to tell a genuine bundle from a tampered one without trusting the CDN or TLS alone. The domain separator stops a signature over one kind of document verifying as another. Injecting the primitive keeps the shared package free of runtime APIs, since Node and Hermes share no crypto API.
- Alternatives considered: TLS and certificate pinning only. JWS or another signed-envelope format. A key fetched from the server, which defeats pinning. A single key with no rotation.
- Source: Documented (source): the headers of `packages/shared/src/payload/signing.ts` and `server/src/shards/keys.ts`.

## D-034 Ed25519 verification on the phone is plain JavaScript (tweetnacl)

- Date: 2026-10-04 (PR #30)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The app verifies signatures with `tweetnacl` 1.0.3 behind the shared `Ed25519Verify` type (`app/src/fetch/ed25519.ts`), with one added rule: a signature whose S is not below the group order is refused.
- Why: Hermes has no WebCrypto and no Node crypto, so the primitive is either native code or plain JavaScript. tweetnacl needs nothing from the engine (no BigInt, no polyfill), so the same code runs on the phone and under Node in the tests. The extra rule makes the phone and the server's signer agree on every signature.
- Alternatives considered: All considered in that header. `@noble/curves`, which needs BigInt and a second package for SHA-512. A native binding (CryptoKit on iOS; Android has Ed25519 in the platform only from API 33), which would need a second library on Android, a bridge method carrying every document, and could not be tested without a phone.
- Source: Documented (source and PR #30): the header of `ed25519.ts`.

## D-035 The fetcher's two addresses of trust are constants in the binary

- Date: 2026-10-04 (PR #30)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The CDN origin and the trusted public keys are constants in `app/src/fetch/reportCdn.ts`, not settings and not values a server supplies. Both are unset today, and with either unset the app fetches nothing.
- Why: That is what pinning means: a build trusts the keys it was built with and nothing a server says later. Stopping with nothing on the network when unconfigured is the fail-closed choice.
- Alternatives considered: Remote configuration. A build-time environment variable. Trust on first use.
- Source: Documented (source): the header of `reportCdn.ts`, and AGENTS.md.

## D-036 Unknown versions are skipped and unknown fields are ignored

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `parseBroadcastQuery` checks `v` first and never parses a version it does not know. Each query in a bundle is verified and parsed on its own, so one newer entry does not discard the rest. API error `code` is validated as a string so an old app can read a new code.
- Why: Old app versions stay in the field for a long time and must not guess at formats they predate.
- Alternatives considered: Strict schemas that reject unknown fields. Best-effort parsing of newer versions.
- Source: Documented (README and source): "Choices worth knowing" in the shared package README.

## D-037 The fetcher pads its traffic: a constant request count and cover shards

- Date: 2026-10-04 (PR #26)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Every fetch cycle that reads an index makes exactly `FETCH_SHARD_REQUESTS_PER_CYCLE` (8) shard requests, whatever changed. The device also follows `FETCH_COVER_SHARDS` (8) shards it has no use for, chosen by a secret in the store, and treats them exactly like real ones. Nothing unverified is stored, and a cycle writes in one transaction.
- Why: The CDN operator sees IP, path and time for every request, and the shards a device asks for are where it has been in 30 days. Cover shards hide which of the followed shards are real; a constant count hides how many changed. The stated limit is that this hides which shards, not the rough region, and not that the device fetched at all. A consequence: `report_cache` holds reports from places the device has not been and must never be presented as "near you".
- Alternatives considered: Fetch exactly what is needed (cheapest, and leaks the most). Download everything (no leak, does not scale). Private information retrieval or an anonymising proxy. All five `FETCH_*` constants are marked provisional.
- Source: Documented (source and README): the header of `packages/shared/src/fetch/cycle.ts`, "Bundle fetcher" in the shared package README, AGENTS.md. Built in PR #26.

## D-038 Bundles and cache purge on Cloudflare R2

- Date: 2026-10-04 (PR #29)
- Status: Proposed
- Decided by: Claude (inferred from existing code): the choice of R2 is not written down
- Decision: The compiler's `ObjectStore` and `CdnInvalidator` interfaces are implemented for Cloudflare R2 (through its S3 API) and Cloudflare's zone cache purge. A directory store remains for a single box. The adapter is hand-written SigV4 over `fetch` with no SDK.
- Why: Inferred: the workload is almost entirely downloads of static files, so a store with no egress charge suits a non-commercial project; R2 speaks the S3 API, so the adapter is not tied to it; and the bucket's custom domain sits on a Cloudflare zone, so storage and cache purge are one vendor and one set of tokens. Skipping the SDK keeps the server at two runtime dependencies and lets tests swap `fetch` for a fake.
- Alternatives considered: Amazon S3 with CloudFront. Google Cloud Storage or Backblaze B2 behind a CDN. A static host or the server's own disk behind any CDN (the directory store already supports this). The AWS SDK instead of hand-written signing.
- Source: Documented (PR #29) for what was built and for "no new dependency". The reason for choosing R2 over other providers is not written down: inferred. No bucket is provisioned and the adapter has never run against a live one. The device side still treats the provider as undecided: the header of `app/src/fetch/reportCdn.ts` says its two constants wait for the storage and CDN decision.

## D-039 TypeScript on Node with Fastify

- Date: 2026-10-03 (PR #12)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: The backend is a Fastify 5 app in TypeScript, importing its schemas and endpoint table from the shared package.
- Why: The plan's reasoning is that the broadcast payload should have exactly one definition, used by the compiler, the device parser and the matching harness, and one language gives that for free. It concedes that Go's single static binary would be nicer to self-host.
- Alternatives considered: Go: considered in the plan. Any other Node framework. Serverless functions, which fit the API but not the compiler's "one at a time" rule.
- Source: Documented (plan), which recommended it; `server/README.md` for what was built. Introduced in PR #12.

## D-040 The server database is Node's built-in SQLite

- Date: 2026-10-03 (PR #12)
- Status: Proposed
- Decided by: Claude (inferred from existing code): the code differs from the plan, which named Postgres, and no approval is recorded
- Decision: `server/src/db.ts` uses `node:sqlite` with WAL. The schema and every query are in that one file.
- Why: The header says the same code then runs in tests (`:memory:`) and on a single box, that reports are rare so there is no write-volume concern, and that moving to Postgres later means replacing that file only. Inferred beyond that: no database service to provision for a project with no deployment yet, and no extra dependency.
- Alternatives considered: Postgres, as the plan had it. `better-sqlite3`. A hosted database.
- Source: Inferred from code, with the stated reasoning in the header of `db.ts`. It differs from the plan, which named Postgres.

## D-041 Endpoints, errors and idempotency are defined once, as data

- Date: 2026-10-03 (PRs #11, #12)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `API_ENDPOINTS` in the shared package lists method, path, schemas, success status and idempotency rule; the server registers routes from it and the app builds requests from it. Every failure has one shape and each error code one HTTP status. Writes that are not naturally idempotent carry a client-minted `Idempotency-Key` scoped to the device.
- Why: A phone sends from a durable queue and may retry a request it cannot know succeeded, so every create must be safe to send twice. One table for both sides removes the chance of the app and server disagreeing about a path or a status.
- Alternatives considered: OpenAPI with generated clients. tRPC or GraphQL. Deduplication by content instead of by key.
- Source: Documented (source): `packages/shared/src/api/endpoints.ts`, `errors.ts`, `idempotency.ts`.

## D-042 Submits are queued durably on the phone before any network call

- Date: 2026-10-04 (PR #28)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: "Broadcast report" writes an `own_report` row first, then a queue runner posts it with backoff. `app/src/report/` is the only submit path.
- Why: A confirmed report must survive no signal and a killed app. It pairs with decision 41: the queue row holds the idempotency key that makes the retry safe.
- Alternatives considered: Post directly and show an error on failure. A generic background-upload library.
- Source: Documented (README): `app/src/navigation/README.md` and AGENTS.md. Built in PR #28.

## D-043 Every report is held for manual review before it is broadcast

- Date: 2026-10-03 (addendum; PR #12)
- Status: Accepted
- Decided by: Captain (plan addendum 2026-10-03; the plan is kept outside this repository and was not seen when this was written)
- Decision: A report is born `pending`. Only an operator's explicit release makes it `released`; `rejected` is final. Nothing automatic changes the state, and `ServerDb.listBroadcastable` is the only read the compiler uses. App copy must say "under review", never "live".
- Why: A broadcast notifies strangers and shows them a phone number. A person phoning the reporter before release confirms the report is real and that the number reaches the reporter. It is also what makes the light device identity (decision 44) acceptable.
- Alternatives considered: Broadcast on submit. Automated checks only. Review after broadcast. Known gaps: a widening edit on a released report is not re-reviewed, and the operator routes are guarded only by a device-id allow-list on a forgeable header until real operator authentication is built.
- Source: Documented (plan): addendum of 2026-10-03. Documented (README and source): "The manual-review gate" in `server/README.md`, `server/src/lifecycle.ts`, AGENTS.md.
- Note (T-000): PR #35 added the `/operator` page behind a one-token stub (D-057), so the operator routes are no longer the only way to review; the gap it describes (no real operator authentication) remains.

## D-044 Device identity is a client-generated id with no verification

- Date: 2026-10-03 (addendum)
- Status: Accepted
- Decided by: Captain (plan addendum 2026-10-03; the plan is kept outside this repository and was not seen when this was written)
- Decision: A device is a random UUID v4 generated on first use, kept in the encrypted store and sent as `Authorization: FMP-Device <uuid>`. The server believes the header. No attestation, no phone verification, no accounts. The scheme sits behind two interfaces (`DeviceIdentity`, `DeviceAuthenticator`) so it can be replaced without touching callers.
- Why: The app has no accounts and should not get any. The plan recommended verifying the reporter's phone number, because an unverified number shown to strangers lets someone attach a third party's number to a report. The addendum chose the plain id alone, on the reasoning that the manual phone call before release (decision 43) already confirms the number, with the explicit caveat that this must be revisited if the manual step is removed or stops scaling.
- Alternatives considered: All considered in the plan. Platform attestation (Play Integrity, App Attest), which breaks on de-Googled and F-Droid builds. SMS-verified reporter number, which costs per message and adds friction. IP limits with proof of work, which punish shared carrier addresses and burn battery. The plan's own recommendation was a mix of the first three.
- Source: Documented (plan): addendum of 2026-10-03, which is outside the repository. In the repository: "Decisions built as decided" in `server/README.md`, and comments in `server/src/app.ts`, `app/src/report/identity.ts` and `packages/shared/src/identity/deviceIdentity.ts`.

## D-045 One tip per device per report, and nothing else limits tips

- Date: 2026-10-03 (addendum)
- Status: Accepted
- Decided by: Captain (plan addendum 2026-10-03; the plan is kept outside this repository and was not seen when this was written)
- Decision: `responses` is `UNIQUE (query_id, device_id)`. There is no daily or monthly cap across reports.
- Why: The structural limit is the product rule (one message per match, no chat), so it costs nothing. The broader caps were declined.
- Alternatives considered: Considered in the plan: a global cap of 5 per day and 20 per 30 days with over-limit tips queued for review (the plan's recommendation); a token bucket scaled to local report volume; no limit.
- Source: Documented (plan): addendum of 2026-10-03. Documented (README): `server/README.md` and the header of `server/src/db.ts`.

## D-046 Tips are plaintext to the server, filtered for links and payment requests

- Date: 2026-10-03 (addendum)
- Status: Accepted
- Decided by: Captain (plan addendum 2026-10-03; the plan is kept outside this repository and was not seen when this was written)
- Decision: A tip is sent to the server in the clear over TLS. `moderateResponse` holds any text containing a link or a payment identifier and delivers everything else at once, to be reviewed afterwards. It is a regex heuristic that prefers over-holding.
- Why: The relay was made readable specifically so that moderation is possible: the people receiving tips are families of missing people, a known target for extortion. The narrow filter covers that shape without needing a person to approve every tip.
- Alternatives considered: End-to-end encrypted tips, which rule out moderation. Considered in the plan: human review of every tip before delivery; a broader classifier for threats and abuse; no moderation.
- Source: Documented (plan): the relay choice and the addendum of 2026-10-03. Documented (source): the header of `server/src/moderation.ts`.

## D-047 The server is bundled with esbuild before it runs

- Date: 2026-10-04 (PR #24)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `server/build.mjs` bundles the three entries into `dist/` as plain ESM; `fastify` and `zod` stay external. A test builds and runs the entries under plain `node`.
- Why: The sources import each other and the shared package without file extensions, and the shared package ships as TypeScript. Node's own type stripping cannot resolve those imports, so the documented run command did not work. Bundling fixes that without changing the import style everywhere or adding a publish step for the shared package.
- Alternatives considered: Add `.ts` extensions to every import and use Node's type stripping. Run through `tsx` or `ts-node`. Compile with `tsc` and build the shared package to JavaScript first.
- Source: Documented (PR #24) and Documented (README): "Running it" in `server/README.md`, and the comment in `build.mjs`.

## D-048 One package holds every contract, in pure TypeScript with injected services

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `packages/shared` is the only definition of the payload, signing, geometry, the store schema, API shapes, stay derivation, matching, retention and the fetcher. It has no I/O, no clock and no randomness of its own: the SQLite driver, the Ed25519 primitive, the transport and random bytes are arguments. A test forbids Node APIs outside `src/testing/`.
- Why: The same code has to run on the server (Node) and in the app (Hermes) and be testable without either. Passing services in is also what makes the matching rule, the purge and the fetcher runnable from a cold background wake with no UI.
- Alternatives considered: Per-runtime copies kept in step by tests. A shared package that imports platform libraries directly. Code generation from a neutral schema language.
- Source: Documented (README): the shared package README and AGENTS.md. Introduced in PR #11.

## D-049 zod as the schema library

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Every wire and API shape is a zod 4 schema. No schema transforms its input.
- Why: One definition gives both the TypeScript type and the runtime check, and zod 4 emits JSON Schema, which is how the files for Kotlin, Swift and third parties are produced. Transforms are banned because a signed document must be canonicalised from the bytes as received.
- Alternatives considered: JSON Schema as the source with generated types. io-ts, Valibot or TypeBox. Hand-written validators.
- Source: Documented (README): "Choices worth knowing" in the shared package README.

## D-050 Cross-language agreement is held by generated files and golden vectors

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: Kotlin and Swift do not restate constants or SQL. They read generated files (`StoreContract.kt`, `StoreContract.swift`, the codegen output) and test against golden vectors under `packages/shared/contracts/` (canonical JSON, signing, geometry, stays, matching, widening). Tests fail when a committed copy differs from what the generator produces.
- Why: Three languages implement the same rules and cannot share code (decision 13). Vectors turn "the platforms agree" into something a pull request can fail on.
- Alternatives considered: A shared native core. Review by hand.
- Source: Documented (README): `packages/shared/contracts/README.md` and AGENTS.md.

## D-051 Tunable numbers live in one file, each labelled decided or provisional

- Date: 2026-10-03 (PR #11)
- Status: Accepted
- Decided by: Not recorded (the reasoning is written down in this repository, the person who decided is not named)
- Decision: `packages/shared/src/constants.ts` holds every number the contracts depend on (150 m, 30 minutes, 30 days, H3 resolutions, size caps, fetch constants), each marked as a product decision, a plan choice or a provisional bound.
- Why: Nobody writes 150 or 1800 at a call site, and a reader can tell which numbers are safe to tune from which are promises.
- Alternatives considered: Per-module constants. Remote configuration, which would let a server change matching behaviour and is at odds with pinning.
- Source: Documented (source): the header of `constants.ts`.

## D-052 A non-commercial, open-source project under the MIT licence

- Date: 2026-10-08 (recorded in T-000; the README and `LICENSE` have said so since the first commit, 2026-09-17)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: findmyperson is a non-commercial, open-source app released under the MIT licence. Nothing in the code takes payment, shows advertising or collects revenue.
- Why: The root `README.md` opens with "A non-commercial, open-source app" and the `LICENSE` file is MIT. The server's choices point the same way (a store with no egress charge, D-038; a single-box database, D-040). The reason the project is non-commercial is not written down in the repository.
- Alternatives considered: A commercial or freemium app. A source-available licence. A copyleft licence (GPL, AGPL), which would stop a closed fork of the server. Related and still open: how strict the "non-commercial" bar is for the projects the Home screen links to (see "Needs you" in `TASKS.md`).
- Source: Inferred from `README.md` and `LICENSE`.

## D-053 No analytics, crash reporting, advertising or other third-party SDK in the app

- Date: 2026-10-08 (recorded in T-000; true of every merged app change up to PR #39)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The app depends on no analytics, crash-reporting, advertising, maps, push or SMS library. Its only network destinations are the report API and the CDN that serves the signed bundles, and both addresses are unset today, so the shipped build makes no network request at all.
- Why: Inferred: the product promise is that location history never leaves the phone and the server never learns who matched (D-026, D-037), and a telemetry SDK would be a second channel that could break it. `app/package.json` lists none, and "Third-party services" in `ARCHITECTURE.md` records the absence.
- Alternatives considered: A crash reporter such as Sentry or Crashlytics (useful with nobody able to read a device log, at the cost of a third party seeing diagnostics). Privacy-preserving usage counts. A self-hosted crash endpoint.
- Source: Inferred from `app/package.json` and the dependency lists in `ARCHITECTURE.md`.

## D-054 Home is the root screen and a hamburger menu is the only navigation; there is no tab bar

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-05, PR #36)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: After onboarding the app opens on Home. Home's hamburger menu reaches "Report a missing person", History and Settings; `CaptureHealth`, `PermissionFlow` and `LiveReport` open from Home's own controls. The bottom tab bar from the first app shell (PR #14) was removed.
- Why: The routes file and `theme.ts` say the v2 design mockups have no tab bar and no report button, and that the mockups outrank older design notes (D-017). Nothing records that the captain chose the menu over tabs apart from the mockups themselves.
- Alternatives considered: Keeping the bottom tabs (Home, History, Settings) with a floating report button. A drawer navigator. Home with inline buttons only.
- Source: Inferred from `app/src/navigation/routes.ts`, `screens.tsx` (`HomeRoute`), the header of `app/src/design-system/theme.ts` and the PR #36 title.

## D-055 Android application identity and SDK levels

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-04, PR #33)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The Android app id is `dev.findmyperson.app`, built from the React Native 0.87 template with `minSdkVersion` 24, `compileSdkVersion` 37 and `targetSdkVersion` 36; the app's release path signs only through an environment-driven init script. Until a signed release has been made, the debug APK that CI attaches to every run is how the app reaches a phone.
- Why: Inferred: the template's defaults plus what the two native modules need (both set `minSdk` 24 when standalone). The `dev.findmyperson` namespace is also what the Kotlin packages use. The reason for the identifier and for 24 as the floor is not written down.
- Alternatives considered: A different application id (it cannot change once published). A higher `minSdk`, which would drop older phones but allow newer platform APIs. An Expo prebuild project instead of the plain template (D-007).
- Source: Inferred from `app/android/build.gradle`, `app/android/app/build.gradle` and `docs/BUILDING.md` ("The Android project").

## D-056 What the report form asks, and its provisional defaults

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-04 and 2026-10-05, PRs #28, #34, #37)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The form takes the person's name, up to two optional photos, a required E.164 phone number for the reporter, a last-seen place, date and time, and details. It does not ask for a search radius or window: it sends a 500 m radius and a window of 30 minutes either side of the last-seen time, both marked provisional. Until a map provider is chosen the place is typed or pasted as latitude and longitude.
- Why: `form.ts` says the mockup has no radius or window control, so the defaults stand in. The coordinate fields are the seam left for a map picker, which would add a third-party SDK and a privacy question (a map SDK sees where the reporter looks). The reporter's number is required because the operator phones it before release (D-043).
- Alternatives considered: A radius and window slider for the reporter. A map picker now. Optional phone number. A verified phone number (D-044).
- Source: Inferred from `app/src/report/form.ts`, `coordinates.ts` and `app/src/navigation/README.md`.

## D-057 Operator review is a server-rendered page behind one shared token, with a log-only alert

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-05, PR #35)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The manual-review gate (D-043) is operated from `GET /operator`, one server-rendered HTML page with no script, listing pending reports and held tips with Release and Reject. Access is a single shared token from `FMP_OPERATOR_WEB_TOKEN` (at least 16 characters, otherwise the page refuses everything), exchanged for a 12-hour signed cookie. When a report arrives the only alert is a log line (`report.pending`). All of this is marked temporary in the code, to be replaced by real operator authentication and a real alert channel.
- Why: Inferred: before the page the only way to review was calling the operator routes by hand, which the previous `ARCHITECTURE.md` listed as "no operator UI", and the gate is the project's main safety control. A page with no script and no new dependency was the smallest thing that let a person do it. `server/README.md` states the limits (no accounts, no record of who decided, no sign-in rate limit).
- Alternatives considered: Calling the operator API routes by hand with `curl`. A separate admin web app. A command-line tool. Real login (accounts, mTLS, or an identity provider) from the start. A push, SMS or email alert in place of the log line.
- Source: Inferred from `server/src/operatorPage.ts`, `server/src/alerts.ts` and "The operator page" in `server/README.md`. Flagged in "Needs you" as admin-screen scope to confirm.

## D-058 The watch list: where the phone has been in 30 days, plus neighbours, capped at 200 cells

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-05, PR #38)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The `subscription` table is kept equal to every res-5 cell with a fix or a stay in the last 30 days, the neighbours of each, and their res-3 parents. Above `SUBSCRIPTION_RES5_CAP` (200, provisional) the device gives up res-5 cells a whole res-3 region at a time, fullest region first, and follows the region's bundle instead. Res-3 parents are push-wake topics only and are never fetched as ordinary shards unless coarsened.
- Why: The header of `packages/shared/src/subscription/watchSet.ts` gives the reasoning (a device near a cell edge already follows the other side; a res-3 bundle holds a whole region, so it is the price of staying under the cap). That the cap is 200 and that coarsening goes to res 3 and never res 4 follow from what the compiler publishes. The number is "not measured against real traces".
- Alternatives considered: A fixed radius around the current position. Following only res-3 regions. No cap. A cap that drops the oldest cells instead of coarsening.
- Source: Documented (source): the header of `watchSet.ts` and "Subscription manager" in `packages/shared/README.md`. Recorded here because the choice is not in the earlier decision list.

## D-059 Matching is the last step of every maintenance run, once per report, and a match is never repeated

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-08, PR #39)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: `runMatchPass` runs at the end of `DataStore.runMaintenance` and again after a fetch that stored new reports, so a report is matched in the wake that fetched it. It writes at most one `match` row per report, ever (`UNIQUE (query_id)`), and moves `report_cache.last_matched_at`. A new report that arrives after the history it would match is matched retrospectively, and a sample may reach the store up to an hour after the moment it records (`MATCH_SAMPLE_LATE_SEC`, provisional). Nothing yet acts on the rows it inserts.
- Why: Inferred from `packages/shared/src/match/runner.ts` and `app/src/fetch/trigger.ts`: the debt is kept in the store (`last_matched_at IS NULL`) so a missed signal loses nothing, and one notification per report is the product rule that also keeps the anti-oracle property of D-027.
- Alternatives considered: Matching only when a report is fetched. A separate scheduled job. Allowing a second notification when a report is widened. Matching in the capture module on every fix.
- Source: Documented (README and source): "Match runner" in `packages/shared/README.md` and the header of `runner.ts`. Recorded here because the choice is not in the earlier decision list.

## D-060 When the app fetches reports, and how often

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-04, PR #30)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: A fetch cycle may start at app start, on every return to the foreground and on every capture wake that reaches JavaScript, but not within 900 seconds (`FETCH_TRIGGER_MIN_INTERVAL_SEC`) of a completed cycle. A failed cycle backs off from 60 seconds up to an hour; on a metered connection a cycle is put off for up to 6 hours; changed shards that did not fit one cycle's 8 requests are fetched by further cycles in the same wake, up to a maximum. Nothing fetches when the app has not been woken: there is no scheduled OS job.
- Why: Inferred from the header of `app/src/fetch/trigger.ts`: a moving phone stores a fix every few seconds, so without a minimum interval each would cause a download. The constants are marked provisional.
- Alternatives considered: An OS-scheduled background task (WorkManager, `BGTaskScheduler`) that fetches without a capture wake. A push that tells the phone a shard changed (not built, see D-058's push topics). A fixed polling interval while the app is open.
- Source: Documented (source): the header of `app/src/fetch/trigger.ts` and the `FETCH_*` constants. Recorded here because the choice is not in the earlier decision list.

## D-061 H3 is also compiled into the iOS capture module, as a vendored C library

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-03 and 2026-10-04, PRs #15, #16)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The H3 C library 4.5.0 is vendored unmodified under `packages/native-location-capture/ios/Sources/CH3` (Apache-2.0, by `scripts/vendor-h3.sh`) so that the Swift capture module can write the res-7 and res-5 cell of each fix itself. The Kotlin module does it differently: `core/H3.kt`, a plain-Kotlin port of `latLngToCell` and `cellToParent`, so its write path loads no native library; it is held to the same golden vectors (`geo-vectors.json`) as TypeScript and, in tests, to h3-java (a test-only dependency).
- Why: Inferred: the native writer stores `h3_r7` and `h3_r5` with each sample (D-009), and it runs with no JavaScript to compute them. Using the same H3 version as `h3-js` keeps the platforms agreeing (D-050). Why the two platforms took different routes (a C library on iOS, a port on Android) is not written down.
- Alternatives considered: A Swift port like the Kotlin one (no vendored C). A Swift H3 package from a package manager (a new dependency). Computing cells only in TypeScript and leaving the columns empty for natively written rows, which would break the "no JavaScript" wake. Leaving the cells to be filled in later by a maintenance pass.
- Source: Inferred from `packages/native-location-capture/ios/README.md` (files table and the geometry test line).

## D-062 Android location comes from Google Play services, with a fallback backend for phones without them

- Date: 2026-10-08 (recorded in T-000; code merged 2026-10-04, PR #16)
- Status: Proposed
- Decided by: Claude (inferred from existing code)
- Decision: The Android capture module uses the fused location provider (`play-services-location` 21.3.0) and also carries `PlatformBackend`, a location path for phones without Google Play services. The M0 trial ran only on the fused provider, so the fallback has never run on a device.
- Why: Inferred: the fused provider is what the M0 trial measured and what makes background capture affordable, and the fallback keeps the app working on de-Googled phones (the same population that rules out Play Integrity in D-044). Whether the fallback is wanted is not stated.
- Alternatives considered: Fused provider only, with the app refusing to capture on phones without it. The platform `LocationManager` only. A third-party location library. Dropping the fallback: it is listed in "Needs you" as unverified scope to confirm.
- Source: Inferred from `packages/native-location-capture/android/README.md` and `platform/LocationBackend.kt`.
