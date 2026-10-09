"""capture_raw.py - record the device's serial stream exactly as it arrives, with a host time stamp per line
(plan item REL-02). The capture gives the legacy-stream adapter (DPR-04) real golden lines and answers
D17's questions about the device (sample period, whether field 0 is a microsecond clock, field 12).

Usage (PowerShell or cmd, from the repository folder, with three-maze closed so that the port is free):
    .venv\\Scripts\\python tools\\capture_raw.py --port COM3 --minutes 30
    .venv\\Scripts\\python tools\\capture_raw.py --port COM3 --seconds 60 --out out\\capture\\test.tsv
Stop early with Ctrl+C: what was received so far is kept.

What it sends to the device: only the init line, once, 2 s after opening the port ("10000,50,10,1" and a
newline, at 115200 baud): exactly what v0.3's hallway01/02/04 experiments send so that the device streams
(experiments/hallway04_experiment.py:157-173). With --no-init it sends nothing at all. Opening the port
asserts DTR and RTS, as pyserial does by default and as the v0.3 backend's port does too. Nothing else is
ever written to the device. TODO(DPR-06a): take the port, baud rate and init line from the rig file once
rig files exist; until then they are the options below, with v0.3's values as defaults.

Output (default out\\capture\\raw-<port>-<date>-<time>.tsv; an existing file is never overwritten):
  - lines starting with "#": the settings, the clock anchors (wall clock and perf_counter_ns read together
    at the start and at the end), every write to the device, and the totals at the end, as JSON;
  - then one line per line received: <host perf_counter_ns> TAB <the line's bytes exactly as received,
    its line ending included>. The stamp is taken when the host reads the bytes that complete the line,
    i.e. after USB and driver buffering. Bytes that are not text are written as they are. A line still
    incomplete when the capture stops is written with a newline added and counted in the totals.
Lines that arrive before the init line (a device that already streams) are recorded too.
"""
import argparse
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

FORMAT = "three-maze raw capture 1"
V03_INIT_LINE = "10000,50,10,1"     # experiments/hallway04_experiment.py:172
V03_INIT_DELAY_S = 2.0              # experiments/hallway04_experiment.py:169
V03_BAUD = 115200                   # experiments/hallway04_experiment.py:157
V03_PORT = "COM3"                   # experiments/hallway04_experiment.py:156 (the control file may name another)
FLUSH_EVERY_S = 1.0


def anchor():
    return {"wall_utc": datetime.now(timezone.utc).isoformat(timespec="microseconds"), "perf_counter_ns": time.perf_counter_ns()}


def comment(fh, obj):
    fh.write(b"# " + json.dumps(obj, ensure_ascii=True).encode("ascii") + b"\n")


def default_out(port):
    name = f"raw-{port.replace(os.sep, '_').replace(':', '')}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.tsv"
    return os.path.join("out", "capture", name)


def capture(port, baud, seconds, out_path, init_line, init_delay_s, serial_module=None, log=print):
    """Record for `seconds` (or until Ctrl+C). Returns the totals written into the file's last line."""
    if serial_module is None:
        import serial as serial_module  # pyserial (requirements.txt)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    stop = {"requested": False}

    def on_signal(signum, frame):
        stop["requested"] = True

    writes = []
    lines = 0
    received = 0
    buf = b""
    # The port first: if it cannot be opened, no file is left behind
    ser = serial_module.Serial(port=port, baudrate=baud, timeout=0.05, write_timeout=1.0)
    start = anchor()
    try:
        fh = open(out_path, "xb")  # "x": never overwrite an earlier capture
    except BaseException:
        ser.close()
        raise
    previous = signal.signal(signal.SIGINT, on_signal)
    with fh:
        comment(fh, {"format": FORMAT, "tool": "tools/capture_raw.py", "port": port, "baud": baud,
                     "init_line": init_line, "init_delay_s": init_delay_s, "planned_s": seconds,
                     "columns": "host perf_counter_ns<TAB>raw line bytes as received (line ending included)"})
        comment(fh, {"opened": start})
        log(f"capturing {port} at {baud} baud into {out_path} for {seconds:g} s (Ctrl+C stops early)")
        t0 = start["perf_counter_ns"]
        end = t0 + int(seconds * 1e9)
        init_due = t0 + int(init_delay_s * 1e9) if init_line is not None else None
        last_flush = t0
        try:
            while not stop["requested"]:
                now = time.perf_counter_ns()
                if now >= end:
                    break
                if init_due is not None and now >= init_due:
                    data = (init_line + "\n").encode("ascii")
                    ser.write(data)
                    t_write = time.perf_counter_ns()
                    writes.append({"perf_counter_ns": t_write, "bytes": data.decode("ascii")})
                    comment(fh, {"wrote_to_device": writes[-1]})
                    log(f"sent the init line {init_line!r}")
                    init_due = None
                chunk = ser.read(ser.in_waiting or 1)  # waits up to 50 ms for the first byte
                if chunk:
                    t = time.perf_counter_ns()
                    received += len(chunk)
                    buf += chunk
                    while True:
                        i = buf.find(b"\n")
                        if i < 0:
                            break
                        fh.write(b"%d\t" % t + buf[:i + 1])
                        buf = buf[i + 1:]
                        lines += 1
                if now - last_flush >= FLUSH_EVERY_S * 1e9:
                    fh.flush()
                    last_flush = now
        finally:
            ser.close()
            signal.signal(signal.SIGINT, previous)
            if buf:
                fh.write(b"%d\t" % time.perf_counter_ns() + buf + b"\n")
            done = anchor()
            totals = {"closed": done, "duration_s": round((done["perf_counter_ns"] - t0) / 1e9, 3),
                      "lines": lines, "bytes_received": received, "incomplete_last_line_bytes": len(buf),
                      "stopped_early": stop["requested"], "writes_to_device": writes}
            comment(fh, totals)
    log(f"{lines} lines ({received} bytes) in {totals['duration_s']} s; written to {os.path.abspath(out_path)}")
    return totals


def main(argv=None):
    ap = argparse.ArgumentParser(description="Record the device's serial stream as it arrives (see the module docstring).")
    ap.add_argument("--port", default=V03_PORT, help=f"serial port (default {V03_PORT})")
    ap.add_argument("--baud", type=int, default=V03_BAUD, help=f"baud rate (default {V03_BAUD})")
    length = ap.add_mutually_exclusive_group()
    length.add_argument("--minutes", type=float, help="how long to record (default 30)")
    length.add_argument("--seconds", type=float, help="how long to record, in seconds")
    ap.add_argument("--out", help="output file (default out\\capture\\raw-<port>-<date>-<time>.tsv)")
    ap.add_argument("--init", default=V03_INIT_LINE, help=f"the init line to send once (default {V03_INIT_LINE!r})")
    ap.add_argument("--init-delay", type=float, default=V03_INIT_DELAY_S, help=f"seconds after opening (default {V03_INIT_DELAY_S:g})")
    ap.add_argument("--no-init", action="store_true", help="send nothing at all: only listen")
    a = ap.parse_args(argv)
    seconds = a.seconds if a.seconds is not None else 60.0 * (a.minutes if a.minutes is not None else 30.0)
    if not seconds > 0:
        print("the capture needs a positive length", file=sys.stderr)
        return 2
    out = a.out or default_out(a.port)
    if os.path.exists(out):
        print(f"{out} exists: choose another --out (an earlier capture is never overwritten)", file=sys.stderr)
        return 2
    try:
        capture(a.port, a.baud, seconds, out, None if a.no_init else a.init, a.init_delay)
    except Exception as exc:  # noqa: BLE001 - say what failed, e.g. the port is missing or in use
        print(f"capture failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
