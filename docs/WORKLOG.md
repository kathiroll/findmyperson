# Worklog

What was actually done and what came up, one entry per task. Append only: add new entries at the bottom and never edit an old one.

## 2026-10-08: T-000

- Onboarded the project onto the working rules. Read the code and docs without changing them, used the 39 merged pull requests to establish what is done, and wrote no code.
- Added the working rules and a coding-style section (adapted from ponytail, as the captain asked in a later message) to `AGENTS.md`, above the existing project notes, which were left as they were. `CLAUDE.md` is unchanged.
- Brought `docs/DECISIONS.md` into the D-XXX format: D-001 to D-051 are the 51 old entries, in their old order, none lost; the old "Status" line is kept as a `Source` field. Added D-052 to D-062, all Proposed and marked inferred from code.
- Checked `docs/ARCHITECTURE.md` against `main` at `88c8a6c` and corrected it in place: the commit it describes, the Home screen and tab-bar passages (now built), the operator page and its token, `response_reviews`, the Android project and SDK levels, the new folders, what `runMaintenance` does, and the pnpm layout row.
- Wrote `docs/PLAN.md` (with Non-goals), `docs/TASKS.md` (T-000 to T-039, a "Needs you" section with 13 `[!]` items and 7 candidates to remove) and this file.
- Files: `AGENTS.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/TASKS.md`, `docs/WORKLOG.md`, `docs/README.md`.
- Defaults taken:
  - Who decided the 51 older decisions, where nothing names them -> "Not recorded", Status `Accepted` (in force and documented) -> change the field per entry once the captain says who decided.
  - How to number T-001 to T-039 -> one per merged PR, task number equals PR number -> renumber in `docs/TASKS.md`.
  - What the repo's milestone names mean when the plan is not visible -> grouped the work by the task IDs the repository cites and named the groups myself in `docs/PLAN.md` -> replace the group list once the captain supplies the plan.
  - Acceptance criteria for the done tasks -> "not reconstructed" instead of inventing them -> fill in only if the captain wants them.
- Notes / questions raised:
  - The M0 to M7 milestone plan is outside the repository and was not seen; `docs/PLAN.md` says so and does not define M6 or M7. The detail of the recut question and the home-screen shortlist (and the Be My Eyes reference) are not in the repository either; the `[!]` items say so. -> "How far to recut" and "Home screen list" in `docs/TASKS.md`.
  - Found out of date and left alone, because T-000 only adds to `AGENTS.md` and its scope is the five record documents: the root `README.md` still says "pre-implementation"; `AGENTS.md`'s shard-compiler note still says the bucket and CDN adapters are not built (R2 landed in PR #29); `WORKSPACE.md` and `.npmrc` say the install is hoisted, but `AGENTS.md` and the installed tree say it is pnpm's isolated layout (D-001 carries a note). -> "Ratify the entries whose decider is not recorded".
  - D-038 (why R2) and D-040 (SQLite where the plan said Postgres) have no recorded approval; D-015 is inferred. All three are Proposed.
  - Attribution for the 51 older entries: where the repository or an addendum does not name who decided, the entry says "Not recorded" rather than guessing, and Status is `Accepted` meaning in force and documented, not asked.
  - Placeholders found, not changed: `CURIOUS_LINKS` on Home, `POLICIES_URL` and `ABUSE_CONTACT_URL`, `API_BASE_URL`, `REPORT_CDN_ORIGIN`, `REPORT_TRUSTED_KEYS`.
  - Nothing was run on a phone and the app was not built; no code, dependency or CI file changed, so the app builds as it did on `main`. `prettier --check` was run on every file written.

## 2026-10-08: T-040

- Landed the iOS project and native wiring an earlier Codex session wrote, as one pull request on top of current `main` (after #39 and #40). Took source only from the main local copy (read-only there): the tracked changes as a patch applied with a three-way merge (it applied cleanly; `AGENTS.md` got one new iOS project line, a note on the URL scheme and the reworded Android line, with the working rules and coding style untouched) and the new files copied across. The new files are `app/ios` (without generated `Pods/` and `build/`, which `.gitignore` already excludes), `app/src/random.ts` and its test, `build/check-ios-archive.sh`, and the capture module's `EncryptedCaptureStore.swift`, `StoreKeyValidation.swift`, `Tests/StoreIntegration` and `scripts/test-store-integration.sh`.
- Left out: `.lavish/`, `IOS_BUILD_CHECKPOINT.md` (its facts are below), `architecture_final.md`, `tasks_final.md`, and the captain's own edits to `m0/ios/FindMyPersonM0.xcodeproj` (`project.pbxproj`, `contents.xcworkspacedata`). `m0/ios/README.md` is in, because it is Codex's.
- Checked here: `pnpm check` passes (types, lint, format, 70 test files, 1,668 tests passed, 1 skipped). `build/build-ios.sh unsigned` finished with `ARCHIVE SUCCEEDED` (Xcode 16.2, iPhoneOS 18.2 SDK) and `build/check-ios-archive.sh` passes on the archive: arm64 only, Hermes bytecode, fonts, native modules, and SQLite/SQLCipher symbols owned by op-sqlite alone.
- What the checkpoint recorded as verified (by Codex, before this task): the Foundation capture suite (155 tests); the encrypted-store and capture contract and Mac-host suites (190 tests in 12 files); the arm64 iPhone-SDK compile check of the Swift, C, Objective-C and Objective-C++ (`check-ios.sh`); `test-store-integration.sh` on real host SQLCipher (capture A, stop, delete, rotate the key, resume, capture B; the reader sees only B and the old key is refused; native retention, visit trimming and cursor rewind), with the operating system and key storage faked; the app's random, fetch and report suites (117 tests); the full `pnpm check` (69 files, 1,633 tests); the unsigned archive and its checker. I re-ran `pnpm check` and the archive with its checker; I did not re-run the Swift suites or the store-integration script.
- Not verified, anywhere: signing and installation; launch without Metro on a phone; the three fonts rendering; the location permission paths (denied, When In Use, Always, approximate-only, back from Settings); capture in the background and while locked after first unlock; the native write being read by JavaScript from the same file; pause and resume; delete and resume on a phone; that ids come from `SecRandomCopyBytes` on a device; visits and stay reconciliation; recovery after a restart and before first unlock; Low Power Mode and Background App Refresh off. They are T-042. The report and tip journey is unfinished, and the API and CDN origins and trusted keys are unset, so the app makes no network request.
- Dependencies and architecture choices Codex made were not in `docs/DECISIONS.md`: logged as D-063 to D-067 (Proposed), with one `[!]` item. Two are new dependencies awaiting approval: `react-native-get-random-values` `^2.0.0` and `@react-native-community/cli-platform-ios` 20.2.0.
- Added T-041 (signed install, blocked by the team ID) and T-042 (phone testing, by the captain); corrected the "Apple developer team" item, since `app/ios` exists and only the team ID is missing; updated `docs/ARCHITECTURE.md` for the iOS structure.
- Files: `app/ios/**`, `app/index.js`, `app/package.json`, `pnpm-lock.yaml`, `app/src/random.ts`, `app/src/random.test.ts`, `app/src/fetch/random.ts`, `app/src/report/identity.ts`, `build/build-ios.sh`, `build/check-ios-archive.sh`, `.github/workflows/build.yml`, `.gitignore`, `AGENTS.md`, `packages/encrypted-store/**`, `packages/native-location-capture/**`, `m0/ios/README.md`, `app/assets/fonts/README.md`, `docs/`.
- Defaults taken:
  - Which `Podfile.lock` to commit -> the one `pod install` wrote during this build (one checksum, for `FindMyPersonEncryptedStore`, differs from the copy Codex left; the podspec had been edited since) -> rerun `pod install` in `app/ios` after any podspec change.
  - CocoaPods failed with an encoding error in this shell -> set `LANG=en_US.UTF-8` for the build only; nothing in the repository changed -> none.
  - Where the new tasks go in `docs/TASKS.md` -> a "Queued" section above "Done", and T-040 in a new "The iOS app" group -> move them.
  - Whether the `Podfile.lock` and `app/ios/.xcode.env` belong in the pull request -> yes (the template tracks both); `.xcode.env.local` and `xcuserdata` stay ignored (Codex's `.gitignore` lines) -> edit `.gitignore`.
- Notes / questions raised: the iOS CI job in `build.yml` still has never run (main and tags only); adding or changing CI is out of scope here. The `findmyperson://` URL scheme is registered in neither native project (`AGENTS.md` now says so for both). Signed install -> T-041; phone testing -> T-042.

## 2026-10-08: T-041

- Built a development-signed iOS app and installed and launched it on the captain's paired iPhone 13 (CoreDevice identifier `<device identifier from 'xcrun devicectl list devices'>`). The team ID went in through the environment only; no team, certificate, profile or Apple ID is in any tracked file. No code changed.
- Build: `LANG=en_US.UTF-8 FMP_IOS_TEAM_ID=<your team id> build/build-ios.sh device` -> `** BUILD SUCCEEDED **`, app at `app/ios/build/DerivedData/Build/Products/Release-iphoneos/FindMyPerson.app`. `codesign -dvv` shows `Identifier=dev.findmyperson.app`, `TeamIdentifier=<your team id>`, signed by the one "Apple Development" identity in the keychain.
- First install attempt, phone cabled but locked: `ERROR: The developer disk image could not be mounted on this device ... The operation failed since the device is locked. (kAMDMobileImageMounterDeviceLocked)`. Reported to firstmate as blocked, retried every 30 seconds; after the captain unlocked the phone:

```
xcrun devicectl device install app --device <device identifier> \
  app/ios/build/DerivedData/Build/Products/Release-iphoneos/FindMyPerson.app
...
Complete!
App installed:
  bundleID: dev.findmyperson.app
  installationURL: file:///private/var/containers/Bundle/Application/<uuid>/FindMyPerson.app/

xcrun devicectl device process launch --device <device identifier> dev.findmyperson.app
Launched application with dev.findmyperson.app bundle identifier.
```

- Afterwards `devicectl device info processes` listed `.../FindMyPerson.app/FindMyPerson` running (pid 6178), and `devicectl device info apps` still lists the M0 app (`dev.findmyperson.m0`) beside `dev.findmyperson.app`; the M0 app was not touched. Launch needed no trust step from the captain (the launch command returned success). What the app shows on screen was not observed: that is T-042.
- A Personal Team build expires after 7 days; rebuild and reinstall with the same two commands. Added to `docs/BUILDING.md` (which already had the commands and the 7 days): the device-id command, that the phone must be unlocked, and the `LANG` note.
- Files: `docs/TASKS.md`, `docs/WORKLOG.md`, `docs/BUILDING.md`.
- Defaults taken:
  - Which team -> the friend's paid team is not visible in this Mac's Xcode (only the Personal Team, with one valid Apple Development identity), so the Personal Team was used -> to switch, sign in to the paid team in Xcode and give its 10-character team ID as `FMP_IOS_TEAM_ID`. Kept as an optional `[!]` item in `docs/TASKS.md`.
  - Identifiers -> the team ID, team name, device name and device identifier are left out of this repository on purpose (it is public) and shown as placeholders -> put them back only in local notes.
  - Bundle identifier -> the default `dev.findmyperson.app` was accepted by the team -> set `FMP_IOS_BUNDLE_ID` otherwise.
  - CocoaPods encoding -> `LANG=en_US.UTF-8` for the build only -> none.
- Notes / questions raised: none; no defect found. Phone testing is T-042 (the captain's).

## 2026-10-09: T-043

- Fixed the iOS "Allow Always does nothing" dead end from the captain's phone test (investigation: option B, JavaScript only). iOS lets the app trigger its "Change to Always Allow" question once; after that the old screen kept an Allow Always button that could not work, with a wrong "iOS did not change the setting" banner. Now the first `request('background')` on iOS records "already asked" in `kv` (`iosAlwaysPromptUsed`, listed in `packages/shared/src/store/tables/kv.ts`), read on mount through two new `DataStore` methods (`getAlwaysPromptUsed`, `markAlwaysPromptUsed`). While unused, the button shows; once used (and in the iOS `denied` stage), a six-step guide ("Turn on Always in Settings", Privacy & Security, Location Services, findmyperson, Always) and an Open Settings button (`openSystemSettings('app')`) replace it. The `limited` stage shows the guide in place of "Allow all the time" once the prompt is used. Android flow and copy are unchanged. Return from Settings uses the existing foreground re-read; no new polling.
- The in-memory fake now behaves like iOS: a `background` request shows a prompt once, later ones show nothing (Android unchanged). Tests: `fake.test.ts` (both platforms) and `permissions.test.tsx` (reproduction, remembered across mount/unmount and a stored flag alone, return from Settings, limited, iOS denied); the old test that pinned the dead flow is replaced.
- Files: `app/src/permissions/{PermissionFlowScreen.tsx,usePermissionFlow.ts,__tests__/permissions.test.tsx}`, `app/src/store/DataStoreContext.tsx`, `packages/shared/src/store/tables/kv.ts`, `packages/native-location-capture/src/{fake.ts,fake.test.ts}`, `app/src/navigation/__tests__/navigation.test.tsx` and `app/src/settings/settings.test.tsx` (their `DataStore` fakes gained the two methods), `docs/`. Nothing in the native module, its spec or `contracts/` changed. `pnpm check` passes.
- Defaults taken:
  - Where the flag lives -> two named methods on `DataStore` over `kv`, rather than exposing the store -> replace with a field on `CaptureStatus` (investigation option C, a contract change).
  - `limited` on iOS -> the guide shows only once the prompt is used (an unused prompt still has a working "Allow all the time" path back to Allow Always) -> make it unconditional.
  - Store unreadable on mount (phone not unlocked) -> treated as "not used", so the button shows and pressing it records the flag again -> none.
  - The flag is set when the request is made, whatever iOS answers, because iOS ignores further calls either way -> none.
  - If the person deletes all data the flag goes with the store, while iOS still remembers; the button then shows once more and its tap is inert until it records again. Not handled -> would need the native flag (option C).
  - The Settings-unavailable notice on iOS reads "Settings could not be opened. Open the Settings app yourself and follow the steps above." -> change the string in `SettingsGuide`.
- On the captain's existing install the native "already asked" flag is set but the new stored flag is not, so the Allow Always button shows once more; tapping it brings the guide, and the guide stays from then on.
- Not verified on a phone: that Open Settings lands on the Settings list (the guide starts there), the iOS 15 name "Privacy", and that the screen updates by itself when the app is not relaunched by iOS after the change. Tests use the fake only.
- Notes: T-044 (signed build for the captain) added; a Settings.bundle suggestion recorded in `docs/TASKS.md` (untested).

## Verify on the phone

For the captain, on the iPhone 13 that already has the app (While Using allowed, iOS's one "Change to Always Allow" question already answered with "Keep Only While Using"). This needs the build from T-044; until then the tests are the only proof. Do each step in order.

1. **Open the app.** Home shows the Capture health card marked "Needs attention" with a button "Allow location all the time". _Success:_ that card and button are there. _If not:_ the card is missing or says "Working normally", which means location is already Always; nothing to fix.
2. **Tap "Allow location all the time", then look at the screen "Allow location 'all the time'".** On this install the button "Allow Always" may still be there once, because the new remembered flag is not set yet. If it is, tap it once. _Success:_ nothing pops up from iOS, the "Allow Always" button disappears and a block headed "Turn on Always in Settings" takes its place, with six numbered steps and an "Open Settings" button. _Wrong:_ the button stays, or a banner says "iOS did not change the setting" (that is the old, broken behaviour).
3. **Leave and come back.** Press the back arrow, then open "Allow location all the time" again. Then force-quit findmyperson (swipe it away in the app switcher), reopen it and open the same screen. _Success:_ both times the "Turn on Always in Settings" block is there straight away, with no "Allow Always" button, not even for a moment. _Wrong:_ the "Allow Always" button comes back.
4. **Follow the steps.** Tap "Open Settings". The Settings app opens, probably on its main list. Tap Privacy & Security, then Location Services, scroll to findmyperson and tap it, choose Always (leave Precise Location on), then switch back to findmyperson. _Success:_ without touching anything the screen changes to "All set" (or "Almost there" with a card for something else on the phone), and the "Turn on Always in Settings" block is gone. On Home the card reads "Working normally"; in the "Troubleshooting log" (Capture health, then Troubleshooting log) the line "Location permission: always" appears. _Wrong:_ the guide stays after you come back with Always chosen. Force-quit and reopen, and say whether it then updates. If Settings opened on a findmyperson page instead, tap Location, then Always, as the note under the steps says.
5. **Optional, needs a reset (delete the app and install it again, which clears its saved data).** Do onboarding and answer "Don't Allow" to the first iOS question. _Success:_ the screen "Location is turned off" shows the same six steps, ending "Choose While Using the App or Always", with an "Open Settings" button, and nothing about "Settings, then Apps". After you choose While Using the App or Always and come back, it moves on by itself. _Wrong:_ it mentions Apps, or has only a bare "Open settings" button.
