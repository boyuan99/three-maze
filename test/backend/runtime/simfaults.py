"""The reference simulated device of device protocol v1 with injected faults, as the reader's and
the recorder's tests run it (test_serial_lines.py, test_recorder_reader.py): its motion and
calibration as rigs/sim.json has them, one fault of every type of plan item DPR-02 with what each
costs the reader, the running totals that a raw-line log ends with, and a session of the
serial_lines driver on the end-to-end bench's simulated serial port (test/e2e/sim), run in a child
process (e2e_sim_reader.py) that never opens a real port.
"""
import json
import math
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SIM_ROOT = REPO / "test" / "e2e" / "sim"
CHILD = Path(__file__).with_name("e2e_sim_reader.py")

SENSOR = {"cmPerCount": 0.0349, "radPerCount": 0.05}  # v0.3's mapping, as rigs/sim.json
SIM_MATRIX = [[0, 0.0349, 0], [0.0349, 0, 0], [0, 0, 0.05]]
B1_LIKE = {"kind": "segments", "segments": [
    {"durationS": 0.3, "forwardCmPerS": 11.168},
    {"durationS": 0.2, "lick": 1},
    {"durationS": 0.25, "yawDegPerS": 45, "leftCmPerS": 3.0},
    {"durationS": 0.25, "forwardCmPerS": -5.0, "yawDegPerS": -90}]}
RATES = {"20Hz": 50000, "250Hz": 4000, "1000Hz": 1000}


def faults_for(period_us, first=8):
    """One fault of every type (DPR-02), apart from each other, and what each costs the reader."""
    s = [first + 6 * k for k in range(7)]
    gap = max(1, min(400, (period_us - 1) // 4))
    silence_ms = max(1, 3 * period_us // 1000)
    return [
        ({"type": "drop", "seq": s[0], "count": 2}, {"seq_gaps": 1, "samples_lost": 2}),
        ({"type": "badCrc", "seq": s[1]}, {"crc_errors": 1, "seq_gaps": 1, "samples_lost": 1}),
        ({"type": "truncate", "seq": s[2], "keepBytes": 9},       # takes the next line with it
         {"crc_errors": 1, "seq_gaps": 1, "samples_lost": 2}),
        ({"type": "split", "seq": s[3], "pieces": 3, "gapUs": gap}, {}),
        ({"type": "burst", "seq": s[4], "count": 3}, {}),
        ({"type": "silence", "seq": s[5], "durationMs": silence_ms},
         {"seq_gaps": 1, "samples_lost": math.ceil(silence_ms * 1000 / period_us)}),
        ({"type": "wrap", "seq": s[6]}, {}),
    ]


def expected_counters(faults):
    out = {"crc_errors": 0, "seq_gaps": 0, "samples_lost": 0}
    for _, cost in faults:
        for key, value in cost.items():
            out[key] += value
    return out


def last_totals(raw_log, seq):
    """The running totals of sample seq, from a raw-line log."""
    marker = b"\tS," + str(seq).encode() + b","
    [line] = [line for line in raw_log.read_bytes().splitlines() if marker in line]
    return [int(v) for v in line.split(b"*")[0].split(b",")[5:]]


def raw_sum(got):
    totals = None
    for s in got:
        totals = list(s.raw) if totals is None else [a + b for a, b in zip(totals, s.raw)]
    return totals


def run_e2e_reader(folder, period_us, faults):
    """A session of the serial_lines driver in a process where test/e2e/sim stands in for
    pySerial's ports (THREEMAZE_SIM=1, THREEMAZE_SIM_PROTOCOL=v1): the device-v1 sim at period_us
    with these faults, until a dozen samples after the last one. Its rig file, data root and the
    sim's files are in folder. Returns the child's result (e2e_sim_reader.py) and the sim's folder,
    which holds its log of every line it sent (serial.jsonl)."""
    device = {"deviceId": "sim-e2e", "periodUs": period_us, "sensor": SENSOR, "lick": 1,
              "trajectory": B1_LIKE, "faults": [f for f, _ in faults]}
    sim_dir = folder / "sim"
    sim_dir.mkdir()
    (folder / "device.json").write_text(json.dumps(device), encoding="utf-8")
    rig = {"format": "three-maze-rig", "version": 1, "name": "e2e-sim",
           "devices": {"ball": {"driver": "serial_lines", "port": "SIMV1READER", "profile": "v1",
                                "deviceId": "sim-e2e", "periodUs": period_us}},
           "bindings": {"motion": "ball"}, "calibration": {"ball": {"matrix": SIM_MATRIX}},
           "dataRoot": str(folder / "data")}
    (folder / "rig.json").write_text(json.dumps(rig), encoding="utf-8")
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("THREEMAZE_") and k != "ELECTRON_RUN_AS_NODE"}
    env.update(PYTHONPATH=str(SIM_ROOT), PYTHONIOENCODING="utf-8", THREEMAZE_SIM="1",
               THREEMAZE_SIM_DIR=str(sim_dir), THREEMAZE_SIM_PROTOCOL="v1",
               THREEMAZE_SIM_DEVICE=str(folder / "device.json"),
               PYTHONDONTWRITEBYTECODE="1")         # no __pycache__ in test/e2e/sim
    seconds = (faults[-1][0]["seq"] + 12) * period_us / 1e6
    out = folder / "result.json"
    proc = subprocess.run([sys.executable, str(CHILD), str(folder / "rig.json"), str(seconds),
                           str(out)], cwd=folder, env=env, capture_output=True, text=True,
                          timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return json.loads(out.read_text(encoding="utf-8")), sim_dir


def sim_log(sim_dir):
    """The e2e sim's log (serial.jsonl): every line it sent, every fault, every command."""
    return [json.loads(line) for line in
            (sim_dir / "serial.jsonl").read_text(encoding="utf-8").splitlines()]


def intact_seqs(serial_log, faults):
    """The samples the e2e sim sent intact, in one line or in pieces, in order: every S line it
    sent, but for the corrupted ones and the line after the truncated one, which is lost with it."""
    sent = {r["seq"] for r in serial_log if r["event"] == "sent" and r["kind"] in ("S", "piece")}
    spoilt = {f["seq"] for f, _ in faults if f["type"] in ("badCrc", "truncate")}
    truncated = [f["seq"] for f, _ in faults if f["type"] == "truncate"]
    return sorted(sent - spoilt - {seq + 1 for seq in truncated})
