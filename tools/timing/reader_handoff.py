"""reader_handoff.py - the serial reader at 1 kHz in real time, and its hand-off latency (plan item
DPR-03, acceptance: "1 kHz for 60 s: 0 lost lines, 0 parse errors; hand-off latency p50/p99
reported from an exclusive bench window with machine load").

    .venv/Scripts/python tools/timing/reader_handoff.py [--rate 1000] [--seconds 60] [--out FILE]
                                                        [--report-only]

The reference simulated device streams at the given rate in real time, in this process, behind
its in-process port, as the rig driver "simulated" runs it. The reader thread
(threemaze/devices/serial_lines.py) reads it and hands every batch of records to an asyncio
event loop with call_soon_threadsafe, as a session with an event loop does. For every sample:

    hand-off  the read that completed its line (t_host_ns) -> the event loop's callback
    pickup    its bytes entering the port's buffer -> the event loop's callback

The design measured a hand-off of 0.09 ms (p50) and 0.2 ms (p99) on the development PC (three-maze-
notes, design/motion_core.json, design sketch section 8). The tool prints and writes p50, p99 and
the maximum of both, with the samples lost (sequence gaps) and the lines rejected. Exit code 0 when
no sample was lost or rejected and the hand-off p99 is below 2 ms (the plan's proposed local limit),
1 otherwise; with --report-only (CI, shared runners) the latency is reported, not judged.

Timing is judged only in an exclusive bench window with the machine load recorded (DPR-27):

    node tools/timing/bench-run.mjs --purpose "DPR-03 reader hand-off" --record out/lock.json \\
        -- .venv/Scripts/python tools/timing/reader_handoff.py --out out/handoff.json

Measured 2026-10-22 on the development PC (Windows 11 build 26200, Python 3.12.10), that way, with
no other bench run (CPU 1.5 % before the run, 3.5 % mean and 13.8 % peak during it, 1.8 % after):
59,986 samples at 1 kHz in 60 s, none lost or rejected, all in order; hand-off p50 0.076 ms,
p99 0.231 ms, max 1.016 ms; pickup p50 0.105 ms, p99 0.334 ms, max 2.694 ms.
"""
import argparse
import asyncio
import json
import platform
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from threemaze.api import DeviceContext  # noqa: E402
from threemaze.core.clock import SessionClock  # noqa: E402
from threemaze.core.records import DeviceSample, StopReport  # noqa: E402
from threemaze.devices.simulated import SimulatedDevice  # noqa: E402

P99_LIMIT_MS = 2.0
SENSOR = {"cmPerCount": 0.0349, "radPerCount": 0.05}   # as rigs/sim.json
MATRIX = [[0, 0.0349, 0], [0.0349, 0, 0], [0, 0, 0.05]]
TRAJECTORY = {"kind": "segments", "segments": [   # running, licking, turning (rigs/sim-gate.json)
    {"durationS": 4, "forwardCmPerS": 11.168}, {"durationS": 2, "forwardCmPerS": 22.336},
    {"durationS": 2, "lick": 1}, {"durationS": 1, "yawDegPerS": 45},
    {"durationS": 3, "forwardCmPerS": 11.168}]}


class _TimedDevice(SimulatedDevice):
    """The simulated device, with the time each sample's bytes enter the port's buffer."""

    arrivals: dict[int, int]

    def open_port(self):
        port = super().open_port()
        self.arrivals = {}
        deliver = port.pacer._sink

        def timed(deliveries):
            now = time.perf_counter_ns()
            for d in deliveries:
                if d.kind == "S" and d.seq is not None:
                    self.arrivals[d.seq] = now
            deliver(deliveries)

        port.pacer._sink = timed
        return port


def quantiles(values_ns: list[int]) -> dict[str, float | None]:
    if not values_ns:
        return {"p50_ms": None, "p99_ms": None, "max_ms": None}
    s = sorted(values_ns)
    return {"p50_ms": round(s[len(s) // 2] / 1e6, 4), "p99_ms": round(s[int(0.99 * len(s))] / 1e6, 4),
            "max_ms": round(s[-1] / 1e6, 4)}


async def measure(rate_hz: float, seconds: float, folder: Path) -> dict:
    loop = asyncio.get_running_loop()
    handoff: list[int] = []
    pickup: list[int] = []
    seqs: list[int] = []
    end: list[StopReport] = []
    device: _TimedDevice | None = None

    def on_batch(name, records):
        now = time.perf_counter_ns()
        for record in records:
            if isinstance(record, DeviceSample):
                handoff.append(now - record.t_host_ns)
                arrived = device.arrivals.pop(record.seq, None)
                if arrived is not None:
                    pickup.append(now - arrived)
                seqs.append(record.seq)
            elif isinstance(record, StopReport):
                end.append(record)

    period_us = round(1e6 / rate_hz)
    entry = {"driver": "simulated", "deviceId": "sim-handoff", "periodUs": period_us,
             "sensor": SENSOR, "lick": 1, "trajectory": TRAJECTORY}
    ctx = DeviceContext(clock=SessionClock(), session_dir=folder, rig_dir=folder,
                        calibration={"matrix": MATRIX}, loop=loop, on_batch=on_batch)
    device = _TimedDevice("ball", entry, ctx)
    await asyncio.to_thread(device.open)
    try:
        await asyncio.to_thread(device.start)
        t0 = time.perf_counter()
        await asyncio.sleep(seconds)
        await asyncio.to_thread(device.stop)
        elapsed = time.perf_counter() - t0
    finally:
        await asyncio.to_thread(device.close)
    counters = device.profile.counters
    produced = end[0].n_samples if end else None
    in_order = seqs == list(range(len(seqs)))
    return {
        "rate_hz": rate_hz, "period_us": period_us, "seconds": seconds,
        "elapsed_s": round(elapsed, 3), "samples_produced": produced, "samples_received": len(seqs),
        "in_order": in_order, "counters": counters, "reader": device.reader.stats,
        "handoff": quantiles(handoff), "pickup": quantiles(pickup),
        "lost": (produced - len(seqs)) if produced is not None else None,
        "python": sys.version.split()[0], "platform": platform.platform(),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="The serial reader in real time: losses and hand-off"
                                             " latency (see the module docstring).")
    ap.add_argument("--rate", type=float, default=1000.0, help="samples per second (default 1000)")
    ap.add_argument("--seconds", type=float, default=60.0, help="how long to stream (default 60)")
    ap.add_argument("--out", help="write the result as JSON to this file")
    ap.add_argument("--report-only", action="store_true",
                    help="report the latency without judging it (shared CI runners)")
    args = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="three-maze-handoff-") as folder:
        result = asyncio.run(measure(args.rate, args.seconds, Path(folder)))
    c = result["counters"]
    rejected = c["crc_errors"] + c["parse_errors"] + c["overflow"] + c["unknown"]
    complete = (result["lost"] == 0 and c["seq_gaps"] == 0 and rejected == 0 and result["in_order"]
                and c["seq_regressions"] == 0)
    fast = result["handoff"]["p99_ms"] is not None and result["handoff"]["p99_ms"] < P99_LIMIT_MS
    result["judged"] = not args.report_only
    result["ok"] = complete and (fast or args.report_only)
    h, p = result["handoff"], result["pickup"]
    print(f"{result['samples_received']} of {result['samples_produced']} samples at {args.rate:g} Hz in"
          f" {result['elapsed_s']} s: lost {result['lost']}, seq gaps {c['seq_gaps']}, rejected"
          f" {rejected}, in order {result['in_order']}")
    print(f"hand-off (read -> loop): p50 {h['p50_ms']} ms, p99 {h['p99_ms']} ms, max {h['max_ms']} ms")
    print(f"pickup (port buffer -> loop): p50 {p['p50_ms']} ms, p99 {p['p99_ms']} ms, max {p['max_ms']} ms")
    print("ok" if result["ok"] else "FAILED" + ("" if complete else ": samples lost or rejected")
          + ("" if fast or args.report_only else f": hand-off p99 not below {P99_LIMIT_MS} ms"))
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
