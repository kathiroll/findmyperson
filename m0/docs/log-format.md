# M0 capture log format v1

Shared contract for the analyser (`m0/analyser/`), the Android trial app and the iPhone trial app. The apps implement exactly this; if a real platform fact forces a deviation, keep the column set and meaning, note the deviation in the PR, and tell firstmate. Do not rename or repurpose columns.

Why a plain CSV: an export is one file the captain can move off the phone by any route (share sheet, adb pull, Files app), open in any editor, and diff by eye. No parser dependency, no database.

## The privacy rule (hard)

**No coordinates, no altitude, no speed, no bearing, no address, nothing derived from position, in any row, anywhere in the file or in the app's storage of this log.** The trial measures whether the phone woke up and got a fix, never where it was. The analyser refuses any file that has a column or value that looks like a coordinate (see the analyser README).

## File

- One UTF-8 CSV file per export, LF line endings, no quoting (no field contains a comma or newline; labels must be sanitised by the app).
- Line 1: `#fmp-capture-log,1` (the number is the schema version).
- Line 2: `#device,label=<free text set in the app or default model name>,platform=<android|ios>,model=<device model>,os=<os version>,app_build=<version code>,utc_offset_min=<minutes>`
  - `label` is how the analyser groups exports of the same phone. `utc_offset_min` is the phone's offset from UTC in minutes (India = `330`); the analyser uses it to decide where a day starts.
- Line 3: the header row, exactly:
  `kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event`
- Then one row per record.

## Rows

- `kind=S`: a capture attempt. One line per attempt, including attempts that got no fix.
- `kind=E`: an app event (adoption funnel and lifecycle). Sample-only columns are empty.

### Sample row (`kind=S`) columns

| column | meaning |
|---|---|
| `ran_at` | epoch milliseconds (UTC) when the job or callback ran |
| `fix_at` | epoch ms of the location fix time (Android `Location.getTime`, iOS `CLLocation.timestamp`). Empty if no fix. Comparing it with `ran_at` is how stale cached fixes are detected |
| `accuracy_m` | horizontal accuracy in metres, one decimal. Empty if no fix |
| `source` | Android: `current` (getCurrentLocation), `updates` (requestLocationUpdates callback), `last_known` (lastLocation cache), `none` (attempt got nothing). iOS: `continuous`, `slc` (significant-location-change), `visit_arrival`, `visit_departure`, `none` |
| `battery_pct` | integer 0-100 at `ran_at` |
| `charging` | `1` or `0` |
| `power_save` | `1` if the OS battery saver (Android) or Low Power Mode (iOS) is on, else `0` |
| `permission` | Android: `denied`, `foreground`, `background`. iOS: `denied`, `when_in_use`, `always`. Append `_approx` when only approximate / reduced-accuracy location is granted (e.g. `foreground_approx`) |
| `mode` | Android: `wm` (Mode 1, WorkManager, no notification) or `fgs` (Mode 2, foreground service). iOS: `ios_all` |
| `event` | empty for sample rows |

### Event row (`kind=E`) columns

`kind=E`, `ran_at` = event time (epoch ms UTC), `event` = one of the names below. Extra data after a colon is allowed, never location. All other columns empty.

`app_opened, perm_fg_prompt_shown, perm_fg_granted, perm_fg_denied, perm_bg_settings_opened, perm_bg_granted, perm_bg_denied, hibernation_prompt_shown, hibernation_exempted, hibernation_declined, oem_settings_opened, mode_changed:<mode>, capture_started, capture_stopped, boot_restart, watchdog_ok, watchdog_restart, export_tapped`

iOS may add `perm_always_prompt_shown, perm_always_granted, perm_always_denied`. Any new event names are allowed if documented here; the analyser tolerates unknown names.

## Analyser defaults

Owned by the analyser, listed so all three agree (each is a command-line flag there):

- usable sample = has a fix and `accuracy_m <= 100`
- stale fix = `ran_at - fix_at > 120000` ms
- gap = time between the fix times of consecutive fresh (not stale), usable samples
- reported per phone, per mode, per day (day boundary from `utc_offset_min`): capture rate (fresh usable samples / expected 15-minute slots), gap median, gap p95, longest gap, share of samples that are usable, share stale, battery drain in percent per hour computed only over spans where `charging=0`
- catch estimate for a stay: `min(1, stay_minutes / p95_gap_minutes)`, printed for 30 minutes
- adoption: furthest permission / hibernation step reached, from the event rows

## Worked example (Android, WorkManager mode)

```
#fmp-capture-log,1
#device,label=xiaomi-kartik,platform=android,model=Redmi Note 12,os=14,app_build=3,utc_offset_min=330
kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event
E,1758000000000,,,,,,,,,app_opened
E,1758000004000,,,,,,,,,perm_fg_prompt_shown
E,1758000009000,,,,,,,,,perm_fg_granted
S,1758000900000,1758000898500,18.0,current,81,0,0,background,wm,
S,1758001803000,1758001801200,22.5,current,80,0,0,background,wm,
S,1758002710000,1757990000000,35.0,last_known,80,0,0,background,wm,
S,1758003600000,,,none,79,0,1,background,wm,
```

Reading it: row 1 got a fresh 18 m fix 1.5 s before the job ran. Row 3 is a stale cache hit (fix is 12,710 s older than the run) so it counts as stale, not as capture. Row 4 got nothing (`source=none`, empty fix columns) and the phone was in battery saver.

## Worked example (iPhone)

```
S,1758000900000,1758000895000,65.0,slc,74,0,0,always,ios_all,
S,1758004200000,1758004199000,10.0,visit_arrival,73,1,0,when_in_use_approx,ios_all,
E,1758004300000,,,,,,,,,perm_always_prompt_shown
```
