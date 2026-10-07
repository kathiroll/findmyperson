# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Working rules (read and follow these before doing anything)

Follow these rules for every task. The goal: the captain always knows what was decided, what was done, what's left and what's waiting on them. Visibility beats speed.

**Project docs (single source of truth)**

- `docs/PLAN.md`: what we're building, in what order, and what we're NOT building. Updated at milestones.
- `docs/TASKS.md`: total / done / remaining / blocked on the captain. Updated every task.
- `docs/DECISIONS.md`: what was decided, why, and by whom. Updated every significant decision.
- `docs/WORKLOG.md`: what was actually done and what came up. Updated every task.
- `docs/ARCHITECTURE.md`: how the app is structured right now. Updated when structure changes.

Doc updates go in the same PR as the code for that task.

`docs/TASKS.md` markers: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked on the captain. Keep a "Needs you" section at the top. Every `[!]` says what's needed and which tasks it blocks.

Task detail format:

```
### T-016 Short title
Goal: One sentence, one outcome.
Acceptance criteria: 2-6 checkable bullets
Out of scope:
Decisions resolved: D-XXX or "none needed"
Likely areas touched:
How to verify:
```

`docs/DECISIONS.md` format:

```
## D-007 Short title
- Date:
- Status: Proposed | Accepted | Superseded by D-XXX
- Decided by: Captain | Claude (proposed) | Claude (inferred from existing code)
- Decision:
- Why:
- Alternatives considered:
```

Never delete a decision; mark it Superseded and link the replacement.

`docs/WORKLOG.md` (append-only):

```
## YYYY-MM-DD: T-016
- What was done, in plain language
- Files:
- Notes / questions raised (-> new task IDs)
```

**Doing a task**

- Do exactly the one task in your brief. Nothing else.
- If the brief doesn't answer a question that matters, stop and report back. Don't guess.
- Leave the app building and running.
- Work only inside your task's scope and the brief's "Out of scope" line.

**Decisions**

Significant = frameworks/libraries, architecture, data models/schema, auth, payments, third-party services, APIs, navigation structure, or anything costly to reverse.

- Never make a significant decision on your own. Stop, add a Proposed entry to `docs/DECISIONS.md` and a `[!]` item to `docs/TASKS.md`, and report it with tradeoffs and at least one alternative.
- Small, reversible implementation details are fine; note any notable ones in `docs/WORKLOG.md`.

**Scope discipline**

- No extra features, tooling, analytics, admin screens, simulations, generated datasets or nice-to-haves.
- Where real data doesn't exist yet, use simple hardcoded placeholders and note them in `docs/WORKLOG.md`. Don't invent models or simulations to produce numbers.
- Never add a dependency without approval.
- Out-of-scope ideas go in `docs/TASKS.md` as suggestions, marked clearly. Don't build them.

**Spikes**

A spike investigates an unknown. It changes only `docs/`: it ends with a Proposed entry in `docs/DECISIONS.md` and a `[!]` item in `docs/TASKS.md`. No production code.

**Definition of done**

A task is `[x]` only when all are true:

1. Acceptance criteria met; the app builds and runs.
2. Commits start with the task ID: `T-016: add bio validation`.
3. `docs/TASKS.md` updated.
4. `docs/WORKLOG.md` entry appended.
5. Any significant decision logged as Proposed, with a matching `[!]` item.
6. `docs/ARCHITECTURE.md` updated if structure changed.

Finish with a 2-4 line summary: what was done, how to verify it, anything that now needs the captain.

**Git**

- Small, focused commits, each prefixed with the task ID. No unrelated changes.
- Never force-push or rewrite history.

**Joining an existing codebase**

If the docs above don't exist yet, don't write any code. Read the codebase without modifying it; write `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (every significant decision you can infer, marked "Decided by: Claude (inferred from existing code)", Status: Proposed), `docs/PLAN.md` (with a Non-goals section) and `docs/TASKS.md` (completed work `[x]`); note anything that looks like unrequested scope under "Needs you" in `docs/TASKS.md` as candidates to remove.

## Coding style

You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.

Before writing any code, stop at the first rung that holds:

1. Does this need to be built at all? (YAGNI)
2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.
3. Does the standard library already do this? Use it.
4. Does a native platform feature cover it? Use it.
5. Does an already-installed dependency solve it? Use it.
6. Can this be one line? Make it one line.
7. Only then: write the minimum code that works.

The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.

Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.

Rules:

- No abstractions that weren't explicitly requested.
- No new dependency if it can be avoided.
- No boilerplate nobody asked for.
- Deletion over addition. Boring over clever. Fewest files possible.
- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Question complex requests: "Do you actually need X, or does Y cover it?"
- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path.

Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.

Adapted from DietrichGebert/ponytail (MIT).

Where this section conflicts with the working rules above, the working rules win: if the task does not answer a question that matters, stop and report instead of defaulting; surface lint and test failures you see even when you did not cause them; and a bug fix or feature that needs an architecture proposal gets one before building.

## Project knowledge

- No simulators or emulators; every claim about device behaviour is either verified from source/build output or listed as unverified in the PR and the relevant `m0/*/README.md`.
- Shared contracts: `packages/shared` is the only definition of the broadcast payload, signing, distance and H3 math, the widen-only edit rule, the store schema and API shapes; import from it, never redefine. Start at `packages/shared/README.md`. `contracts/README.md` there covers the files Kotlin and Swift must match and which of them are frozen versus generated (`pnpm exec vitest run packages/shared -u`, from the repo root). `src/store/ownership.ts` says which task may write which table. Outside `src/testing/` and tests that package must stay free of Node APIs.
- SQLCipher parameters: the real build reads `packages/shared/contracts/cipher-params.json`, pinned by a test to the M0 original `m0/store-proof/shared/cipher-params.json`, so change both together. In `m0/store-proof` run `npm run gen:cipher` and never hand-edit the generated TS/Kotlin/Swift constants. op-sqlite's Node build ignores the encryption key, so its Jest uses `@journeyapps/sqlcipher`; details in `m0/store-proof/README.md`.
- Encrypted store: `packages/encrypted-store` is the only code that opens the on-device store, holds its key or names its directory, in TypeScript (`openStore`, `deleteAllData`), Kotlin and Swift (`EncryptedStore`); never open the file or build a path elsewhere. Backup exclusion and key accessibility are gated by `src/policy.test.ts` there, which reads the manifests and native sources, so a failure means a rule was broken, not a fixture to refresh. `StoreContract.kt`/`.swift` and `contracts/` are generated (`pnpm exec vitest run packages/encrypted-store -u`, from the repo root). The Swift half only runs on a Mac (`pnpm test` skips it on Linux). Start at that package's README.
- One SQLite on Android: native code reaches SQLite only through `SqlcipherConnection` in `packages/encrypted-store/android`, a JNI front (`src/main/cpp`) linked to the SQLCipher inside op-sqlite's `libop-sqlite.so`, the copy JavaScript uses. Never add a dependency that carries its own SQLite or SQLCipher, and never use `android.database.sqlite` on the store: two copies in one process do not see each other's file locks. Gated by `src/policy.test.ts` and, on built APKs, `scripts/check-native-libs.ts`. `gradle -p packages/encrypted-store/android -PfmpHostSqlcipher testDebugUnitTest` runs the Kotlin and C on real SQLCipher; `build/android-linkcheck.sh` builds and reads an APK.
- Matching: `matchReport` in `packages/shared/src/match/` is the only match rule. It reads a report's radius and window rounded outward to the 150 m / 30 min grid, which is what makes the anti-oracle property of plan 8.3 true (the tests under "anti-oracle" hold it); never match on the criteria as written, and pick rows with `matchBounds`. `runMatchPass` in `runner.ts` there is the only caller on a device and the only writer of new `match` rows and of `report_cache.last_matched_at`; it is the last step of `DataStore.runMaintenance` and returns the rows it inserted (`MaintenanceResult.matches`), which nothing notifies on yet. A match is never "near you". Start at "Match runner" in `packages/shared/README.md`. `pnpm --filter @findmyperson/server harness` re-measures recall and false positives on synthetic populations (`server/src/harness/`, figures in `server/README.md`).
- Retention: `packages/shared/src/retention/` decides what is deleted by age. It runs in three places: the app (`app/src/store/`: `StoreMaintenance` calls `DataStore.runMaintenance()` at start, on foreground and on each reported sample, the moments `useAppWake` defines for all background work), and each capture module on a wake with no JavaScript, with the purge statements of `native-writer.json`. A new table or column that holds location history needs a line in `purgeExpired` and its 60-day test, in `NATIVE_WRITER_CONTRACT`, and in both native purges. The weekly VACUUM is off on Android until the one-SQLite link has been verified on a phone ("Before the Android vacuum is switched on" in `packages/encrypted-store/README.md`): `ANDROID_VACUUM_ENABLED` in `app/src/store/retention.ts`. "Retention" in `packages/shared/README.md` lists the limits.
- Native capture module: `packages/native-location-capture/src/specs/NativeLocationCapture.ts` is the one interface the Kotlin module, the Swift module and the in-memory fake (`…/fake`) all implement, and its comments are the contract; change it there first, never per platform. `contracts/` in that package is codegen output pinned by a test (`pnpm exec vitest run packages/native-location-capture -u`, from the repo root). Start at that package's README. The iOS module is `ios/` there (`ios/README.md`): decisions live in `Sources/CaptureCore`, which is Foundation-only so `swift test` covers it without a phone; keep `Sources/Platform` and `Sources/Bridge` as thin adapters, and run `sh scripts/check-ios.sh` after touching them.
- App UI: build screens from `app/src/design-system/` (`import { … } from '../design-system'`); tokens live only in its `theme.ts`, extracted from the Design-canvas v2 mockups (the artifact outranks any older design notes). Component tests run against stubs, not real react-native; `app/assets/fonts/README.md` covers the bundled fonts.
- App navigation: route names, params and deep links are defined only in `app/src/navigation/routes.ts`; a screen task replaces its stub in `screens.tsx` and keeps the route name. Tests render the real graph against JS-only navigator doubles (`navigation/__tests__/stubs.tsx`). The `findmyperson://` scheme is not yet registered: `app/android`'s manifest has no intent filter for it.
- Real-app builds: `build/*.sh` is the single path for local and CI builds (Android on every PR, iOS only on main/tags to save macOS runner cost); see `docs/BUILDING.md`. Signing comes only from env vars/CI secrets.
- Android app project: `app/android` is the React Native 0.87 app template plus the differences tabled in `docs/BUILDING.md` ("The Android project"); keep that table true, and upgrade by diffing against the new template. node_modules is pnpm's isolated layout (the `node-linker` line in `.npmrc` is not read), so Gradle finds React Native's parts with `node --print require.resolve(...)` and `app/metro.config.js` pins `react` and `react-native` to one copy in the bundle. Metro bundles from `app/index.js`, not `app/src/index.ts`. `app/` is `"type": "module"`: its config files are ES modules or JSON, never `module.exports`. There is no `app/ios` yet.
- Android capture module: `packages/native-location-capture/android` is a Gradle build of its own (`./gradlew testDebugUnitTest lintDebug assembleDebug` there, after `source build/env.sh`; the `android-module` CI job). Decisions live in `core/` (plain Kotlin, tested on the JVM against fakes of the OS), Android calls in `platform/`; keep it that way. `store/` is a stand-in for the store package's `EncryptedStore`, already opening its connection through that package, which the standalone build includes as a subproject. Start at its README.
- Bundle fetcher: `runFetchCycle` in `packages/shared/src/fetch/cycle.ts` is the only code that reads the CDN and the only writer of fetched reports; its header is the account of the padding (constant request count, cover shards), and any change to what goes on the wire has to keep both. The app calls it through `DataStore.runFetchCycle` (`app/src/store/`), from the fetch trigger in `app/src/fetch/trigger.ts`, which supplies its inputs and decides how often; start at "Report fetch" in `app/src/navigation/README.md`. `report_cache` also holds reports from cover shards, so never present it as "near you". The CDN origin and pinned keys are unset until the storage/CDN decision: `REPORT_CDN_ORIGIN` and `REPORT_TRUSTED_KEYS` in `app/src/fetch/reportCdn.ts`, and with either unset the app fetches nothing. The watch list is `listWatchedShards` over the `subscription` table.
- Subscription manager: `syncSubscriptions` in `packages/shared/src/subscription/` is the only writer of `subscription`; the rule for the set (visited res-5 cells, their ring, res-3 parents, the cap and its coarsening) is `watchSetForCells` in `watchSet.ts` there and nowhere else. `DataStore.runMaintenance` runs it after the purge. An `ancestor` row is a push-wake topic and must never reach the fetcher: its bundle is a whole res-3 region. Push-topic subscription is not built; a run's `added`/`removed` are its input. Start at "Subscription manager" in `packages/shared/README.md`.
- Shard compiler: `server/src/shards/compiler.ts` is the only writer of the files devices fetch (`/index.json`, `/shards/<cell>/<generation>.json`) and reads reports only through `ServerDb.listBroadcastable`. A bundle path never changes its bytes: generations move only when contents change, and the `shard_generations` table is never reset. Bucket and CDN adapters are not built (interfaces in `storage.ts`). Server entries do not run from source under plain Node (extensionless imports, TS-only shared package): `server/build.mjs` bundles them to `dist/` and `src/entrypoints.test.ts` runs the built entries. Start at `server/README.md`.
- Operator page: `server/src/operatorPage.ts` serves `/operator`, the only HTML the server emits. Stored text reaches it only through that file's `markup` tag, which escapes it (the tag is not called `html` because Prettier would reflow it). It decides nothing itself: reports go through `reviewReport` in `server/src/app.ts`, held responses through `decideHeldResponse` in `server/src/moderation.ts`. Access is a one-token stub (`FMP_OPERATOR_WEB_TOKEN`) awaiting real operator login; see "The operator page" in `server/README.md`.
- Report submit: `app/src/report/` is the only submit path (`form.ts` validation, `queue.ts` over the `own_report` table, `api.ts` client); the report is born `pending` server-side, so UI copy must say "under review", never "live". Photo, map and API base URL are seams nobody supplies yet; see the end of `app/src/navigation/README.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
