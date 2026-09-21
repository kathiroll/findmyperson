# M0 capture-log analyser

Turns exported capture logs (format in `m0/docs/log-format.md`) into a per-phone, per-mode, per-day capture-quality report. Python 3 standard library only.

```
python3 m0/analyser/fmp_analyse.py export1.csv export2.csv ... [--md out.md]
    [--usable-acc 100] [--stale-ms 120000] [--stay-min 30] [--slot-min 15] [--tz-from-file | --utc]
```

Try it without phones: `python3 m0/analyser/gen_sample_logs.py` regenerates the synthetic logs in `fixtures/` (two Android phones with different modes, one iPhone), then run the analyser on `m0/analyser/fixtures/*.csv`. Tests: `python3 -m unittest discover m0/analyser`.

## Input handling

- Exports are grouped by the `label=` in line 2. Several exports of one phone are concatenated and exact duplicate lines are dropped, so overlapping exports are fine.
- Days follow the phone's `utc_offset_min` (the first export's value is used for the whole phone). `--tz-from-file` is accepted for clarity and is the default; `--utc` switches to UTC days.
- A truncated last line (app killed mid-write) is ignored with a warning. Files with only events work (zero capture reported). Unknown event names are kept and listed.
- A file is rejected (exit code 2, message on stderr, nothing analysed) if line 1 is not `#fmp-capture-log,1`, the schema version is unknown, or the header row is not exactly the v1 header.
- **Coordinate refusal:** the analyser refuses, loudly, any file with a column or device key named like position data (lat, lon, altitude, speed, address ...) or any value with 4 or more decimals or `lat=`/`lon=` text. The trial must never record where a phone was; a refused file should be deleted, and the app that wrote it fixed.

## How to read each number

- **capture rate**: fresh usable samples / expected slots. Expected slots = time the phone was supposed to be capturing (from the first sample to the end of the export, per mode) divided by the slot length (15 min). Silent hours count as misses, which is the point. Above 100% means the mode samples more often than every 15 min (the foreground service does).
- **usable**: share of all sample attempts that have a fix with accuracy at or under 100 m.
- **stale**: share of all attempts whose fix was older than 120 s when the job ran (a cached location, not a real capture). Stale samples are excluded from capture rate and gaps.
- **gap**: minutes between fix times of consecutive fresh usable samples (same mode). Reported as median, p95 (linear interpolation) and longest. A gap counts toward the day it ends on.
- **battery drain**: percent per hour, only over spans between two consecutive samples that are both unplugged. Battery is an integer percent, so single days can be noisy; trust multi-day summaries.
- **catch estimate**: `min(1, stay_minutes / p95_gap_minutes)` for a 30 minute stay. A rough chance that at least one fresh fix lands inside a stay of that length. It is a rule of thumb, not a probability model.
- **adoption**: per phone, the furthest funnel step reached (opened, fg prompt, fg granted, background step, background granted, hibernation prompt, hibernation exempted) and the first time each event was seen. A step "reached" means the event was seen at least once.

## Decision reading (plain words)

The reliable gap is the p95 gap per phone and mode: 95 times out of 100 the phone is at most this long between fresh fixes.

- About 30 minutes or less: works as designed. A 30 minute stay is caught nearly every time.
- 30 to 60 minutes: weaker promise; ship anyway with an honest promise (a 30 minute stay is caught roughly half the time or more).
- Frequent multi-hour gaps: discuss before committing. The report flags this when any gap is over 2 hours.

These lines are the captain's proposal-level starting points, not decisions.
