# Architecture

A map of the whole of findmyperson for someone joining the project: what it is built from, where each part lives, how the parts talk to each other, and what is not built yet.

It describes `main` at commit `0a1bbb4` (2026-10-04, pull request #30). One pull request was open at that point and is called out where it changes the picture: #31 (one SQLCipher on Android). This file links to the README that owns each topic instead of repeating it; when the two disagree, the README and the code win.

The idea in one paragraph: each phone keeps 30 days of its own location history in an encrypted file that never leaves it. A missing-person report is reviewed by a person, then published as signed static files on a CDN. Every phone downloads the reports for the regions it has been in and checks them against its own history, on the phone. Only a phone that matches shows anything, and only if its owner chooses to send a tip does the server hear from it. The server never learns who matched.

Contents:

1. [Tech stack and major libraries](#1-tech-stack-and-major-libraries)
2. [Folder structure](#2-folder-structure)
3. [Navigation and screen map](#3-navigation-and-screen-map)
4. [State management](#4-state-management)
5. [Data models](#5-data-models)
6. [Backend, API and auth](#6-backend-api-and-auth)
7. [Third-party services](#7-third-party-services)
8. [Stubs and unfinished](#8-stubs-and-unfinished)

Related: [DECISIONS.md](DECISIONS.md) lists why things are the way they are. [WORKSPACE.md](../WORKSPACE.md) covers the workspace and everyday commands, [BUILDING.md](BUILDING.md) covers installable builds, and [AGENTS.md](../AGENTS.md) holds the rules that are easy to break.

## 1. Tech stack and major libraries

Versions are the ones pinned in the manifests and resolved in `pnpm-lock.yaml`. "Declared" is the range in `package.json`; "Resolved" is what the lockfile installs.

### Runtime and tooling

| Piece             | Declared              | Resolved | Where it is set                               |
| ----------------- | --------------------- | -------- | --------------------------------------------- |
| Node              | `>=24`                | 24 in CI | `engines` in `package.json`, `ci.yml`         |
| pnpm              | `12.8.1`              | 12.8.1   | `packageManager` in `package.json`            |
| Linker            | `node-linker=hoisted` | -        | `.npmrc`                                      |
| TypeScript        | `^5.9.0`              | 5.9.3    | root; strict settings in `tsconfig.base.json` |
| Vitest            | `^4.0.0`              | 4.1.11   | root; `vitest.config.ts` runs every member    |
| ESLint            | `^10.11.0`            | 10.11.0  | root, flat config in `eslint.config.js`       |
| typescript-eslint | `^8.71.0`             | 8.71.0   | root                                          |
| Prettier          | `^3.9.9`              | 3.9.9    | root, `.prettierrc.json`                      |
| esbuild           | `^0.28.2`             | 0.28.2   | `server` only, used by `server/build.mjs`     |

### App (`app/`)

| Library                          | Declared   | Resolved | Used for                                                 |
| -------------------------------- | ---------- | -------- | -------------------------------------------------------- |
| `react-native`                   | `0.87.1`   | 0.87.1   | The app. New Architecture (Turbo Native Modules, Fabric) |
| `react`                          | `19.2.3`   | 19.2.3   |                                                          |
| `@react-navigation/native`       | `^7.5.0`   | 7.5.0    | Navigation container and deep links                      |
| `@react-navigation/native-stack` | `^7.20.0`  | 7.20.0   | Root stack                                               |
| `@react-navigation/bottom-tabs`  | `^7.20.0`  | 7.20.0   | Home, History, Settings tabs                             |
| `react-native-screens`           | `^4.28.0`  | 4.28.0   | Native screen containers for the stack                   |
| `react-native-safe-area-context` | `^5.10.1`  | 5.10.1   | Insets                                                   |
| `react-native-svg`               | `^15.15.5` | 15.15.5  | Icons in the design system                               |
| `@op-engineering/op-sqlite`      | `18.2.5`   | 18.2.5   | SQLite with SQLCipher, enabled by the `op-sqlite` flag   |
| `tweetnacl`                      | `1.0.3`    | 1.0.3    | Ed25519 verification on Hermes, which has no WebCrypto   |
| `react-test-renderer` (dev)      | `19.2.3`   | 19.2.3   | Component tests, against stubs of react-native           |

The `"op-sqlite": { "sqlcipher": true }` flag is set in both `app/package.json` and the root `package.json`, because op-sqlite's Android and iOS builds look in different places.

### Shared, store and capture packages

| Library                  | Declared | Resolved | Used for                                                                      |
| ------------------------ | -------- | -------- | ----------------------------------------------------------------------------- |
| `zod`                    | `^4.0.0` | 4.6.5    | Every wire and API schema in `packages/shared`; also emits the JSON Schemas   |
| `h3-js`                  | `^4.5.0` | 4.5.0    | H3 cells for matching pre-filter and shards                                   |
| `@react-native/codegen`  | `0.87.1` | 0.87.1   | Generates the native interfaces of both Turbo Native Modules, pinned by tests |
| `@journeyapps/sqlcipher` | `^6.0.0` | 6.0.0    | Dev only: a real SQLCipher under Node, because op-sqlite has none there       |

### Server (`server/`)

| Library       | Declared  | Resolved | Used for                                       |
| ------------- | --------- | -------- | ---------------------------------------------- |
| `fastify`     | `^5.12.5` | 5.12.5   | HTTP API                                       |
| `zod`         | `^4.6.5`  | 4.6.5    | Request validation, through the shared schemas |
| `node:sqlite` | built in  | Node 24  | The server database (`DatabaseSync`)           |
| `node:crypto` | built in  | Node 24  | Ed25519 signing, SigV4 for R2, hashing         |

There is no ORM, no cloud SDK and no HTTP client library on the server: R2 is reached with `fetch` and hand-written SigV4.

### Native code

| Piece                                   | Version                                         | Where                                                 |
| --------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Kotlin                                  | 2.2.0, JVM target 17                            | both `android/build.gradle` files                     |
| Android Gradle Plugin (capture module)  | 8.7.3, Gradle wrapper 8.9                       | `packages/native-location-capture/android`            |
| Android Gradle Plugin (encrypted store) | 9.2.1 standalone                                | `packages/encrypted-store/android/build.gradle`       |
| Android SDK levels                      | `compileSdk` 35, `minSdk` 24 when standalone    | both modules; the app supplies its own once it exists |
| `androidx.work:work-runtime`            | 2.10.0                                          | capture module (WorkManager mode)                     |
| `play-services-location`                | 21.3.0                                          | capture module (fused location provider)              |
| `net.zetetic:sqlcipher-android`         | 4.19.0                                          | both Android modules; removed by open PR #31          |
| Swift                                   | tools 5.9 (capture), 5.0 (store podspec)        | `Package.swift`, the two podspecs                     |
| iOS deployment target                   | React Native's minimum; iOS 15 for `swift test` | podspecs use `min_ios_version_supported`              |
| H3 C library                            | 4.5.0, vendored unmodified                      | `packages/native-location-capture/ios/Sources/CH3`    |
| SQLCipher on iOS                        | op-sqlite's copy (4.19.0 in the host check)     | both podspecs depend on `op-sqlite`                   |

### CI

`ci.yml` runs typecheck, lint, format check and unit tests in one Linux job on every pull request, plus the Kotlin capture module as its own Gradle job. `build.yml` builds Android on every pull request and iOS only on `main` and tags, on `macos-15`. See [BUILDING.md](BUILDING.md).

## 2. Folder structure

```
app/                              React Native app (TypeScript only; no android/ or ios/ yet)
packages/shared/                  Contracts and pure logic, used by app and server
packages/encrypted-store/         The on-device encrypted file: TypeScript, Kotlin, Swift
packages/native-location-capture/ The capture Turbo Native Module: spec, fake, Kotlin, Swift
server/                           Fastify API, shard compiler, matching harness
build/                            Build scripts shared by local builds and CI
docs/                             This folder
m0/                               Finished research trial apps; not part of the workspace
.github/workflows/                ci.yml and build.yml
```

### `app/src/`

| Folder            | What lives there                                                                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigation/`     | `routes.ts` (the only definition of routes, params and deep links), `AppNavigator.tsx`, `screens.tsx`, its own README                                                                         |
| `design-system/`  | `theme.ts` tokens, primitives (`Button`, `Card`, `Field`, `Text`, `BottomSheet`, ...), motion, a `Catalogue`                                                                                  |
| `onboarding/`     | The onboarding screen                                                                                                                                                                         |
| `permissions/`    | The staged permission flow, `CaptureContext` (the capture module provider), `stages.ts`                                                                                                       |
| `capture-health/` | Home status row and the diagnostics screen, built on `getStatus` and `getDiagnostics`                                                                                                         |
| `settings/`       | Settings screen (pause and resume, retention explainer, delete all data), `links.ts`                                                                                                          |
| `store/`          | `createDataStore` and its provider, `StoreMaintenance`, `useAppWake.ts` (the moments background work runs), `retention.ts`                                                                    |
| `report/`         | The only report submit path: `form.ts`, `queue.ts`, `api.ts`, `identity.ts`, `image.ts`, `services.tsx`, the screen                                                                           |
| `fetch/`          | The report fetch: `trigger.ts` (when to run a cycle), `reportCdn.ts` (CDN origin and pinned keys, both unset), `ed25519.ts`, `httpTransport.ts`, `random.ts`, and the `ReportFetch` component |
| `index.ts`        | A placeholder export. There is no `AppRegistry` entry point yet                                                                                                                               |

`app/assets/fonts/` holds the three bundled font files and their README.

### `packages/shared/src/`

The map is in [packages/shared/README.md](../packages/shared/README.md). In short: `constants.ts` (every tunable number, each marked decided or provisional), `geo/`, `payload/` (canonical JSON, signing, the broadcast query, bundles, the widen-only rule), `api/` (endpoints and error shape), `identity/`, `store/` (cipher parameters, migrations, one module per table, table ownership), `stay/`, `match/`, `retention/`, `fetch/`. `contracts/` holds golden vectors and generated files that Kotlin and Swift must match. The package has no I/O of its own and no Node API outside `src/testing/`.

### `packages/encrypted-store/`

`src/` (TypeScript: `openStore`, `deleteAllData`, the backup policy and its tests), `android/` (Kotlin: Keystore-wrapped key, no-backup directory, the writer), `ios/` (Swift: Keychain key, backup-excluded directory, the writer, a host check that runs on a Mac), `contracts/` (generated). See [its README](../packages/encrypted-store/README.md).

### `packages/native-location-capture/`

`src/specs/NativeLocationCapture.ts` is the interface and its contract. `src/fake.ts` is the in-memory implementation tests use. `android/` and `ios/` are the two real implementations, each split into a platform-free core that is unit-tested and thin platform adapters. `contracts/` is committed codegen output. See [its README](../packages/native-location-capture/README.md), [android/README.md](../packages/native-location-capture/android/README.md) and [ios/README.md](../packages/native-location-capture/ios/README.md).

### `server/src/`

| File or folder  | What it is                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------ |
| `app.ts`        | Every route, the auth wrapper, the idempotency wrapper                                     |
| `db.ts`         | The schema and every query (`ServerDb`)                                                    |
| `lifecycle.ts`  | The review gate: `pending -> released` or `rejected`                                       |
| `moderation.ts` | The link and payment filter on tips                                                        |
| `operator.ts`   | Who may release or reject                                                                  |
| `alerts.ts`     | The alert raised when a report arrives                                                     |
| `shards/`       | The compiler, signing keys, storage interfaces, the R2 adapter, the worker and the CLI     |
| `harness/`      | Offline recall and false-positive measurement of `matchReport`; not imported by the server |
| `main.ts`       | Process entry; `build.mjs` bundles it, the shard CLI and the harness CLI into `dist/`      |

See [server/README.md](../server/README.md).

### `m0/`

The research milestone: native trial apps that measured background capture on real phones, a log analyser, and `store-proof`, which proved that Kotlin, Swift and op-sqlite can open one SQLCipher file. It is not a workspace member and tooling ignores it. One live link remains: `m0/store-proof/shared/cipher-params.json` is pinned by a test to `packages/shared/contracts/cipher-params.json`.

## 3. Navigation and screen map

React Navigation 7: a native stack at the root with bottom tabs under `Main`. Route names, params and deep links are defined only in [`app/src/navigation/routes.ts`](../app/src/navigation/routes.ts); `screens.tsx` binds each route to a screen.

```
Root stack (initial route: Onboarding)
|- Onboarding
|- Main (bottom tabs)
|   |- Home
|   |- History
|   `- Settings
|- CaptureHealth
|- PermissionFlow
|- ReportForm
|- LiveReport   { reportId }
`- Bystander    { matchId }   presented as a modal
```

| Route            | Params                 | Deep link                          | Screen                                      | State                                                                                                |
| ---------------- | ---------------------- | ---------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Onboarding`     | none                   | `findmyperson://welcome`           | `OnboardingScreen`                          | Real                                                                                                 |
| `Main`           | nested tab, optional   | -                                  | tab navigator                               | Real                                                                                                 |
| `Home`           | none                   | `findmyperson://home`              | `PlaceholderScreen` + `CaptureHealthStatus` | Placeholder shell. The capture-health row is real; the rest is temporary buttons to the other routes |
| `History`        | none                   | `findmyperson://history`           | `PlaceholderScreen`                         | Placeholder. Not in the v2 mockups                                                                   |
| `Settings`       | none                   | `findmyperson://settings`          | `SettingsScreen`                            | Real                                                                                                 |
| `CaptureHealth`  | none                   | `findmyperson://capture-health`    | `CaptureHealthDiagnostics`                  | Real                                                                                                 |
| `PermissionFlow` | none                   | `findmyperson://permissions`       | `PermissionFlowScreen`                      | Real                                                                                                 |
| `ReportForm`     | none                   | `findmyperson://new-report`        | `ReportSubmitScreen`                        | Real, with two seams unfilled (photo, map); see section 8                                            |
| `LiveReport`     | `{ reportId: string }` | `findmyperson://report/<reportId>` | `PlaceholderScreen`                         | Placeholder: a fixed "Submitted, under review" text                                                  |
| `Bystander`      | `{ matchId: string }`  | `findmyperson://match/<matchId>`   | `PlaceholderScreen`                         | Placeholder: the match notice and the share-or-stay-anonymous choice are not built                   |

How screens reach each other: `Onboarding` opens `PermissionFlow` and then replaces itself with `Main`. `Home` pushes `ReportForm`, `CaptureHealth`, and (through temporary preview buttons) `LiveReport` and `Bystander`. `Settings` and `CaptureHealth` open `PermissionFlow`. A successful submit replaces `ReportForm` with `LiveReport`, so Back cannot return to a form that was already sent. `matchNotificationUrl(id)` and `reportNotificationUrl(id)` in `routes.ts` build the links a notification should carry.

"Real" means the screen is implemented and tested in TypeScript against the in-repo fake of the capture module and a real SQLCipher file under Node. Nothing has run on a phone, because no native project exists yet.

Details per flow are in [app/src/navigation/README.md](../app/src/navigation/README.md).

## 4. State management

There is no state library: no Redux, Zustand, MobX or query cache, and no AsyncStorage. State lives in three places.

**The encrypted store is the durable state.** Location history, cached reports, matches, queued submits and the device id are rows in one SQLCipher file. Screens do not hold a database handle; they get a `DataStore` (`app/src/store/DataStoreContext.tsx`) with a small set of operations: `runMaintenance`, `runFetchCycle`, `enqueueReport`, `runReportQueue`, `deleteAll`, `deviceIdentity`. `createDataStore` opens the store on first use, keeps the handle, and runs every piece of work through one serial queue so a delete cannot close the connection under a purge.

**The native capture module owns capture state.** Whether capture is running, in which mode, with which permission and which health flags is held natively and persisted natively, because the OS relaunches the app in the background with no JavaScript. The app reads it with `getStatus()` and follows it with the `onStatusChanged` and `onSampleWritten` events (`app/src/capture-health/useCaptureHealth.ts`, `app/src/permissions/usePermissionFlow.ts`). The permission flow has no state of its own beyond this: its stage is derived from `getStatus().permission`.

**React holds only what is on screen.** Form fields, busy flags and error text are `useState` in the screen that shows them.

Dependencies reach screens through three React contexts, all provided by `AppNavigator`, and each replaceable in tests:

| Context                 | File                                     | Provides                                                | Test double                                     |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| `CaptureContext`        | `app/src/permissions/CaptureContext.tsx` | the `LocationCapture` module                            | `createFakeLocationCapture`                     |
| `DataStoreContext`      | `app/src/store/DataStoreContext.tsx`     | the `DataStore`                                         | a recording store, or real SQLCipher under Node |
| `ReportServicesContext` | `app/src/report/services.tsx`            | photo port, location port, optional API client override | plain objects                                   |

Background work is driven by two components that render nothing, not by screens. Both use `useAppWake` (`app/src/store/useAppWake.ts`), which names the three moments the app does background work: at start, on every return to the foreground, and on every stored sample the capture module reports. `StoreMaintenance` calls `DataStore.runMaintenance()` at each of them: one run derives stays, purges what is past retention and, when due and allowed, vacuums the file; at start and on foreground it also retries the queued report submits. `ReportFetch` runs the fetch trigger (`app/src/fetch/trigger.ts`), which decides how often a wake becomes a fetch cycle.

Two rules shape all of this and are enforced by tests. Coordinates never cross from native to JavaScript on the capture path: no return value or event of the capture module carries a latitude or longitude, and JavaScript reads positions only from the store. And writes to a table go only through that table's functions in `packages/shared/src/store/tables/`, by the owner listed in `ownership.ts`.

## 5. Data models

### On the device

One SQLCipher file, schema version 1, defined in [`packages/shared/src/store/migrations.ts`](../packages/shared/src/store/migrations.ts). The version is `PRAGMA user_version`. TypeScript owns migrations; native code only checks the version and runs the statements in `contracts/native-writer.json`. A released migration is frozen: a schema change is a new migration appended to the list.

| Table               | Holds                                                                     | Written by                                                       | Purged                                    |
| ------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `location_sample`   | Raw fixes: time, lat, lon, accuracy, source, res-7 and res-5 H3 cells     | The native capture module only                                   | After 30 days, natively and in TypeScript |
| `stay`              | Dwell intervals, the main matching unit                                   | TypeScript stay derivation (`derived`); the iOS module (`visit`) | After 30 days; a running stay is trimmed  |
| `report_cache`      | Verified broadcast queries as received, with a match cursor               | The bundle fetcher                                               | At `expires_at`                           |
| `match`             | Local match decisions, one per report, with state                         | The match runner (not built)                                     | When its report leaves the cache          |
| `subscription`      | The shard cells this device follows                                       | The subscription manager (not built)                             | Not purged                                |
| `outbound_response` | Durable send queue for a bystander's tip                                  | The bystander send pipeline (not built)                          | 7 days after sent or failed               |
| `own_report`        | The reporter's own reports and their submit queue                         | The report submit screen and queue                               | Not purged; retention undecided           |
| `received_response` | Tips received for the reporter's reports                                  | The reporter response fetch (not built)                          | Not purged; retention undecided           |
| `kv`                | Cursors and small values: stay cursor, fetch state, cover seed, device id | Per key, listed in `store/tables/kv.ts`                          | -                                         |

Design points worth knowing before touching it:

- The two natively written tables carry no constraints beyond `NOT NULL`, because a failed constraint in the background would drop a fix where nothing can report it. Every other table states its invariants as `CHECK` and `UNIQUE`.
- `match` is `UNIQUE (query_id)`: at most one notification per report, ever. `outbound_response` is `UNIQUE (query_id)`: one tip per report from a device.
- `report_cache` also holds reports from cover shards (section 6), so it must never be shown as "reports near this phone".
- Who may write which table is listed in [`ownership.ts`](../packages/shared/src/store/ownership.ts), and a test checks the list covers exactly the tables the migration creates.
- "Delete all my data" drops the file and rotates the key; it is not a per-table delete.

Limits and retention rules: "Retention" in [packages/shared/README.md](../packages/shared/README.md). Key, directory, backup exclusion and the open sequence: [packages/encrypted-store/README.md](../packages/encrypted-store/README.md). The cipher parameters are `packages/shared/contracts/cipher-params.json` (SQLCipher 4, 4096-byte pages, raw 32-byte key, WAL).

### On the wire

Defined with zod in `packages/shared/src/payload/` and exported as JSON Schema under `packages/shared/contracts/`.

- **`BroadcastQuery`**: one report as every device receives it. Version, `query_id` (a ULID), `revision`, `key_id`, `issued_at`, `expires_at`, the match criteria (`center`, `radius_m`, `window`), `cells` (the res-7 cover of the search area), `person` (name, description, optional inline thumbnail of at most 256 px), `reporter_phone`, `respond.endpoint`, and `sig`. Everything the match screen shows is inside it, so a matching phone fetches nothing more.
- **`ShardBundle`**: the signed list of queries filed under one H3 shard (res 5, or res 3 when coarsened), with a `generation`.
- **`ShardIndex`**: the signed list of every shard that has reports and its current generation.

All three are signed with Ed25519 over canonical JSON with a domain separator per kind (`payload/signing.ts`). Readers verify first and parse second.

### On the server

Node's built-in SQLite, schema in [`server/src/db.ts`](../server/src/db.ts).

| Table               | Holds                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `devices`           | Device id, platform, app version, optional push provider and token                                                       |
| `reports`           | One row per report: reporter device, `review_state`, `status`, revision, criteria, person JSON, reporter phone, reviewer |
| `responses`         | Tips: `UNIQUE (query_id, device_id)`, text, optional phone, `moderation` (`delivered` or `held`) and reason              |
| `idempotency`       | Remembered outcomes keyed by `(device_id, key)`                                                                          |
| `shard_generations` | The newest generation, content hash and count per shard. Never reset, never deleted                                      |
| `shard_index_state` | Hash and time of the last published index (a single row)                                                                 |
| `shard_cdn_pending` | Paths whose CDN purge failed and must be retried                                                                         |

A report has two independent fields: `review_state` (`pending`, `released`, `rejected`) and `status` (`active`, `ended`, `expired`). Only `released`, `active` and unexpired reports are broadcast, and `ServerDb.listBroadcastable` is the single query that says so.

The server stores no location history of any device and no record of which device matched which report.

## 6. Backend, API and auth

### Shape

One Node process (`server/src/main.ts`) runs the Fastify API and, when a publish target is configured, the shard compiler on a timer. The compiler can also run as a second process from the CLI. Devices talk to two different things:

```
reporter phone --POST /v1/reports--> API --(held as pending)--> operator releases
                                                                     |
                                              shard compiler reads released reports,
                                              signs them, writes static files
                                                                     |
every phone <--GET /index.json, /shards/<cell>/<gen>.json-- CDN <----'
     |
     `-- matches on the phone; if the owner chooses --POST /v1/responses--> API --> reporter
```

Reading reports is anonymous static-file traffic. Only filing a report, sending a tip and reading tips touch the API.

### Endpoints

The six public endpoints are data in [`packages/shared/src/api/endpoints.ts`](../packages/shared/src/api/endpoints.ts) (`API_ENDPOINTS`): method, path, schemas, success status and whether an idempotency key is required. The server registers its routes from that table and the app builds its requests from it.

| Method and path                         | Purpose                                         | Idempotency key | In `API_ENDPOINTS` |
| --------------------------------------- | ----------------------------------------------- | --------------- | ------------------ |
| `POST /v1/devices`                      | Register a device and, optionally, a push token | no              | yes                |
| `POST /v1/reports`                      | File a report; it is stored as `pending`        | required        | yes                |
| `GET /v1/reports/:id`                   | The reporter reads their own report             | no              | no, server only    |
| `PATCH /v1/reports/:id`                 | Widen-only edit                                 | required        | yes                |
| `POST /v1/reports/:id/end`              | End a report                                    | no              | yes                |
| `GET /v1/reports/:id/responses`         | The reporter reads delivered tips, paged        | no              | yes                |
| `POST /v1/responses`                    | A bystander sends one tip                       | required        | yes                |
| `POST /v1/operator/reports/:id/release` | Release a pending report                        | no              | no, operator       |
| `POST /v1/operator/reports/:id/reject`  | Reject a pending report                         | no              | no, operator       |
| `GET /v1/operator/reports?state=`       | List reports by review state                    | no              | no, operator       |
| `GET /v1/operator/responses/held`       | List tips held by moderation                    | no              | no, operator       |

Conventions, each defined once in `packages/shared/src/api/`:

- **Errors** are always `{ "error": { "code", "message", ... } }`, and each code has one fixed HTTP status (`errors.ts`). Clients branch on `code`. No error may depend on whether any device matched.
- **Idempotency** (`idempotency.ts`): the client mints one UUID per user action when it is queued and sends it on every retry; the server scopes it to `(device, key)`, replays the stored outcome for the same body, and answers 422 for a different one.
- **Someone else's report** and an unknown id are the same `not_found`.
- **Body limit** is 256 KB.

### Static files

Published by `compileShards` in `server/src/shards/compiler.ts`, the only writer of what devices fetch:

| Path                                  | Content                                | Cache               |
| ------------------------------------- | -------------------------------------- | ------------------- |
| `/index.json`                         | Signed index of shards and generations | 60 seconds          |
| `/shards/<h3 cell>/<generation>.json` | Signed bundle of one shard             | immutable, new path |

A bundle path never changes its bytes; a change is a new generation at a new path. Layout, generations, key rotation and bundle sizes are in [server/README.md](../server/README.md). The device side is `runFetchCycle` in `packages/shared/src/fetch/cycle.ts`; its header explains the padding (a constant number of requests per cycle and cover shards).

### Auth

**Device identity.** Every API call is made as a device. The id is a random UUID v4 the app generates on first use and keeps in the encrypted store (`kv`, key `identity.device_id`; `app/src/report/identity.ts`). It is sent as `Authorization: FMP-Device <uuid>`. The server accepts whatever id the header claims (`createStubDeviceAuthenticator` in `packages/shared/src/identity/deviceIdentity.ts`). There are no accounts, no attestation and no phone-number verification.

This is a decision, not an oversight. It was made in the 2026-10-03 addendum to the architecture plan. That plan is a planning record kept outside this repository; what follows is a summary, and the repository's own trace of it is the "Decisions built as decided" section of `server/README.md` and the comments in `app.ts` and `identity.ts`. The plan had compared four options: a client-generated id; platform attestation (Play Integrity, App Attest); an SMS-verified reporter number; and IP limits with proof of work. It recommended verifying the reporter's number, because that number is shown to strangers and an unverified one lets someone attach a third party's number to a report. The addendum chose the client-generated id alone and dropped the other three, on the reasoning that reports are no longer broadcast on submission: a person phones the reporter and confirms before releasing anything, which covers the unverified-number problem by hand. The addendum states that this must be revisited if the manual review step is ever removed or stops scaling.

Consequences to keep in mind: the id is forgeable, so deduplication and any future rate limit are only as strong as that; "Delete all my data" mints a new id; and `DeviceIdentity` and `DeviceAuthenticator` are the two interfaces a stronger scheme would replace without touching callers.

**Operator.** The release and reject routes check that the caller's device id is on an allow-list (`FMP_OPERATOR_DEVICE_IDS`; empty means nobody). It is the same forgeable identity, so it is not safe on the public internet. See section 8.

**Publisher keys.** What devices trust is not the server's TLS identity but Ed25519 keys pinned in the app binary. `server/src/shards/keys.ts` holds the key ring and describes rotation with an overlap.

### Configuration

Environment variables only; nothing secret is committed. `FMP_DB_PATH`, `FMP_PORT`, `FMP_OPERATOR_DEVICE_IDS` (`server/src/main.ts`); `FMP_SHARD_OUT_DIR` or the `FMP_R2_*` and `FMP_CDN_*` set, `FMP_SHARD_KEYS` or `FMP_SHARD_KEYS_FILE`, `FMP_RESPOND_ENDPOINT`, `FMP_SHARD_INTERVAL_SEC` (`server/src/shards/worker.ts`). Build signing uses the `FMP_ANDROID_*` and `FMP_IOS_*` secrets in [BUILDING.md](BUILDING.md).

## 7. Third-party services

| Service                         | Used for                                                  | State                                                                                                                              |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare R2                   | Object store for the index and shard bundles (S3 API)     | Adapter built and tested against a fake endpoint; no bucket provisioned, never run live                                            |
| Cloudflare zone and cache purge | Serves the bucket on a custom domain; purges `index.json` | Same                                                                                                                               |
| Google Play services (location) | Fused location provider on Android                        | Linked by the capture module. A fallback for phones without Play services (`PlatformBackend`) exists and has never run on a device |
| Android Keystore, iOS Keychain  | Holding the store key                                     | Platform features, not network services                                                                                            |
| GitHub Actions                  | CI and installable builds                                 | Running; app build jobs skip until native projects exist                                                                           |
| Apple Developer, Google Play    | Signing and distribution                                  | Secrets are read from CI if present; none are required to build unsigned                                                           |
| Google Fonts (source only)      | Bricolage Grotesque, Atkinson Hyperlegible Next           | Bundled as static files; nothing is fetched at run time                                                                            |

Not used, deliberately or not yet: no analytics, crash reporting or advertising SDK; no push provider (the API accepts an `fcm` or `apns` token but nothing sends); no SMS or OTP provider; no maps or geocoding SDK; no hosted database; no cloud SDK. The app's only network destinations are the API and the CDN, and both addresses are unset today (`API_BASE_URL` and `REPORT_CDN_ORIGIN` are `null`), so the app as it stands makes no network request at all.

## 8. Stubs and unfinished

Each entry was checked against the code at the commit named at the top. "Waiting on" is what has to happen before it can be finished.

### No native app project

- **`app/android` and `app/ios` do not exist**, and `app/src/index.ts` is a placeholder export with no `AppRegistry.registerComponent`. Nothing in the app has been built into an installable binary or run on a phone, a simulator or an emulator. The build scripts and CI jobs detect this and skip. Waiting on: the task that adds the native projects, which must also register the `findmyperson://` URL scheme, link the fonts (`npx react-native-asset`) and run both build scripts for the first time.
- **Every "not verified" list in the package READMEs** follows from this: Keychain and Keystore behaviour after a reboot, real backup exclusion, op-sqlite itself (its Node build has no SQLCipher), autolinking of both native modules, and capture behaviour on real devices.

### Unset configuration

| Item                                | Where                        | Today                                                                                                                              | Waiting on                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_BASE_URL`                      | `app/src/report/api.ts`      | `null`. A submitted report is written to `own_report` and stays queued; nothing is sent                                            | A deployed backend and its URL                                                                                                                                                                           |
| `REPORT_CDN_ORIGIN`                 | `app/src/fetch/reportCdn.ts` | `null`. Every wake of the fetch trigger ends as `unconfigured`, with nothing on the network                                        | The storage and CDN provider decision, then a provisioned bucket and custom domain; must equal the server's `FMP_CDN_ORIGIN`                                                                             |
| `REPORT_TRUSTED_KEYS`               | `app/src/fetch/reportCdn.ts` | `{}`. With no key the app has no report source, whatever the origin is                                                             | A production signing key (`dist/cli.js keygen` prints the public half) and a decision on where its seed is kept. These are constants in the binary on purpose: a build trusts the keys it was built with |
| `POLICIES_URL`, `ABUSE_CONTACT_URL` | `app/src/settings/links.ts`  | Placeholder values (`https://findmyperson.app/policies`, `mailto:abuse@findmyperson.app`). Neither the page nor the mailbox exists | A published policy page and a monitored abuse address; the store listings need the same URL                                                                                                              |
| Server R2 and CDN variables         | `server/src/shards/r2.ts`    | Read from the environment; unset means files go to a local directory or nowhere                                                    | Provisioned Cloudflare resources and tokens                                                                                                                                                              |

### Seams with no implementation

- **Photo picker and resizer** (`PhotoPort` in `app/src/report/image.ts`, supplied through `ReportServicesProvider`). No image library is in the app. Without a port the form hides "Add photo". Waiting on: a choice of image picker and resize library, which needs the native projects.
- **Map picker** (`LocationPort` in `app/src/report/services.tsx`). No map library is in the app. Without a port the reporter types latitude and longitude. Waiting on: a choice of map provider, which also adds a third-party service and a privacy question (a map SDK sees where the reporter looks).
- **Report radius and window defaults.** The form sends a 500 m radius and a window of 30 minutes either side of the last-seen time; both are marked provisional.
- **Secure random on Hermes.** `platformRandomBytes` (device id, idempotency keys) assumes `globalThis.crypto.getRandomValues` exists and throws if it does not. `deviceRandom` in `app/src/fetch/random.ts` (the cover-shard secret and request order) falls back to `Math.random` instead. Which of the two a real build gets is unverified until a native build exists; a polyfill may be needed.
- **HTTP cache under the fetcher.** The padding relies on every request reaching the CDN. Whether the platform HTTP client (the default `URLSession` has a cache) answers a repeat request itself is unverified; the header of `app/src/fetch/httpTransport.ts` says what to check.

### Switched off

- **`ANDROID_VACUUM_ENABLED`** (`app/src/store/retention.ts`) is `false`, so the weekly `VACUUM` never runs on Android and the file does not shrink after a purge. The cause is that TypeScript and Kotlin use two copies of SQLite in one process, which do not see each other's file locks. Open PR #31 removes the second copy (a JNI shim onto op-sqlite's SQLCipher) but leaves the flag off. Waiting on: PR #31 merging, then a run on a real Android phone.

### Pieces of the product that are not built

- **Report fetch.** The trigger, the Ed25519 verify and the metered-connection getter are built and wired (`ReportFetch` in `AppNavigator`), but a run stops at once as `unconfigured` until `REPORT_CDN_ORIGIN` and `REPORT_TRUSTED_KEYS` are set. Once they are, a cycle would still fetch only cover shards, because the watch list is empty (next item).
- **Subscription manager.** Nothing writes the `subscription` table, so the fetcher's watch list is empty. `putSubscription` and `deleteSubscription` exist in `packages/shared` with no caller. Waiting on: its own task (B3.7 in the plan), which turns visited cells into followed shards.
- **Match runner.** `matchReport` is implemented and measured, but nothing calls it outside tests and the offline harness. There is no retrospective or prospective pass, nothing writes `match`, and `report_cache.last_matched_at` is never set. The fetch trigger's `onRematch` hook defaults to a no-op marked `TODO(M5.2)`. Waiting on: its own task (M5.2), which also depends on reports actually arriving.
- **Match notification and bystander screen.** No local notification is raised, and `Bystander` is a placeholder. The notification permission (Android 13 and later) is not requested anywhere.
- **Bystander tip pipeline.** Nothing in the app writes `outbound_response` or calls `POST /v1/responses`. The server side of that endpoint is built.
- **Reporter side after submit.** `LiveReport` is a placeholder; the app never calls `GET /v1/reports/:id`, `PATCH`, `end` or `GET .../responses`, and nothing writes `received_response`. The app's `own_report` handling does not read `review_state` yet, so it cannot tell `pending` from `released`.
- **Push.** No FCM or APNs code exists on either side. The server stores a push token if one is registered, the app never calls `POST /v1/devices`, and nothing sends a push: not the coarse wake topics, not "a tip arrived" to the reporter.
- **Home and History.** Home is a placeholder shell around the real capture-health row; History is an empty placeholder and has no mockup.
- **Onboarding gate.** The initial route is always `Onboarding`; nothing remembers that it was completed.
- **Capture mode setting.** The capture module supports switching between the WorkManager mode and the foreground-service mode at run time, but Settings only has pause and resume and always starts with the defaults.
- **Navigation chrome.** `theme.ts` records that the v2 mockups replaced the bottom tab bar with a hamburger menu, and `HamburgerMenu` exists in the design system, but the navigator still uses bottom tabs and nothing renders the menu.

### Server

- **Operator authentication** (`server/src/operator.ts`). The release gate, the project's main safety control, is guarded by a device-id allow-list on a forgeable header. Waiting on: a real operator credential (a token, mTLS or an admin login) before the API is exposed.
- **Operator alert** (`server/src/alerts.ts`). A new pending report produces one log line, `report.pending`. Waiting on: a real channel (push, SMS or email) implementing `OperatorAlerter`.
- **No operator UI.** Review is done by calling the operator routes directly.
- **No rate limits.** The plan's one report per device per day is not enforced; the `rate_limited` error code exists and nothing returns it.
- **Moderation** is a regex filter for links and payment identifiers. Its misses are listed at the top of `server/src/moderation.ts`. The policy page, abuse contact and review commitments that go with it are not built.
- **Widening after release.** A widening edit on a released report stays released with no second review.
- **Database.** SQLite on one box. The plan named Postgres; the file is written so that only `db.ts` would change.
- **No deployment.** There is no Dockerfile, hosting config or deploy job.

### Native modules

- **Capture modules carry their own store code.** Both still open the store through a stand-in written before `packages/encrypted-store` existed. The swap to `EncryptedStore` is listed in that package's README, which also says the swap has to land before a Settings screen offers the delete: the iOS stand-in keeps its connection open, so after a delete it goes on writing to the removed file until the app restarts. Settings offers the delete today (it stops capture first), so on iOS a delete followed by a resume in the same run is exposed to this.
- **No scheduled purge when nothing wakes.** A phone with capture stopped and the app never opened keeps what it has until the app is next opened.

### Documentation that lags

- The status paragraph of the root `README.md` still says "pre-implementation" and its package list omits `packages/encrypted-store`.
- The shard compiler note in `AGENTS.md` still says the bucket and CDN adapters are not built; the R2 adapter landed in pull request #29.
