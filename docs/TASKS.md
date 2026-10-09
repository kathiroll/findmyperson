# Tasks

The state of the work: what is done, what is left, and what is waiting on the captain. Updated every task, in the same pull request as the task. Markers: `[ ]` not started, `[~]` in progress, `[x]` done, `[!]` blocked on the captain.

|                        |                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Total                  | 46 (T-000 to T-045)                                                                                                                        |
| Done                   | 45                                                                                                                                         |
| In progress            | 0                                                                                                                                          |
| Remaining              | 1 queued (T-042); no others are listed until the captain approves the next breakdown |
| Blocked on the captain | 14 items below, each marked `[!]`                                                                                                          |

As of commit `88c8a6c` (2026-10-08), plus T-040 and T-041. T-000 is this onboarding. T-001 to T-039 are the merged pull requests #1 to #39, one task each, numbered by pull request; they were written down after the fact in T-000, so their acceptance criteria are not reconstructed (the pull request is the record).

## Needs you

No task IDs exist yet for the work these items block, so each says what it blocks in words. Proposed decisions are in [DECISIONS.md](DECISIONS.md); the plan and its non-goals are in [PLAN.md](PLAN.md).

### Decisions and approvals

- [!] **How far to recut the M0 to M7 plan.** Needed from you: how far to reorder the milestones for dependency order; whether to run a spike on whether TypeScript can run on a background wake before the native wake-trigger work begins; and confirmation of the build concurrency you have decided (one build task at a time by default; parallel only for tasks that touch different files with no shared open decisions, and only after asking you). The milestone plan lives outside this repository and the detail of the recut question is in firstmate's records, so it is not visible here. Blocks: the next task breakdown, so every build task after T-039.
- [!] **The Home screen's list of non-commercial altruistic projects.** Needed from you: whether the strict non-commercial bar stays (the reference project, Be My Eyes, raised venture funding and fails it) or relaxes to "free to the person helped and volunteer-powered", and which 6 to 8 of the shortlist ship. The shortlist, and the reference to Be My Eyes, are not in the repository: what is there is the placeholder list `CURIOUS_LINKS` in `app/src/home/HomeScreen.tsx` (`[VIDEO LINK]`, `[PROJECT 1]`, `[PROJECT 2]`). Blocks: the real content of Home's "If you're curious" list, and any copy that states what kind of projects are linked. Related: [D-052](DECISIONS.md).
- [!] **Approve or change the proposed decisions** D-015 (no state library), D-040 (the server database is Node's built-in SQLite although the plan named Postgres) and D-052 to D-062 (inferred in T-000: non-commercial MIT, no third-party SDKs in the app, hamburger navigation, Android id and SDK levels, report form defaults, the operator page, the watch-list rule, matching cadence, fetch cadence, vendored H3 on iOS, Play services with a fallback). Blocks: nothing is stopped today, but each stays `Proposed` until you accept it, and a later task must not build on a Proposed entry without asking.
- [!] **Approve the iOS app's dependencies and choices** (D-063 to D-067, inferred in T-040 from the work an earlier Codex session did). Two are new dependencies, which need your approval by name: `react-native-get-random-values` `^2.0.0` (secure randomness, D-063) and `@react-native-community/cli-platform-ios` `20.2.0` (dev dependency, CocoaPods autolinking, D-064). The other three: React Native 0.87.1 on iOS, device-only, New Architecture, Hermes (D-065); op-sqlite's SQLCipher as the single owner of SQLCipher symbols (D-066); `EncryptedCaptureStore` over `EncryptedStore.shared` as the production iOS capture store (D-067). Blocks: nothing is stopped today, but each stays `Proposed` until you accept it, and no later task may build on one without asking.
- [!] **Ratify the entries whose decider is "not recorded"** (D-001 to D-051, except D-011, D-043 to D-046 which cite plan addenda, D-032's photo cap which the captain decided, and the three marked Proposed). They are in force and documented in the repository, so they are marked `Accepted`, but nothing says who chose them. Part of this: D-001 and `WORKSPACE.md` say the install is hoisted (`node-linker=hoisted` in `.npmrc`); `AGENTS.md` and the installed tree say it is pnpm's isolated layout and that the `.npmrc` line is not read. Needed from you: confirm which is intended; if hoisted was meant, the build has drifted from it. Blocks: nothing today.

### Open choices the code is waiting on

- [!] **Storage and CDN provider.** The server publishes through a Cloudflare R2 adapter (PR #29, [D-038](DECISIONS.md), Proposed: why R2 is not written down), but the app's `REPORT_CDN_ORIGIN` waits on "the storage and CDN decision". Needed from you: confirm R2 or pick another provider, then provision the bucket and a custom domain. Blocks: report fetch ever making a request, and so everything downstream of it (matching real reports, notifications).
- [!] **The production signing key.** Needed from you: generate the production Ed25519 key (`dist/cli.js keygen` prints the public half) and decide where its seed is kept. The public half is built into the app as `REPORT_TRUSTED_KEYS`. Blocks: report fetch (with no key the app has no report source) and publishing from a real server.
- [!] **Where the backend runs.** There is no deployment, no Dockerfile and no hosting config, and `API_BASE_URL` is `null`. Needed from you: a hosting choice and an address. Blocks: a submitted report ever leaving the phone, the operator page being used, and any end-to-end test with real phones.
- [!] **Real operator authentication and alert channel.** The release gate is guarded by a device-id allow-list and by one shared token ([D-057](DECISIONS.md)), and a new report only writes a log line. Needed from you: how operators sign in (accounts, mTLS or an identity provider) and how you are alerted (push, SMS or email). Blocks: exposing the server to the internet; the manual-review gate (D-043) being safe in production.
- [!] **Photo picker and map provider.** The report form has a seam for each and no library: with no photo port "Add photo" is hidden, and with no map port the reporter types coordinates. Both choices add a dependency, and a map SDK also adds a third party that sees where the reporter looks. Needed from you: approval of a library for each, or a decision to leave them out. Blocks: photos in reports and picking a place on a map.
- [!] **How a match reaches the person (local notification or push).** No notification is raised, the notification permission is not requested, and no FCM or APNs code exists. Needed from you: the approach and any push provider, which would be a new third-party service. Blocks: the match notification and the Bystander screen, the reporter hearing that a tip arrived, and the push-wake topics of the subscription manager.
- [!] **Paid Apple team (optional).** T-041 signed with the Personal Team already in this Mac's Xcode, so nothing blocks T-042. The friend's paid team is not visible in this Mac's Xcode. Needed from you only if you want it: sign in to it in Xcode and give its 10-character team ID (kept local, never committed). Blocks: iOS builds in CI and distribution (also need the paid-account secrets in `docs/BUILDING.md`); a Personal Team build expires after 7 days.
- [!] **Policy page and abuse contact.** `POLICIES_URL` and `ABUSE_CONTACT_URL` in `app/src/settings/links.ts` are placeholders (`findmyperson.app/policies`, `abuse@findmyperson.app`); neither the page nor the mailbox exists. Needed from you: the real address and a monitored mailbox. Blocks: store listings, and honest Settings links.
- [!] **Three policy points the code leaves open.** (1) How long `own_report` and `received_response` are kept (today: never purged; `ownership.ts` says undecided). (2) Whether a widening edit on a released report needs a second review (today it does not). (3) Whether to enforce the plan's one report per device per day (the `rate_limited` error code exists and nothing returns it). Needed from you: a call on each. Blocks: the reporter's live-report screen and edit flow (1, 2) and any public launch (3).

### Candidates to remove (suggestions, not tasks)

These look like scope nobody asked for in the repository's own record, or tooling that serves only itself. Each is still wired in and some are load-bearing, so nothing is removed until you say so. Needed from you: keep or remove.

- Offline matching harness and its synthetic populations: `server/src/harness/` (simulation and generated data, [D-029](DECISIONS.md)). It produced the recall and false-positive figures behind the 150 m / 30 minute grid, and a smaller run is held in the unit tests.
- The Android link-check project: `packages/encrypted-store/android-linkcheck/`, `build/android-linkcheck.sh` and the `android-linkcheck` CI job (tooling that exists to check the APK has one SQLite; `app/android` now builds the real APK that the same two checks run on).
- `PlatformBackend`, the location path for phones without Google Play services ([D-062](DECISIONS.md)): never run on a device.
- The operator page, `/operator` ([D-057](DECISIONS.md)): an admin screen. It is the only usable interface to the manual-review gate, so removing it means reviewing by hand through the API.
- The design-system catalogue, `DesignSystemCatalogue` (`app/src/design-system/Catalogue.tsx`): a showcase of the primitives, exported but not reachable from any route.
- The `History` route and menu entry: a placeholder with no mockup ("Not in the v2 mockups").
- `m0/`: the finished research trial apps and analyser (149 tracked files). Evidence for decisions; one file in it is pinned by a test to the real build's cipher parameters.

## Queued

### T-041 [x] Signed build installed on the captain's iPhone

Goal: A development-signed build of the app is installed on the captain's iPhone and launches.
Acceptance criteria:

- `FMP_IOS_TEAM_ID=<team id> build/build-ios.sh device` succeeds using the existing Personal Team; nothing about the team is committed.
- The app is installed on the paired iPhone (Xcode or `xcrun devicectl`) and opens without Metro.
- The separate M0 app and its data on the phone are untouched.

Out of scope: any on-device testing beyond launching (T-042); push, TestFlight or App Store distribution; CI signing.
Decisions resolved: none needed. Done with the Personal Team already in Xcode on this Mac (see the WORKLOG entry).
Likely areas touched: none in the repository unless the build exposes a defect; a unique local bundle identifier if `dev.findmyperson.app` is unavailable to the team (`FMP_IOS_BUNDLE_ID`).
How to verify: the app icon is on the phone and opens to onboarding.

### T-043 [x] Settings guide in place of the dead Allow Always button (iOS)

Goal: On iOS, once the one-time Always upgrade prompt has been used, or location was denied, the permission screen shows a written Settings guide instead of an Allow Always button that cannot work.
Acceptance criteria:

- The `upgrade` stage shows Allow Always only while the prompt is unused; the first `request('background')` on iOS records it in `kv` (`iosAlwaysPromptUsed`), and it is read on mount.
- Used prompt, `limited` and iOS `denied` show the six-step guide with the real labels and an Open Settings button; the "iOS did not change the setting" banner is gone on iOS; Android is unchanged.
- Returning from Settings with Always moves the stage to `complete` by itself.
- Tests: an honest fake (iOS asks once), and the reproduction, remembered, return and denied cases; `pnpm check` passes.

Out of scope: the native module, its spec and contracts; a Settings.bundle; `App-prefs` links; Android; building or installing on the phone (T-044).
Decisions resolved: none needed (option B of the investigation, which the captain approved).
Likely areas touched: `app/src/permissions/`, `app/src/store/DataStoreContext.tsx`, `packages/shared/src/store/tables/kv.ts`, `packages/native-location-capture/src/fake.ts`.
How to verify: the "Verify on the phone" section of the WORKLOG entry, after T-044; until then the tests in `app/src/permissions/__tests__/permissions.test.tsx`.

- [x] Verified on the phone: met by T-045 (steps 1 to 4; step 5 not run).

### T-044 [x] Signed build with the T-043 fix installed on the captain's iPhone, for the captain to verify

Goal: The captain's iPhone runs a signed build that contains the T-043 guide, so the captain can follow "Verify on the phone".
Acceptance criteria: the build is installed over the existing app and launches (as T-041). The captain's per-step results are T-045 (recorded below).
Out of scope: fixing what fails (new tasks).
Decisions resolved: none needed.
Likely areas touched: none in the repository unless the build exposes a defect.
How to verify: the captain's results.

### T-045 [x] Captain verified the Always guide on the real iPhone

Goal: The project's record shows that T-043's fix was verified by the captain on a real iPhone, and what remains unverified.
Result (2026-10-09): the captain ran "Verify on the phone" (WORKLOG, T-044 entry) on an iPhone 13, iOS 17.5.1, with the signed build from T-044 (main at the T-043 merge), and reported: "everything works".

- Steps 1 to 4 (Capture health card with "Allow location all the time"; the "Turn on Always in Settings" guide replacing the Allow Always button; the guide showing straight away after leaving and after force-quit and reopen; following the guide through Settings, Privacy & Security, Location Services, findmyperson, Always, and returning with the screen updating by itself): reported working. Only that summary was reported, no per-step detail.
- Step 5 (Don't Allow on the first iOS question; needs delete and reinstall): not run.

Out of scope: any code, build or device action.
Decisions resolved: none needed.
Likely areas touched: `docs/` only.
How to verify: this entry and the WORKLOG entry for T-045.

- [ ] **Suggestion, not a task (untested): add a minimal `Settings.bundle` so Open Settings lands on the app's own page.** From the investigation's option E: Apple DTS's workaround for apps with no Settings page. Not built and not proven on this phone. Non-blocking: the guide works without it, as the phone verification (T-045) showed.

### T-042 [ ] Real-phone testing against the checklist in `m0/ios/README.md`

Goal: Record what the app actually does on a real iPhone, item by item. Done by the captain, with the app from T-041.
Acceptance criteria: each result names device, OS, build, timestamp and observed rows or errors, for these behaviours that nothing so far has verified:

- Launch with Metro unavailable, and the three bundled fonts rendering.
- The permission paths: denied, When In Use, Always, approximate-only, and returning from Settings; the visible health matches the real conditions. (Observed in T-045 on an iPhone 13, iOS 17.5.1: While Using, then Always via Settings, and returning from Settings with the screen updating by itself. Still unverified: denied, approximate-only, and the visible health against other real conditions.)
- Capture in the background and with the phone locked after first unlock, native fixes landing, and JavaScript reading the same encrypted rows (native-first and JavaScript-first start-up, one key and one path).
- Pause and resume, and capture A, stop, delete all data, resume, capture B in the same process: JavaScript sees only B and the old key refuses the new file.
- Device and report ids and cover state coming from `SecRandomCopyBytes`, not a debugger-injected source.
- Visits and stay reconciliation, recovery after restart and before first unlock, Low Power Mode, Background App Refresh off, termination and movement, and a longer untouched capture.
- That the Keychain key and backup exclusion behave as the store package's README expects after a reboot.

Out of scope: fixing what fails (new tasks from the results); API/CDN-dependent behaviour (origins and trusted keys are unset).
Decisions resolved: none needed.
Likely areas touched: `m0/ios/README.md` (results recorded there or in `docs/WORKLOG.md`).
How to verify: the recorded results; every item is either observed or listed as failed.

## Done

### Onboarding

#### T-000 [x] Adopt the working rules and write the record documents

Goal: Bring the project onto the working rules so the captain can see what was decided, done, left and waiting on them.
Acceptance criteria:

- `AGENTS.md` carries the working rules and a coding-style section; its existing content is unchanged.
- `docs/DECISIONS.md` is in the D-XXX format with no entry lost, and every inferable unrecorded decision is added as Proposed.
- `docs/ARCHITECTURE.md` is checked against `main` and corrected, not rewritten.
- `docs/PLAN.md`, `docs/TASKS.md` and `docs/WORKLOG.md` exist; TASKS has a "Needs you" section.

Out of scope: any code, dependency or CI change; recutting the milestone plan; proposing or queueing new feature work; the uncommitted changes in the main local copy.
Decisions resolved: none needed (it proposes D-052 to D-062).
Likely areas touched: `AGENTS.md`, `docs/`.
How to verify: `git diff --stat main...HEAD` shows only those files; `pnpm format:check` passes; open `docs/TASKS.md`.

### Research on real phones

#### T-001 [x] M0: capture log format and analyser

Goal: Define the capture log format v1 and a log analyser for the M0 trial.
PR: [#1](https://github.com/kathiroll/findmyperson/pull/1)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded
Likely areas touched: `m0/analyser`, `m0/docs`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-002 [x] M0: iPhone capture trial app

Goal: Build a native Swift trial app that logs background location capture on a real iPhone.
PR: [#2](https://github.com/kathiroll/findmyperson/pull/2)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded (evidence for D-012)
Likely areas touched: `m0/ios`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-003 [x] M0: Android toolchain env, README, gitignore

Goal: Make the Android toolchain for the trials reproducible from a script.
PR: [#3](https://github.com/kathiroll/findmyperson/pull/3)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none needed
Likely areas touched: `m0/env.sh`, `m0/README.md`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-004 [x] M0: Android capture trial app

Goal: Build a native Kotlin trial app with WorkManager and foreground-service capture modes.
PR: [#4](https://github.com/kathiroll/findmyperson/pull/4)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded (evidence for D-011)
Likely areas touched: `m0/android`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-005 [x] M0 iOS: remove the distance filter

Goal: Remove the distance filter on continuous location updates in the iOS trial.
PR: [#5](https://github.com/kathiroll/findmyperson/pull/5)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded (evidence for D-014)
Likely areas touched: `m0/ios`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-006 [x] M0 analyser: per-source gaps, relaunch recovery, BOM tolerance

Goal: Extend the analyser to report per-source gaps and relaunch recovery.
PR: [#6](https://github.com/kathiroll/findmyperson/pull/6)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none needed
Likely areas touched: `m0/analyser`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-007 [x] M0 store proof (S0.4)

Goal: Prove native Kotlin and Swift writes and TypeScript reads of one SQLCipher file.
PR: [#7](https://github.com/kathiroll/findmyperson/pull/7)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-018
Likely areas touched: `m0/store-proof`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

### Foundation

#### T-008 [x] Wave 0: pnpm workspace, shared tooling and CI

Goal: Set up the pnpm workspace, strict TypeScript, ESLint, Prettier, Vitest and CI.
PR: [#8](https://github.com/kathiroll/findmyperson/pull/8)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-001, D-002, D-003, D-004
Likely areas touched: root config, `.github/workflows/ci.yml`, empty package shells
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-009 [x] Build pipelines (F1.2)

Goal: Provide one build path for Android APK/AAB and iOS archive, locally and in CI.
PR: [#9](https://github.com/kathiroll/findmyperson/pull/9)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-006
Likely areas touched: `build/`, `.github/workflows/build.yml`, `docs/BUILDING.md`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-010 [x] App design system

Goal: Build the v2 theme tokens, primitives, animations and catalogue.
PR: [#10](https://github.com/kathiroll/findmyperson/pull/10)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-017
Likely areas touched: `app/src/design-system`, `app/assets/fonts`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-011 [x] Shared contracts

Goal: Define the broadcast payload, signing, geometry, store schema, API shapes and identity seam in one package.
PR: [#11](https://github.com/kathiroll/findmyperson/pull/11)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-019, D-020, D-028, D-032, D-033, D-036, D-041, D-048, D-049, D-050, D-051
Likely areas touched: `packages/shared`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-012 [x] Backend skeleton

Goal: Build report intake, the manual-review gate and the response relay.
PR: [#12](https://github.com/kathiroll/findmyperson/pull/12)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-039, D-040, D-043
Likely areas touched: `server/src`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-013 [x] Native location capture spec

Goal: Define the Turbo Module interface for capture, its codegen config and an in-memory fake.
PR: [#13](https://github.com/kathiroll/findmyperson/pull/13)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-008, D-009, D-010
Likely areas touched: `packages/native-location-capture`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-014 [x] App shell (F1.5)

Goal: Build the navigation graph, tab bar, deep links and placeholder screens.
PR: [#14](https://github.com/kathiroll/findmyperson/pull/14)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-016
Likely areas touched: `app/src/navigation`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

### Capture and the on-device store

#### T-015 [x] iOS capture module

Goal: Implement the capture spec in Swift with a state machine, Core Location adapters and tests.
PR: [#15](https://github.com/kathiroll/findmyperson/pull/15)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-012, D-013, D-014, D-061
Likely areas touched: `packages/native-location-capture/ios`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-016 [x] Android capture module

Goal: Implement the capture spec in Kotlin with WorkManager and foreground-service modes.
PR: [#16](https://github.com/kathiroll/findmyperson/pull/16)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-011, D-013, D-014, D-061, D-062
Likely areas touched: `packages/native-location-capture/android`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-017 [x] Encrypted store (C2.3)

Goal: Provide migrations, key management, backup exclusion and the native writer on both platforms.
PR: [#17](https://github.com/kathiroll/findmyperson/pull/17)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-018, D-019, D-021, D-022, D-023
Likely areas touched: `packages/encrypted-store`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-018 [x] Permission flow (C2.6)

Goal: Build the staged location-permission asks, the Play disclosure and the denied and degraded states.
PR: [#18](https://github.com/kathiroll/findmyperson/pull/18)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded
Likely areas touched: `app/src/permissions`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-019 [x] Onboarding and Settings screens

Goal: Build onboarding, pause and resume, the retention explainer and delete-all-data.
PR: [#19](https://github.com/kathiroll/findmyperson/pull/19)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded
Likely areas touched: `app/src/onboarding`, `app/src/settings`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-020 [x] Capture health (C2.7)

Goal: Show capture status on Home and a diagnostics screen from `getStatus` and `getDiagnostics`.
PR: [#20](https://github.com/kathiroll/findmyperson/pull/20)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none recorded
Likely areas touched: `app/src/capture-health`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-021 [x] Stay derivation (C2.4)

Goal: Extract stay points from stored fixes, reconcile CLVisit rows and run restart-safely.
PR: [#21](https://github.com/kathiroll/findmyperson/pull/21)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-026
Likely areas touched: `packages/shared/src/stay`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-022 [x] Shard compiler (B3.4)

Goal: Compile signed res-5 and res-3 bundles and an index from released reports.
PR: [#22](https://github.com/kathiroll/findmyperson/pull/22)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-030, D-031
Likely areas touched: `server/src/shards`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-023 [x] Retention purge (C2.5)

Goal: Purge history older than 30 days from the store's maintenance hook, with a gated weekly VACUUM.
PR: [#23](https://github.com/kathiroll/findmyperson/pull/23)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-025
Likely areas touched: `packages/shared/src/retention`, `packages/encrypted-store`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-024 [x] Server entries run under plain Node

Goal: Bundle the server entries with esbuild so the documented run command works.
PR: [#24](https://github.com/kathiroll/findmyperson/pull/24)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-047
Likely areas touched: `server/build.mjs`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-025 [x] Retention triggers

Goal: Run maintenance at app start and foreground, add a native charging/idle getter and purge on capture wakes.
PR: [#25](https://github.com/kathiroll/findmyperson/pull/25)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-025
Likely areas touched: `app/src/store`, `packages/native-location-capture`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

### Distribution, matching and the reporter side

#### T-026 [x] Bundle fetcher (B3.6)

Goal: Fetch verified shard bundles into `report_cache`, padded to a constant request count.
PR: [#26](https://github.com/kathiroll/findmyperson/pull/26)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-037
Likely areas touched: `packages/shared/src/fetch`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-027 [x] Matching engine (M5.1)

Goal: Build the pure `matchReport` rule, its golden vectors, the anti-oracle grid and an offline recall and false-positive harness.
PR: [#27](https://github.com/kathiroll/findmyperson/pull/27)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-026, D-027, D-029
Likely areas touched: `packages/shared/src/match`, `server/src/harness`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-028 [x] Report submit screen (R4.1)

Goal: Build the validated report form with a thumbnail, an offline queue and pending-review copy.
PR: [#28](https://github.com/kathiroll/findmyperson/pull/28)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-042, D-056
Likely areas touched: `app/src/report`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-029 [x] Shard publishing to Cloudflare R2

Goal: Implement the object-store and cache-purge interfaces for Cloudflare R2.
PR: [#29](https://github.com/kathiroll/findmyperson/pull/29)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-038
Likely areas touched: `server/src/shards/r2.ts`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-030 [x] Report fetch trigger

Goal: Add the wake trigger, Ed25519 verification for Hermes and a native metered-connection getter.
PR: [#30](https://github.com/kathiroll/findmyperson/pull/30)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-034, D-035, D-060
Likely areas touched: `app/src/fetch`, `packages/native-location-capture`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-031 [x] Android: one SQLCipher

Goal: Make Kotlin use op-sqlite's SQLCipher through a JNI shim and remove Zetetic's library.
PR: [#31](https://github.com/kathiroll/findmyperson/pull/31)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-024
Likely areas touched: `packages/encrypted-store`, `build/`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-032 [x] Docs: ARCHITECTURE.md and DECISIONS.md

Goal: Write the architecture map and the decisions reading aid.
PR: [#32](https://github.com/kathiroll/findmyperson/pull/32)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: none needed
Likely areas touched: `docs/`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-033 [x] Android app project

Goal: Add `app/android` from the RN 0.87 template, autolink the native modules and build a debug APK in CI.
PR: [#33](https://github.com/kathiroll/findmyperson/pull/33)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-055
Likely areas touched: `app/android`, `docs/BUILDING.md`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-034 [x] Report form: typed coordinates

Goal: Let the reporter type or paste coordinates for the location step.
PR: [#34](https://github.com/kathiroll/findmyperson/pull/34)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-056
Likely areas touched: `app/src/report`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-035 [x] Operator page

Goal: Serve `/operator` for review of pending reports and held tips, behind a one-token stub.
PR: [#35](https://github.com/kathiroll/findmyperson/pull/35)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-057
Likely areas touched: `server/src/operatorPage.ts`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-036 [x] Home screen and hamburger menu

Goal: Build Home per the v2 mockups, remove the tab bar and put Settings in the menu.
PR: [#36](https://github.com/kathiroll/findmyperson/pull/36)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-054
Likely areas touched: `app/src/home`, `app/src/navigation`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-037 [x] Reports carry up to two photos

Goal: Change `person.photo` to `person.photos`, capped at two.
PR: [#37](https://github.com/kathiroll/findmyperson/pull/37)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-032
Likely areas touched: `packages/shared`, `app/src/report`, `server/src`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-038 [x] Subscription manager

Goal: Keep the watch list equal to the last 30 days of history, capped and coarsened.
PR: [#38](https://github.com/kathiroll/findmyperson/pull/38)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-058
Likely areas touched: `packages/shared/src/subscription`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

#### T-039 [x] Match runner

Goal: Match cached reports against the phone's history on every wake, at most once per report.
PR: [#39](https://github.com/kathiroll/findmyperson/pull/39)
Acceptance criteria: not reconstructed; the pull request and the tests it merged into `main` are the record.
Out of scope: not recorded.
Decisions resolved: D-059
Likely areas touched: `packages/shared/src/match`, `app/src/store`
How to verify: the pull request's checks; the tests and READMEs it added are on `main`.

### The iOS app

#### T-040 [x] Land the iOS project and native wiring

Goal: The iOS project and native wiring written by an earlier Codex session are on a branch as one pull request, building to a verified unsigned archive.
Acceptance criteria:

- The source changes are on current `main` (the working rules and the match runner already landed), with `AGENTS.md`'s working rules and coding style intact.
- `pnpm check` passes.
- `build/build-ios.sh unsigned` produces the archive and `build/check-ios-archive.sh` passes on it.
- Docs updated: ARCHITECTURE, TASKS (T-041, T-042), DECISIONS (D-063 to D-067, Proposed, with a `[!]` item), WORKLOG.
- Generated output (`Pods`, `build`, archives), `.lavish/`, the recovery note and scratch documents, and the captain's own M0 project edits are not in the pull request.

Out of scope: signing, installing or running on any device; API/CDN origins and trusted keys; finishing the report/tip journey; an iOS CI job; changing native behaviour beyond reconciling with `main`.
Decisions resolved: none needed (it proposes D-063 to D-067).
Likely areas touched: `app/ios`, `app/index.js`, `app/src/random.ts`, `build/`, `packages/encrypted-store/ios`, `packages/native-location-capture/ios`, `docs/`.
How to verify: `git diff --stat main...HEAD`; the checks on the pull request; the archive verification output in its description.
