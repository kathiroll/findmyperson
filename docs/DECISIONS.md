# Decisions

The significant technical decisions in findmyperson, why each was likely made, and what else could have been done. It is a reading aid, not a record of authority: the README or source file named in each entry is where the decision actually lives.

It describes `main` at commit `0a1bbb4` (2026-10-04, pull request #30). [ARCHITECTURE.md](ARCHITECTURE.md) describes what was built; this file is about why.

## How to read an entry

- **Status** says where the decision can be found:
  - **Documented (README)**, **Documented (PR #n)**, **Documented (source)**: the reasoning is written down in the repository, in the place named.
  - **Documented (plan)**: the reasoning is in the architecture plan and its addenda. That plan is a planning record kept outside this repository, so the entry summarises it; the code comments that cite "plan" sections refer to it.
  - **Inferred from code**: nothing states the reason. The "why" is a reading of the code and history, and may be wrong.
- **Why** is the stated reason where there is one, and marked as inferred where there is not.
- **Alternatives** lists what else existed. "Considered" means the record shows it was weighed; otherwise it is simply an option that was available.

## Workspace and tooling

### 1. One pnpm workspace, with a hoisted `node_modules`

- **Decision:** The app, the shared package, the two native-module packages and the server are members of one pnpm workspace (pnpm 12.8.1, pinned in `packageManager`), linked with `workspace:*`. `.npmrc` sets `node-linker=hoisted`.
- **Status:** Documented (README): [WORKSPACE.md](../WORKSPACE.md), and the comment in `.npmrc`. Introduced in PR #8.
- **Why:** The app and the server must import the same payload types and matching code with no publishing step and no version drift. pnpm is strict about undeclared dependencies and has first-class workspace links. The hoisted linker gives up some of that strictness on purpose: React Native's Metro bundler and native autolinking expect a flat `node_modules` and do not follow pnpm's default symlinked layout reliably.
- **Alternatives:** npm or Yarn workspaces (flat by default, less strict). pnpm's default isolated linker with Metro configured to follow symlinks. Separate repositories with a published shared package. A build orchestrator (Turborepo, Nx), which the size of the repo does not yet need.

### 2. One test runner (Vitest), with React Native stubbed in component tests

- **Decision:** Vitest runs every member from one root config (`projects`). App component tests run against JavaScript stubs of react-native and of the navigators, not against the real library or Jest's React Native preset.
- **Status:** Documented (README): WORKSPACE.md and the "App UI" and "App navigation" notes in [AGENTS.md](../AGENTS.md).
- **Why:** TypeScript works with no extra setup and one command covers the repo. Stubbing react-native keeps the tests in plain Node, which matters because no native project exists and nothing can run on a device (decision 5).
- **Alternatives:** Jest with `@react-native/jest-preset`, the conventional choice, which M0's store proof used. Device or simulator tests (Detox, Maestro), which decision 5 rules out for now.

### 3. Strict TypeScript everywhere, configured once

- **Decision:** One `tsconfig.base.json` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `verbatimModuleSyntax`; one flat ESLint config and one Prettier config at the root.
- **Status:** Documented (README): WORKSPACE.md. The specific flags are inferred from `tsconfig.base.json`.
- **Why:** Inferred: the contracts package is the single source of types for three runtimes, so loose optional and index typing would leak into every consumer.
- **Alternatives:** Per-package configs; default `strict` only.

### 4. M0 research code stays in the repository, outside the workspace

- **Decision:** `m0/` holds the trial apps and the store proof. It is not a workspace member, and lint, format and tests skip it. One file is still load-bearing: the cipher parameters there are pinned by a test to the real build's copy.
- **Status:** Documented (README): WORKSPACE.md, `m0/README.md`, the SQLCipher note in AGENTS.md.
- **Why:** M0 is the evidence for several later decisions (capture modes, the store open sequence), so it is kept readable, but it has its own toolchains (Gradle, Xcode, npm) that should not slow or break the workspace.
- **Alternatives:** A separate repository or an archived branch. Folding it into the workspace.

### 5. No simulators or emulators; decisions live where a unit test can reach them

- **Decision:** Nothing is claimed about device behaviour unless it was verified from source or build output; everything else is listed as unverified in the relevant README. To make that workable, both native modules are split into a platform-free core that holds every decision and is unit-tested (JVM for Kotlin, `swift test` for Swift) and thin platform adapters that are only compiled.
- **Status:** Documented (README): AGENTS.md, and the "Verified and not verified" sections of the package READMEs.
- **Why:** Background location capture behaves differently on a real phone than on any simulator, and M0 was run on live phones only. Rather than trust a simulator, the design moves logic to where it can be tested for certain and is honest about the rest.
- **Alternatives:** Simulator and emulator runs in CI. Instrumented device tests on a device farm. Both cost money or give false confidence for this particular problem.

### 6. Build scripts are the single build path; Android on every pull request, iOS only on `main` and tags

- **Decision:** `build/*.sh` is used by both local builds and CI. Signing comes only from environment variables, injected on Android by a Gradle init script so the app's own build file never mentions secrets. A fork builds unsigned with no secrets.
- **Status:** Documented (README): [BUILDING.md](BUILDING.md). Introduced in PR #9.
- **Why:** A local build is then a faithful rehearsal of CI. macOS runners cost roughly ten times a Linux runner, so iOS does not build on pull requests.
- **Alternatives:** Fastlane or EAS Build. iOS on every pull request. Signing config in the Gradle and Xcode projects.

## App platform

### 7. React Native (New Architecture) for the app, with native code only where the OS requires it

- **Decision:** The UI, matching, storage access and networking are TypeScript on React Native 0.87.1. Background capture and key handling are Kotlin and Swift.
- **Status:** Documented (plan), and WORKSPACE.md for the version.
- **Why:** One language for the app, the matching engine and the server means one definition of the broadcast payload. The plan states that background location APIs cannot be reached from JavaScript, so the native part is unavoidable, and that the New Architecture is the default since 0.76 with the legacy bridge being removed.
- **Alternatives:** Two fully native apps (the M0 trial apps are exactly this). Flutter or Kotlin Multiplatform. Expo with config plugins; nothing in the repo uses Expo, which is inferred to follow from needing custom native modules and a custom SQLCipher build.

### 8. A Turbo Native Module spec with codegen is the one capture interface

- **Decision:** `packages/native-location-capture/src/specs/NativeLocationCapture.ts` is the single interface. The Kotlin module, the Swift module and an in-memory fake all implement it. The generated native interfaces are committed under `contracts/` and a test fails when they drift.
- **Status:** Documented (README): [packages/native-location-capture/README.md](../packages/native-location-capture/README.md). Introduced in PR #13.
- **Why:** A method missing or mistyped on one platform becomes a compile error instead of a runtime surprise. Typed event emitters make "no coordinates in an event" something a test checks rather than a convention. The fake lets every screen be tested without a phone.
- **Alternatives:** A legacy bridge module with `addListener` events and JSON strings (the plan's first draft returned diagnostics as a JSON string; rejected because two platforms writing free-form JSON would drift). A community library such as a background-geolocation package. Two unrelated native APIs behind a TypeScript adapter.

### 9. Coordinates never cross from native to JavaScript on the capture path

- **Decision:** The native module writes each fix straight into the encrypted store. No return value or event carries a latitude or longitude. JavaScript reads positions only from the store.
- **Status:** Documented (README): the capture package README, citing plan section 5.5.
- **Why:** The OS relaunches the app in the background with no JavaScript running, so the native side has to be able to store a fix by itself. Keeping coordinates off the bridge also removes a whole class of accidental leaks into logs and events.
- **Alternatives:** Deliver fixes to JavaScript and write from there, which loses every fix taken while JavaScript is not running. A native staging store drained by TypeScript: considered in the plan and rejected because it doubles the encrypted-data and purge surface, and a crash could strand a staging file past retention.

### 10. The native side finds the key and the file by itself

- **Decision:** The interface has `getOrCreateStoreKeyHex()`, `getStoreDirectory()` and `initStore()` rather than `initStore(dbPath, keyHex)` with JavaScript supplying the key.
- **Status:** Documented (README): "Where this differs from the plan's draft" in the capture package README.
- **Why:** Same root cause as decision 9: a background relaunch has no JavaScript to hand over a key. This is the shape the M0 store proof showed to work.
- **Alternatives:** The plan's draft, with JavaScript owning the key (for example through a keychain library) and passing it in.

### 11. Android capture: WorkManager by default, foreground service as a user-selectable mode

- **Decision:** Two modes. `wm` (a periodic WorkManager job, no notification) is the default. `fgs` (a foreground service with a permanent notification) is the alternative, selected at run time through `useForegroundService` in the `start` config. The selection is stored natively and restored after a reboot. If the service cannot run, the module falls back to the periodic job; it never falls back the other way.
- **Status:** Documented (plan): addendum of 2026-10-02. Documented (README): the capture package README and its `android/README.md`.
- **Why:** A permanent notification is a real cost to the user, and a location foreground service for passive, always-on capture is a poor fit for the use cases Google Play approves, so it is a store-review risk. Making it a setting needed no new architecture because the spec already carried the flag. There is no fallback from `wm` to `fgs` because that would show a notification the user chose not to have.
- **Alternatives:** Foreground service as the default (more reliable, per the trial). A build-time choice. Exact alarms. One mode only.

### 12. iOS capture: four Core Location services and relaunch on launch

- **Decision:** Continuous updates are the sampler; significant-location-change, visits and an exit region around the last sample exist to get the dead app relaunched. Every launch restarts capture natively. `CLVisit` arrivals and departures are written as `stay` rows, not as samples.
- **Status:** Documented (README): `packages/native-location-capture/ios/README.md`, citing plan section 5.3 and the M0 trial on a real iPhone.
- **Why:** iOS never restarts continuous updates for a terminated app, so the three relaunching services are what make capture survive a process death. A visit is reported minutes to hours late, so it is a dwell interval and not a fresh fix.
- **Alternatives:** Significant-change only (coarse, roughly 500 m). Background fetch or silent push as the wake source. Treating visits as samples.

### 13. The two capture implementations are separate codebases with one contract

- **Decision:** Kotlin and Swift implementations share no code. They share the spec, the SQL they may run (`native-writer.json`), the cipher parameters and the geometry vectors, all from `packages/shared/contracts/`. Each owns its own directory so the two never touch the same file.
- **Status:** Documented (README): "For the native tasks" in the capture package README.
- **Why:** The platforms' background models have almost nothing in common (decisions 11 and 12). What must agree is behaviour at the edges, and that is pinned by generated constants and golden vectors rather than by shared source.
- **Alternatives:** Kotlin Multiplatform or a C++ core shared through JSI. A third-party cross-platform location library.

### 14. A fix is stored when the interval has passed or the phone has moved

- **Decision:** No minimum distance is given to the OS location provider. The rule "interval passed or moved `minDistanceM`" is applied in the module's own code on both platforms.
- **Status:** Documented (README): the capture package README, which notes this settles a reading of the plan.
- **Why:** A hard distance filter stores nothing from a phone that is sitting still, and stays are built from exactly those samples.
- **Alternatives:** The plan's literal 100 m minimum update distance on the Android location request.

### 15. No state library; the store and the capture module are the state

- **Decision:** The app uses React context for three injected dependencies (capture module, data store, report services) and `useState` for what is on screen. Durable state is rows in the encrypted store, reached through a small `DataStore` facade with a serial work queue.
- **Status:** Inferred from code (`app/src/store/DataStoreContext.tsx`, `app/src/permissions/CaptureContext.tsx`, `app/src/report/services.tsx`).
- **Why:** Inferred: nearly everything the app shows is already persisted either in the store or natively by the capture module, so a client cache would be a second copy to keep in sync. Injecting the three dependencies through props and context is what lets every screen be tested against the fake module and a real SQLCipher file under Node.
- **Alternatives:** Redux or Zustand with persistence. A query library over the store. AsyncStorage or MMKV for small values, which would put data outside the encrypted file and outside "Delete all my data".

### 16. Route names, params and deep links have one definition

- **Decision:** `app/src/navigation/routes.ts` defines every route and deep link. A screen task replaces a stub in `screens.tsx` and keeps the route name. React Navigation 7 with a native stack and bottom tabs.
- **Status:** Documented (README): `app/src/navigation/README.md` and AGENTS.md. Introduced in PR #14.
- **Why:** Screens were built by separate tasks in parallel; a fixed route table let each one land without touching the others, and notification links can be built from the same file.
- **Alternatives:** Expo Router or file-based routing. Per-screen route declarations. Note that `theme.ts` records the v2 mockups dropping the tab bar for a hamburger menu, which the navigator has not followed yet.

### 17. Design tokens come from the mockups; fonts are bundled as static instances

- **Decision:** Tokens live only in `app/src/design-system/theme.ts`, extracted from the v2 mockups, which outrank older design notes. Fonts are static cuts of two variable families.
- **Status:** Documented (source and README): the header of `theme.ts`, `app/assets/fonts/README.md`, AGENTS.md.
- **Why:** One source for colours and type stops screens drifting. React Native on Android cannot select variable-font axes, so static instances are required.
- **Alternatives:** A component library (Paper, Tamagui). System fonts. Variable fonts on iOS only.

## On-device store

### 18. One encrypted SQLite file: SQLCipher through op-sqlite

- **Decision:** All on-device data is in one SQLCipher 4 database. TypeScript opens it through op-sqlite 18.2.5 with its SQLCipher flag; Kotlin and Swift open the same file with the same pinned parameters. The parameters are one JSON file from which native constants are generated.
- **Status:** Documented (plan) and Documented (README): [packages/encrypted-store/README.md](../packages/encrypted-store/README.md). Proved in M0 (PR #7), built in PR #17.
- **Why:** One schema and one query layer in TypeScript, with a native writer that can run without JavaScript. The plan named the risk: both sides must link a compatible SQLCipher and use identical parameters or the file will not open, in the background, with no debugger. Hence the pinned parameters, the read-back check on every open, and the M0 proof before anything was built on it.
- **Alternatives:** Realm or WatermelonDB. Plain SQLite relying on OS file protection only. A native-only store with a query API over the bridge. An encrypted key-value store, which does not fit time-and-cell range queries.

### 19. TypeScript owns the schema; native code only checks the version

- **Decision:** The schema version is `PRAGMA user_version`. Migrations live in `packages/shared` and are frozen once released. Native code never creates or alters a table: it compares the version with the one it was built for and writes nothing if they differ. The two natively written tables carry no constraints beyond `NOT NULL`.
- **Status:** Documented (source): the header of `packages/shared/src/store/migrations.ts`.
- **Why:** One owner for the schema avoids three implementations of each migration. `user_version` is readable before any table exists and changes in the same transaction as the schema. Constraints are left off the native tables because a failed constraint in the background would drop a fix where nothing can report it.
- **Alternatives:** A schema-version row in a table. Native code running its own migrations. An ORM or migration tool.

### 20. One list says which task may write which table

- **Decision:** `packages/shared/src/store/ownership.ts` names the owner of every write path. Writes go only through the functions in `store/tables/`.
- **Status:** Documented (source): the header of `ownership.ts`.
- **Why:** Eight separate tasks read or write these tables. The list stops two of them both assuming a write is theirs, and a test checks it covers exactly the tables the migration creates.
- **Alternatives:** A repository class per feature. Convention only.

### 21. The store key: random, device-bound, readable while the phone is locked

- **Decision:** A 32-byte random key made on first use. iOS: a Keychain generic password with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Android: a file in the no-backup directory, wrapped by an AES-256-GCM key in the Android Keystore that requires neither an unlocked device nor user authentication. A key that exists but cannot be read is reported, never replaced.
- **Status:** Documented (README): "The key" in the encrypted-store README.
- **Why:** Capture has to write while the phone is locked in a pocket, so the key must be readable then. The cost is stated plainly in the same README: the encryption protects the file when it is read outside the app, not against someone who has the phone unlocked. Replacing an unreadable key would silently orphan every stored row. `EncryptedSharedPreferences`, which the plan named for Android, is deprecated and lives in a location Android backs up, so a plain wrapped file is used instead.
- **Alternatives:** A key that needs the device unlocked or biometric authentication (stronger, and breaks background capture). A passphrase-derived key. `EncryptedSharedPreferences`. A key held in JavaScript through a keychain library.

### 22. Location history is kept out of cloud backups, in three layers, enforced by tests

- **Decision:** Android: the store and wrapped key are in `noBackupFilesDir`; the manifest sets `allowBackup="false"` plus rule files excluding every domain from cloud backup and device transfer; and the store refuses to open in an app that allows backup. iOS: the store directory carries `isExcludedFromBackup`, set and read back on every open. A policy test reads the manifests and native sources on every pull request, and the Android build checks the merged manifest.
- **Status:** Documented (README): "Backup exclusion" in the encrypted-store README, and AGENTS.md.
- **Why:** Both platforms back app data up to the vendor's cloud by default, which would take 30 days of location history off the phone. The usual way this regresses is a dependency's manifest merging the default back in, which is why there are layers and why a failing policy test means a rule was broken rather than a fixture to refresh.
- **Alternatives:** Relying on encryption alone (the key is device-bound, so a backup would be unreadable elsewhere, but the promise made is that history stays on the device). `allowBackup="false"` only, which does not stop device-to-device transfer on Android 12 and later. `Library/Caches` on iOS, which the system may empty.

### 23. "Delete all my data" drops the file and rotates the key

- **Decision:** Deleting closes both connections, removes the file with its `-wal` and `-shm`, deletes the key (and on Android the Keystore key that wrapped it), reopens, then checks that the key changed and the new file started empty.
- **Status:** Documented (README): "Delete all my data" in the encrypted-store README.
- **Why:** A per-table delete leaves ciphertext pages in the file and misses any table added later. Verifying the result means a Settings screen cannot report a delete that did not happen.
- **Alternatives:** `DELETE` from each table followed by `VACUUM`. Deleting the key only (crypto-shredding).

### 24. One SQLCipher in the Android process

- **Decision:** On Android the Kotlin writer should use the SQLCipher inside op-sqlite's library through a small JNI shim, instead of a second copy from Zetetic's library.
- **Status:** Chosen and implemented in open PR #31; not merged at the commit this file describes. On `main` two copies still coexist, the problem is described under "Open decision" in the encrypted-store README, and the weekly `VACUUM` is switched off on Android because of it (`ANDROID_VACUUM_ENABLED`).
- **Why:** SQLite's file locks belong to the process, so two library copies in one process do not see each other's locks and can both believe they hold the write lock. One copy removes the problem and makes Android match iOS.
- **Alternatives:** Both considered in that README: run capture in its own process (`android:process`), where file locks work but the module's link to JavaScript changes; or a lock that both sides take, with TypeScript opening the store per unit of work.

### 25. Retention is one stateless purge that runs in three places

- **Decision:** History older than 30 days is deleted by `purgeExpired`, which computes its cutoff from the time it is given on every run and remembers nothing. It runs in the app (start, foreground, each stored sample) and natively in both capture modules on a wake with no JavaScript, using the same statements. A weekly `VACUUM` runs only when the phone is charging and idle.
- **Status:** Documented (README): "Retention" in [packages/shared/README.md](../packages/shared/README.md), and AGENTS.md. Built in PRs #23 and #25.
- **Why:** A purge that depends on its own last-run state can be skipped by a clock change or a long gap; a stateless one cannot. A phone on which the app is never opened only ever runs the capture module, so the purge has to exist there too. `VACUUM` rewrites the whole file, so it waits for a moment when that is cheap.
- **Alternatives:** A scheduled OS job for the purge (noted as still missing for the case where nothing wakes). Purging in TypeScript only. Per-row expiry timestamps.

## Matching

### 26. Matching happens on the device, against stays first

- **Decision:** `matchReport` is a pure function over a device's own stays and samples. Evidence is a stay that overlaps, or a sample inside, the report's window widened by 30 minutes, within the report's radius plus 150 m. Stays are derived in TypeScript from stored fixes (150 m, 15 minutes); on iOS, `CLVisit` rows cover their interval.
- **Status:** Documented (README): "Matching" and "Stay derivation" in the shared package README. The constants are marked DECIDED in `packages/shared/src/constants.ts`.
- **Why:** The product's privacy claim is that location history never leaves the phone, so the comparison has to run there. Dwell-based matching fits what background capture reliably delivers (on Android's default mode, a fix about every 15 minutes): the harness finds 96 to 97 percent of people who were stopped near the missing person and far fewer of those moving past.
- **Alternatives:** Server-side matching on uploaded history. Private set intersection or similar cryptographic matching. Sample-only matching with no stay derivation. Bluetooth proximity, as exposure-notification systems used.

### 27. Match criteria are read on a 150 m and 30 minute grid

- **Decision:** Before the rule is applied, the radius is rounded up to a multiple of 150 m and both ends of the window are rounded outward to 30-minute marks. Rows are selected with `matchBounds`, never with the criteria as written.
- **Status:** Documented (README and source): the shared package README, the header of `packages/shared/src/match/matchReport.ts`, AGENTS.md. Built in PR #27.
- **Why:** It is a security property. The plan relies on a reporter gaining nothing from precision finer than the two constants, and the rule as first written did not give that: a 5 m and a 140 m radius reach different people. On the grid they are the same report, so two reports that agree on the grid return identical results on any history. Rounding is outward only, so nothing the written rule finds is lost.
- **Alternatives:** The rule as written, with no rounding. Rounding at intake on the server instead (noted in the README as something that would also close a small gap in the widen-only rule, and not done). Adding random noise. The measured cost of the grid is 25 to 29 percent more notifications (`server/README.md`).

### 28. Edits to a report may only widen it

- **Decision:** A `PATCH` is accepted only if the new window contains the old one, the radius is not smaller, and the new search disc covers the old one (`distance + old radius <= new radius + 1 m`). The server, the reporter's app and the device all call the same function.
- **Status:** Documented (source): the header of `packages/shared/src/payload/widening.ts`.
- **Why:** A reporter who could narrow a report and watch whether tips keep arriving could binary-search for where a specific person was. The centre rule is a coverage test rather than "may move up to N metres" because a per-edit allowance can be spent again on every edit, walking the centre across a city.
- **Alternatives:** A per-edit distance allowance: considered and rejected for the reason above. No edits at all. Free edits with a re-review.

### 29. The match parameters are measured, offline, on synthetic populations

- **Decision:** `server/src/harness/` runs the unchanged `matchReport` over simulated populations and reports recall, false-positive rate and notifications per report. A smaller run is part of the unit tests and holds its figures within a band.
- **Status:** Documented (README): [server/README.md](../server/README.md). Built in PR #27.
- **Why:** There are no real users to measure against, and the constants trade recall against how many people are notified. The harness makes that trade visible and guards it against accidental change.
- **Alternatives:** Tuning on field data only. No measurement.

## Distribution of reports

### 30. Reports reach phones as signed static files, sharded by H3 cell

- **Decision:** Released reports are compiled into signed bundles, one per H3 shard at res 5 and again at res 3 (the coarser level a device falls back to when it has been in too many res-5 cells), plus a signed index. Devices fetch them from a CDN. A bundle path never changes its bytes: a change is a new generation at a new path, and the generation table is never reset. Matching pre-filters on res-7 cells; a shard is the parent of a res-7 cell.
- **Status:** Documented (README and source): `server/README.md`, the header of `server/src/shards/compiler.ts`, AGENTS.md. Built in PR #22.
- **Why:** The server must not learn which device is interested in which report, so reports are pushed out to everyone in a region rather than queried. Static, cacheable files are also what lets a small project serve a large population cheaply; the plan cites exposure-notification export files as the precedent. Immutable paths make caching safe and make a half-finished publish repeatable.
- **Alternatives:** A query API ("reports near me"), which tells the server where each device is. Push delivery of full report content. Geohash or S2 cells instead of H3. One global file.

### 31. The cover of a search area is computed one way, on both sides

- **Decision:** The compiler files a report under every shard its search disc touches using `searchAreaCells` and `shardKeysForCells` from the shared package, not h3's `polygonToCells` with `compactCells`.
- **Status:** Documented (README): "Open points for review" in `server/README.md`, and the compiler header.
- **Why:** `polygonToCells` keeps only cells whose centre is inside the shape, so it can leave out a cell the disc touches, and devices derive their shards as parents of res-7 cells. Using the shared helpers gives one definition both sides agree on.
- **Alternatives:** The plan's `polygonToCells` plus `compactCells`.

### 32. Everything a match screen needs is inside the broadcast payload

- **Decision:** The photo thumbnail (at most 256 px, inline base64) and the reporter's phone number are part of the signed query. Nothing is fetched lazily.
- **Status:** Documented (source): the header of `packages/shared/src/payload/query.ts`, citing plan section 6.2.
- **Why:** A fetch made only by devices that matched would tell the server who matched.
- **Alternatives:** A photo URL, which is smaller but leaks the match. The cost is recorded in `server/README.md`: the photo is nearly all of a bundle's size, and a device re-downloads a whole bundle when any report in its shard changes.

### 33. Ed25519 signatures over canonical JSON, with keys pinned in the app

- **Decision:** Queries, bundles and the index are each signed over `findmyperson.<kind>.v1` plus canonical JSON. Readers verify on the raw value before applying a schema. Devices trust the public keys built into the binary. Several keys can be valid at once, each with `sign_from` and `verify_until`, so rotation has an overlap. The curve arithmetic is passed in by each runtime.
- **Status:** Documented (source): the headers of `packages/shared/src/payload/signing.ts` and `server/src/shards/keys.ts`.
- **Why:** The files are served by a third-party CDN, so the device must be able to tell a genuine bundle from a tampered one without trusting the CDN or TLS alone. The domain separator stops a signature over one kind of document verifying as another. Injecting the primitive keeps the shared package free of runtime APIs, since Node and Hermes share no crypto API.
- **Alternatives:** TLS and certificate pinning only. JWS or another signed-envelope format. A key fetched from the server, which defeats pinning. A single key with no rotation.

### 34. Ed25519 verification on the phone is plain JavaScript (tweetnacl)

- **Decision:** The app verifies signatures with `tweetnacl` 1.0.3 behind the shared `Ed25519Verify` type (`app/src/fetch/ed25519.ts`), with one added rule: a signature whose S is not below the group order is refused.
- **Status:** Documented (source and PR #30): the header of `ed25519.ts`.
- **Why:** Hermes has no WebCrypto and no Node crypto, so the primitive is either native code or plain JavaScript. tweetnacl needs nothing from the engine (no BigInt, no polyfill), so the same code runs on the phone and under Node in the tests. The extra rule makes the phone and the server's signer agree on every signature.
- **Alternatives:** All considered in that header. `@noble/curves`, which needs BigInt and a second package for SHA-512. A native binding (CryptoKit on iOS; Android has Ed25519 in the platform only from API 33), which would need a second library on Android, a bridge method carrying every document, and could not be tested without a phone.

### 35. The fetcher's two addresses of trust are constants in the binary

- **Decision:** The CDN origin and the trusted public keys are constants in `app/src/fetch/reportCdn.ts`, not settings and not values a server supplies. Both are unset today, and with either unset the app fetches nothing.
- **Status:** Documented (source): the header of `reportCdn.ts`, and AGENTS.md.
- **Why:** That is what pinning means: a build trusts the keys it was built with and nothing a server says later. Stopping with nothing on the network when unconfigured is the fail-closed choice.
- **Alternatives:** Remote configuration. A build-time environment variable. Trust on first use.

### 36. Unknown versions are skipped and unknown fields are ignored

- **Decision:** `parseBroadcastQuery` checks `v` first and never parses a version it does not know. Each query in a bundle is verified and parsed on its own, so one newer entry does not discard the rest. API error `code` is validated as a string so an old app can read a new code.
- **Status:** Documented (README and source): "Choices worth knowing" in the shared package README.
- **Why:** Old app versions stay in the field for a long time and must not guess at formats they predate.
- **Alternatives:** Strict schemas that reject unknown fields. Best-effort parsing of newer versions.

### 37. The fetcher pads its traffic: a constant request count and cover shards

- **Decision:** Every fetch cycle that reads an index makes exactly `FETCH_SHARD_REQUESTS_PER_CYCLE` (8) shard requests, whatever changed. The device also follows `FETCH_COVER_SHARDS` (8) shards it has no use for, chosen by a secret in the store, and treats them exactly like real ones. Nothing unverified is stored, and a cycle writes in one transaction.
- **Status:** Documented (source and README): the header of `packages/shared/src/fetch/cycle.ts`, "Bundle fetcher" in the shared package README, AGENTS.md. Built in PR #26.
- **Why:** The CDN operator sees IP, path and time for every request, and the shards a device asks for are where it has been in 30 days. Cover shards hide which of the followed shards are real; a constant count hides how many changed. The stated limit is that this hides which shards, not the rough region, and not that the device fetched at all. A consequence: `report_cache` holds reports from places the device has not been and must never be presented as "near you".
- **Alternatives:** Fetch exactly what is needed (cheapest, and leaks the most). Download everything (no leak, does not scale). Private information retrieval or an anonymising proxy. All five `FETCH_*` constants are marked provisional.

### 38. Bundles and cache purge on Cloudflare R2

- **Decision:** The compiler's `ObjectStore` and `CdnInvalidator` interfaces are implemented for Cloudflare R2 (through its S3 API) and Cloudflare's zone cache purge. A directory store remains for a single box. The adapter is hand-written SigV4 over `fetch` with no SDK.
- **Status:** Documented (PR #29) for what was built and for "no new dependency". The reason for choosing R2 over other providers is not written down: inferred. No bucket is provisioned and the adapter has never run against a live one. The device side still treats the provider as undecided: the header of `app/src/fetch/reportCdn.ts` says its two constants wait for the storage and CDN decision.
- **Why:** Inferred: the workload is almost entirely downloads of static files, so a store with no egress charge suits a non-commercial project; R2 speaks the S3 API, so the adapter is not tied to it; and the bucket's custom domain sits on a Cloudflare zone, so storage and cache purge are one vendor and one set of tokens. Skipping the SDK keeps the server at two runtime dependencies and lets tests swap `fetch` for a fake.
- **Alternatives:** Amazon S3 with CloudFront. Google Cloud Storage or Backblaze B2 behind a CDN. A static host or the server's own disk behind any CDN (the directory store already supports this). The AWS SDK instead of hand-written signing.

## Backend

### 39. TypeScript on Node with Fastify

- **Decision:** The backend is a Fastify 5 app in TypeScript, importing its schemas and endpoint table from the shared package.
- **Status:** Documented (plan), which recommended it; `server/README.md` for what was built. Introduced in PR #12.
- **Why:** The plan's reasoning is that the broadcast payload should have exactly one definition, used by the compiler, the device parser and the matching harness, and one language gives that for free. It concedes that Go's single static binary would be nicer to self-host.
- **Alternatives:** Go: considered in the plan. Any other Node framework. Serverless functions, which fit the API but not the compiler's "one at a time" rule.

### 40. The server database is Node's built-in SQLite

- **Decision:** `server/src/db.ts` uses `node:sqlite` with WAL. The schema and every query are in that one file.
- **Status:** Inferred from code, with the stated reasoning in the header of `db.ts`. It differs from the plan, which named Postgres.
- **Why:** The header says the same code then runs in tests (`:memory:`) and on a single box, that reports are rare so there is no write-volume concern, and that moving to Postgres later means replacing that file only. Inferred beyond that: no database service to provision for a project with no deployment yet, and no extra dependency.
- **Alternatives:** Postgres, as the plan had it. `better-sqlite3`. A hosted database.

### 41. Endpoints, errors and idempotency are defined once, as data

- **Decision:** `API_ENDPOINTS` in the shared package lists method, path, schemas, success status and idempotency rule; the server registers routes from it and the app builds requests from it. Every failure has one shape and each error code one HTTP status. Writes that are not naturally idempotent carry a client-minted `Idempotency-Key` scoped to the device.
- **Status:** Documented (source): `packages/shared/src/api/endpoints.ts`, `errors.ts`, `idempotency.ts`.
- **Why:** A phone sends from a durable queue and may retry a request it cannot know succeeded, so every create must be safe to send twice. One table for both sides removes the chance of the app and server disagreeing about a path or a status.
- **Alternatives:** OpenAPI with generated clients. tRPC or GraphQL. Deduplication by content instead of by key.

### 42. Submits are queued durably on the phone before any network call

- **Decision:** "Broadcast report" writes an `own_report` row first, then a queue runner posts it with backoff. `app/src/report/` is the only submit path.
- **Status:** Documented (README): `app/src/navigation/README.md` and AGENTS.md. Built in PR #28.
- **Why:** A confirmed report must survive no signal and a killed app. It pairs with decision 41: the queue row holds the idempotency key that makes the retry safe.
- **Alternatives:** Post directly and show an error on failure. A generic background-upload library.

### 43. Every report is held for manual review before it is broadcast

- **Decision:** A report is born `pending`. Only an operator's explicit release makes it `released`; `rejected` is final. Nothing automatic changes the state, and `ServerDb.listBroadcastable` is the only read the compiler uses. App copy must say "under review", never "live".
- **Status:** Documented (plan): addendum of 2026-10-03. Documented (README and source): "The manual-review gate" in `server/README.md`, `server/src/lifecycle.ts`, AGENTS.md.
- **Why:** A broadcast notifies strangers and shows them a phone number. A person phoning the reporter before release confirms the report is real and that the number reaches the reporter. It is also what makes the light device identity (decision 44) acceptable.
- **Alternatives:** Broadcast on submit. Automated checks only. Review after broadcast. Known gaps: a widening edit on a released report is not re-reviewed, and the operator routes are guarded only by a device-id allow-list on a forgeable header until real operator authentication is built.

### 44. Device identity is a client-generated id with no verification

- **Decision:** A device is a random UUID v4 generated on first use, kept in the encrypted store and sent as `Authorization: FMP-Device <uuid>`. The server believes the header. No attestation, no phone verification, no accounts. The scheme sits behind two interfaces (`DeviceIdentity`, `DeviceAuthenticator`) so it can be replaced without touching callers.
- **Status:** Documented (plan): addendum of 2026-10-03, which is outside the repository. In the repository: "Decisions built as decided" in `server/README.md`, and comments in `server/src/app.ts`, `app/src/report/identity.ts` and `packages/shared/src/identity/deviceIdentity.ts`.
- **Why:** The app has no accounts and should not get any. The plan recommended verifying the reporter's phone number, because an unverified number shown to strangers lets someone attach a third party's number to a report. The addendum chose the plain id alone, on the reasoning that the manual phone call before release (decision 43) already confirms the number, with the explicit caveat that this must be revisited if the manual step is removed or stops scaling.
- **Alternatives:** All considered in the plan. Platform attestation (Play Integrity, App Attest), which breaks on de-Googled and F-Droid builds. SMS-verified reporter number, which costs per message and adds friction. IP limits with proof of work, which punish shared carrier addresses and burn battery. The plan's own recommendation was a mix of the first three.

### 45. One tip per device per report, and nothing else limits tips

- **Decision:** `responses` is `UNIQUE (query_id, device_id)`. There is no daily or monthly cap across reports.
- **Status:** Documented (plan): addendum of 2026-10-03. Documented (README): `server/README.md` and the header of `server/src/db.ts`.
- **Why:** The structural limit is the product rule (one message per match, no chat), so it costs nothing. The broader caps were declined.
- **Alternatives:** Considered in the plan: a global cap of 5 per day and 20 per 30 days with over-limit tips queued for review (the plan's recommendation); a token bucket scaled to local report volume; no limit.

### 46. Tips are plaintext to the server, filtered for links and payment requests

- **Decision:** A tip is sent to the server in the clear over TLS. `moderateResponse` holds any text containing a link or a payment identifier and delivers everything else at once, to be reviewed afterwards. It is a regex heuristic that prefers over-holding.
- **Status:** Documented (plan): the relay choice and the addendum of 2026-10-03. Documented (source): the header of `server/src/moderation.ts`.
- **Why:** The relay was made readable specifically so that moderation is possible: the people receiving tips are families of missing people, a known target for extortion. The narrow filter covers that shape without needing a person to approve every tip.
- **Alternatives:** End-to-end encrypted tips, which rule out moderation. Considered in the plan: human review of every tip before delivery; a broader classifier for threats and abuse; no moderation.

### 47. The server is bundled with esbuild before it runs

- **Decision:** `server/build.mjs` bundles the three entries into `dist/` as plain ESM; `fastify` and `zod` stay external. A test builds and runs the entries under plain `node`.
- **Status:** Documented (PR #24) and Documented (README): "Running it" in `server/README.md`, and the comment in `build.mjs`.
- **Why:** The sources import each other and the shared package without file extensions, and the shared package ships as TypeScript. Node's own type stripping cannot resolve those imports, so the documented run command did not work. Bundling fixes that without changing the import style everywhere or adding a publish step for the shared package.
- **Alternatives:** Add `.ts` extensions to every import and use Node's type stripping. Run through `tsx` or `ts-node`. Compile with `tsc` and build the shared package to JavaScript first.

## Cross-cutting

### 48. One package holds every contract, in pure TypeScript with injected services

- **Decision:** `packages/shared` is the only definition of the payload, signing, geometry, the store schema, API shapes, stay derivation, matching, retention and the fetcher. It has no I/O, no clock and no randomness of its own: the SQLite driver, the Ed25519 primitive, the transport and random bytes are arguments. A test forbids Node APIs outside `src/testing/`.
- **Status:** Documented (README): the shared package README and AGENTS.md. Introduced in PR #11.
- **Why:** The same code has to run on the server (Node) and in the app (Hermes) and be testable without either. Passing services in is also what makes the matching rule, the purge and the fetcher runnable from a cold background wake with no UI.
- **Alternatives:** Per-runtime copies kept in step by tests. A shared package that imports platform libraries directly. Code generation from a neutral schema language.

### 49. zod as the schema library

- **Decision:** Every wire and API shape is a zod 4 schema. No schema transforms its input.
- **Status:** Documented (README): "Choices worth knowing" in the shared package README.
- **Why:** One definition gives both the TypeScript type and the runtime check, and zod 4 emits JSON Schema, which is how the files for Kotlin, Swift and third parties are produced. Transforms are banned because a signed document must be canonicalised from the bytes as received.
- **Alternatives:** JSON Schema as the source with generated types. io-ts, Valibot or TypeBox. Hand-written validators.

### 50. Cross-language agreement is held by generated files and golden vectors

- **Decision:** Kotlin and Swift do not restate constants or SQL. They read generated files (`StoreContract.kt`, `StoreContract.swift`, the codegen output) and test against golden vectors under `packages/shared/contracts/` (canonical JSON, signing, geometry, stays, matching, widening). Tests fail when a committed copy differs from what the generator produces.
- **Status:** Documented (README): `packages/shared/contracts/README.md` and AGENTS.md.
- **Why:** Three languages implement the same rules and cannot share code (decision 13). Vectors turn "the platforms agree" into something a pull request can fail on.
- **Alternatives:** A shared native core. Review by hand.

### 51. Tunable numbers live in one file, each labelled decided or provisional

- **Decision:** `packages/shared/src/constants.ts` holds every number the contracts depend on (150 m, 30 minutes, 30 days, H3 resolutions, size caps, fetch constants), each marked as a product decision, a plan choice or a provisional bound.
- **Status:** Documented (source): the header of `constants.ts`.
- **Why:** Nobody writes 150 or 1800 at a call site, and a reader can tell which numbers are safe to tune from which are promises.
- **Alternatives:** Per-module constants. Remote configuration, which would let a server change matching behaviour and is at odds with pinning.
