"""Simulated three-maze rig: Teensy (pyserial), NI-DAQ (nidaqmx) and the D:\\VirmenData folder.

Active only when THREEMAZE_SIM=1 and this directory is on PYTHONPATH; otherwise this file only
runs the sitecustomize it shadows (if there is one). See threemaze_sim/__init__.py for the
variables, the simulated protocol and the log files.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_FAIL_EXIT_CODE = 86


def _same_dir(a, b):
    return os.path.normcase(os.path.normpath(os.path.abspath(a))) == os.path.normcase(os.path.normpath(b))


def _on_pythonpath():
    return any(entry and _same_dir(entry, _HERE) for entry in os.environ.get("PYTHONPATH", "").split(os.pathsep))


def _fail_closed(exc):
    """THREEMAZE_SIM=1 but the sim could not be set up: exit rather than run against real hardware."""
    import traceback
    text = ("threemaze_sim: THREEMAZE_SIM=1 but the simulated rig could not be activated; exiting "
            f"with code {_FAIL_EXIT_CODE} so that no real hardware is used.\n"
            + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    try:
        sim_dir = os.environ.get("THREEMAZE_SIM_DIR")
        if not sim_dir:  # same default as threemaze_sim.config
            import tempfile
            sim_dir = os.path.join(tempfile.gettempdir(), "three-maze-sim")
        if not os.path.splitdrive(os.path.abspath(sim_dir))[0].upper() == "D:":
            os.makedirs(sim_dir, exist_ok=True)
            with open(os.path.join(sim_dir, "sim_error.log"), "a", encoding="utf-8") as fh:
                fh.write(f"pid {os.getpid()}: {text}\n")
    except Exception:
        pass
    try:
        if sys.stderr is not None:  # pythonw.exe may have no stderr
            sys.stderr.write(text)
            sys.stderr.flush()
    except Exception:
        pass
    os._exit(_FAIL_EXIT_CODE)


def _run_shadowed_sitecustomize():
    from importlib.machinery import PathFinder
    path = [entry for entry in sys.path if not _same_dir(entry or os.curdir, _HERE)]
    spec = PathFinder.find_spec("sitecustomize", path)
    if spec is None or spec.loader is None:
        return
    import importlib.util
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)


if os.environ.get("THREEMAZE_SIM") == "1" and _on_pythonpath():
    try:
        import threemaze_sim
        threemaze_sim.activate()
    except BaseException as _exc:  # noqa: BLE001 - fail closed on anything
        _fail_closed(_exc)

try:
    _run_shadowed_sitecustomize()
except Exception as _exc:  # same as site.py does for a failing sitecustomize
    try:
        if sys.stderr is not None:
            sys.stderr.write(f"Error in sitecustomize; set PYTHONVERBOSE for traceback:\n{type(_exc).__name__}: {_exc}\n")
    except Exception:
        pass
