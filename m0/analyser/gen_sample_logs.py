#!/usr/bin/env python3
"""Generate synthetic M0 capture logs (format v1) so the analyser can be tested without phones.

Usage: python3 m0/analyser/gen_sample_logs.py [outdir]   (default: m0/analyser/fixtures)
Deterministic (fixed seed). Writes no coordinates, matching the real format.
Phones: xiaomi-wm (Android, WorkManager, split into two overlapping exports), oneplus-fgs (Android,
foreground service then WorkManager), iphone-15 (iOS, all sources).
"""
import os
import random
import sys

HEADER = "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event"
START = 1757894400000  # 2025-09-15 00:00:00 UTC
MIN = 60000
HOUR = 60 * MIN
OFFSET = 330  # India, minutes


def local_hour(ts):
    return ((ts + OFFSET * MIN) % (24 * HOUR)) / HOUR


class Battery:
    """Drains at a constant rate; plugged in overnight (local 23:00-06:30)."""

    def __init__(self, pct, per_hour):
        self.pct, self.per_hour, self.t = float(pct), per_hour, START

    def at(self, ts):
        h = local_hour(ts)
        charging = h >= 23 or h < 6.5
        dt = (ts - self.t) / HOUR
        self.pct = min(100.0, self.pct + 25 * dt) if charging else max(1.0, self.pct - self.per_hour * dt)
        self.t = ts
        return int(self.pct), int(charging)


def S(ts, fix, acc, src, bat, ps, perm, mode):
    b, ch = bat.at(ts)
    return (ts, "S,%d,%s,%s,%s,%d,%d,%d,%s,%s," % (
        ts, "" if fix is None else fix, "" if acc is None else "%.1f" % acc, src, b, ch, ps, perm, mode))


def E(ts, name):
    return (ts, "E,%d,,,,,,,,,%s" % (ts, name))


def android_sample(rng, ts, bat, mode, perm, stale_p, none_p, poor_p, src_fresh):
    ps = 1 if rng.random() < 0.1 else 0
    r = rng.random()
    if r < none_p:
        return S(ts, None, None, "none", bat, ps, perm, mode)
    if r < none_p + stale_p:
        return S(ts, ts - rng.randint(5, 240) * MIN, rng.uniform(10, 60), "last_known", bat, ps, perm, mode)
    acc = rng.uniform(120, 500) if rng.random() < poor_p else rng.uniform(5, 60)
    return S(ts, ts - rng.randint(200, 20000), acc, src_fresh, bat, ps, perm, mode)


def xiaomi(rng):
    bat, rows, perm = Battery(90, 2.0), [], "background"
    for s, n in enumerate(["app_opened", "perm_fg_prompt_shown", "perm_fg_granted", "perm_bg_settings_opened",
                           "perm_bg_granted", "hibernation_prompt_shown", "hibernation_exempted",
                           "capture_started"]):
        rows.append(E(START + 8 * HOUR + s * 7000, n))
    t = START + 8 * HOUR + 60000
    end = START + 3 * 24 * HOUR
    kill_from, kill_to = START + 24 * HOUR + 10 * HOUR, START + 24 * HOUR + 14 * HOUR  # 4 h silent
    reboot = START + 48 * HOUR + 2 * HOUR
    while t < end:
        if kill_from <= t < kill_to:
            t = kill_to
            rows.append(E(t, "watchdog_restart"))
        elif abs(t - reboot) < 8 * MIN:
            rows.append(E(t, "boot_restart"))
            t += 95 * MIN
        else:
            rows.append(android_sample(rng, t, bat, "wm", perm, 0.15, 0.05, 0.08, "current"))
            t += (15 + rng.choice([0, 0, 1, 2, 5, 12])) * MIN
    rows.append(E(end + 5 * MIN, "export_tapped"))
    return "xiaomi-wm", "Redmi Note 12", "14", rows


def oneplus(rng):
    bat, rows = Battery(80, 3.0), []
    for s, n in enumerate(["app_opened", "perm_fg_prompt_shown", "perm_fg_granted", "perm_bg_settings_opened",
                           "perm_bg_granted", "hibernation_prompt_shown", "hibernation_declined",
                           "oem_settings_opened", "capture_started"]):
        rows.append(E(START + 9 * HOUR + s * 6000, n))
    t = START + 9 * HOUR + 60000
    end = START + 3 * 24 * HOUR
    switch = START + 2 * 24 * HOUR + 12 * HOUR
    mode, step = "fgs", 10
    while t < end:
        if mode == "fgs" and t >= switch:
            mode, step = "wm", 15
            rows.append(E(t, "mode_changed:wm"))
        rows.append(android_sample(rng, t, bat, mode, "background", 0.02 if mode == "fgs" else 0.1,
                                   0.01, 0.05, "updates" if mode == "fgs" else "current"))
        t += (step + rng.choice([0, 0, 0, 1])) * MIN
    rows.append(E(end + 2 * MIN, "export_tapped"))
    return "oneplus-fgs", "OnePlus 11", "14", rows


def iphone(rng):
    bat, rows = Battery(70, 1.5), []
    for s, n in enumerate(["app_opened", "perm_fg_prompt_shown", "perm_fg_granted", "perm_always_prompt_shown",
                           "perm_always_granted", "capture_started"]):
        rows.append(E(START + 7 * HOUR + s * 9000, n))
    t = START + 7 * HOUR + 60000
    end = START + 3 * 24 * HOUR
    while t < end:
        h = local_hour(t)
        if 0 <= h < 6:  # asleep and still: iOS delivers nothing for hours
            t += rng.randint(120, 300) * MIN
            continue
        src = rng.choice(["slc", "slc", "visit_arrival", "visit_departure", "continuous"])
        ps = 1 if bat.pct < 25 else 0
        if rng.random() < 0.04:
            rows.append(S(t, None, None, "none", bat, ps, "always", "ios_all"))
        else:
            acc = rng.choice([5.0, 10.0, 30.0, 65.0, 140.0, 1000.0])
            rows.append(S(t, t - rng.randint(1, 60) * 1000, acc, src, bat, ps, "always", "ios_all"))
        t += rng.randint(8, 150) * MIN
    return "iphone-15", "iPhone 15", "18.2", rows


def write(path, label, platform, model, os_ver, build, rows):
    rows = sorted(rows, key=lambda r: r[0])
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("#fmp-capture-log,1\n")
        fh.write("#device,label=%s,platform=%s,model=%s,os=%s,app_build=%d,utc_offset_min=%d\n"
                 % (label, platform, model, os_ver, build, OFFSET))
        fh.write(HEADER + "\n")
        for _ts, line in rows:
            fh.write(line + "\n")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "fixtures")
    os.makedirs(out, exist_ok=True)
    rng = random.Random(20250915)
    label, model, ver, rows = xiaomi(rng)
    cut = START + 24 * HOUR + 12 * HOUR
    write(os.path.join(out, "xiaomi_export1.csv"), label, "android", model, ver, 3, [r for r in rows if r[0] < cut + 24 * HOUR])
    # second export overlaps the first from day 2 onwards: the analyser must de-duplicate
    write(os.path.join(out, "xiaomi_export2.csv"), label, "android", model, ver, 3, [r for r in rows if r[0] >= cut])
    label, model, ver, rows = oneplus(rng)
    write(os.path.join(out, "oneplus.csv"), label, "android", model, ver, 3, rows)
    label, model, ver, rows = iphone(rng)
    write(os.path.join(out, "iphone.csv"), label, "ios", model, ver, 1, rows)


if __name__ == "__main__":
    main()
