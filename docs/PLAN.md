# Plan

What findmyperson is, what has been built and in what order, what is not built yet, and what it is deliberately not. This file is for the captain and for any agent starting a task. [TASKS.md](TASKS.md) says what is done and what is waiting on the captain; [DECISIONS.md](DECISIONS.md) says why; [ARCHITECTURE.md](ARCHITECTURE.md) says how it is put together.

T-000 wrote this file from the repository, as it stood at commit `88c8a6c` (2026-10-08, pull request #39). It does not set a new plan. **The M0 to M7 milestone plan itself is part of the architecture plan, which is kept outside this repository and was not seen when this was written.** What follows is derived from the READMEs, the code and the 39 merged pull requests, and the task IDs they cite. Milestone numbers are used only where the repository uses them (M0 and M5.1); nothing here says what M6 or M7 contain, because nothing in the repository does. How far to recut the milestone order is an open decision for the captain (see "Needs you" in [TASKS.md](TASKS.md)).

## What is being built

A non-commercial, open-source app (MIT licence) that broadcasts missing-person reports against on-device location history, so people who may have crossed paths with a missing person are told, and can choose to pass on what they know.

In one paragraph: each phone keeps 30 days of its own location history in an encrypted file that never leaves it. A person reports someone missing; a human reviews the report (and phones the reporter) before anything is published. Released reports go out as signed static files on a CDN, filed by region. Every phone downloads the reports for the regions it has been in and checks them against its own history, on the phone. A phone that matches shows a private notice, and only if its owner chooses to send a tip does the server hear from it. The server never learns who matched, and nothing about where a phone has been is uploaded.

The pieces, each with the folder that owns it:

| Piece                                      | What it does                                                                                                | Where                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Background capture                         | Records where the phone is, with no JavaScript running, on Android and iOS                                  | `packages/native-location-capture/`     |
| Encrypted store                            | One SQLCipher file holding the history, cached reports, matches and queues; key and file owned natively     | `packages/encrypted-store/`             |
| Shared contracts and pure logic            | Payload, signing, geometry, schema, stay derivation, matching, retention, fetching, watch list              | `packages/shared/`                      |
| The app                                    | Onboarding, permissions, capture health, settings, report form, home                                        | `app/`                                  |
| Report intake, review gate and tip relay   | Holds each report as pending until an operator releases it; relays one tip per device per report            | `server/` (`app.ts`, `lifecycle.ts`)    |
| Operator review                            | A page where the captain releases or rejects pending reports and held tips                                  | `server/src/operatorPage.ts`            |
| Shard compiler and publishing              | Turns released reports into signed bundles and an index, publishes them to object storage, purges the cache | `server/src/shards/`                    |
| Fetch, watch list, matching (on the phone) | Fetches the regions the phone has been in, padded so the CDN learns little, and matches them locally        | `packages/shared/` and `app/src/fetch/` |
| Builds                                     | Android debug APK on every pull request; iOS archive on `main` and tags once an iOS project exists          | `build/`, `.github/workflows/`          |

## What has been built, in the order it was built

This is the order of the merged pull requests (one task per pull request in [TASKS.md](TASKS.md)), grouped by what each stretch of work was for. The group names are this file's, not the plan's.

1. **Research on real phones (PRs #1 to #7, 2026-09-21 to 2026-10-03).** Trial apps and a log analyser that measured whether background location capture works, and a proof that Kotlin, Swift and op-sqlite can all open one SQLCipher file. The evidence behind the capture and store decisions. Code stays in `m0/`, outside the workspace.
2. **Foundation (PRs #8 to #14, 2026-10-03).** The pnpm workspace and CI, the build pipelines, the design system, the shared contracts, the backend skeleton with its manual-review gate, the native capture interface with an in-memory fake, and the app shell with navigation.
3. **Capture and the on-device store (PRs #15 to #21, #23 and #25, 2026-10-03 to 2026-10-04).** The iOS and Android capture modules, the encrypted store, the permission flow, onboarding and settings, capture health, stay derivation and 30-day retention, with the triggers that make each of them run.
4. **Distribution of reports (PRs #22, #24, #26, #29, #30 and #38, 2026-10-04 to 2026-10-05).** The shard compiler, making the server run under plain Node, the bundle fetcher with its padding, publishing to Cloudflare R2, the fetch trigger with Ed25519 verification on the phone, and the subscription manager that keeps the watch list.
5. **Matching (PRs #27 and #39).** The match rule, its golden vectors and the offline harness that measures recall and false positives; then the runner that applies it on every wake (#39, 2026-10-08).
6. **Reporter side (PRs #28, #34, #35, #37).** The report form with its durable offline queue, typed coordinates, the operator page for review, and up to two photos per report.
7. **Packaging and Home (PRs #31, #33 and #36, 2026-10-04 to 2026-10-05).** One SQLCipher inside the Android process, the Android project that builds an installable debug APK, and the Home screen per the v2 mockups with a hamburger menu.
8. **Documentation (PR #32 and T-000).** Architecture and decision records; then these working rules and the five record documents.

Task IDs that the repository cites for this work: `S0.x` (research spikes), `F1.x` (foundation), `C2.x` (capture and store), `B3.x` (broadcast of reports), `R4.x` (reporter), `M5.x` (matching).

## What is not built yet

This is the list the repository itself keeps in "Stubs and unfinished" in [ARCHITECTURE.md](ARCHITECTURE.md), summarised. It is not a task list and it carries no order: the order is an open decision, and the captain approves the next breakdown separately.

- **Nothing has run on a phone.** The Android debug APK builds in CI; nobody has installed it. There is no iOS project (it waits on an Apple developer team).
- **The app makes no network request yet.** The API address and the CDN origin and pinned signing keys are unset constants, so submit stays queued and fetch ends as "unconfigured". No server is deployed and no bucket exists.
- **What follows a match.** The runner writes `match` rows; no local notification is raised and the Bystander screen is a placeholder. The notification permission is not requested.
- **The bystander tip pipeline.** The server endpoint exists; the app never writes or sends a tip.
- **The reporter after submit.** `LiveReport` is a placeholder. The app never reads review state, edits, ends a report or reads tips.
- **Push.** No FCM or APNs code on either side; no wake topics, no "a tip arrived".
- **Report form seams.** No photo picker or resizer, no map picker (coordinates are typed).
- **Home and History.** Home's "If you're curious" list is placeholder text; History is an empty placeholder with no mockup.
- **Onboarding gate and capture-mode setting.** Onboarding is always the first screen; Settings cannot switch between the two Android capture modes.
- **Operator side.** Real operator authentication, a real alert channel, rate limits on reports, and re-review of a widening edit on a released report.
- **Operations.** No deployment, no policy page or abuse mailbox (placeholder links), a weekly `VACUUM` that stays off on Android until it is checked on a phone, and no scheduled purge when nothing wakes the app.

## Non-goals

What the project is not building, with where each comes from. "Stated" means the repository says so; "from the code" means the code behaves this way and nothing says it is meant to change. Anything here can be changed by the captain; an agent may not change it.

- **Not a commercial product.** No payments, advertising or revenue features. Stated: `README.md`; see [D-052](DECISIONS.md).
- **No accounts.** A device is a random id with no sign-in, no attestation and no phone verification. Stated: [D-044](DECISIONS.md), to be revisited only if the manual review step is removed or stops scaling.
- **No chat.** A bystander sends at most one tip per report; there is no conversation and no daily cap beyond that. Stated: [D-045](DECISIONS.md) and the product rule in `packages/shared`.
- **No location history leaves the phone, and the server never learns who matched.** No upload, no "reports near me" query, no server-side matching. Stated: [D-026](DECISIONS.md), [D-030](DECISIONS.md), [D-037](DECISIONS.md).
- **No broadcast without human review.** Nothing is published until an operator releases it, and app copy says "under review", never "live". Stated: [D-043](DECISIONS.md).
- **Matches are never "near you".** The phone also holds reports from cover shards, so no screen may present the cache as nearby reports. Stated: `AGENTS.md`, [D-037](DECISIONS.md).
- **No matching finer than 150 m and 30 minutes.** Criteria are read on that grid on purpose, so a reporter learns nothing from finer precision. Stated: [D-027](DECISIONS.md).
- **No narrowing of a published report.** Edits may only widen. Stated: [D-028](DECISIONS.md).
- **No end-to-end encrypted tips.** Tips are readable by the server so that links and payment requests can be held for review. Stated: [D-046](DECISIONS.md).
- **No analytics, crash reporting, advertising or other third-party SDK in the app.** From the code: [D-053](DECISIONS.md), proposed.
- **No simulators or emulators.** Claims about device behaviour come from source or build output, or are listed as unverified. Stated: `AGENTS.md`, [D-005](DECISIONS.md).
- **No shipping of the research trial apps.** `m0/` is evidence, not product. Stated: [D-004](DECISIONS.md).
- **Nothing outside the brief of a task.** No extra features, tooling, analytics, admin screens, simulations or generated datasets; no new dependency without approval. Stated: the working rules in `AGENTS.md`.
