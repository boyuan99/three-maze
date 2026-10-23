"""Crash durability of the session recorder (plan item DPR-07): a process recording a synthetic
session at 1,000 samples per second (recorder_child.py) is killed 20 times at random moments
(TerminateProcess on Windows, SIGKILL elsewhere: nothing of the process runs after it). Every
table and log must stay readable each time, losing at most a cut-off last line, and the newest
sample on disk must be at most about one flush interval (1 s) older than the kill.

The experiment-data design measured the same for TSV and JSONL (20/20 readable, at most 1 s lost;
three-maze-notes design/experiment_data.json, section 6, "Format decision").
"""
import random
import subprocess
import sys
import time
from pathlib import Path

from threemaze.record import read_log, read_table
from threemaze.record.formats import (COMMANDS, EVENTS, FRAMES, LONG_TASKS, POSES, SAMPLES,
                                      TRIALS)
from threemaze.record.writer import FLUSH_INTERVAL_S

CHILD = Path(__file__).with_name("recorder_child.py")
KILLS = 20
PARALLEL = 4                  # children at a time, each killed at its own moment
KILL_AFTER_S = (0.2, 2.6)     # after the child is ready: before, at and after its first flushes
# What a crash may cost: the second of plan item DPR-07 ("at most about 1 s of data lost on a
# crash"), plus the time the writer thread needs to write and fsync a second of data and the
# scheduling delays of a busy test machine. The bound does not follow FLUSH_INTERVAL_S, so a writer
# that flushed less often would fail here.
ACCEPTED_LOSS_S = 1.0
MAX_LOSS_S = ACCEPTED_LOSS_S + 0.75


def run_child(folder, seed, rng):
    proc = subprocess.Popen([sys.executable, str(CHILD), str(folder), str(seed)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return {"proc": proc, "folder": folder, "delay": rng.uniform(*KILL_AFTER_S)}


def test_every_file_stays_readable_after_random_kills(tmp_path):
    assert FLUSH_INTERVAL_S <= ACCEPTED_LOSS_S
    rng = random.Random(20261022)
    losses, partial = [], 0
    for first in range(0, KILLS, PARALLEL):
        children = []
        for n in range(first, min(first + PARALLEL, KILLS)):
            folder = tmp_path / f"kill{n:02d}"
            folder.mkdir()
            children.append(run_child(folder, n, rng))
        for child in children:
            line = child["proc"].stdout.readline()
            assert line.strip() == b"ready", child["proc"].stderr.read().decode(errors="replace")
            child["ready"] = time.perf_counter_ns()
            child["kill_at"] = child["ready"] + int(child["delay"] * 1e9)
        for child in sorted(children, key=lambda c: c["kill_at"]):
            pause = (child["kill_at"] - time.perf_counter_ns()) / 1e9
            if pause > 0:
                time.sleep(pause)
            assert child["proc"].poll() is None, child["proc"].stderr.read().decode()
            child["killed"] = time.perf_counter_ns()
            child["proc"].kill()
        for child in children:
            child["proc"].wait(10)
            child["proc"].stdout.close()
            child["proc"].stderr.close()
            losses.append(check_folder(child))
            partial += child["partial"]
    print(f"\n{KILLS} kills: newest sample on disk {min(losses):.3f} to {max(losses):.3f} s"
          f" before the kill; {partial} of {7 * KILLS} files ended in a cut-off line")
    assert max(losses) <= MAX_LOSS_S, losses


def check_folder(child):
    """Every file reads (DataFileError otherwise); returns how old the newest sample was."""
    folder = child["folder"]
    tables = {name: read_table(folder / name) for name in (SAMPLES, POSES, FRAMES, TRIALS)}
    logs = {name: read_log(folder / name) for name in (EVENTS, COMMANDS, LONG_TASKS)}
    samples = tables[SAMPLES].rows
    assert [r["seq"] for r in samples] == list(range(len(samples))), folder
    poses = tables[POSES].rows
    assert [r["seq"] for r in poses] == list(range(len(poses))), folder
    frames = [r["frame"] for r in tables[FRAMES].rows]
    assert frames == list(range(len(frames))), folder
    assert all(r["rewards_requested"] == r["rewards_done"] == 1 for r in tables[TRIALS].rows)
    assert all(r["kind"] in ("zone", "trial_start", "trial_end") for r in logs[EVENTS].records)
    assert all(r["cmd_id"] >= 1 for r in logs[COMMANDS].records)
    child["partial"] = sum(f.partial for f in [*tables.values(), *logs.values()])
    newest = samples[-1]["t_host_ns"] if samples else child["ready"]
    return (child["killed"] - newest) / 1e9
