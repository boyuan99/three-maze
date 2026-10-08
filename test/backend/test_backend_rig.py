"""Without a working rig, registration fails with the device's error and the backend stays usable.

The backend is started the way Electron starts it (see test_backend_process.py). The simulated rig
of the end-to-end bench (test/e2e/sim; see test/e2e/README.md) stands in for the Teensy, the NI-DAQ
and the D: drive: it is active in a Python process started with THREEMAZE_SIM=1 and test/e2e/sim on
PYTHONPATH, and THREEMAZE_SIM_SERIAL / THREEMAZE_SIM_DATA make a device missing. Each test registers
hallway04_experiment.py as the renderer does (experiment_register with {filename, config: {}}),
then checks that
- the reply is an experiment_error naming the missing device,
- the backend still answers (ping) and released what the experiment had opened,
- the only traceback in its output is the one it logs with the registration error, and
- it exits with code 0 on 'shutdown'.

Cases (from the step-0 bench, sim_validate/run_all.py): COM3 missing, the data folder
D:\\VirmenData cannot be created (no D: drive), and no rig at all (no simulation: the real pyserial
reports the missing COM3; skipped on a machine that has a COM3, which the test would open).

Windows only, like the simulated rig. Each case takes about 1 s; the missing data folder about 4 s,
because hallway04 waits 2.5 s for the Teensy before it opens the data file.
"""
import asyncio
import ctypes
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest
import websockets

pytestmark = pytest.mark.skipif(sys.platform != "win32",
                                reason="the simulated rig (test/e2e/sim) models a Windows rig")

SIM_ROOT = Path(__file__).resolve().parents[1] / "e2e" / "sim"
EXPERIMENT = "hallway04_experiment.py"
REGISTER_TIMEOUT_S = 30  # the renderer's own timeout for experiment_register
EXIT_TIMEOUT_S = 8       # see test_backend_process.py
COM3_MISSING = "could not open port 'COM3': FileNotFoundError(2,"  # then a localized message


def load_jsonl(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


@pytest.fixture
def sim_dir(tmp_path):
    """Folder for the rig's logs ($THREEMAZE_SIM_DIR). The rig refuses one on D: (where it
    redirects D:\\VirmenData from), so if pytest's temp folder is there, use one in the user
    profile instead and remove it afterwards. Request it before start_backend, so the backend
    has stopped when the folder is removed."""
    if tmp_path.drive.upper() != "D:":
        yield tmp_path / "sim"
        return
    base = Path(tempfile.mkdtemp(prefix="three-maze-pytest-", dir=Path.home()))
    try:
        yield base / "sim"
    finally:
        shutil.rmtree(base, ignore_errors=True)


def rig_env(sim_dir, **modes):
    """Environment that activates the simulated rig; modes: serial='missing', data='missing'."""
    env = {
        "THREEMAZE_SIM": "1",
        "THREEMAZE_SIM_DIR": str(sim_dir),
        "PYTHONPATH": str(SIM_ROOT),
        "PYTHONDONTWRITEBYTECODE": "1",  # no __pycache__ in test/e2e/sim
    }
    env.update({f"THREEMAZE_SIM_{name.upper()}": value for name, value in modes.items()})
    return env


async def register_and_ping(port):
    """Connect as the renderer does, register EXPERIMENT, then ping. Returns both replies."""
    async with websockets.connect(f"ws://127.0.0.1:{port}", open_timeout=10) as ws:
        async def request(msg_type, data, request_id, timeout):
            await ws.send(json.dumps({"type": msg_type, "data": data, "requestId": request_id}))
            while True:  # skip events, such as serial_data sent while the experiment initializes
                reply = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if reply.get("requestId") == request_id:
                    return reply

        await request("connect", {"clientId": "pytest"}, "connect-1", 10)
        registered = await request("experiment_register", {"filename": EXPERIMENT, "config": {}},
                                   "register-1", REGISTER_TIMEOUT_S)
        pong = await request("ping", {}, "ping-1", 10)
    return registered, pong


def register_and_shut_down(backend, *error_parts):
    """Register (it must fail with all of error_parts in the error), ping, disconnect, then shut
    the backend down; check that the failure did not take the backend with it."""
    try:
        registered, pong = asyncio.run(asyncio.wait_for(register_and_ping(backend.port), 60))
    except Exception as exc:
        pytest.fail(f"talking to the backend failed: {exc!r}\n{backend.log}")
    code = backend.shut_down(EXIT_TIMEOUT_S)
    log = backend.log

    assert registered.get("type") == "experiment_error", f"{registered}\n{log}"
    error = registered["data"]["error"]
    for part in error_parts:
        assert part in error, f"{part!r} not in the registration error {error!r}"
    assert pong.get("type") == "pong", f"the backend stopped answering after the failure: {pong}"
    assert code == 0, f"exit code {code}:\n{log}"
    assert "Shutdown requested" in log

    # The backend logs the registration error with its traceback (exc_info=True). Any other
    # traceback, an unhandled task error or main()'s 'Server error' would be a crash
    lines = log.splitlines()
    tracebacks = [i for i, line in enumerate(lines) if line.startswith("Traceback")]
    assert len(tracebacks) == 1 and "Error registering experiment" in lines[tracebacks[0] - 1], log
    assert "Task exception was never retrieved" not in log, log
    assert "Server error" not in log, log
    return log


def test_serial_port_missing(sim_dir, start_backend):
    backend = start_backend(env=rig_env(sim_dir, serial="missing"))
    log = register_and_shut_down(backend, COM3_MISSING)

    activations = [r for r in load_jsonl(sim_dir / "sim.jsonl") if r["event"] == "activate"]
    assert activations and "backend.src.main" in activations[0]["argv"], "the rig was not active"
    serial = load_jsonl(sim_dir / "serial.jsonl")
    assert [r["port"] for r in serial if r["event"] == "open_failed"] == ["COM3"], serial
    # Nothing after the serial port was touched: no DAQ task, no data file
    assert not load_jsonl(sim_dir / "daq.jsonl")
    assert not list((sim_dir / "VirmenData").iterdir())
    assert "Persistent DAQ task created" not in log and "Data file opened" not in log


def test_data_folder_cannot_be_created(sim_dir, start_backend):
    # No D: drive: os.makedirs(r"D:\VirmenData") fails after the serial port and the DAQ task opened
    backend = start_backend(env=rig_env(sim_dir, data="missing"))
    register_and_shut_down(backend, "[WinError 3]", "D:\\")

    redirects = [r for r in load_jsonl(sim_dir / "sim.jsonl") if r["event"] == "redirect_missing"]
    assert any(r["fn"] == "os.makedirs" and r["src"] == "D:\\VirmenData" for r in redirects), redirects
    assert not (sim_dir / "VirmenData").exists(), "a data folder was created"
    # Fails closed: the serial port opened for the experiment is closed again, and the valve output
    # was never driven above 0 V and its task is closed
    serial = load_jsonl(sim_dir / "serial.jsonl")
    assert [r["event"] for r in serial if r["event"] in ("open", "close")] == ["open", "close"], serial
    daq = load_jsonl(sim_dir / "daq.jsonl")
    assert [r["value"] for r in daq if r["event"] == "write" and r["value"] != 0.0] == [], daq
    assert any(r["event"] == "close" for r in daq), daq


def com3_exists():
    """True if Windows knows a COM3 device (or cannot tell); the no-rig test would open it."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    buffer = ctypes.create_unicode_buffer(1024)
    if kernel32.QueryDosDeviceW("COM3", buffer, len(buffer)):
        return True
    if ctypes.get_last_error() != 2:  # anything but ERROR_FILE_NOT_FOUND: assume it may exist
        return True
    from serial.tools import list_ports
    return any(port.device.upper() == "COM3" for port in list_ports.comports())


def test_no_rig_fails_closed(start_backend):
    # The backend started without the simulation on a machine without the rig: the real pyserial
    # cannot open COM3, so nothing else (DAQ task, data file on D:) is ever touched
    if com3_exists():
        pytest.skip("this machine has a COM3; without the simulated rig the test would open it")
    backend = start_backend(env={"PYTHONPATH": None, "PYTHONDONTWRITEBYTECODE": "1"})
    log = register_and_shut_down(backend, COM3_MISSING)

    assert "threemaze_sim" not in log and "serialwin32.py" in log, "the real pyserial was not used"
    assert "Persistent DAQ task created" not in log and "Data file opened" not in log
