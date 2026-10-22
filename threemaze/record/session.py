"""The session record, session.json (plan item DPR-08a; docs/data-format-v1.md, section 10;
schema/session-v1.schema.json).

One JSON object, rewritten whole and atomically (a temporary file, fsync, then a rename over the
old one) whenever it changes: when the session is armed, at each change of state, when the motion
worker says hello, when the renderer reports ready, and a last time once the session has ended and
the recorder has closed its files. A reader never sees half a record.

Who waits for the disk: the first record, each change of state and the last record are written by
the thread that makes them (the runtime's). What arrives from elsewhere (the hello and the ready
report from the link server, the rig information and the build from the launcher) is written a
moment later by the record's own thread, so that the link server never waits for an fsync, nor for
a rename that Windows refuses while a virus scanner has the file open: its event loop also carries
the samples and the heartbeats, and a stall of about 80 ms trips the motion worker's watchdog
(link protocol, B1 and B2).

`status` says whether the session was closed properly:

    running    from arming until the session has ended: its runtime holds the session's lock
    complete   ended as planned, and the recorder has closed its files
    aborted    ended early or after a failure (abort_reason says why), and the recorder has closed
               its files (if it was open)
    crashed    its runtime ended while the session was open: a later session found the record still
               "running" with nobody holding its lock, and marked it (`crash` says when and who)

A complete or aborted session's files hold every row the recorder was given, unless
recording.errors says otherwise (a write that failed, or a writer that did not finish).

The lock is an operating-system lock on session.lock in the session folder, held from the first
record until the last. The operating system releases it when the process ends, however it ends,
so a record that says running while its lock is free belongs to a runtime that is gone, and a
session still open in another runtime is never taken for a crashed one.

What is recorded (DPR-08a): the status and every state with its clock anchor; the session clock;
the three-maze version, git commit and dirty flag; Python and every installed package; the
operating system; the rig file (its copy, hash and the defaults in force) and the task; every
device's identity, protocol profile and guarantee level (device protocol v1, section 8.3); the
motion worker's versions from its hello (link protocol, C5: Electron, Chromium, V8, three.js,
Rapier, Ajv); the render host and its warm-up report (render.report ready); the rig-information
probe's displays and GPU (plan item REN-1, when the launcher passes them); the build kind and
dist hash (REN-26, idem); the free-disk check; the recorder's summary. The subject is open (owner
decision D16): `subject` stays null until it is decided and entered (plan items DPR-08b, TS-29).
"""
import importlib.metadata
import json
import logging
import os
import platform
import socket
import subprocess
import threading
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .. import __version__ as RUNTIME_VERSION
from ..core.clock import ClockAnchor
from .formats import FORMAT, FORMAT_VERSION
from .session_dir import RIG_COPY

SESSION_JSON = "session.json"
LOCK_FILE = "session.lock"
STATUSES = ("running", "complete", "aborted", "crashed")
REPO = Path(__file__).resolve().parents[2]
# How long finish() waits for a write the record's thread has begun, and then for its own turn
FINISH_WAIT_S = 10.0

log = logging.getLogger("threemaze.record")


# --- the lock -------------------------------------------------------------------------------------

def _lock(fh) -> None:
    """Lock the first byte of an open file without waiting; OSError if someone holds it."""
    if os.name == "nt":
        import msvcrt
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(fh) -> None:
    if os.name == "nt":
        import msvcrt
        fh.seek(0)
        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


class SessionLock:
    """The lock a runtime holds on its open session (session.lock in the session folder)."""

    def __init__(self, path: Path):
        self.path = path
        self._fh = None

    def acquire(self) -> None:
        fh = open(self.path, "a+b")
        try:
            _lock(fh)
        except OSError:
            fh.close()
            raise
        self._fh = fh

    def release(self) -> None:
        """Unlock and remove the lock file. Idempotent."""
        if self._fh is None:
            return
        try:
            _unlock(self._fh)
        except OSError:
            pass
        self._fh.close()
        self._fh = None
        try:
            self.path.unlink()
        except OSError:
            pass


def lock_is_free(path: Path) -> bool:
    """Nobody holds the lock of a session (or it has no lock file)."""
    try:
        fh = open(path, "rb+")
    except FileNotFoundError:
        return True
    except OSError:
        return False  # it exists but cannot be opened: take it as held
    with fh:
        try:
            _lock(fh)
        except OSError:
            return False
        _unlock(fh)
        return True


# --- versions and the system ----------------------------------------------------------------------

def _command(args: list[str], cwd: Path) -> str | None:
    """A command's output, or None if it cannot run or fails. No console window on Windows (the
    runtime may run under pythonw, which has none)."""
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=10,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def three_maze_version(repo: Path = REPO) -> dict[str, Any]:
    """The three-maze version (package.json), the runtime package's, and the checkout's git commit
    and dirty flag (a tracked file differs from the commit), null when git cannot tell."""
    try:
        with open(repo / "package.json", encoding="utf-8") as fh:
            version = json.load(fh).get("version")
    except (OSError, ValueError):
        version = None
    commit = _command(["git", "rev-parse", "HEAD"], repo)
    # --no-optional-locks: git status would otherwise refresh and rewrite the checkout's index at
    # every session, and a git command run on the rig meanwhile would find index.lock taken
    status = _command(["git", "--no-optional-locks", "status", "--porcelain",
                       "--untracked-files=no"], repo)
    return {"version": version, "runtime_version": RUNTIME_VERSION, "git_commit": commit,
            "git_dirty": None if commit is None or status is None else status != ""}


def installed_packages() -> dict[str, str]:
    """Every package installed in the runtime's Python environment: name -> version."""
    packages = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata["Name"]
        if name:
            packages[name] = dist.version
    return dict(sorted(packages.items(), key=lambda item: item[0].lower()))


def runtime_info() -> dict[str, Any]:
    return {
        "host": socket.gethostname(),
        "pid": os.getpid(),
        "three_maze": three_maze_version(),
        "python": {"version": platform.python_version(),
                   "implementation": platform.python_implementation()},
        "packages": installed_packages(),
        "os": {"platform": platform.platform(), "system": platform.system(),
               "release": platform.release(), "version": platform.version(),
               "machine": platform.machine()},
    }


def clock_info() -> dict[str, Any]:
    """The session clock: time.perf_counter_ns() and what Python says about it."""
    info = time.get_clock_info("perf_counter")
    return {"source": "time.perf_counter_ns()", "implementation": info.implementation,
            "resolution_s": info.resolution, "monotonic": info.monotonic,
            "adjustable": info.adjustable}


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return dict(value)
    if isinstance(value, tuple):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not a JSON value")


def _dumps(record: Mapping[str, Any]) -> str:
    return json.dumps(record, indent=2, allow_nan=False, default=_json_value) + "\n"


def _write_json(path: Path, record: Mapping[str, Any]) -> None:
    _write_text(path, _dumps(record))


def _write_text(path: Path, text: str) -> None:
    """Write a file atomically: a temporary file next to it, fsync, rename over it."""
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    for attempt in range(10):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: a reader (or a virus scanner) has the file open
            if attempt == 9:
                raise
            time.sleep(0.02)


def _anchor(anchor: ClockAnchor | None) -> dict[str, Any] | None:
    return None if anchor is None else {"perf_ns": anchor.perf_ns, "wall_utc": anchor.wall_utc}


# --- the record -----------------------------------------------------------------------------------

class SessionRecord:
    """session.json of one session. Thread-safe: the runtime's thread, the link server and the
    launcher may all update it.

        open()            take the lock, write the first record, start the record's thread
        state_changed()   a change of state, written before it returns (the runtime's thread)
        update()          new sections, also through client_hello(), render_ready(),
                          set_rig_info() and set_build(): returns at once, and the record's thread
                          writes the record a moment later
        flush()           wait until every update made so far is on disk
        finish()          the last record, written before it returns; then the lock is released.
                          An update that arrives later is logged and not recorded.
    """

    def __init__(self, folder: Path, *, session_id: str, rig, task, data_root: Path):
        self.folder = Path(folder)
        self.path = self.folder / SESSION_JSON
        self._mutex = threading.Lock()                   # guards data, _asked, _covered, _ending
        self._on_disk = threading.Condition(self._mutex)
        self._asked = 0          # updates that asked for a write
        self._covered = 0        # of them, those that the record on disk includes
        self._ending = False     # finish() has begun
        self._thread: threading.Thread | None = None
        self._io = threading.Lock()                      # one write at a time, newest data last
        self._wake = threading.Event()
        self._lock = SessionLock(self.folder / LOCK_FILE)
        rig_data = rig.to_dict()
        self.data: dict[str, Any] = {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "session": session_id,
            "status": "running",
            "state": None,
            "abort_reason": None,
            "states": [],
            "clock": {"session_clock": clock_info(), "start": None, "stop": None},
            "runtime": runtime_info(),
            "rig": {"name": rig.name, "source": str(rig.rig_dir / Path(rig.source).name),
                    "copy": RIG_COPY, "sha256": rig.sha256,
                    "data_root": str(data_root), "bindings": dict(rig.bindings),
                    "in_force": {"motion": rig_data["motion"], "backend": rig_data["backend"]}},
            "task": None if task is None else {"kind": task.kind, "ref": task.ref},
            "subject": None,
            "devices": {},
            "client": None,
            "render": None,
            "rig_info": None,
            "build": {"kind": None, "dist_sha256": None},
            "preflight": None,
            "crashed_sessions": [],
            "recording": None,
        }
        self.closed = False

    def open(self) -> None:
        """Take the session's lock, write the first record (status running) and start the
        record's thread."""
        self._lock.acquire()
        try:
            self.write()
        except BaseException:
            self._lock.release()
            raise
        self._thread = threading.Thread(target=self._run, name="session-record", daemon=True)
        self._thread.start()

    def write(self, timeout_s: float | None = None) -> bool:
        """Write the record now, on this thread, with every update made so far. Writes take turns,
        and each takes the data when its turn comes, so the newest data is written last. False if
        the turn did not come within timeout_s (None: wait as long as it takes)."""
        if not self._io.acquire(timeout=-1 if timeout_s is None else timeout_s):
            return False
        try:
            with self._mutex:
                text = _dumps(self.data)
                asked = self._asked
            _write_text(self.path, text)
            with self._on_disk:
                self._covered = max(self._covered, asked)
                self._on_disk.notify_all()
        finally:
            self._io.release()
        return True

    def flush(self, timeout_s: float | None = 5.0) -> bool:
        """Wait until every update made so far is on disk; False if that took longer than
        timeout_s (or the record's thread is not running)."""
        with self._on_disk:
            target = self._asked
            return self._on_disk.wait_for(lambda: self._covered >= target, timeout_s)

    def update(self, write: bool = True, **sections: Any) -> None:
        """Replace top-level sections (devices, preflight, crashed_sessions, ...). With write, the
        record's thread writes the record; this returns without waiting for the disk."""
        unknown = [key for key in sections if key not in self.data]
        if unknown:
            raise KeyError(f"session.json has no section {unknown[0]!r}")
        with self._mutex:
            if self._ending:
                log.warning("session record %s: %s arrived after the session ended; not recorded",
                            self.path, ", ".join(sections))
                return
            self.data.update(sections)
            if write:
                self._asked += 1
        if write:
            self._wake.set()

    def _run(self) -> None:
        """The record's thread: writes the record whenever an update asks for it."""
        while True:
            self._wake.wait()
            self._wake.clear()
            with self._mutex:
                if self._ending:
                    return  # finish() writes the last record itself
            try:
                self.write()
            except Exception as exc:  # noqa: BLE001 - the next write includes this update
                log.error("session record %s not written: %r", self.path, exc)

    def state_changed(self, state: str, anchor: ClockAnchor, reason: str | None = None,
                      write: bool = True) -> None:
        with self._mutex:
            self.data["state"] = state
            self.data["states"].append({"state": state, **_anchor(anchor), "reason": reason})
            if state == "running":
                self.data["clock"]["start"] = _anchor(anchor)
            if state in ("complete", "aborted"):
                self.data["clock"]["stop"] = _anchor(anchor)
            if state == "aborted":
                self.data["abort_reason"] = reason
        if write:
            self.write()

    def client_hello(self, data: Mapping[str, Any], t_host_ns: int | None = None) -> None:
        """The data of the motion worker's hello (link protocol, C5): the client program, the
        protocol version it speaks and the versions of what it runs. Its token is not kept."""
        client = data.get("client") or {}
        self.update(client={"role": data.get("role"), "impl": client.get("impl"),
                            "version": client.get("version"),
                            "protocol_version": data.get("version"),
                            "versions": dict(data.get("versions") or {}),
                            "t_host_ns": t_host_ns})

    def render_ready(self, data: Mapping[str, Any], t_host_ns: int | None = None) -> None:
        """The data of render.report ready: which render host draws, why it fell back if it did,
        and its warm-up report (ADR-0003, Decision 3)."""
        render = {key: value for key, value in data.items() if key != "kind"}
        render.setdefault("fallback_reason", None)
        render["t_host_ns"] = t_host_ns
        self.update(render=render)

    def set_rig_info(self, info: Mapping[str, Any]) -> None:
        """What `npm run rig:info` (plan item REN-1) found on this computer: the displays, the
        GPU, the operating system and the renderer's versions."""
        self.update(rig_info=dict(info))

    def set_build(self, kind: str, dist_sha256: str | None) -> None:
        """How the renderer was built and served (plan item REN-26), for example rig or
        dev-server, and the hash of the build it loaded."""
        self.update(build={"kind": kind, "dist_sha256": dist_sha256})

    def finish(self, status: str, **sections: Any) -> None:
        """The last record, once the session has ended and its files are closed; then the lock is
        released. It includes every update made before; the record's thread ends first. Never
        raises: a record that cannot be written is logged."""
        if status not in ("complete", "aborted"):
            raise ValueError(f"a session ends complete or aborted, not {status!r}")
        with self._mutex:
            self._ending = True
            self.data["status"] = status
            self.data.update(sections)
        self._wake.set()
        thread, self._thread = self._thread, None
        try:
            if thread is not None:
                thread.join(FINISH_WAIT_S)  # a write it has begun ends first
            if not self.write(timeout_s=FINISH_WAIT_S):
                raise TimeoutError(f"a write still in progress after {FINISH_WAIT_S:g} s")
        except Exception as exc:  # noqa: BLE001 - ending the session must not fail here
            log.error("session record %s: the last record was not written: %r", self.path, exc)
        finally:
            self._lock.release()
            self.closed = True


# --- crashed sessions -----------------------------------------------------------------------------

def _read_record(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def find_crashed_sessions(data_root: Path) -> list[Path]:
    """Session folders under data_root whose record still says running while nobody holds their
    lock: the runtime that had them open has ended without closing them."""
    try:
        folders = sorted(path for path in Path(data_root).iterdir() if path.is_dir())
    except OSError:
        return []
    found = []
    for folder in folders:
        record = _read_record(folder / SESSION_JSON)
        if record is not None and record.get("status") == "running" and lock_is_free(
                folder / LOCK_FILE):
            found.append(folder)
    return found


def mark_crashed(folder: Path, *, detected_by: str) -> bool:
    """Mark a crashed session's record (status crashed, and when and by which session it was
    found) and remove its stale lock file; everything else in the record stays as it was. Returns
    whether it marked the record.

    It takes the session's lock first and reads the record again under it, so a session that is
    open, that another runtime is marking, or that was closed after find_crashed_sessions() read
    its record (a runtime writes its last record before it releases the lock) is left alone."""
    folder = Path(folder)
    lock = SessionLock(folder / LOCK_FILE)
    try:
        lock.acquire()
    except OSError:
        return False
    try:
        path = folder / SESSION_JSON
        record = _read_record(path)
        if record is None or record.get("status") != "running":
            return False
        record["status"] = "crashed"
        record["crash"] = {"detected_wall_utc": datetime.now(timezone.utc).isoformat(
            timespec="microseconds"), "detected_by": detected_by,
            "last_state": record.get("state")}
        _write_json(path, record)
        return True
    finally:
        lock.release()  # and the stale lock file goes with it
