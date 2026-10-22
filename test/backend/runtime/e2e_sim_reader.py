"""Child process of test_serial_lines.py: a session with the serial_lines driver, in a process where
the end-to-end bench's simulated rig (test/e2e/sim) replaces pySerial's ports.

    python e2e_sim_reader.py <rig file> <seconds> <result.json>

The parent starts it with THREEMAZE_SIM=1, test/e2e/sim on PYTHONPATH, THREEMAZE_SIM_PROTOCOL=v1
and THREEMAZE_SIM_DEVICE. It refuses to run (exit code 3) unless serial.Serial is the sim's, so it
can never open a real port; a sim that cannot start stops the process with exit code 86 first.
"""
import json
import sys
import time
from pathlib import Path

import serial

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO))

from threemaze.core.records import DeviceSample  # noqa: E402
from threemaze.runtime import Session, TaskSource  # noqa: E402


def main():
    rig, seconds, out = sys.argv[1], float(sys.argv[2]), Path(sys.argv[3])
    serial_class = f"{serial.Serial.__module__}.{serial.Serial.__qualname__}"
    if serial_class != "threemaze_sim.teensy.SimSerial":
        print(f"serial.Serial is {serial_class}, not the simulated rig's: refusing to run",
              file=sys.stderr)
        return 3
    got = []

    class Listener:
        def on_device_batch(self, session, device, records):
            got.extend(r for r in records if isinstance(r, DeviceSample))

    session = Session()
    session.add_listener(Listener())
    session.configure(rig)
    session.set_task(TaskSource("declarative", "e2e-sim-reader"))
    session.arm()
    session.start()
    time.sleep(seconds)
    session.stop()
    ball = session.devices["ball"].describe()
    raw_sum = [0, 0, 0]
    for sample in got:
        raw_sum = [a + b for a, b in zip(raw_sum, sample.raw)]
    out.write_text(json.dumps({
        "serial_class": serial_class, "state": session.state.value,
        "counters": ball["counters"], "guarantees": ball["guarantees"],
        "stop_report": ball["stop_report"],
        "seqs": [s.seq for s in got], "raw_sum": raw_sum,
        "t_dev_steps": sorted({b.t_dev_us - a.t_dev_us for a, b in zip(got, got[1:])}),
    }), encoding="utf-8")
    return 0 if session.state.value == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
