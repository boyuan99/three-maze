"""Shared setup for the backend tests (test/backend).

Puts the repository root on sys.path, so the tests import the code under test the way the backend
does (`backend.src.main`; experiments/*.py are loaded from their files), and provides the fakes and
helpers the tests share. Nothing here needs real hardware: no Teensy, NI-DAQ or D: drive.

Run from the repository root:  .venv/Scripts/python -m pytest   (Windows; .venv/bin/python elsewhere)
"""
import asyncio
import errno
import importlib.util
import inspect
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO = Path(__file__).resolve().parents[2]
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

# Name of the thread BackendServer.start() runs the parent-pipe watcher in (backend/src/main.py);
# tests that run a watcher in their own thread use the same name, so the guards below find it
WATCHER_THREAD = "parent-pipe"


# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------

class FakeAOTask:
    """Fake NI-DAQmx analog-output task; also works as `with nidaqmx.Task() as task:`.

    Records every write in volts (`writes`). Like the real output, it holds its last value when the
    task is closed (`value_at_close`), and a closed task rejects writes.
    """

    def __init__(self):
        self.writes = []
        self.closed = False
        self.value_at_close = None
        self.ao_channels = SimpleNamespace(add_ao_voltage_chan=lambda channel: None)

    @property
    def value(self):
        return self.writes[-1] if self.writes else 0.0

    def write(self, data, auto_start=None):
        if self.closed:
            raise RuntimeError("task is closed")
        self.writes.append(float(data[0] if isinstance(data, (list, tuple)) else data))

    def close(self):
        if not self.closed:
            self.value_at_close, self.closed = self.value, True

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.close()
        return False


class FakeSerial:
    """Fake pyserial port that records what is written to it."""

    port = "COM_TEST"

    def __init__(self):
        self.is_open = True
        self.writes = []

    def write(self, data):
        self.writes.append(bytes(data))
        return len(data)

    def close(self):
        self.is_open = False


class CountingExperiment:
    """Stand-in for an active experiment: counts terminate() calls, each taking `delay` seconds."""

    def __init__(self, delay=0.05):
        self.experiment_id = "counting"
        self.delay = delay
        self.terminated = 0

    async def terminate(self):
        self.terminated += 1
        await asyncio.sleep(self.delay)
        return {}


class ParentPipe:
    """A real OS pipe whose read end serves as stdin, the way Electron connects the backend."""

    def __init__(self):
        read_fd, self._write_fd = os.pipe()
        self.reader = open(read_fd, "r", encoding="utf-8")

    def send(self, data: bytes):
        os.write(self._write_fd, data)

    def close_writer(self):
        """Close the parent's end, as when Electron exits or crashes."""
        if self._write_fd is not None:
            os.close(self._write_fd)
            self._write_fd = None


# ---------------------------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------------------------

@pytest.fixture(scope="session")
def repo_root():
    return REPO


@pytest.fixture
def make_ao():
    """Factory for FakeAOTask."""
    return FakeAOTask


@pytest.fixture
def fake_serial():
    return FakeSerial()


@pytest.fixture
def counting_experiment():
    """Factory for CountingExperiment."""
    return CountingExperiment


@pytest.fixture
def run():
    """run(coro, timeout=10): run a coroutine in a new event loop; fail if it takes longer."""
    def run(coro, timeout=10):
        return asyncio.run(asyncio.wait_for(coro, timeout))
    return run


@pytest.fixture
def wait_until():
    """await wait_until(condition): yield to the event loop until condition() is true.

    Steps the loop instead of sleeping, so a test can act at a precise point (for example while
    a valve pulse is high) without depending on wall-clock timing.
    """
    async def wait_until(condition, turns=1000):
        for _ in range(turns):
            if condition():
                return
            await asyncio.sleep(0)
        raise AssertionError(f"condition not met after {turns} event-loop turns")
    return wait_until


@pytest.fixture(scope="session")
def experiment_class():
    """experiment_class('hallway04_experiment.py'): the experiment class defined in that file
    (the class with a _deliver_water method), loaded like the backend's ExperimentLoader does."""
    cache = {}

    def load(filename):
        if filename not in cache:
            path = REPO / "experiments" / filename
            spec = importlib.util.spec_from_file_location(path.stem, path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            classes = [obj for _, obj in inspect.getmembers(module, inspect.isclass)
                       if obj.__module__ == module.__name__ and hasattr(obj, "_deliver_water")]
            assert classes, f"no experiment class with _deliver_water in {path}"
            cache[filename] = classes[0]
        return cache[filename]
    return load


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("localhost", 0))
        return s.getsockname()[1]


@pytest.fixture
def new_server(monkeypatch):
    """Factory for BackendServer on a free port. The working directory is the repository root,
    as when Electron starts the backend (ExperimentLoader scans ./experiments)."""
    from backend.src.main import BackendServer
    monkeypatch.chdir(REPO)

    def new():
        return BackendServer(host="localhost", port=free_port())
    return new


def _join_watchers(timeout):
    for thread in threading.enumerate():
        if thread.name == WATCHER_THREAD:
            thread.join(timeout)


@pytest.fixture
def exit_calls(monkeypatch):
    """Make the backend's shutdown watchdog harmless: os._exit only records its argument, and
    SHUTDOWN_DEADLINE_S is 0.05 s. A watcher thread started during the test is joined before
    os._exit is restored, so it can never end the test run."""
    from backend.src.main import BackendServer
    calls = []
    monkeypatch.setattr(os, "_exit", calls.append)
    monkeypatch.setattr(BackendServer, "SHUTDOWN_DEADLINE_S", 0.05)
    yield calls
    _join_watchers(timeout=5)
    stuck = [t for t in threading.enumerate() if t.name == WATCHER_THREAD and t.is_alive()]
    assert not stuck, "a parent-pipe watcher thread did not finish"


@pytest.fixture
def parent_pipe(monkeypatch, exit_calls):
    """sys.stdin is the read end of a real pipe; the test writes to or closes the other end.

    Depends on exit_calls, so on teardown the pipe closes first (any watcher still polling it
    returns) and the watcher threads are joined before os._exit is restored.
    """
    pipe = ParentPipe()
    monkeypatch.setattr(sys, "stdin", pipe.reader)
    yield pipe
    pipe.close_writer()
    _join_watchers(timeout=5)
    pipe.reader.close()


# ---------------------------------------------------------------------------------------------
# The backend as a process (test_backend_process.py, test_backend_rig.py)
# ---------------------------------------------------------------------------------------------

# main() always serves on this port (backend/src/main.py). Its search for a free port does not
# notice a busy port on Windows (it probes with SO_REUSEADDR), so a backend started while
# three-maze or an end-to-end bench run holds the port crashes on bind instead of moving on
BACKEND_PORT = 8765
STARTUP_TIMEOUT_S = 30


def port_in_use(port):
    """Why `port` cannot be bound on localhost (a string), or None if it is free.

    Binds the way the backend's server does: without SO_REUSEADDR on Windows (asyncio sets it only
    on POSIX, where a listening socket still blocks the bind), on both loopback addresses, because
    the server listens on 'localhost'. A port held only by connections in TIME_WAIT counts as free,
    as it does for the server.
    """
    taken = {errno.EADDRINUSE, errno.EACCES,
             getattr(errno, "WSAEADDRINUSE", None), getattr(errno, "WSAEACCES", None)} - {None}
    for family, host in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            probe = socket.socket(family, socket.SOCK_STREAM)
        except OSError:
            continue  # no IPv6 on this machine
        with probe:
            if os.name == "posix":
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind((host, port))
            except OSError as exc:
                # Without IPv6 on the loopback, ::1 cannot be bound at all: not a busy port
                if family == socket.AF_INET or exc.errno in taken:
                    return f"{host}:{port}: {exc}"
    return None


@pytest.fixture
def backend_port_free():
    """Skip the test if the backend's port is taken, instead of failing with 'did not start'."""
    busy = port_in_use(BACKEND_PORT)
    if busy:
        pytest.skip(f"port {BACKEND_PORT} is in use ({busy}); close three-maze first "
                    "(and wait for any end-to-end bench run to finish)")


class BackendProcess:
    """`python -m backend.src.main` with its output collected by a thread, as Electron does
    (otherwise the backend would block on a full stdout pipe).

    The environment is the test run's, without any THREEMAZE_* variable, plus PYTHONUNBUFFERED=1,
    THREEMAZE_PARENT_PIPE=1 when `parent_pipe`, and `env` (a value of None removes the variable).
    """

    def __init__(self, repo_root, interpreter, parent_pipe, stdin, env=None):
        environ = {key: value for key, value in os.environ.items() if not key.startswith("THREEMAZE_")}
        environ["PYTHONUNBUFFERED"] = "1"
        if parent_pipe:
            environ["THREEMAZE_PARENT_PIPE"] = "1"
        for key, value in (env or {}).items():
            if value is None:
                environ.pop(key, None)
            else:
                environ[key] = value
        self.popen = subprocess.Popen([str(interpreter), "-m", "backend.src.main"], cwd=repo_root,
                                      stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                      env=environ)
        self.lines = []
        self.port = None
        self.ready = threading.Event()
        self._reader = threading.Thread(target=self._collect_output, daemon=True)
        self._reader.start()

    def _collect_output(self):
        for raw in iter(self.popen.stdout.readline, b""):
            line = raw.decode(errors="replace")
            self.lines.append(line)
            if self.port is None and "WebSocket server ready on port" in line:
                self.port = int(line.rsplit(" ", 1)[-1])
                self.ready.set()
        self.ready.set()  # output closed: the backend has exited

    @property
    def log(self):
        return "".join(self.lines)

    def wait(self, timeout):
        """Exit code, or None if the backend is still running after `timeout` seconds."""
        try:
            code = self.popen.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None
        self._reader.join(timeout=5)
        return code

    def shut_down(self, timeout):
        """Ask the backend to stop the way Electron does before it quits (proc.stdin.end('shutdown'));
        returns the exit code, or None if it is still running after `timeout` seconds."""
        self.popen.stdin.write(b"shutdown")
        self.popen.stdin.close()
        return self.wait(timeout)

    def stop(self):
        if self.popen.poll() is None:
            if sys.platform == "win32":
                # Kill by PID with its children: a venv's python.exe is a launcher that runs the
                # interpreter as a child process
                subprocess.run(["taskkill", "/PID", str(self.popen.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.popen.kill()
        try:
            self.popen.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        if self.popen.stdin and not self.popen.stdin.closed:
            try:
                self.popen.stdin.close()
            except OSError:
                pass
        self._reader.join(timeout=5)
        if not self._reader.is_alive():
            self.popen.stdout.close()


@pytest.fixture
def start_backend(repo_root, backend_port_free):
    """start_backend(interpreter=python, parent_pipe=True, stdin=PIPE, env=None) -> a running
    BackendProcess. Every backend started is stopped (killed with its children if it is still
    running) when the test ends. Skips the test if the backend's port is taken."""
    started = []

    def start(interpreter=Path(sys.executable), parent_pipe=True, stdin=subprocess.PIPE, env=None):
        backend = BackendProcess(repo_root, interpreter, parent_pipe, stdin, env)
        started.append(backend)
        backend.ready.wait(STARTUP_TIMEOUT_S)
        assert backend.port is not None, f"the backend did not start:\n{backend.log}"
        return backend

    yield start
    for backend in started:
        backend.stop()
