#!/usr/bin/env python3
"""Analyse M0 capture logs (format v1, see m0/docs/log-format.md).

Python 3 standard library only. Usage:
  python3 m0/analyser/fmp_analyse.py a.csv b.csv [--md out.md] [--usable-acc 100]
      [--stale-ms 120000] [--stay-min 30] [--slot-min 15] [--tz-from-file | --utc]
"""
import argparse
import re
import sys
from collections import OrderedDict, defaultdict, namedtuple
from datetime import date, timedelta

MAGIC = "#fmp-capture-log"
HEADER = "kind,ran_at,fix_at,accuracy_m,source,battery_pct,charging,power_save,permission,mode,event"
NCOLS = len(HEADER.split(","))
DAY_MS = 86400000

# Words that mean "position data". Any column or device key containing one is refused.
COORD_WORDS = {"lat", "lon", "lng", "long", "latitude", "longitude", "altitude", "alt",
               "speed", "bearing", "heading", "address", "geohash", "position", "location"}
# A number with 4+ decimals (metre-level or better degrees) in any field looks like a coordinate.
COORD_VALUE_RE = re.compile(r"\d\.\d{4,}")
COORD_KV_RE = re.compile(r"(?<![a-z])(lat|lon|lng|latitude|longitude)(?![a-z])\s*[=:]", re.I)

# Funnel order. Steps with the same rank are alternatives (Android vs iOS wording).
FUNNEL = [
    ("app_opened", 0), ("perm_fg_prompt_shown", 1), ("perm_fg_granted", 2),
    ("perm_always_prompt_shown", 3), ("perm_bg_settings_opened", 3),
    ("perm_always_granted", 4), ("perm_bg_granted", 4),
    ("hibernation_prompt_shown", 5), ("hibernation_exempted", 6),
]
FUNNEL_RANK = dict(FUNNEL)
FUNNEL_LABEL = {0: "opened app", 1: "saw foreground location prompt", 2: "granted foreground location",
                3: "reached the background/Always step", 4: "granted background/Always location",
                5: "saw the battery-hibernation prompt", 6: "exempted app from battery optimisation"}
MILESTONES = ["perm_fg_denied", "perm_bg_denied", "perm_always_denied", "hibernation_declined",
              "oem_settings_opened", "capture_started", "capture_stopped", "boot_restart",
              "watchdog_ok", "watchdog_restart", "export_tapped"]

Sample = namedtuple("Sample", "ran_at fix_at acc source batt charging power_save permission mode")
Event = namedtuple("Event", "ran_at name")


class ExportError(Exception):
    """A file was rejected; the run must not continue."""


class CoordinateRefusal(ExportError):
    pass


class Export:
    def __init__(self, path):
        self.path = path
        self.meta = {}
        self.offset = 0
        self.rows = []  # (raw_line, Sample|Event)
        self.warnings = []


def _coord_name(name):
    tokens = [t for t in re.split(r"[^a-z]+", name.lower()) if t]
    return any(t in COORD_WORDS or t.startswith("coord") for t in tokens)


def _int(s, what):
    try:
        return int(s)
    except ValueError:
        raise ValueError("%s is not an integer: %r" % (what, s))


def _parse_row(f):
    kind = f[0]
    if kind == "E":
        if not f[10]:
            raise ValueError("event row without an event name")
        return Event(_int(f[1], "ran_at"), f[10])
    if kind != "S":
        raise ValueError("unknown kind %r" % kind)
    ran_at = _int(f[1], "ran_at")
    fix_at = _int(f[2], "fix_at") if f[2] else None
    try:
        acc = float(f[3]) if f[3] else None
    except ValueError:
        raise ValueError("accuracy_m is not a number: %r" % f[3])
    batt = _int(f[5], "battery_pct")
    if not 0 <= batt <= 100:
        raise ValueError("battery_pct out of range: %d" % batt)
    if f[6] not in ("0", "1") or f[7] not in ("0", "1"):
        raise ValueError("charging/power_save must be 0 or 1")
    if not f[9]:
        raise ValueError("empty mode")
    return Sample(ran_at, fix_at, acc, f[4], batt, int(f[6]), int(f[7]), f[8], f[9])


def parse_export(path):
    try:
        with open(path, "rb") as fh:
            text = fh.read().decode("utf-8")
    except UnicodeDecodeError:
        raise ExportError("%s: not valid UTF-8" % path)
    ex = Export(path)
    truncated = not text.endswith("\n")
    lines = [l.rstrip("\r") for l in text.split("\n")]
    if lines and lines[-1] == "":
        lines.pop()
    if not lines or not lines[0].startswith(MAGIC):
        raise ExportError("%s: not an fmp capture log (line 1 must be '%s,1')" % (path, MAGIC))
    parts = lines[0].split(",")
    if len(parts) != 2 or parts[1] != "1":
        raise ExportError("%s: unknown schema version in line 1 (%r); this analyser reads version 1 only"
                          % (path, lines[0]))
    if len(lines) < 2 or not lines[1].startswith("#device,"):
        raise ExportError("%s: line 2 must be the '#device,...' line" % path)
    for item in lines[1].split(",")[1:]:
        k, _, v = item.partition("=")
        if _coord_name(k):
            raise CoordinateRefusal("%s: REFUSED, device line has a coordinate-like key %r" % (path, k))
        ex.meta[k] = v
    if ex.meta.get("platform") not in ("android", "ios") or not ex.meta.get("label"):
        raise ExportError("%s: device line needs label= and platform=android|ios" % path)
    try:
        ex.offset = int(ex.meta.get("utc_offset_min", ""))
    except ValueError:
        raise ExportError("%s: device line needs an integer utc_offset_min" % path)
    if len(lines) < 3:
        raise ExportError("%s: header row missing" % path)
    cols = lines[2].split(",")
    for c in cols:
        if _coord_name(c):
            raise CoordinateRefusal("%s: REFUSED, column %r looks like position data. "
                                    "Capture logs must never contain coordinates." % (path, c))
    if lines[2] != HEADER:
        raise ExportError("%s: header mismatch.\n  expected: %s\n  found:    %s" % (path, HEADER, lines[2]))
    for i, line in enumerate(lines[3:], start=4):
        if not line.strip():
            continue
        if COORD_VALUE_RE.search(line) or COORD_KV_RE.search(line):
            raise CoordinateRefusal("%s line %d: REFUSED, value looks like a coordinate (4+ decimals or "
                                    "lat=/lon=). Capture logs must never contain coordinates." % (path, i))
        last = truncated and i == len(lines)
        f = line.split(",")
        try:
            if len(f) != NCOLS:
                raise ValueError("expected %d fields, got %d" % (NCOLS, len(f)))
            ex.rows.append((line, _parse_row(f)))
        except ValueError as e:
            if last:
                ex.warnings.append("%s: ignored truncated last line (%s)" % (path, e))
            else:
                raise ExportError("%s line %d: %s" % (path, i, e))
    return ex


class Phone:
    def __init__(self, label):
        self.label = label
        self.meta = {}
        self.offset = None
        self.files = []
        self.seen = set()
        self.samples = []
        self.events = []
        self.warnings = []

    def add(self, ex):
        self.files.append(ex.path)
        if self.offset is None:
            self.offset = ex.offset
            self.meta = dict(ex.meta)
        elif ex.offset != self.offset:
            self.warnings.append("%s has utc_offset_min=%d, differs from first export (%d); using %d for all days"
                                 % (ex.path, ex.offset, self.offset, self.offset))
        if ex.meta.get("platform") != self.meta.get("platform"):
            self.warnings.append("%s: platform differs between exports sharing label %r" % (ex.path, self.label))
        self.warnings.extend(ex.warnings)
        for raw, rec in ex.rows:
            if raw in self.seen:
                continue
            self.seen.add(raw)
            (self.samples if isinstance(rec, Sample) else self.events).append(rec)


def percentile(vals, p):
    """Linear interpolation between closest ranks (same as numpy's default)."""
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def gap_stats(gaps):
    if not gaps:
        return {"n": 0, "median": None, "p95": None, "max": None}
    return {"n": len(gaps), "median": percentile(gaps, 50), "p95": percentile(gaps, 95), "max": max(gaps)}


def catch_estimate(stay_min, p95):
    if p95 is None:
        return None
    if p95 <= 0:
        return 1.0
    return min(1.0, stay_min / p95)


def analyse_phone(ph, cfg):
    off_ms = (0 if cfg["utc"] else ph.offset) * 60000
    day_of = lambda ts: (ts + off_ms) // DAY_MS
    samples = sorted(ph.samples, key=lambda s: s.ran_at)
    all_ts = [s.ran_at for s in samples] + [e.ran_at for e in ph.events]
    res = {"cells": {}, "modes": {}, "days": []}
    if not all_ts:
        return res
    t1 = max(all_ts)
    t0 = samples[0].ran_at if samples else min(all_ts)
    slot_ms = cfg["slot_min"] * 60000

    def new_cell():
        return dict(expected_ms=0, n=0, fix=0, usable=0, stale=0, fresh=0, gaps=[],
                    drain_pct=0.0, drain_h=0.0)
    cells = defaultdict(new_cell)

    # Expected slots: each run of same-mode samples "owns" time until the next run starts (or the
    # export ends), so hours where the phone was silent still count as missed slots.
    segs = []
    for s in samples:
        if not segs or segs[-1][1] != s.mode:
            segs.append([s.ran_at, s.mode])
    if not segs:
        segs = [[t0, "(none)"]]
    for i, (a, mode) in enumerate(segs):
        b = segs[i + 1][0] if i + 1 < len(segs) else t1
        d = day_of(a)
        while d <= day_of(max(a, b - 1)):
            ds = d * DAY_MS - off_ms
            ov = min(b, ds + DAY_MS) - max(a, ds)
            if ov > 0:
                cells[(mode, d)]["expected_ms"] += ov
            d += 1

    fresh_by_mode = defaultdict(set)
    for s in samples:
        c = cells[(s.mode, day_of(s.ran_at))]
        c["n"] += 1
        if s.fix_at is None:
            continue
        c["fix"] += 1
        usable = s.acc is not None and s.acc <= cfg["usable_acc"]
        stale = s.ran_at - s.fix_at > cfg["stale_ms"]
        c["usable"] += usable
        c["stale"] += stale
        if usable and not stale:
            c["fresh"] += 1
            fresh_by_mode[s.mode].add(s.fix_at)
    for mode, fixes in fresh_by_mode.items():
        fl = sorted(fixes)
        for prev, cur in zip(fl, fl[1:]):
            cells[(mode, day_of(cur))]["gaps"].append((cur - prev) / 60000.0)
    # Battery: only spans between two consecutive samples that are both unplugged; a rise while
    # unplugged (rounding, or an unlogged charge) is skipped rather than counted as negative drain.
    for prev, cur in zip(samples, samples[1:]):
        if prev.charging == 0 and cur.charging == 0 and cur.ran_at > prev.ran_at and cur.batt <= prev.batt:
            c = cells[(cur.mode, day_of(cur.ran_at))]
            c["drain_pct"] += prev.batt - cur.batt
            c["drain_h"] += (cur.ran_at - prev.ran_at) / 3600000.0

    def finish(c):
        exp = c["expected_ms"] // slot_ms
        if c["fresh"] and exp < 1:
            exp = 1
        out = dict(c)
        out["expected"] = exp
        out["rate"] = c["fresh"] / exp if exp else None
        out["usable_share"] = c["usable"] / c["n"] if c["n"] else None
        out["stale_share"] = c["stale"] / c["n"] if c["n"] else None
        out["gap"] = gap_stats(c["gaps"])
        out["drain"] = c["drain_pct"] / c["drain_h"] if c["drain_h"] > 0 else None
        return out

    res["cells"] = OrderedDict((k, finish(cells[k])) for k in sorted(cells, key=lambda k: (k[1], k[0])))
    for mode in sorted({k[0] for k in cells}):
        mc = [cells[k] for k in cells if k[0] == mode]
        agg = new_cell()
        for c in mc:
            for key in ("expected_ms", "n", "fix", "usable", "stale", "fresh", "drain_pct", "drain_h"):
                agg[key] += c[key]
            agg["gaps"].extend(c["gaps"])
        f = finish(agg)
        f["days"] = len([k for k in cells if k[0] == mode])
        res["modes"][mode] = f
    return res


def fmt_day(d):
    return (date(1970, 1, 1) + timedelta(days=d)).isoformat()


def fmt_time(ts, offset):
    d, r = divmod(ts + offset * 60000, DAY_MS)
    return "%s %02d:%02d" % (fmt_day(d), r // 3600000, r // 60000 % 60)


def m1(x):
    return "n/a" if x is None else "%.1f" % x


def pc(x):
    return "n/a" if x is None else "%.0f%%" % (100 * x)


def adoption(ph):
    first = {}
    for e in sorted(ph.events, key=lambda e: e.ran_at):
        base = e.name.split(":")[0]
        first.setdefault(base, e.ran_at)
    best = max((FUNNEL_RANK[n] for n in first if n in FUNNEL_RANK), default=None)
    return first, best


def reading(p95, gaps):
    if p95 is None:
        return "no usable gaps (not enough fresh fixes to judge)"
    long_gaps = sum(1 for g in gaps if g > 120)
    if p95 <= 30:
        return "works as designed (p95 at or under 30 min)"
    if p95 <= 60:
        return "weaker promise, ship anyway (p95 30-60 min)"
    if long_gaps:
        return "discuss: %d of %d gaps are over 2 hours" % (long_gaps, len(gaps))
    return "discuss (p95 over 60 min)"


def build_report(phones, cfg):
    blocks = []
    add = lambda *b: blocks.append(b)
    add("h1", "M0 capture-quality report")
    add("p", "Usable = fix with accuracy <= %g m. Stale = fix older than %d ms at run time. Gap = time between "
             "fix times of consecutive fresh usable samples. Expected slots = one per %g min. Days are %s."
        % (cfg["usable_acc"], cfg["stale_ms"], cfg["slot_min"],
           "UTC days" if cfg["utc"] else "local days from utc_offset_min"))
    analysed = OrderedDict((l, analyse_phone(p, cfg)) for l, p in phones.items())
    for label, ph in phones.items():
        r = analysed[label]
        m = ph.meta
        add("h2", "Phone: %s" % label)
        add("p", "%s, model %s, os %s, app_build %s, utc_offset_min %d; %d export(s), %d samples, %d events"
            % (m.get("platform"), m.get("model", "?"), m.get("os", "?"), m.get("app_build", "?"),
               ph.offset, len(ph.files), len(ph.samples), len(ph.events)))
        for w in ph.warnings:
            add("p", "WARNING: " + w)
        if not ph.samples:
            add("p", "No sample rows in this phone's exports (events only): capture rate is zero.")
        if r["cells"]:
            rows = []
            for (mode, d), c in r["cells"].items():
                rows.append([fmt_day(d), mode, c["n"], "%d/%d" % (c["fresh"], c["expected"]), pc(c["rate"]),
                             m1(c["gap"]["median"]), m1(c["gap"]["p95"]), m1(c["gap"]["max"]),
                             pc(c["usable_share"]), pc(c["stale_share"]), m1(c["drain"])])
            add("table", "Per day (gap columns in minutes; drain in %/h while unplugged)",
                ["day", "mode", "samples", "fresh/expected", "capture", "gap med", "gap p95", "gap max",
                 "usable", "stale", "drain %/h"], rows)
        for mode, s in r["modes"].items():
            g = s["gap"]
            add("table", "Summary, mode %s (%d day(s))" % (mode, s["days"]), ["metric", "value"], [
                ["capture rate (fresh usable / expected)", "%s (%d/%d)" % (pc(s["rate"]), s["fresh"], s["expected"])],
                ["reliable gap (p95, min)", m1(g["p95"])],
                ["median gap (min)", m1(g["median"])],
                ["longest gap (min)", m1(g["max"])],
                ["usable share", pc(s["usable_share"])],
                ["stale share", pc(s["stale_share"])],
                ["battery drain (%/h, unplugged)", m1(s["drain"])],
                ["catch estimate, %g min stay" % cfg["stay_min"],
                 pc(catch_estimate(cfg["stay_min"], g["p95"]))],
                ["proposal-level reading", reading(g["p95"], s["gaps"])],
            ])
    add("h2", "Adoption (how far each phone got through the permission steps)")
    rows = []
    for label, ph in phones.items():
        first, best = adoption(ph)
        furthest = "no funnel events" if best is None else FUNNEL_LABEL[best]
        rows.append([label, furthest])
    add("table", "Furthest step reached", ["phone", "furthest step"], rows)
    for label, ph in phones.items():
        first, _ = adoption(ph)
        order = [n for n, _r in FUNNEL if n in first] + [n for n in MILESTONES if n in first]
        order += sorted(n for n in first if n not in order)
        rows = [[n, fmt_time(first[n], ph.offset)] for n in order]
        if rows:
            add("table", "First seen, %s" % label, ["event", "first seen (phone local time)"], rows)
    add("p", "Decision lines (p95 <= 30 min works as designed; 30-60 weaker promise; frequent multi-hour gaps "
             "discuss) are proposal-level starting points, not decisions.")
    return blocks


def render(blocks, md):
    out = []
    for b in blocks:
        kind = b[0]
        if kind == "h1":
            out += [("# " if md else "") + b[1], "" if md else "=" * len(b[1]), ""]
        elif kind == "h2":
            out += ["", ("## " if md else "") + b[1], "" if md else "-" * len(b[1]), ""]
        elif kind == "p":
            out += [b[1], ""]
        else:
            _k, title, head, rows = b
            rows = [[str(c) for c in r] for r in rows]
            out.append(("**%s**" % title) if md else title)
            out.append("")
            if md:
                out.append("| " + " | ".join(head) + " |")
                out.append("|" + "|".join("---" for _ in head) + "|")
                out += ["| " + " | ".join(r) + " |" for r in rows]
            else:
                w = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(head)]
                out.append("  ".join(h.ljust(w[i]) for i, h in enumerate(head)))
                out += ["  ".join(c.ljust(w[i]) for i, c in enumerate(r)).rstrip() for r in rows]
            out.append("")
    return "\n".join(x for x in out if x is not None).rstrip("\n") + "\n"


def load_phones(paths):
    phones = OrderedDict()
    for p in paths:
        ex = parse_export(p)
        label = ex.meta["label"]
        phones.setdefault(label, Phone(label)).add(ex)
    return phones


def main(argv=None):
    ap = argparse.ArgumentParser(description="Per-phone, per-day capture-quality report from M0 capture logs.")
    ap.add_argument("files", nargs="+", help="exported capture log CSV files")
    ap.add_argument("--tz-from-file", action="store_true",
                    help="day boundaries from utc_offset_min in the file (this is already the default)")
    ap.add_argument("--utc", action="store_true", help="use UTC days instead of the phone's local days")
    ap.add_argument("--usable-acc", type=float, default=100.0, help="max accuracy in metres to count as usable")
    ap.add_argument("--stale-ms", type=int, default=120000, help="ran_at - fix_at above this is a stale fix")
    ap.add_argument("--stay-min", type=float, default=30.0, help="stay length for the catch estimate, minutes")
    ap.add_argument("--slot-min", type=float, default=15.0, help="expected sampling slot, minutes")
    ap.add_argument("--md", metavar="OUT.md", help="also write the report as Markdown")
    a = ap.parse_args(argv)
    cfg = dict(usable_acc=a.usable_acc, stale_ms=a.stale_ms, stay_min=a.stay_min,
               slot_min=a.slot_min, utc=a.utc and not a.tz_from_file)
    try:
        phones = load_phones(a.files)
    except (ExportError, OSError) as e:
        print("REJECTED: %s" % e, file=sys.stderr)
        return 2
    blocks = build_report(phones, cfg)
    sys.stdout.write(render(blocks, False))
    if a.md:
        with open(a.md, "w", encoding="utf-8") as fh:
            fh.write(render(blocks, True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
