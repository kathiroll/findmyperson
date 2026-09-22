# M0 iPhone capture trial

A throwaway, native Swift (UIKit, no dependencies, no React Native) app with one screen. It measures
how well an iPhone captures location **in the background** and writes a CSV log in the shared
"M0 capture log format v1" (owned by `m0/docs/log-format.md`). The log holds **no coordinates**: only
when a fix happened, how accurate it claimed to be, which source produced it, battery and permission state.

Target device: one iPhone 13. Deployment target is iOS 15.0 (the lowest the code allows: it uses
`CLLocationManager.authorizationStatus` / `accuracyAuthorization` instance properties, iOS 14+, and
`FileHandle.seekToEnd`, iOS 13.4+). The iOS version of the phone is not known yet and is not hard-coded anywhere.

## What the app does

| Source | iOS API | Log `source` | Written |
|---|---|---|---|
| Continuous | `startUpdatingLocation` + `allowsBackgroundLocationUpdates` + `pausesLocationUpdatesAutomatically = false`, accuracy 100 m, distance filter 50 m | `continuous` | at most one row per 15-minute wall-clock slot, at the first fix after the slot opens (comparable to Android's 15 min cadence) |
| Significant location change | `startMonitoringSignificantLocationChanges` | `slc` | every callback (rare, roughly per 500 m moved) |
| Visits | `startMonitoringVisits` | `visit_arrival`, `visit_departure` | every visit callback |
| Failed attempt | `didFailWithError` or an invalid fix | `none` | at most one per 15-minute slot |

Why three separate `CLLocationManager` objects: continuous and significant-change fixes arrive in the same
delegate method, so one manager could not say which source produced a fix.

Why capture is restarted on every launch: iOS never resumes `startUpdatingLocation` after the process
dies. The only things that relaunch a dead app are significant-change and visit events (and only with the
"Always" permission and Background App Refresh on). `AppDelegate.didFinishLaunching` runs on every such
launch and starts all three sources again.

Settings live in `App/CaptureController.swift` (`CaptureConfig`): 100 m accuracy and no distance filter
(`kCLDistanceFilterNone`). The trial measures gaps the platform imposes on its own, not how far the
phone physically moved, so a stationary phone must not manufacture an artificial gap that looks like a
platform failure. The app still downsamples to one row per 15-minute wall-clock slot.

### Permission flow

1. Button "Step 1 of 2": in-app explanation screen, then the *When In Use* system prompt (`perm_fg_prompt_shown`, then `perm_fg_granted` / `perm_fg_denied`).
2. Button "Step 2 of 2": explanation screen, then the *Always* upgrade prompt (`perm_always_prompt_shown`, then `perm_always_granted` / `perm_always_denied`). iOS shows this prompt only once. If refused, the button becomes "Open Settings to choose Always" (`perm_bg_settings_opened:always`).
3. Denied or restricted: button opens Settings (`perm_bg_settings_opened:denied`). Approximate location only: button opens Settings for Precise Location (`perm_bg_settings_opened:precise`); log rows carry `_approx` in `permission`.

### Status screen

Permission state, whether each of the three sources is active, rows written, time of last row and last fix,
Low Power Mode, Background App Refresh, battery, trial day and days until the free-provisioning expiry
(assumed to be first launch + 7 days; red warning from day 5), the Export button and the last 20 log rows.

### Log storage and export

- Rows are appended to `Documents/capture-rows.csv` (open, append one line, close, per row) with file protection
  `NSFileProtectionCompleteUntilFirstUserAuthentication`, so a background launch on a locked-but-already-unlocked-once phone can write.
  The file is excluded from iCloud/iTunes backup. Before the *first unlock after a reboot* no app file can be written; rows that fail are held in memory and flushed on the next append (lost if the app dies first).
- Export builds a temp file `fmp-capture-ios-<model>-<date>.csv` = the three header lines + the stored rows, and opens the share sheet. `export_tapped` is logged first.
- The `#device` line label is the model name (`iPhone`), model is the hardware id (`iPhone14,5` written as `iPhone14_5` because the format forbids commas), `utc_offset_min` is the offset at export time.

### Events beyond the spec (all documented here, none contain location)

`bg_relaunch:location` (iOS relaunched the app for a location event), `env:bg_refresh=<on|denied|restricted>;low_power=<0|1>` (at every launch and app open),
`capture_started:<sources>` / `capture_stopped:<sources>` (sources joined by `+`: continuous, slc, visit),
`boot_restart` (first launch after the kernel boot time changed), `perm_always_*` (as the spec allows),
`perm_bg_settings_opened:<always|denied|precise>`, `perm_accuracy:<reduced|full>`, `perm_changed:<from>_to_<to>` (permission changed in Settings).

### Deviations from log format v1 (column set and meaning unchanged)

- `battery_pct` is empty if iOS reports the level as unknown (-1); never seen on a real phone.
- Visit rows: `fix_at` is the visit's arrival (or departure) time and `accuracy_m` its horizontal accuracy. A visit has no fix timestamp; `ran_at - fix_at` therefore shows how late iOS reports it, and the analyser's stale-fix rule (>120 s) will classify visit rows as stale. That is correct: a visit is not a fresh sample. Look at the visit rows separately.
- `permission`: "not asked yet" and "restricted" are logged as `denied`.

## Build and install with a free Apple ID (one time)

Needs a Mac with Xcode 16.2, the iPhone, and a Lightning/USB-C cable. No Apple Developer account, no paid program.

1. Open `m0/ios/FindMyPersonM0.xcodeproj` in Xcode (double-click it).
2. In the left file list click the blue **FindMyPersonM0** project, then under TARGETS select **FindMyPersonM0**, then the **Signing & Capabilities** tab.
3. Xcode > Settings > Accounts: click **+**, add your Apple ID (once). Back on the tab, tick **Automatically manage signing** and set **Team** to *Your Name (Personal Team)*.
4. **Change the Bundle Identifier** in that same tab (field "Bundle Identifier") to something only you would pick, for example `com.yourname.fmpm0`. The default `dev.findmyperson.m0` may already be registered by another free account, which fails with "Failed to register bundle identifier". It is stored in the project file as `PRODUCT_BUNDLE_IDENTIFIER`.
5. Plug the iPhone into the Mac by cable. Unlock it. Tap **Trust** on the phone ("Trust This Computer?") and enter the passcode.
6. Enable Developer Mode on the phone (iOS 16 and later): Settings > Privacy & Security > Developer Mode > on, then restart when asked and confirm after restart. The switch only appears after Xcode has seen the phone once (step 5 and step 7 first). On iOS 15 there is no such switch.
7. At the top of Xcode pick the iPhone as the run destination (not a simulator) and press **Run** (the play button). The first build may take a minute; if Xcode says it needs to prepare the device, wait.
8. First launch fails with "Untrusted Developer": on the phone go to Settings > General > VPN & Device Management, tap your Apple ID under "Developer App", tap **Trust**, then press Run again (or open the app from the home screen).
9. The app opens. Tap **Step 1 of 2**, then in the system prompt choose **Allow While Using App**. Tap **Step 2 of 2**, then choose **Change to Always Allow**. Leave "Precise Location" on. The status screen should show `Permission: Always, precise` and Continuous / Sig-change / Visits `ACTIVE`.
10. Unplug and put the phone away. Do not force-quit the app on purpose, except in the planned test below. Xcode's debugger must not stay attached (it keeps the app alive artificially): after installing, press Stop in Xcode and start the app from the home screen.

## The 6-day plan

Free provisioning expires after 7 days, after which the app will no longer open. Day 1 is the install day (the app assumes first launch = install). Export on **day 6**.

| Day | Do |
|---|---|
| 1 | Install, grant permissions (steps above), leave the phone as you normally use it. Note the day-1 time. |
| 2 | Normal life: phone in pocket, screen locked, app not opened. Just look at the status screen once in the evening. |
| 3 | **Force-quit test.** Open the app, confirm rows are growing, then swipe the app away in the app switcher. Carry the phone at least 500 m (walk or ride), then open the app again. Expect a `bg_relaunch:location` event and an `slc` row from the moment of the move if iOS relaunched it. |
| 4 | **Low Power Mode.** Settings > Battery > Low Power Mode on for the whole day, normal use. Compare `power_save=1` rows. |
| 5 | **Reboot test** in the morning: restart the phone, unlock it once, do not open the app, carry on. Expect `boot_restart` after the first relaunch. Evening: **Background App Refresh off** for this app (Settings > General > Background App Refresh, or globally). Turn it back on at the end of the day. The status screen turns red from today: that is the expiry warning. |
| 6 | **Export.** Open the app, tap **Export log**, and in the share sheet choose AirDrop to the Mac, or Save to Files, or Mail. Check the CSV starts with `#fmp-capture-log,1`. Export again a few hours later if you like; each export contains the full log. |
| 7 | The app stops opening. Do not rely on day 7. |

Mid-trial exports are fine and encouraged (a safety net if something breaks).

## What is expected to be observed (hypotheses, not verified)

- **Backgrounded, phone locked, Always granted:** continuous rows keep appearing while the phone moves; while the phone is completely still the 50 m distance filter may suppress callbacks, giving gaps.
- **Force-quit:** continuous updates stop and stay stopped until iOS relaunches the app for a significant-change or visit event, which needs about 500 m of movement (or a visit). Expect a stretch with no rows after the force-quit, then `bg_relaunch:location` and rows again.
- **Low Power Mode:** iOS may reduce background activity and delay location callbacks; look for larger gaps on day 4.
- **Background App Refresh off:** the plan document says iOS then does not relaunch the app for any location event (significant change, visits, region monitoring) after it has been killed. Whether continuous updates of a still-running app are also affected is something this trial should show.
- **After a reboot:** nothing runs until the phone is unlocked once; then a relaunch by a location event should restart capture (`boot_restart`).
- Battery: iOS shows a location indicator while continuous updates run; drain is visible in the `battery_pct` series.

## Tests

The log format, writer and 15-minute slot logic are in `Sources/CaptureLog` (Foundation only) and are tested on the Mac:

```
cd m0/ios
swift test
```

The same three files are compiled into the app by the Xcode project, so the tests cover the exact code the phone runs. No simulator is used anywhere. Compilation for a real iPhone can be checked without Xcode's build system:

```
xcrun --sdk iphoneos swiftc -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios15.0 \
  -swift-version 5 -parse-as-library -wmo -module-name FindMyPersonM0 -o /tmp/fmp-check App/*.swift Sources/CaptureLog/*.swift
```

or, where Xcode's command line works: `xcodebuild -project FindMyPersonM0.xcodeproj -scheme FindMyPersonM0 -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`.

## Regenerating the Xcode project

`FindMyPersonM0.xcodeproj` is committed and ready to use. It is generated by `python3 tools/generate_xcodeproj.py` (no XcodeGen needed); run it only if you add or rename Swift files.

## What could NOT be verified without a phone

Everything about real behaviour: none of it ran on a device or simulator.

- Whether the app runs at all on the iPhone 13, and the iPhone's iOS version (the only iOS-version facts used are API availability from Apple's headers: instance `authorizationStatus`/`accuracyAuthorization` need iOS 14, so the minimum is iOS 15 here).
- Whether Xcode opens `FindMyPersonM0.xcodeproj` without complaints and signs it: the file was hand-generated and checked only as a valid property list with no dangling object references. On the machine that built this, `xcodebuild` could not start at all (Xcode's CoreSimulator plug-in fails to load; `xcodebuild -runFirstLaunch` would fix it and needs admin rights), so the compile check above used `swiftc` against the iPhoneOS 18.2 SDK, which type-checks and links an arm64 iOS executable without errors.
- Whether the Always upgrade prompt appears right after When In Use, and how the "Keep Only While Using" refusal is detected (no delegate callback fires; the app infers it when it becomes active again after the prompt).
- Whether significant-change and visit events relaunch the app after force-quit, reboot, Low Power Mode, or Background App Refresh off, and how long they take.
- Whether `.location` launch options are present on those relaunches (used for `bg_relaunch:location`).
- Whether separate `CLLocationManager` instances each keep receiving events while another is running continuously.
- Whether battery level has 1% granularity on the phone, and whether it reads correctly in a background launch.
- Whether the file can be written from a background launch while the phone is locked but unlocked once since boot, and the exact behaviour before the first unlock.
- Whether the visit callbacks contain usable arrival/departure dates and accuracy values in practice.
- That the 7-day expiry assumption (install = first launch) matches Xcode's provisioning profile dates.
