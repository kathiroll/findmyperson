import contextlib
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fmp_analyse as fa  # noqa: E402

T0 = 1757894400000  # 2025-09-15 00:00:00 UTC
MIN = 60000
HOUR = 60 * MIN
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def s(t, fix_off=1000, acc=10.0, src="current", batt=90, chg=0, ps=0, perm="background", mode="wm"):
    """Sample row at T0+t minutes; fix_off ms before the run (None = no fix)."""
    ts = T0 + t * MIN
    if fix_off is None:
        return "S,%d,,,none,%d,%d,%d,%s,%s," % (ts, batt, chg, ps, perm, mode)
    return "S,%d,%d,%.1f,%s,%d,%d,%d,%s,%s," % (ts, ts - fix_off, acc, src, batt, chg, ps, perm, mode)


def e(t, name):
    return "E,%d,,,,,,,,,%s" % (T0 + t * MIN, name)


def log_text(rows, label="p1", offset=0, platform="android", header=fa.HEADER, version="1", newline_end=True):
    lines = ["#fmp-capture-log," + version,
             "#device,label=%s,platform=%s,model=M,os=14,app_build=1,utc_offset_min=%d" % (label, platform, offset),
             header] + rows
    return "\n".join(lines) + ("\n" if newline_end else "")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.n = 0

    def write(self, text):
        self.n += 1
        p = os.path.join(self.tmp.name, "f%d.csv" % self.n)
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(text)
        return p

    def analyse(self, rows, files=None, **cfg_over):
        cfg = dict(usable_acc=100.0, stale_ms=120000, stay_min=30.0, slot_min=15.0, utc=False)
        cfg.update(cfg_over)
        paths = files or [self.write(log_text(rows))]
        phones = fa.load_phones(paths)
        ph = phones["p1"]
        return ph, fa.analyse_phone(ph, cfg)

    def run_main(self, paths, extra=()):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = fa.main(list(paths) + list(extra))
        return rc, out.getvalue(), err.getvalue()


class MetricTests(Base):
    def rows(self):
        return [
            s(0, acc=10, batt=90), s(15, acc=20, batt=89), s(30, acc=30, batt=88), s(60, acc=40, batt=86),
            s(75, fix_off=300000, batt=85),        # stale (300 s old) but accurate
            s(90, fix_off=None, batt=84),          # no fix
            s(105, acc=150, batt=83),              # fix, too inaccurate
            e(120, "export_tapped"),
        ]

    def test_day_metrics_by_hand(self):
        _, r = self.analyse(self.rows())
        (key, c), = r["cells"].items()
        self.assertEqual(key[0], "wm")
        self.assertEqual(c["n"], 7)
        self.assertEqual(c["fix"], 6)
        self.assertEqual(c["usable"], 5)   # stale one is usable, the 150 m one is not
        self.assertEqual(c["stale"], 1)
        self.assertEqual(c["fresh"], 4)
        self.assertEqual(c["expected"], 8)  # 120 min / 15
        self.assertAlmostEqual(c["rate"], 0.5)
        self.assertAlmostEqual(c["usable_share"], 5 / 7)
        self.assertAlmostEqual(c["stale_share"], 1 / 7)

    def test_gap_distribution_by_hand(self):
        _, r = self.analyse(self.rows())
        g = r["modes"]["wm"]["gap"]
        self.assertEqual(g["n"], 3)          # gaps 15, 15, 30
        self.assertAlmostEqual(g["median"], 15.0)
        self.assertAlmostEqual(g["p95"], 28.5)  # 15 + 0.9 * (30 - 15)
        self.assertAlmostEqual(g["max"], 30.0)

    def test_drain_by_hand(self):
        _, r = self.analyse(self.rows())
        # drops 1+1+2+1+1+1 = 7 % over 105 min = 1.75 h
        self.assertAlmostEqual(r["modes"]["wm"]["drain"], 4.0)

    def test_drain_ignores_charging_spans(self):
        rows = [s(0, batt=90), s(60, batt=80), s(120, batt=85, chg=1), s(180, batt=95, chg=1),
                s(240, batt=90), s(300, batt=84)]
        _, r = self.analyse(rows)
        self.assertAlmostEqual(r["modes"]["wm"]["drain"], 8.0)  # (10 + 6) % over 2 h

    def test_stale_boundary_is_exclusive(self):
        _, r = self.analyse([s(0, fix_off=120000), s(15, fix_off=120001)])
        c = list(r["cells"].values())[0]
        self.assertEqual(c["stale"], 1)
        self.assertEqual(c["fresh"], 1)

    def test_flags_change_thresholds(self):
        _, r = self.analyse(self.rows(), usable_acc=15.0, stale_ms=400000)
        c = list(r["cells"].values())[0]
        self.assertEqual(c["usable"], 2)  # 10 m and 10 m (stale row); 20 m is over 15
        self.assertEqual(c["stale"], 0)

    def test_slot_min_changes_expected(self):
        _, r = self.analyse(self.rows(), slot_min=30.0)
        self.assertEqual(list(r["cells"].values())[0]["expected"], 4)

    def test_percentile_and_catch(self):
        self.assertAlmostEqual(fa.percentile([10, 20, 30, 40, 50], 50), 30)
        self.assertAlmostEqual(fa.percentile([10, 20, 30, 40, 50], 95), 48)
        self.assertIsNone(fa.percentile([], 50))
        self.assertAlmostEqual(fa.catch_estimate(30, 60), 0.5)
        self.assertAlmostEqual(fa.catch_estimate(30, 15), 1.0)
        self.assertIsNone(fa.catch_estimate(30, None))

    def test_two_modes_split_and_expected_follow_segments(self):
        rows = [s(0, mode="fgs"), s(10, mode="fgs"), s(20, mode="wm"), s(35, mode="wm"), e(50, "export_tapped")]
        _, r = self.analyse(rows)
        self.assertEqual(set(r["modes"]), {"fgs", "wm"})
        self.assertEqual(r["modes"]["fgs"]["expected"], 1)   # 20 min -> 1 slot
        self.assertEqual(r["modes"]["wm"]["expected"], 2)    # 30 min -> 2 slots
        self.assertEqual(r["modes"]["fgs"]["gap"]["max"], 10.0)


class DayTests(Base):
    def test_day_with_no_samples_reports_zero_capture(self):
        rows = [s(10 * 60), s(2 * 24 * 60 + 10 * 60)]
        _, r = self.analyse(rows, utc=True)
        cells = {fa.fmt_day(k[1]): c for k, c in r["cells"].items()}
        mid = cells["2025-09-16"]
        self.assertEqual((mid["n"], mid["fresh"], mid["expected"]), (0, 0, 96))
        self.assertEqual(mid["rate"], 0.0)
        self.assertIsNone(mid["usable_share"])
        self.assertEqual(cells["2025-09-17"]["gap"]["max"], 48 * 60.0)  # gap lands on the day it ends

    def test_local_day_boundary_uses_utc_offset(self):
        # UTC 18:00 is 23:30 local (+330), UTC 19:00 is 00:30 next local day
        p = self.write(log_text([s(18 * 60), s(19 * 60)], offset=330))
        _, r = self.analyse(None, files=[p])
        self.assertEqual(sorted(fa.fmt_day(k[1]) for k in r["cells"]), ["2025-09-15", "2025-09-16"])
        _, r = self.analyse(None, files=[p], utc=True)
        self.assertEqual(sorted(fa.fmt_day(k[1]) for k in r["cells"]), ["2025-09-15"])

    def test_events_only_file(self):
        p = self.write(log_text([e(0, "app_opened"), e(1, "perm_fg_prompt_shown"), e(2, "perm_fg_denied")]))
        rc, out, _ = self.run_main([p])
        self.assertEqual(rc, 0)
        self.assertIn("events only", out)
        self.assertIn("saw foreground location prompt", out)


class RobustnessTests(Base):
    def test_truncated_last_line_is_tolerated(self):
        text = log_text([s(0), s(15)], newline_end=True) + "S,1757895"
        ph, _ = self.analyse(None, files=[self.write(text)])
        self.assertEqual(len(ph.samples), 2)
        self.assertTrue(any("truncated" in w for w in ph.warnings))

    def test_bad_middle_line_is_rejected(self):
        p = self.write(log_text([s(0), "S,1757895", s(15)]))
        with self.assertRaises(fa.ExportError):
            fa.load_phones([p])

    def test_unknown_event_names_tolerated(self):
        p = self.write(log_text([e(0, "some_future_event:abc"), e(1, "app_opened")]))
        rc, out, _ = self.run_main([p])
        self.assertEqual(rc, 0)
        self.assertIn("some_future_event", out)

    def test_exports_concatenate_and_deduplicate(self):
        a = self.write(log_text([s(0), s(15), e(16, "app_opened")]))
        b = self.write(log_text([s(15), s(30), e(16, "app_opened")]))
        ph, _ = self.analyse(None, files=[a, b])
        self.assertEqual(len(ph.samples), 3)
        self.assertEqual(len(ph.events), 1)
        self.assertEqual(len(ph.files), 2)

    def test_header_mismatch(self):
        p = self.write(log_text([s(0)], header=fa.HEADER.replace("power_save", "psave")))
        rc, _, err = self.run_main([p])
        self.assertEqual(rc, 2)
        self.assertIn("header mismatch", err)

    def test_unknown_schema_version(self):
        rc, _, err = self.run_main([self.write(log_text([s(0)], version="2"))])
        self.assertEqual(rc, 2)
        self.assertIn("unknown schema version", err)

    def test_not_a_log(self):
        rc, _, err = self.run_main([self.write("hello\n")])
        self.assertEqual(rc, 2)
        self.assertIn("not an fmp capture log", err)


class CoordinateRefusalTests(Base):
    def refused(self, text):
        rc, out, err = self.run_main([self.write(text)])
        self.assertEqual(rc, 2)
        self.assertEqual(out, "")
        self.assertIn("REFUSED", err)

    def test_coordinate_columns(self):
        self.refused(log_text([], header=fa.HEADER + ",lat,lon"))
        self.refused(log_text([], header=fa.HEADER.replace("accuracy_m", "latitude")))

    def test_coordinate_values(self):
        self.refused(log_text([e(0, "note:12.971598")]))
        self.refused(log_text([e(0, "note:lat=12.97")]))
        self.refused(log_text([s(0).replace(",10.0,", ",10.12345,")]))

    def test_coordinate_in_truncated_last_line_still_refused(self):
        self.refused(log_text([s(0)]) + "E,1757895000000,,,,,,,,,x:77.594566")

    def test_device_line_key(self):
        self.refused(log_text([s(0)]).replace("utc_offset_min=0", "utc_offset_min=0,lat=1"))

    def test_normal_values_are_not_refused(self):
        rc, _, _ = self.run_main([self.write(log_text([s(0), e(1, "mode_changed:fgs")]))])
        self.assertEqual(rc, 0)


class AdoptionTests(Base):
    def test_furthest_step_and_first_seen(self):
        ph, _ = self.analyse([e(5, "app_opened"), e(6, "perm_fg_prompt_shown"), e(7, "perm_fg_granted"),
                              e(8, "perm_bg_settings_opened"), e(9, "perm_bg_denied"),
                              e(10, "perm_fg_prompt_shown")])
        first, best = fa.adoption(ph)
        self.assertEqual(best, 3)
        self.assertEqual(first["perm_fg_prompt_shown"], T0 + 6 * MIN)  # first, not last

    def test_ios_funnel_reaches_always(self):
        ph, _ = self.analyse([e(0, "app_opened"), e(1, "perm_always_granted")])
        self.assertEqual(fa.adoption(ph)[1], 4)

    def test_no_funnel_events(self):
        ph, _ = self.analyse([s(0)])
        self.assertIsNone(fa.adoption(ph)[1])


class FixtureTests(unittest.TestCase):
    def test_fixtures_end_to_end(self):
        paths = sorted(os.path.join(FIXTURES, f) for f in os.listdir(FIXTURES) if f.endswith(".csv"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(fa.main(paths), 0)
        text = out.getvalue()
        for label in ("xiaomi-wm", "oneplus-fgs", "iphone-15"):
            self.assertIn("Phone: " + label, text)
        self.assertIn("catch estimate, 30 min stay", text)

    def test_overlapping_exports_dedupe(self):
        both = fa.load_phones([os.path.join(FIXTURES, "xiaomi_export1.csv"),
                               os.path.join(FIXTURES, "xiaomi_export2.csv")])["xiaomi-wm"]
        one = fa.load_phones([os.path.join(FIXTURES, "xiaomi_export1.csv")])["xiaomi-wm"]
        two = fa.load_phones([os.path.join(FIXTURES, "xiaomi_export2.csv")])["xiaomi-wm"]
        self.assertLess(len(both.samples), len(one.samples) + len(two.samples))

    def test_markdown_output(self):
        with tempfile.TemporaryDirectory() as d:
            md = os.path.join(d, "r.md")
            with contextlib.redirect_stdout(io.StringIO()):
                fa.main([os.path.join(FIXTURES, "iphone.csv"), "--md", md])
            with open(md, encoding="utf-8") as fh:
                self.assertIn("| metric | value |", fh.read())


if __name__ == "__main__":
    unittest.main()
