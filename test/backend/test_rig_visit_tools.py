"""The rig visit kit's Python tools (plan item REL-02), without a rig:

- tools/retro_gain_check.py on simulated v0.3 data files (the 8-column rows of hallway04's _log_data), one of
  them corrupt: the glob pattern is expanded by the tool itself, as cmd and PowerShell leave it alone; every
  file gets a CSV row, the corrupt one with its error.
- tools/capture_raw.py against the simulated Teensy of the end-to-end bench (test/e2e/sim): lines and stamps
  are written, and the only write to the device is the init line (or none with --no-init).
"""
import csv
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
RETRO = REPO / "tools" / "retro_gain_check.py"
CAPTURE = REPO / "tools" / "capture_raw.py"
SIM_ROOT = REPO / "test" / "e2e" / "sim"
K_LIN = 0.0349          # retro_gain_check's default: units per ball count
COUNTS = 16             # forward counts per sample, as the simulated Teensy sends
PERIOD_US = 50_000


def write_v03(path, samples=600, drop=(), heading=0.0):
    """A v0.3 data file of straight running at gain 1: x, -y, theta, raw_x, raw_y, water, t_us, scene
    (experiments/hallway04_experiment.py:650-676). drop: sample numbers with no row (lost samples)."""
    step = COUNTS * K_LIN
    with open(path, "w", newline="\n") as fh:
        for k in range(samples):
            if k in drop:
                continue
            # forward is (-sin th, -cos th) and the file stores -z in its second column
            x = -math.sin(heading) * step * k
            z = -math.cos(heading) * step * k
            fh.write(f"{x:.3f}\t{-z:.3f}\t{heading:.3f}\t0\t{COUNTS}\t0\t{(k + 1) * PERIOD_US}\twide70\n")


def run(args, **kw):
    return subprocess.run([sys.executable, *map(str, args)], capture_output=True, text=True, timeout=120, **kw)


@pytest.fixture
def data_dir(tmp_path):
    d = tmp_path / "VirmenData"
    d.mkdir()
    write_v03(d / "hallway04_experiment-20261001-100000.txt")
    write_v03(d / "hallway04_experiment-20261002-100000.txt", drop=set(range(100, 600, 100)))
    # A damaged timestamp (1e400 overflows to infinity): the prototype stopped the whole audit here
    rows = (d / "hallway04_experiment-20261001-100000.txt").read_text().splitlines()
    rows[50] = "\t".join(rows[50].split("\t")[:6] + ["1e400", "wide70"])
    (d / "hallway04_experiment-20261003-100000.txt").write_text("\n".join(rows) + "\n")
    (d / "hallway04_experiment-20261001-100000.renderer.jsonl").write_text("{}\n")  # not a data file
    return d


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def test_retro_audit_expands_the_pattern_and_lists_the_corrupt_file(data_dir, tmp_path):
    out = tmp_path / "report" / "audit.csv"
    out.parent.mkdir()
    # The pattern reaches the tool unexpanded, as from cmd or PowerShell
    r = run([RETRO, str(data_dir / "*.txt"), "--csv", out])
    assert r.returncode == 1, r.stderr  # one file failed; the CSV is still complete
    rows = {Path(row["file"]).name: row for row in read_csv(out)}
    assert sorted(rows) == ["hallway04_experiment-20261001-100000.txt", "hallway04_experiment-20261002-100000.txt",
                            "hallway04_experiment-20261003-100000.txt"]
    good = rows["hallway04_experiment-20261001-100000.txt"]
    assert good["error"] == ""
    assert float(good["period_us_median"]) == PERIOD_US
    assert int(good["missing_samples"]) == 0
    assert abs(float(good["g_eff_median"]) - 1.0) < 1e-3  # 3-decimal positions: rounding only
    assert abs(float(good["implied_display_hz"]) - 60.0) < 0.1
    gaps = rows["hallway04_experiment-20261002-100000.txt"]
    assert int(gaps["missing_samples"]) == 5 and int(gaps["gaps_gt_1.5_periods"]) == 5
    bad = rows["hallway04_experiment-20261003-100000.txt"]
    assert bad["error"] == "OverflowError: cannot convert float infinity to integer"
    assert bad["period_us_median"] == ""
    assert "3 file(s): 2 analysed, 1 with an error (hallway04_experiment-20261003-100000.txt)" in r.stdout


def test_retro_audit_keeps_literal_names_and_reports_a_missing_file(data_dir, tmp_path):
    out = tmp_path / "audit.csv"
    r = run([RETRO, data_dir / "hallway04_experiment-20261001-100000.txt", data_dir / "nope.txt", "--csv", out])
    assert r.returncode == 1
    rows = read_csv(out)
    assert [Path(x["file"]).name for x in rows] == ["hallway04_experiment-20261001-100000.txt", "nope.txt"]
    assert rows[1]["error"].startswith("FileNotFoundError")


def test_retro_audit_is_read_only_on_the_data_folder(data_dir):
    before = {p.name: p.read_bytes() for p in data_dir.iterdir()}
    r = run([RETRO, str(data_dir / "*.txt"), "--csv", data_dir / "audit.csv"])
    assert r.returncode == 2
    assert "is in a folder with audited files" in r.stderr
    assert {p.name: p.read_bytes() for p in data_dir.iterdir()} == before


def test_retro_audit_without_a_match(tmp_path):
    r = run([RETRO, str(tmp_path / "*.txt")])
    assert r.returncode == 2
    assert "no file matches" in r.stderr


# --- capture against the simulated Teensy -----------------------------------------------------------

sim_only = pytest.mark.skipif(sys.platform != "win32", reason="the simulated rig (test/e2e/sim) models a Windows rig")


def sim_env(sim_dir):
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith("THREEMAZE_")}
    env.update({"THREEMAZE_SIM": "1", "THREEMAZE_SIM_DIR": str(sim_dir), "PYTHONPATH": str(SIM_ROOT),
                "PYTHONDONTWRITEBYTECODE": "1"})
    return env


def sim_events(sim_dir, event):
    with open(sim_dir / "serial.jsonl", encoding="utf-8") as fh:
        return [e for e in map(json.loads, fh) if e["event"] == event]


def read_capture(path):
    comments, data = [], []
    for line in path.read_bytes().split(b"\n")[:-1]:
        if line.startswith(b"# "):
            comments.append(json.loads(line[2:]))
        else:
            stamp, raw = line.split(b"\t", 1)
            data.append((int(stamp), raw))
    return comments, data


@sim_only
def test_capture_records_the_stream_and_writes_only_the_init_line(tmp_path):
    sim_dir, out = tmp_path / "sim", tmp_path / "capture" / "raw.tsv"
    r = run([CAPTURE, "--port", "COM3", "--seconds", "1.5", "--init-delay", "0.2", "--out", out], env=sim_env(sim_dir))
    assert r.returncode == 0, r.stderr
    comments, data = read_capture(out)
    # The sim streams one CRLF line per 50 ms from 50 ms after the init line: about 26 in 1.3 s
    assert 20 <= len(data) <= 28
    stamps = [t for t, _ in data]
    assert stamps == sorted(stamps)
    complete = [raw for raw in data if raw[1].endswith(b"\r")]  # the line ending is kept: \r before the \n
    assert len(complete) >= len(data) - 1
    first = complete[0][1].rstrip(b"\r").split(b",")
    assert len(first) == 13 and first[0] == b"50000" and first[-1] == b"1"
    header, totals = comments[0], comments[-1]
    assert header["init_line"] == "10000,50,10,1" and header["baud"] == 115200
    assert totals["lines"] == len(data) - (1 if totals["incomplete_last_line_bytes"] else 0)
    assert [w["bytes"] for w in totals["writes_to_device"]] == ["10000,50,10,1\n"]
    # The device's side: one write from the host, the init line, and nothing else
    assert [e["data"] for e in sim_events(sim_dir, "received")] == ["10000,50,10,1\n"]


@sim_only
def test_capture_with_no_init_writes_nothing(tmp_path):
    sim_dir, out = tmp_path / "sim", tmp_path / "raw.tsv"
    r = run([CAPTURE, "--port", "COM3", "--seconds", "0.5", "--no-init", "--out", out], env=sim_env(sim_dir))
    assert r.returncode == 0, r.stderr
    comments, data = read_capture(out)
    assert data == []  # the sim stays silent until it gets an init line
    assert comments[-1]["writes_to_device"] == []
    assert sim_events(sim_dir, "received") == []


@sim_only
def test_capture_reports_a_missing_port_and_leaves_no_file(tmp_path):
    sim_dir, out = tmp_path / "sim", tmp_path / "raw.tsv"
    env = {**sim_env(sim_dir), "THREEMAZE_SIM_SERIAL": "missing"}
    r = run([CAPTURE, "--port", "COM3", "--seconds", "0.5", "--out", out], env=env)
    assert r.returncode == 1
    assert "capture failed: SerialException: could not open port 'COM3'" in r.stderr
    assert not out.exists()


def test_capture_never_overwrites(tmp_path):
    out = tmp_path / "raw.tsv"
    out.write_text("earlier capture\n")
    # Not the simulated rig: a port that cannot exist and --no-init, so that this test could not
    # write to a real device on a rig computer even if the check below were broken
    r = run([CAPTURE, "--port", "THREEMAZE-NO-SUCH-PORT", "--no-init", "--seconds", "1", "--out", out])
    assert r.returncode == 2
    assert "exists: choose another --out" in r.stderr
    assert out.read_text() == "earlier capture\n"
