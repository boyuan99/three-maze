"""threemaze_sim: a simulated rig for the three-maze Python backend.

Lets the real experiment code (e.g. experiments/hallway04_experiment.py) run on a machine without
a Teensy, an NI-DAQ device or a D: drive. Nothing in the repo is changed: the sim patches the
process at startup through sitecustomize.py.

Activation
    The sim is active only in a Python process started with BOTH
      THREEMAZE_SIM=1
      PYTHONPATH containing the directory that holds sitecustomize.py (test/e2e/sim)
    e.g. (Git Bash, from the repo root):
      THREEMAZE_SIM=1 THREEMAZE_SIM_DIR=<run dir> PYTHONPATH="$(cygpath -m "$PWD/test/e2e/sim")" \\
        .venv/Scripts/python.exe -m backend.src.main      (pythonw.exe works the same way)
    Electron passes its environment to the backend, so setting these variables on Electron
    activates the sim in the backend it spawns. If activation fails, the process exits with
    code 86 and writes $THREEMAZE_SIM_DIR/sim_error.log, so a "sim" run can never fall through
    to real hardware.

Environment
    THREEMAZE_SIM_DIR     where logs and data go (default: <temp dir>/three-maze-sim; not on D:)
    THREEMAZE_SIM_SPEED   running-speed multiplier, default 1 (16 forward counts per sample)
    THREEMAZE_SIM_SERIAL  ok | missing | busy | silent        (see teensy.py)
    THREEMAZE_SIM_OPEN_DELAY_S  seconds the port open blocks first (default 0; see teensy.py)
    THREEMAZE_SIM_DAQ     ok | missing                        (see daq.py)
    THREEMAZE_SIM_DATA    ok | missing                        (see paths.py)
    Failure modes and what the real system does on a Windows PC without the devices:
      SERIAL=missing  "could not open port 'COM3': FileNotFoundError(2, 'The system cannot find the
                      file specified.', None, 2)" (identical to real pyserial here; registration fails)
      SERIAL=busy     "... PermissionError(13, 'Access is denied.', None, 5)" (COM3 held elsewhere;
                      a second backend sharing THREEMAZE_SIM_DIR gets this too)
      DAQ=missing     DaqNotFoundError at nidaqmx.Task() (hallway04 then runs without rewards)
      DATA=missing    os.makedirs('D:\\VirmenData') -> FileNotFoundError [WinError 3] ... 'D:\\'
    Hardware state after a crash: the last daq.jsonl write of a pid is the level its output was left
    at; a task without a close record was never closed (e.g. the process was killed).

What is simulated
    serial.Serial    -> teensy.SimSerial: a Teensy streaming the hallway firmware's 13-field CSV
                        at the period given by the init string (50 ms for "10000,50,10,1")
    nidaqmx.Task     -> daq.SimTask: an analog output whose writes are logged
    D:\\VirmenData    -> $THREEMAZE_SIM_DIR/VirmenData (paths.py)
    pyserial and nidaqmx are patched right after their first import (importhook.py), so the sim
    does not change what the backend imports, or when.

Files in $THREEMAZE_SIM_DIR (JSON lines; every record has t = time.perf_counter(),
wall = time.time(), pid, event)
    sim.jsonl      activate (pid, ppid, executable, argv, cwd, settings), patched, redirect
    serial.jsonl   port and device events, every line sent and every write received
    daq.jsonl      task events, every write {value} and close {value_at_close}
    VirmenData/    the experiment's data files (and the backend's .renderer.jsonl sidecars)
    ports/         lock files that make a simulated COM port exclusive
    perf_counter values are comparable only within one process (pid).

Motion profile and units (hallway04)
    Each sample carries y = 16 counts (x = theta = 0). hallway04 turns it into a world velocity
    v_z = -y * ENCODER_TO_CM / DT = -16 * 0.0349 / 0.05 = -11.168 m/s, which the renderer holds
    (setLinvel) and integrates with Rapier's fixed 1/60 s step once per frame, i.e. 0.5584 m per
    50 ms sample at 60 frames/s. hallway04 ends a trial at |z| >= TRIAL_END_Y = 70 m, so a trial
    takes 126 samples, about 6.3 s, at THREEMAZE_SIM_SPEED=1 and 60 Hz rendering (the time scales
    with 60/frame rate, because the renderer's step does not depend on the frame interval).
"""
import os
import sys

__all__ = ["activate"]


def activate():
    from . import config, importhook, paths, runtime, simlog

    settings = config.from_env()
    os.makedirs(settings.sim_dir, exist_ok=True)
    runtime.settings = settings
    runtime.sim_log = simlog.JsonlLog(settings.sim_log)
    runtime.serial_log = simlog.JsonlLog(settings.serial_log)
    runtime.daq_log = simlog.JsonlLog(settings.daq_log)

    paths.install(settings, runtime.sim_log)
    importhook.install({"serial": _patch_serial, "nidaqmx": _patch_nidaqmx})

    runtime.sim_log.write(
        "activate",
        ppid=os.getppid(),
        executable=sys.executable,
        argv=list(getattr(sys, "orig_argv", None) or getattr(sys, "argv", None) or []),
        cwd=os.getcwd(),
        settings=settings.as_dict(),
        sim_root=config.SIM_ROOT,
        python=sys.version.split()[0],
    )


def _patched(name, install):
    from . import runtime
    try:
        install()
    except Exception as exc:
        runtime.sim_log.write("patch_failed", module=name, error=repr(exc))
        raise ImportError(f"threemaze_sim could not patch {name}: {exc!r}") from exc


def _patch_serial(module):
    def install():
        from . import teensy
        teensy.install(module)
    _patched(module.__name__, install)


def _patch_nidaqmx(module):
    def install():
        from . import daq
        daq.install(module)
    _patched(module.__name__, install)
