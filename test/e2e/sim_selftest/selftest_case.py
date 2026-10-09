"""One self-test case of the simulated rig, run in a child process by selftest_sim.py.

Usage: python selftest_case.py <case> <result.json> [--report-timing]   (not a pytest module: it runs on import)
Writes {"case", "ok", "checks": [[name, ok, detail], ...], "timing": [...]} to result.json (works under
pythonw.exe).

Timing tolerances (first line after init, median gap, lines per 1.32 s, pulse width) are tight for
Windows' 15.6 ms timer on a loaded machine. They are asserted by default; with --report-timing
(run.mjs --ci, for shared CI runners) they are only measured and reported in "timing".
"""
import json
import os
import sys
import time
import traceback
import warnings

CASE, OUT = sys.argv[1], sys.argv[2]
REPORT_TIMING = "--report-timing" in sys.argv[3:]
checks = []
timing = []


def check(name, ok, detail=""):
    checks.append([name, bool(ok), detail if isinstance(detail, str) else repr(detail)])
    return ok


def timing_check(name, value, low, high):
    """A timing tolerance: asserted as a check, or with --report-timing only reported."""
    within = value is not None and low <= value <= high
    timing.append({"name": name, "value": value, "low": low, "high": high, "within": within,
                   "asserted": not REPORT_TIMING})
    if not REPORT_TIMING:
        check(name, within, value)
    return within


def expect_raises(name, fn, exc_type, text=None):
    try:
        fn()
    except exc_type as exc:
        return check(name, text is None or text in str(exc), f"{type(exc).__name__}: {exc}")
    except Exception as exc:  # noqa: BLE001
        return check(name, False, f"unexpected {type(exc).__name__}: {exc}")
    return check(name, False, "no exception")


def parse_like_hallway04(line):
    values = line.split(",")
    if len(values) < 13 or not line[0].isdigit():
        return None
    return {"timestamp": values[0], "x": float(values[7]), "y": float(values[8]), "theta": float(values[9]),
            "water": int(values[10]), "direction": float(values[11]), "frameCount": int(values[12])}


def case_main():
    import threemaze_sim.runtime as rt
    check("sim active", rt.settings is not None, rt.settings and rt.settings.as_dict())
    check("serial not imported at startup", "serial" not in sys.modules)
    check("numpy not imported at startup", "numpy" not in sys.modules)

    # --- Teensy -----------------------------------------------------------------------------
    import serial
    check("serial.Serial patched", serial.Serial.__name__ == "SimSerial", serial.Serial)
    port = serial.Serial(port="COM3", baudrate=115200, timeout=0.001, write_timeout=1.0)
    check("port open", port.is_open and port.port == "COM3")
    time.sleep(0.2)
    check("silent before init", port.in_waiting == 0, port.in_waiting)
    expect_raises("second open is busy", lambda: serial.Serial(port="com3", baudrate=115200),
                  serial.SerialException, "could not open port 'com3': PermissionError(13, 'Access is denied.', None, 5)")
    t_init = time.perf_counter()
    port.write("10000,50,10,1\n".encode("utf-8"))
    lines, arrivals = [], []
    deadline = time.perf_counter() + 1.32
    while time.perf_counter() < deadline:  # hallway04's read loop, minus asyncio
        if port.in_waiting > 0:
            line = port.readline().decode("utf-8").strip()
            if line:
                lines.append(line)
                arrivals.append(time.perf_counter())
        else:
            time.sleep(0.001)
    # Timing tolerances leave room for a loaded machine; the e2e scenarios check the rate again
    check("lines arrive after init", len(lines) >= 2, len(lines))
    timing_check("about 26 lines in 1.32 s", len(lines), 24, 27)
    timing_check("first line one period after init", arrivals[0] - t_init if arrivals else None, 0.045, 0.08)
    gaps = sorted(b - a for a, b in zip(arrivals, arrivals[1:]))
    timing_check("median gap 50 ms", gaps[len(gaps) // 2] if gaps else None, 0.048, 0.052)
    parsed = [parse_like_hallway04(line) for line in lines]
    check("all lines parse as 13 fields", all(parsed), lines[:2])
    check("line 1 exact", lines[0] == "50000,0,16,50000,0,16,50000,0,16,0,0,0,1", lines[0])
    check("device timestamps step 50000 us",
          all(int(p["timestamp"]) == 50000 * (i + 1) for i, p in enumerate(parsed)), [p["timestamp"] for p in parsed[:3]])
    check("y=16 x=0 theta=0", all(p["y"] == 16 and p["x"] == 0 and p["theta"] == 0 for p in parsed))
    port.write(b"STOP\n")
    time.sleep(0.15)
    port.reset_input_buffer()
    time.sleep(0.15)
    check("STOP stops the stream", port.in_waiting == 0, port.in_waiting)
    port.close()
    check("closed", not port.is_open)
    expect_raises("in_waiting on closed port", lambda: port.in_waiting, serial.SerialException, "ClearCommError failed")
    expect_raises("write on closed port", lambda: port.write(b"x"), serial.PortNotOpenError)
    reopened = serial.Serial("COM3", 115200, timeout=1)
    check("reopen after close", reopened.is_open)
    reopened.close()
    via_url = serial.serial_for_url("COM7", baudrate=115200, timeout=0)
    check("serial_for_url gives the sim", type(via_url).__name__ == "SimSerial" and via_url.is_open)
    via_url.close()

    # --- NI-DAQ -------------------------------------------------------------------------------
    import nidaqmx
    from nidaqmx.constants import SampleTimingType, VoltageUnits
    from nidaqmx.errors import DaqError, DaqWriteError
    check("nidaqmx.Task patched", nidaqmx.Task.__name__ == "SimTask", nidaqmx.Task)
    task = nidaqmx.Task()
    task.ao_channels.add_ao_voltage_chan("Dev1/ao0", min_val=0.0, max_val=5.0, units=VoltageUnits.VOLTS)
    task.timing.samp_timing_type = SampleTimingType.ON_DEMAND
    check("write returns 1", task.write([5.0], auto_start=True) == 1)
    time.sleep(0.07)
    task.write([0.0], auto_start=True)
    expect_raises("out-of-range write", lambda: task.write([6.0], auto_start=True), DaqWriteError, "-200561")
    task.close()
    expect_raises("write after close", lambda: task.write([0.0], auto_start=True), DaqError, "-200088")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        task.close()
    check("second close warns", any("already closed" in str(w.message) for w in caught), [str(w.message) for w in caught])
    with nidaqmx.Task() as ctx_task:  # backend/src/hardware/water_delivery.py style
        ctx_task.ao_channels.add_ao_voltage_chan("Dev1/ao0")
        ctx_task.write(0.0)
    expect_raises("context manager closed the task", lambda: ctx_task.write(0.0), DaqError, "-200088")

    # --- D:\VirmenData ------------------------------------------------------------------------
    os.makedirs(r"D:\VirmenData", exist_ok=True)
    data_path = "D:\\VirmenData\\selftest-%d.txt" % os.getpid()
    with open(data_path, "w") as fh:
        fh.write("1\t2\n")
    target = os.path.join(rt.settings.virmen_dir, os.path.basename(data_path))
    check("open redirected", os.path.isfile(target), target)
    check("exists (forward slashes, lower case)", os.path.exists(data_path.replace("\\", "/").lower()))
    check("isdir D:/VirmenData", os.path.isdir("D:/VirmenData"))
    sidecar = os.path.splitext(data_path)[0] + ".renderer.jsonl"
    with open(sidecar, "a", encoding="utf-8") as fh:
        fh.write("{}\n")
    check("sidecar redirected", os.path.isfile(os.path.join(rt.settings.virmen_dir, os.path.basename(sidecar))))
    import pathlib
    check("pathlib read", pathlib.Path(data_path).read_text() == "1\t2\n")
    check("other D: paths untouched", not os.path.exists(r"D:\Other"))
    check("escape via .. is not redirected", not os.path.exists("D:\\VirmenData\\..\\" + os.path.basename(data_path)))
    os.remove(data_path)
    os.remove(sidecar)
    check("remove redirected", not os.path.exists(target))

    # --- logs ---------------------------------------------------------------------------------
    serial_events = [json.loads(line) for line in open(rt.settings.serial_log, encoding="utf-8")]
    mine = [r for r in serial_events if r["pid"] == os.getpid()]
    sent = [r for r in mine if r["event"] == "sent"]
    read = [r for r in mine if r["event"] == "read"]
    received = [r for r in mine if r["event"] == "received"]
    # Every line read was sent and logged as read (the count itself is a timing matter, above)
    check("serial.jsonl has sent/read/received", len(lines) >= 2 and len(sent) >= len(lines) and len(read) >= len(lines)
          and len(received) >= 2, (len(sent), len(read), len(received), len(lines)))
    check("serial records have t and wall", all("t" in r and "wall" in r for r in mine))
    daq_events = [json.loads(line) for line in open(rt.settings.daq_log, encoding="utf-8")]
    mine = [r for r in daq_events if r["pid"] == os.getpid()]
    writes = [r for r in mine if r["event"] == "write"]
    check("daq writes flattened", [w["value"] for w in writes][:2] == [5.0, 0.0], [w["value"] for w in writes])
    width = (writes[1]["t"] - writes[0]["t"]) * 1e3
    timing_check("pulse width ~70 ms", width, 69, 90)
    closes = [r for r in mine if r["event"] == "close"]
    check("close records value_at_close", closes and closes[0]["value_at_close"] == 0.0, closes[:1])


def case_inactive():
    import serial
    check("serial.Serial is real", serial.Serial.__module__ == "serial.serialwin32", serial.Serial)
    check("open is real", open.__module__ in ("io", "_io", "builtins"), open)
    check("threemaze_sim not imported", "threemaze_sim" not in sys.modules)


def case_serial_missing():
    import serial
    expect_raises("missing COM3", lambda: serial.Serial(port="COM3", baudrate=115200, timeout=0.001, write_timeout=1.0),
                  serial.SerialException,
                  "could not open port 'COM3': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")


def case_serial_silent():
    import serial
    port = serial.Serial(port="COM3", baudrate=115200, timeout=0.001)
    port.write(b"10000,50,10,1\n")
    time.sleep(0.3)
    check("silent device sends nothing", port.in_waiting == 0, port.in_waiting)
    port.close()


def case_daq_missing():
    import nidaqmx
    from nidaqmx.errors import DaqNotFoundError
    expect_raises("DAQ missing", nidaqmx.Task, DaqNotFoundError, "Could not find an installation of NI-DAQmx")


def case_data_missing():
    # Windows localizes the text after "[WinError 3]"; the path must be the drive root
    expect_raises("makedirs on missing D:", lambda: os.makedirs(r"D:\VirmenData", exist_ok=True), FileNotFoundError,
                  "[WinError 3]")
    try:
        os.makedirs(r"D:\VirmenData", exist_ok=True)
    except FileNotFoundError as exc:
        check("makedirs fails at the drive root", exc.filename == "D:\\", exc.filename)
    expect_raises("open on missing D:", lambda: open(r"D:\VirmenData\x.txt", "w"), FileNotFoundError,
                  "[Errno 2] No such file or directory: 'D:\\\\VirmenData\\\\x.txt'")
    check("exists is False", not os.path.exists(r"D:\VirmenData"))


def case_speed():
    import serial
    port = serial.Serial(port="COM3", baudrate=115200, timeout=0.001)
    port.write(b"10000,50,10,1\n")
    time.sleep(0.53)
    lines = [port.readline().decode().strip() for _ in range(10)]
    port.close()
    ys = [int(float(line.split(",")[8])) for line in lines]
    check("speed 1.3 -> 20.8 counts on average", sum(ys) == 208 and set(ys) <= {20, 21}, ys)


def wait_for_file(path, timeout_s):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.02)
    return False


def case_hold_port():
    """Child of case_cross_process_busy: open COM3, say so (OUT.ready), and hold it until the parent
    releases it (OUT.release) or HOLD_S has passed. Files, not sleeps, so a slow machine cannot race."""
    import serial
    port = serial.Serial(port="COM3", baudrate=115200, timeout=0.001)
    check("child holds COM3", port.is_open)
    open(OUT + ".ready", "w").close()
    wait_for_file(OUT + ".release", float(os.environ.get("HOLD_S", "30")))
    port.close()


def case_cross_process_busy():
    import subprocess
    import serial
    holder_out = OUT + ".holder.json"
    holder = subprocess.Popen([sys.executable, __file__, "hold_port", holder_out], env=dict(os.environ, HOLD_S="30"),
                              creationflags=0x08000000)
    try:
        if check("holder opened COM3", wait_for_file(holder_out + ".ready", 30)):
            expect_raises("COM3 held by another process is busy", lambda: serial.Serial(port="COM3", baudrate=115200),
                          serial.SerialException, "could not open port 'COM3': PermissionError(13, 'Access is denied.', None, 5)")
    finally:
        open(holder_out + ".release", "w").close()
        holder.wait(30)
    check("holder exited cleanly", holder.returncode == 0, holder.returncode)
    port = serial.Serial(port="COM3", baudrate=115200)
    check("free again after the holder closed it", port.is_open)
    port.close()


CASES = {name[5:]: fn for name, fn in globals().items() if name.startswith("case_")}

try:
    CASES[CASE]()
except Exception:  # noqa: BLE001
    check("no exception", False, traceback.format_exc())
with open(OUT, "w", encoding="utf-8") as fh:
    json.dump({"case": CASE, "pid": os.getpid(), "executable": sys.executable,
               "ok": all(ok for _, ok, _ in checks), "checks": checks,
               "timing_mode": "report" if REPORT_TIMING else "assert", "timing": timing}, fh, indent=1)
