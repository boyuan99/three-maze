"""retro_gain_check.py - audit existing three-maze data files written by hallway01/02/04_experiment._log_data
(8 tab-separated columns: x, -z, theta, raw_x, raw_y, water, teensy_ts_us, experiment_id; no header) for:
  1. effective VR gain  g_eff = VR path length / ball path length over clean windows (1.0 expected; the
     frame-coupled integrator makes it ~ display_rate/60 x (true sample period / 50 ms))
  2. implied display rate  ~ 60 * g_eff  (assumes the Teensy really sampled every 50 ms; see period_us_median)
  3. sample accounting from Teensy timestamps (missing / duplicated samples, longest gap; uint32 micros() wrap)
  4. heading divergence per trial: direction of VR motion vs logged (camera) heading, forward running only
  5. frozen-while-running rows: ball moved but VR did not (false 'falls' in hallway02, movement lock)

Usage (PowerShell or cmd, from the repository folder; the quotes keep the shell from touching the pattern):
    .venv\\Scripts\\python tools\\retro_gain_check.py "D:\\VirmenData\\*.txt" --csv out\\audit.csv
    .venv\\Scripts\\python tools\\retro_gain_check.py file1.txt [file2.txt ...] [--k-lin 0.0349] [--period-us 50000]

Each argument is a file or a glob pattern (* ? [..] and ** for subfolders), expanded here because cmd and
PowerShell pass patterns on unexpanded. A file that cannot be analysed is listed with its error and the
audit goes on; the CSV has one row per file, with the error (and any numpy warning) in its own columns.
Exit code: 0 every file analysed, 1 some files failed (CSV still complete), 2 bad arguments or no file.

Read-only: data files are only opened for reading, and the CSV may not be written into a folder that holds
an audited file.

The analysis (load, wrap, analyse) is the design review's prototype, unchanged
(proto/motion_core/retro_gain_check.py in the separate three-maze-notes repository); this copy adds
the pattern expansion and per-file error handling (plan item REL-02).
"""
import argparse
import csv
import glob
import os
import sys
import warnings

import numpy as np


def load(path):
    rows = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            f = line.rstrip("\n").split("\t")
            if len(f) < 7:
                continue
            try:
                rows.append((float(f[0]), -float(f[1]), float(f[2]), float(f[3]), float(f[4]), int(float(f[6]))))
            except ValueError:
                continue                                   # header or damaged row
    a = np.asarray(rows, dtype=float) if rows else np.zeros((0, 6))
    ts = a[:, 5].astype(np.int64)
    d = np.diff(ts)
    wraps = np.concatenate([[0], np.cumsum(d < -(1 << 31))])  # Teensy micros() is uint32: wraps every 71.6 min
    ts = ts + wraps * (1 << 32)
    return a[:, 0], a[:, 1], a[:, 2], a[:, 3], a[:, 4], ts


def wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def analyse(path, k_lin=0.0349, period_us=50_000, win=20, tol=0.25):
    x, z, th, rx, ry, ts = load(path)
    out = {"rows": len(ts)}
    if len(ts) < 3:
        return out
    uts = np.unique(ts)
    d_uts = np.diff(uts)
    per = float(np.median(d_uts))                           # actual device period (check against 50 ms!)
    out["period_us_median"] = per
    out["period_us_p1_p99"] = (float(np.percentile(d_uts, 1)), float(np.percentile(d_uts, 99)))
    expected = int(round((uts[-1] - uts[0]) / per)) + 1
    out["device_samples_expected"] = expected
    out["device_samples_logged"] = len(uts)
    out["missing_samples"] = expected - len(uts)
    out["missing_pct"] = 100.0 * (expected - len(uts)) / expected
    out["gaps_gt_1.5_periods"] = int((d_uts > 1.5 * per).sum())
    out["longest_gap_s"] = float(d_uts.max() / 1e6)
    out["duplicate_ts_rows"] = len(ts) - len(uts)
    dts = np.diff(ts)
    dx, dz = np.diff(x), np.diff(z)
    l_vr = np.hypot(dx, dz)
    l_ball = np.hypot(rx[1:], ry[1:]) * k_lin
    at_origin = np.hypot(x, z) < 1e-9                        # reset rows written after a trial end
    teleport = at_origin[1:] | at_origin[:-1] | (l_vr > 20 * np.maximum(l_ball, 0.05))
    one_period = np.abs(dts - per) <= tol * per
    ok = one_period & ~teleport
    # windowed gain over `win` consecutive clean steps with real running
    ratios, run = [], []
    for i in range(len(ok)):
        if ok[i]:
            run.append(i)
            if len(run) >= win:
                idx = run[-win:]
                lb = l_ball[idx].sum()
                if lb > 5.0:
                    ratios.append(l_vr[idx].sum() / lb)
                run = []
        else:
            run = []
    r = np.asarray(ratios)
    if len(r):
        g = float(np.median(r))
        out["g_eff_median"] = g
        out["g_eff_iqr"] = (float(np.percentile(r, 25)), float(np.percentile(r, 75)))
        out["implied_display_hz"] = 60.0 * g * (period_us / per)
        out["windows"] = len(r)
    # frozen while running: >= 0.5 units of ball travel, < 5 % of it in VR (excludes teleports)
    frozen = ok & (l_ball > 0.5) & (l_vr < 0.05 * l_ball)
    out["frozen_while_running_rows"] = int(frozen.sum())
    # heading divergence: VR motion direction vs logged heading, forward running only
    fwd = ok & (ry[1:] > 2 * np.abs(rx[1:])) & (l_ball > 0.5) & (l_vr > 0.2)
    phi = np.arctan2(-dx, -dz)                               # forward = (-sin th, -cos th) in this codebase
    dev = wrap(phi - th[1:])
    trial_id = np.cumsum(at_origin)[1:]
    per_trial = []
    for t in np.unique(trial_id[fwd]):
        dd = dev[fwd & (trial_id == t)]
        if len(dd) >= 15:
            per_trial.append(max(abs(float(np.median(dd[i:i + 15]))) for i in range(len(dd) - 14)))
    pt = np.asarray(per_trial)
    out["trials_checked"] = len(pt)
    if len(pt):
        out["heading_offset_trials_gt_2deg"] = int((pt > np.deg2rad(2)).sum())
        out["heading_offset_max_deg"] = float(np.rad2deg(pt.max()))
    out["trials_total"] = int(at_origin.sum())
    t_reset = ts[at_origin]
    if len(t_reset) > 1:                                     # double trial ends (stale-pose race) show up as
        iti = np.diff(t_reset) / 1e6                         # implausibly short trials
        out["trials_shorter_than_1s"] = int((iti < 1.0).sum())
        out["trial_duration_s_median"] = float(np.median(iti))
    return out


# --- wrapper: patterns, per-file errors, CSV (REL-02) ---------------------------------------------

def expand(args):
    """Files named by the arguments, in order, each once. Returns (files, patterns that matched nothing)."""
    files, unmatched = [], []
    for arg in args:
        if glob.has_magic(arg):
            hits = sorted(p for p in glob.glob(arg, recursive=True) if os.path.isfile(p))
            if not hits:
                unmatched.append(arg)
            files.extend(hits)
        else:
            files.append(arg)  # a literal name: a missing file is reported as that file's error
    seen, unique = set(), []
    for f in files:
        key = os.path.normcase(os.path.abspath(f))
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return unique, unmatched


def csv_problem(csv_path, files):
    """Why the CSV may not be written there, or None: never over an audited file or into its folder."""
    target = os.path.normcase(os.path.abspath(csv_path))
    folders = {os.path.normcase(os.path.dirname(os.path.abspath(f))) for f in files}
    if target in {os.path.normcase(os.path.abspath(f)) for f in files}:
        return f"--csv {csv_path} is one of the audited files"
    if os.path.dirname(target) in folders:
        return f"--csv {csv_path} is in a folder with audited files; write it somewhere else (read-only on data)"
    return None


def audit_file(path, k_lin, period_us):
    """One CSV row: the analysis, or the error that stopped it; numpy warnings in their own column."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            row = {"file": path, "error": "", **analyse(path, k_lin, period_us)}
        except Exception as exc:  # noqa: BLE001 - one bad file must not stop the audit
            row = {"file": path, "error": f"{type(exc).__name__}: {exc}"}
    row["warnings"] = "; ".join(sorted({f"{w.category.__name__}: {w.message}" for w in caught}))
    return row


def fmt(v):
    if isinstance(v, float):
        return round(v, 3)
    if isinstance(v, tuple):
        return tuple(round(u, 3) for u in v)
    return v


def main(argv=None):
    ap = argparse.ArgumentParser(description="Audit v0.3 data files (see the module docstring).")
    ap.add_argument("files", nargs="+", help="data files or glob patterns, e.g. \"D:\\VirmenData\\*.txt\"")
    ap.add_argument("--k-lin", type=float, default=0.0349)
    ap.add_argument("--period-us", type=int, default=50_000)
    ap.add_argument("--csv")
    a = ap.parse_args(argv)

    files, unmatched = expand(a.files)
    for p in unmatched:
        print(f"no file matches {p}", file=sys.stderr)
    if not files:
        print("no file to audit", file=sys.stderr)
        return 2
    if a.csv:
        problem = csv_problem(a.csv, files)
        if problem:
            print(problem, file=sys.stderr)
            return 2

    table = []
    for f in files:
        row = audit_file(f, a.k_lin, a.period_us)
        table.append(row)
        print(f"\n{f}")
        for k, v in row.items():
            if k != "file" and v != "":
                print(f"  {k:32s} {fmt(v)}")
    failed = [r for r in table if r["error"]]
    if a.csv:
        rest = sorted({k for row in table for k in row} - {"file", "error", "warnings"})
        os.makedirs(os.path.dirname(os.path.abspath(a.csv)), exist_ok=True)
        with open(a.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["file", "error", "warnings", *rest])
            w.writeheader()
            w.writerows(table)
    print(f"\n{len(table)} file(s): {len(table) - len(failed)} analysed, {len(failed)} with an error"
          + (f" ({', '.join(os.path.basename(r['file']) for r in failed[:10])})" if failed else "")
          + (f"; CSV: {os.path.abspath(a.csv)}" if a.csv else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
