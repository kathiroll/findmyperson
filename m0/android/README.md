# M0 Android capture trial

A throwaway, native Kotlin app with one screen. It measures how well an Android phone captures location **in the
background** and writes a CSV log in the shared "M0 capture log format v1" (`m0/docs/log-format.md`). The log holds
**no coordinates, altitude, speed or address**, anywhere: the app reads a `Location`, keeps only its fix time and
accuracy, and drops the rest immediately.

The captain's question this answers: **is Mode 1 (WorkManager, no notification) good enough?** "A few times each hour"
is roughly the cadence the product needs. If Mode 1 delivers that on the Xiaomi and the OnePlus, we can skip the permanent
notification and the extra Google Play foreground-service declaration. Mode 2 (foreground service) is the reference to compare against.

No React Native, no third-party libraries: only androidx core, WorkManager and Google Play services location
(`FusedLocationProviderClient`). Package `dev.findmyperson.m0`, minSdk 26, targetSdk 35. The phone's Android version is
**not** hard-coded anywhere; every version-dependent branch checks `Build.VERSION.SDK_INT` at runtime.

## The two modes

| | Mode 1 `wm` | Mode 2 `fgs` |
|---|---|---|
| Mechanism | `PeriodicWorkRequest`, every 15 min (WorkManager's minimum) | Foreground service, `foregroundServiceType="location"`, `requestLocationUpdates` |
| Notification | none | permanent ("findmyperson test: recording capture health") |
| Per-sample source | `current` (`getCurrentLocation`, balanced accuracy, 30 s), else `last_known` (with its OLD fix time), else `none` | `updates` (one row per delivered location) |
| Rows | exactly one per run, including runs that got nothing | one per delivered fix (batched delivery can add several rows at once) |
| Location request | balanced power accuracy | balanced, interval 15 min, min distance 100 m, max delay 30 min |

Why the two are so different on Android: since Android 8 the OS computes a new location for a *background* app only a few times
per hour, and a foreground service with a visible notification is the documented way out. WorkManager's 15 minutes is a floor, not
a schedule: Doze and app-standby delay jobs. That gap is exactly what Mode 1 measures.

Note for reading the results: Mode 2 has a 100 m minimum distance. A phone lying still on a desk may deliver no updates for a long
time, which shows as a gap in `fgs` rows that is **not** a failure. Mode 1 samples on a timer and does not have that property. Compare
the two while keeping that in mind (this follows the brief; change `minUpdateDistanceMeters` in `CaptureService.kt` to compare without it).

Only one mode is active at a time. Switching logs `mode_changed:<wm|fgs|stopped>` then `capture_started` or `capture_stopped`.
The choice is stored in SharedPreferences, so it survives app restarts and reboots.

### Safety nets

- **Boot**: `BootReceiver` (BOOT_COMPLETED) restarts the selected mode and logs `boot_restart`. It also fires on `MY_PACKAGE_REPLACED`
  (`adb install -r`), logged as `boot_restart:package_replaced`. It does not use LOCKED_BOOT_COMPLETED: the log is in credential-protected
  storage, which cannot be written until the phone has been unlocked once after boot.
- **Watchdog**: an hourly WorkManager job, separate from the Mode 1 job so Mode 1 stays a clean measurement, active in both modes.
  It checks the selected mode is running (Mode 1: a queued or running job; Mode 2: the service is alive) and logs `watchdog_ok`, or
  `watchdog_restart` and starts it again. It is itself a WorkManager job, so Doze can delay it too.

## Staged permission flow (on the screen, top to bottom)

Each step has an in-app explanation, then the system action. Every step writes an event row.

1. **Foreground location** (fine or approximate): `perm_fg_prompt_shown`, then `perm_fg_granted` or `perm_fg_denied`. Approximate-only also logs `perm_fg_approx_only`.
2. **Background location** ("Allow all the time"): on Android 11 and later Android has no dialog for this, only the app's Settings page. The
   button opens it: `perm_bg_settings_opened`; when you come back the app re-checks and logs `perm_bg_granted` or `perm_bg_denied`.
3. **Notifications** (Android 13+, only while Mode 2 is selected): `perm_notif_prompt_shown`, `perm_notif_granted` / `perm_notif_denied`.
4. **Hibernation exemption** (androidx `PackageManagerCompat.getUnusedAppRestrictionsStatus` and `IntentCompat.createManageUnusedAppRestrictionsIntent`):
   `hibernation_prompt_shown`, then `hibernation_exempted` or `hibernation_declined`. Why: Android 11+ resets permissions and blocks all background work of apps not opened for
   some months, and running a background job does not count as opening the app.
5. **Battery optimisation exemption** (optional, `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`): `battery_opt_prompt_shown`, then `battery_opt_exempted` or `battery_opt_declined`.
   Sideloaded trial only: Google Play restricts apps that request this.

Any step can be skipped where optional (logged as `..._declined:skipped` or `perm_notif_denied:skipped`).
Capture can be started before permissions are granted; the `permission` column of each row says what the app had at that moment.

**OEM shortcuts**: buttons to the phone maker's autostart and battery screens (Xiaomi, OnePlus, Samsung) with a fallback to the app's Settings page. Brand is read from `Build.MANUFACTURER`.
The vendor screens are opened by internal component names that are not public API and were **not** verified on real phones. Logged as `oem_settings_opened:<which>`
(`which` is the vendor screen that opened, e.g. `miui_autostart`, or `fallback_app_details`).

## Status screen and export

Shows: active mode, permission state, whether capture is running, count of rows written, time of last row and last fix, battery, power-save, hibernation and
battery-optimisation state, and the last 20 rows. **Export log** (logs `export_tapped`) builds the file and opens the share sheet through a FileProvider.

### Log storage

- Rows are appended to `files/capture-rows.csv` in the app's private directory, one open-append-close per row, so a killed process cannot corrupt earlier rows.
- The three header lines are added when you export (the device line has the label and the UTC offset at export time). Export file name: `fmp-capture-android-<model>-<timestamp>.csv`.
- `label` (phone label, set on the screen, defaults to the model name) is how the analyser groups exports of one phone. Set it to e.g. `xiaomi-kartik` and `oneplus-kartik`.

### Events beyond the spec (none contain location; the analyser tolerates unknown names and ignores text after the colon)

| Event | Meaning |
|---|---|
| `perm_fg_approx_only` | foreground location granted, but only approximate |
| `perm_notif_prompt_shown`, `perm_notif_granted`, `perm_notif_denied` | POST_NOTIFICATIONS step (`perm_notif_denied:skipped` if skipped) |
| `battery_opt_prompt_shown`, `battery_opt_exempted`, `battery_opt_declined` | battery-optimisation step (`:skipped` suffix when skipped in the app) |
| `hibernation_declined:skipped` | user skipped the hibernation step |
| `oem_settings_opened:<which>` | the spec's `oem_settings_opened` plus which screen opened |
| `boot_restart:package_replaced` | the app was replaced (`adb install -r`) and the mode was restarted |
| `fgs_start_failed:<Exception>` | Android refused to start the foreground service (Android 12+ background start ban, or Android 14+ without location permission). This is data, not a bug |
| `fgs_updates_failed:SecurityException` | the service ran but location updates were refused for missing permission |

## Build

```
source m0/env.sh        # from the toolchain PR; or:  source ~/.fmp-m0-env.sh   (Java 17, Android SDK)
cd m0/android
./gradlew assembleDebug testDebugUnitTest lintDebug
```

APK: `m0/android/app/build/outputs/apk/debug/app-debug.apk`. The Gradle wrapper is committed (Gradle 8.9). Build output is git-ignored.
Unit tests are JVM only (row formatting, permission and mode mapping, log writer, setup order, brand detection). Nothing here runs on an emulator.

## Install on the phones (captain's checklist)

### One-time phone setup

**OnePlus**
1. Settings > About device > Version > tap **Build number** seven times, enter the PIN. "You are now a developer".
2. Settings > System settings (or "Additional settings") > **Developer options** > turn on **USB debugging**.
3. Plug in the cable. On the phone choose "File transfer" if asked. Tap **Allow** on "Allow USB debugging?" (tick "Always allow from this computer").

**Xiaomi** (menu names differ between MIUI and HyperOS; the labels below are what I would expect, not verified)
1. Settings > About phone > tap **Build number** seven times; if there is no Build number, tap **MIUI version** or **OS version** seven times instead.
2. Settings > Additional settings > **Developer options** > turn on **USB debugging**.
3. In the same screen turn on **Install via USB** and **USB debugging (Security settings)**. Xiaomi may ask you to sign in to a Mi account and may require a SIM in the phone before it lets you switch these on.
4. Plug in the cable, choose "File transfer" if asked, tap **Allow** on the USB debugging prompt.
5. If `adb install` later says `INSTALL_FAILED_USER_RESTRICTED`, "Install via USB" is still off. Also, an on-phone "install app" security prompt may appear: accept it.

### Install

```
adb devices                      # must list your phone as "device", not "unauthorized"
adb -s <serial> install -r m0/android/app/build/outputs/apk/debug/app-debug.apk
```
With both phones plugged in, `-s <serial>` (serial from `adb devices`) picks the phone. Record the model and Android version from Settings > About phone in your notes;
the app logs them in the export header.

### First run, in this order

1. Open **FMP M0 capture**. Type a label (`xiaomi-kartik` or `oneplus-kartik`), tap **Save label**.
2. Pick the mode: Xiaomi starts on **Mode 1**, OnePlus starts on **Mode 2** (see the 14 day plan).
3. Follow the step box: foreground location (choose **Precise** and **While using the app**), then background (Settings > Permissions > Location > **Allow all the time**),
   then notifications (Mode 2 only), then the hibernation page (turn off "Pause app activity if unused"), then optionally the battery-optimisation prompt (choose **Allow**).
4. Tap the **OEM shortcut** buttons. On Xiaomi: turn **Autostart** on for this app, and in Battery set it to **No restrictions**. On OnePlus: allow **Auto launch** / background activity, and set battery usage to **Don't optimise** / "Allow background activity". If a button just opens the app info page, the vendor screen did not resolve: go there by hand.
5. Confirm the status box shows `Capture running: yes`, then check that rows appear (Mode 1 writes the first row immediately).

## Cable tests (do for BOTH modes on BOTH phones)

Set the mode in the app first. Rows are the evidence: use **Export** or `adb pull` afterwards and read the rows around the test time. Package: `dev.findmyperson.m0`.

Useful before starting: `adb shell dumpsys jobscheduler | grep -B2 -A12 dev.findmyperson.m0` lists the app's jobs with ids and state; `adb shell cmd jobscheduler run -f dev.findmyperson.m0 <jobId>` runs one now.

- [ ] **Forced Doze**, mode `wm`, then again for mode `fgs`:
  ```
  adb shell dumpsys battery unplug          # tell the phone it is on battery, Doze needs that
  adb shell dumpsys deviceidle force-idle
  adb shell dumpsys deviceidle get deep     # expect IDLE
  ```
  Turn the screen off, wait 30 minutes, then:
  ```
  adb shell dumpsys deviceidle unforce
  adb shell dumpsys battery reset
  ```
  Expect (Mode 1): few or no `current` rows while idle, a burst or `last_known` / `none` rows after. Expect (Mode 2): `updates` rows keep arriving only if the phone moved 100 m; a foreground service is exempt from most Doze throttling but not necessarily from Doze on every vendor build. Write down what happened.
- [ ] **Forced App Standby** (the app is treated as unused), each mode:
  ```
  adb shell am set-inactive dev.findmyperson.m0 true
  adb shell am get-inactive dev.findmyperson.m0             # expect: Idle=true
  adb shell am set-standby-bucket dev.findmyperson.m0 rare  # also try: restricted
  adb shell am get-standby-bucket dev.findmyperson.m0
  ```
  Wait at least an hour (two 15-minute Mode 1 slots plus the hourly watchdog), then reset:
  ```
  adb shell am set-inactive dev.findmyperson.m0 false
  adb shell am set-standby-bucket dev.findmyperson.m0 active
  ```
- [ ] **Reboot**, each mode:
  ```
  adb reboot
  ```
  Unlock the phone once (do not open the app). Within a few minutes expect a `boot_restart` event and capture rows again (Mode 2: the notification returns). If not, record whether Xiaomi/OnePlus "Autostart" was on.
- [ ] **72 hours untouched**, each mode: unplug the cable, use the phone as normal but **never open the app**, keep the phone on the charger overnight only as you normally would. After 72 hours export and check the rows and `watchdog_ok` / `watchdog_restart` events.

### Forcing app hibernation from adb

Not verified: no phone was available. On Android 11+ there is a system service for it and, from memory of the AOSP source, these commands should exist:
```
adb shell cmd -l | grep -i hibernation                              # is the service present on this phone?
adb shell cmd app_hibernation get-state dev.findmyperson.m0
adb shell cmd app_hibernation set-state dev.findmyperson.m0 true    # hibernate now (false to undo)
```
If `cmd app_hibernation` is not present (vendor build or old Android), the unavailable fallback is: Settings > Apps > this app > "Pause app activity if unused" (that is the toggle the exemption step turns off), and `adb shell am force-stop dev.findmyperson.m0` as a *harsher* stand-in (a force-stopped app runs nothing, including WorkManager, until the user opens it again; hibernation behaves similarly). After hibernating, watch whether Mode 1 rows and the watchdog resume by themselves, and whether permissions were reset (the `permission` column drops to `denied`).

## 14 day plan

- Xiaomi: days 1 to 7 on **Mode 1**, swap on day 8 to **Mode 2**, days 8 to 14.
- OnePlus: days 1 to 7 on **Mode 2**, swap on day 8 to **Mode 1**, days 8 to 14.
- Doing the swap means each phone is measured in both modes, and each mode gets one week on a Xiaomi and on a OnePlus, so phone and mode effects are not mixed up.
- Days 1 and 8: run the cable tests above for the mode in use, then leave the phone alone. Use the phone normally, charge it as normal, do not open the app except at the exports below.
- Export **mid-trial** as well (day 3 or 4, and day 7 just before the swap) so a lost phone or a full reinstall does not lose the data. Day 7 export = end of the first mode; day 14 export = end of the second.
- Do NOT reinstall with `adb uninstall` in between: it deletes the log. `adb install -r` keeps it.

### How to export

- On the phone: **Export log** > share sheet > Drive, email, Files, or "Nearby Share". The same file is also saved in the app's folder.
- By cable:
  ```
  adb pull /sdcard/Android/data/dev.findmyperson.m0/files/exports/ ./exports/
  ```
  (unverified: some Android versions restrict reading `Android/data` even for adb; if it fails use the share sheet). The raw rows without header are at `files/capture-rows.csv` and can be read with
  `adb exec-out run-as dev.findmyperson.m0 cat files/capture-rows.csv` because the debug build is debuggable.
- Feed the exports to the analyser: `m0/analyser/README.md`.

## What I could NOT verify (no phone, no emulator)

The app builds, lints and passes its JVM unit tests. Nothing has been run on a device. Specifically unverified:

- Anything about actual capture: whether `getCurrentLocation` ever returns while the app is in the background on these phones, how stale `last_known` gets, how often Mode 1 actually runs.
- The vendor settings screens (Xiaomi Security / Power Keeper, OnePlus and OPlus/ColorOS Safe Center and Battery, Samsung Device Care): component names are the commonly reported ones and may not exist on the captain's ROM version. Fallback is the app's info page.
- Android version facts I did not check because the versions are not known yet: whether the "Allow all the time" Settings path has the exact wording above; whether a foreground service of type location may be started from the boot receiver or the watchdog on this Android version (Android 12+ restricts background starts, Android 15 changed boot-time rules; the app logs `fgs_start_failed:<reason>` if refused); whether `getUnusedAppRestrictionsStatus` reports `API_30`, `API_31` or `FEATURE_NOT_AVAILABLE` on each phone; whether the adb `Android/data` pull works.
- The `dumpsys deviceidle`, `am set-inactive`, `am set-standby-bucket` and `cmd app_hibernation` commands: written from documentation and memory, check each prints sane output before trusting a test.
- Xiaomi and OnePlus menu wording and the Mi account / SIM requirement for USB debugging (security).
- That the list of the last 20 rows and status text render well on the real screen sizes (plain views, no layout preview was possible).
