"""The session: from a rig file to open devices and back (plan item DPR-06a; ADR-0002).

    s = Session()
    s.configure("rigs/sim.json")                      # IDLE -> CONFIGURED: rig file validated
    s.set_task(TaskSource("declarative", "hallway04"))
    s.arm()        # -> ARMED: session folder with the rig file and its hash; devices open
    s.start()      # -> RUNNING: input devices stream
    s.stop()       # -> STOPPING -> COMPLETE (or ABORTED if a device failed while stopping)

abort(reason) ends any session that is not over (-> ABORTED). Whenever a session stops or aborts,
every output device is put in its safe state first, then input streams stop, then every device
is closed; a failing device does not keep the others from being made safe. Used as a context
manager, a session that is left by an exception is aborted.

Arming also checks that the data root has room for the session's data and opens the session's
recorder (plan item DPR-07, threemaze/record/recorder.py): `recorder` takes the device samples,
poses, events, commands and render reports of the session, and records every state the session
enters from ARMED on. Once the session has ended, the recorder is closed, its files complete on
disk, and `recording` holds its summary.

The session record (plan item DPR-08a, threemaze/record/session.py) is written when the session
folder exists, at each change of state, and a last time once the recorder is closed: status
running until then, complete or aborted after. `record` takes what reaches the runtime later,
from any thread and without waiting for the disk: the motion worker's hello
(record.client_hello), the renderer's ready report (passed on by the recorder), the
rig-information probe (record.set_rig_info) and the build (record.set_build). Before it creates
its folder, a session looks for sessions of its data root that a runtime left running when it
ended, marks them crashed and names them in `crashed_sessions`.

An invalid rig file fails in configure(), so nothing is opened or written for it. A failure
while arming (a device that does not open, a data root that cannot be created) aborts the
session. Every transition is stamped on the session clock (perf_counter_ns) and anchored to
the wall clock.
"""
import logging
from dataclasses import dataclass
from pathlib import Path

from ..api.devices import Device, DeviceContext, InputDevice, OutputDevice
from ..api.registry import driver_class
from ..config.rig import RigConfig, load_rig
from ..core.clock import ClockAnchor, SessionClock
from ..core.states import InvalidTransition, SessionState, StateMachine, Transition
from ..record.recorder import SessionRecorder, disk_preflight
from ..record.session import SessionRecord, find_crashed_sessions, mark_crashed
from ..record.session_dir import (check_session_id, create_session_dir, default_session_id,
                                  write_rig_copy)

S = SessionState
log = logging.getLogger("threemaze.runtime")

# Kind of device each role needs
INPUT_ROLES = frozenset({"motion"})
OUTPUT_ROLES = frozenset({"reward"})

# Phase 1 runs declarative tasks only; code tasks are phase 2 (D20 = c, owner 2026-10-09)
TASK_KINDS = ("declarative",)


class SessionError(Exception):
    """The session cannot go on; the message says why (the cause is chained)."""


class TaskSourceError(SessionError):
    """A second task source, or a kind of task this runtime does not run."""


@dataclass(frozen=True)
class TaskSource:
    """Where the session's task comes from. A session has exactly one (ADR-0002, "One task source
    per session"), so that one writer owns the epoch."""

    kind: str
    ref: str  # names the task for people and the session record, for example an experiment id

    def __str__(self) -> str:
        return f"{self.kind} task {self.ref!r}"


@dataclass(frozen=True)
class DeviceFailure:
    device: str
    action: str
    error: str


class Session:
    def __init__(self, clock=None):
        self.clock = clock if clock is not None else SessionClock()
        self._machine = StateMachine(self.clock.now_ns())
        self.rig: RigConfig | None = None
        self.task: TaskSource | None = None
        self.data_root: Path | None = None
        self.session_id: str | None = None
        self.dir: Path | None = None
        self.devices: dict[str, Device] = {}          # name -> device, in the order opened
        self.inputs: dict[str, InputDevice] = {}      # role -> device
        self.outputs: dict[str, OutputDevice] = {}    # role -> device
        self.anchors: dict[str, ClockAnchor] = {}     # state -> clocks read at the transition
        self.failures: list[DeviceFailure] = []       # device errors while stopping or aborting
        self.abort_reason: str | None = None
        self.recorder: SessionRecorder | None = None  # from arming until the session has ended
        self.recording: dict | None = None            # the recorder's summary, once closed
        self.preflight: dict | None = None            # the free-disk check made when arming
        self.record: SessionRecord | None = None      # session.json, from arming on
        self.crashed_sessions: list[str] = []         # found and marked when arming

    # --- state -------------------------------------------------------------------------------

    @property
    def state(self) -> SessionState:
        return self._machine.state

    @property
    def history(self) -> list[Transition]:
        return list(self._machine.history)

    def _require(self, target: SessionState) -> None:
        if not self._machine.can(target):
            raise InvalidTransition(self.state, target)

    def _go(self, target: SessionState, reason: str | None = None) -> None:
        anchor = self.clock.anchor()
        self._machine.go(target, anchor.perf_ns, reason)
        self.anchors[target.value] = anchor
        if target is S.ABORTED:
            self.abort_reason = reason
        log.info("session %s: %s%s", self.session_id or "-", target.value,
                 f" ({reason})" if reason else "")
        if self.recorder is not None:
            data = {"state": target.value, **({"reason": reason} if reason else {})}
            try:
                self.recorder.event("runtime", "state", data=data, t_host_ns=anchor.perf_ns)
            except Exception as exc:  # noqa: BLE001 - recording must not stop a transition
                log.error("session %s: the %s state was not recorded: %r", self.session_id,
                          target.value, exc)
        if self.record is not None:
            # The last record waits until the recorder has closed its files (_close_recording)
            try:
                self.record.state_changed(target.value, anchor, reason, write=not target.final)
            except Exception as exc:  # noqa: BLE001 - recording must not stop a transition
                log.error("session %s: session.json not written: %r", self.session_id, exc)

    def _end(self, target: SessionState, reason: str | None = None) -> None:
        """COMPLETE or ABORTED, then the recording is closed."""
        self._go(target, reason)
        self._close_recording()

    # --- lifecycle ---------------------------------------------------------------------------

    def configure(self, rig: str | Path | RigConfig, *, data_root: str | Path | None = None,
                  session_id: str | None = None) -> None:
        """IDLE -> CONFIGURED. Loads and validates the rig file (RigFileError if it is invalid; the
        session then stays IDLE). data_root replaces the rig file's dataRoot (tests, tools)."""
        self._require(S.CONFIGURED)
        config = rig if isinstance(rig, RigConfig) else load_rig(rig)
        session_id = session_id or default_session_id(config.name)
        check_session_id(session_id)
        self.rig = config
        self.data_root = Path(data_root) if data_root is not None else config.data_root
        self.session_id = session_id
        self._go(S.CONFIGURED)

    def set_task(self, source: TaskSource) -> None:
        """Name the session's task source, once, before the session is armed."""
        if self.task is not None:
            raise TaskSourceError(f"the session already has a task source ({self.task}); a session"
                                  f" has exactly one, so {source} is refused (ADR-0002)")
        if self.state not in (S.IDLE, S.CONFIGURED):
            raise SessionError("the task source is set before the session is armed"
                               f" (state {self.state.value})")
        if source.kind not in TASK_KINDS:
            raise TaskSourceError(f"{source}: this runtime runs {', '.join(TASK_KINDS)} tasks only"
                                  " (code tasks are phase 2, D20)")
        self.task = source

    def arm(self) -> Path:
        """CONFIGURED -> ARMED: mark the sessions of the data root that a runtime left running when
        it ended; create the session folder, copy the rig file and its hash into it and write
        session.json; open and check every bound device; check the free disk space and open the
        recorder. Returns the session folder."""
        self._require(S.ARMED)
        if self.task is None:
            raise SessionError("no task source: call set_task() before arm()")
        try:
            self._mark_crashed_sessions()
            self.dir = create_session_dir(self.data_root, self.session_id)
            write_rig_copy(self.dir, self.rig.raw, self.rig.sha256)
            self._open_record()
            self._open_devices()
            self._open_recorder()
            self.record.update(devices=self._describe_devices(), preflight=self.preflight,
                               write=False)
        except Exception as exc:
            self._shutdown()
            self._end(S.ABORTED, f"arming failed: {exc}")
            raise SessionError(f"cannot arm the session: {exc}") from exc
        self._go(S.ARMED)
        return self.dir

    def start(self) -> None:
        """ARMED -> RUNNING: start every input device's stream."""
        self._require(S.RUNNING)
        try:
            for device in _unique(self.inputs.values()):
                device.start()
        except Exception as exc:
            self._shutdown()
            self._end(S.ABORTED, f"starting failed: {exc}")
            raise SessionError(f"cannot start the session: {exc}") from exc
        self._go(S.RUNNING)

    def stop(self) -> None:
        """RUNNING -> STOPPING -> COMPLETE; ABORTED instead if a device fails while stopping."""
        self._require(S.STOPPING)
        self._go(S.STOPPING)
        failures = self._shutdown()
        if failures:
            self._end(S.ABORTED, "stopping failed: " + "; ".join(
                f"{f.device}.{f.action}: {f.error}" for f in failures))
        else:
            self._end(S.COMPLETE)

    def abort(self, reason: str) -> None:
        """Any state that is not final -> ABORTED, outputs made safe first. Never raises because
        a device fails; the failures are in `failures`."""
        self._require(S.ABORTED)
        self._shutdown()
        self._end(S.ABORTED, reason)

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if not self.state.final:
            if exc_type is not None:
                self.abort(f"{exc_type.__name__}: {exc}")
            elif self.state is S.RUNNING:
                self.stop()
            else:
                self.abort(f"closed in state {self.state.value}, before it ran")
        return False

    # --- devices -----------------------------------------------------------------------------

    def _open_devices(self) -> None:
        rig = self.rig
        for name in rig.bound_devices():
            spec = rig.devices[name]
            cls = driver_class(spec.driver)
            if cls is None:
                raise SessionError(f"device {name!r}: driver {spec.driver!r} is not available")
            ctx = DeviceContext(clock=self.clock, session_dir=self.dir, rig_dir=rig.rig_dir,
                                calibration=rig.calibration.get(name),
                                log=logging.getLogger(f"threemaze.devices.{name}"))
            device = cls(name, spec.config, ctx)
            self.devices[name] = device  # before open(): a device that fails to open is closed too
            device.open()
        for role, name in rig.bindings.items():
            device = self.devices[name]
            if role in INPUT_ROLES and isinstance(device, InputDevice):
                self.inputs[role] = device
            elif role in OUTPUT_ROLES and isinstance(device, OutputDevice):
                self.outputs[role] = device
            else:
                raise SessionError(f"device {name!r} cannot serve the {role} role")

    # --- recording -------------------------------------------------------------------------------

    def _mark_crashed_sessions(self) -> None:
        """Sessions of the data root that a runtime left open when it ended (it was killed or it
        crashed): mark each crashed and remember it. A failure here is logged and does not stop
        the new session."""
        try:
            crashed = find_crashed_sessions(self.data_root)
        except Exception as exc:  # noqa: BLE001 - a damaged data root must not block a session
            log.error("looking for crashed sessions in %s failed: %r", self.data_root, exc)
            return
        for folder in crashed:
            try:
                marked = mark_crashed(folder, detected_by=self.session_id)
            except Exception as exc:  # noqa: BLE001
                log.error("could not mark session %s as crashed: %r", folder.name, exc)
                continue
            if not marked:
                continue  # closed, or taken by another runtime, since it was found
            log.warning("session %s was left running by a runtime that ended; marked crashed",
                        folder.name)
            self.crashed_sessions.append(folder.name)

    def _open_record(self) -> None:
        """Write the first session.json (status running, the states so far) under the lock."""
        record = SessionRecord(self.dir, session_id=self.session_id, rig=self.rig, task=self.task,
                               data_root=self.data_root)
        for step in self._machine.history:
            record.state_changed(step.target.value, self.anchors[step.target.value], step.reason,
                                 write=False)
        record.update(crashed_sessions=list(self.crashed_sessions), write=False)
        record.open()
        self.record = record

    def _describe_devices(self) -> dict[str, dict]:
        """Each opened device as the session record states it: its roles, then its driver's
        description (device protocol v1, section 8.3, for the devices that speak it)."""
        roles: dict[str, list[str]] = {}
        for role, name in self.rig.bindings.items():
            roles.setdefault(name, []).append(role)
        described = {}
        for name, device in self.devices.items():
            try:
                described[name] = {"roles": roles.get(name, []), **device.describe()}
            except Exception as exc:  # noqa: BLE001 - one device must not lose the others
                described[name] = {"roles": roles.get(name, []),
                                   "describe_error": f"{type(exc).__name__}: {exc}"}
        return described

    def _open_recorder(self) -> None:
        """Check the free disk space for the motion device's rate, then open the recorder. Its
        samples.tsv has one column per column of the calibration matrix, which rule H5 has checked
        against the axes of the device's hello."""
        name = self.rig.bindings["motion"]
        n_axes = len(self.rig.calibration[name]["matrix"][0])
        info = self.devices[name].describe()
        period_us = info.get("period_us") or (info.get("hello") or {}).get("period_us")
        if period_us:
            self.preflight = disk_preflight(self.data_root, period_us=period_us, n_axes=n_axes)
        else:
            log.warning("session %s: device %s states no sample period, so the free disk space"
                        " was not checked", self.session_id, name)
        self.recorder = SessionRecorder(self.dir, n_axes=n_axes, seq_source=info.get("seq_source"),
                                        clock=self.clock, on_ready=self.record.render_ready)
        for name in self.crashed_sessions:
            self.recorder.event("runtime", "warning", data={
                "code": "crashed_session", "session": name,
                "message": "a session of this data root was left running by a runtime that ended;"
                           " it is marked crashed"})

    def _close_recording(self) -> None:
        """Close the recorder, then write the last session record (complete or aborted) and
        release its lock; once, and never raises (a failure goes into the summary's errors)."""
        if self.recorder is not None and self.recording is None:
            try:
                self.recording = self.recorder.close()
            except Exception as exc:  # noqa: BLE001 - ending the session must not fail here
                self.recording = {"errors": [f"closing the recorder: {type(exc).__name__}: {exc}"]}
            if self.recording.get("errors"):
                log.error("session %s: recording errors: %s", self.session_id,
                          "; ".join(self.recording["errors"]))
        if self.record is not None and not self.record.closed:
            self.record.finish(self.state.value, devices=self._describe_devices(),
                               recording=self.recording)

    def _shutdown(self) -> list[DeviceFailure]:
        """Every output device safe, input streams stopped, every device closed: each step for
        every device, whatever the others do. Returns the failures of this call."""
        failures = []
        devices = list(self.devices.items())

        def attempt(name, action, call):
            try:
                call()
            except Exception as exc:  # noqa: BLE001 - one device must not stop the others' shutdown
                failures.append(DeviceFailure(name, action, f"{type(exc).__name__}: {exc}"))
                log.error("device %s: %s failed: %r", name, action, exc)

        for name, device in devices:
            if isinstance(device, OutputDevice):
                attempt(name, "safe_state", device.safe_state)
        for device in _unique(self.inputs.values()):  # the devices start() started
            attempt(device.name, "stop", device.stop)
        for name, device in reversed(devices):
            attempt(name, "close", device.close)
        self.failures.extend(failures)
        return failures


def _unique(devices):
    return list({id(device): device for device in devices}.values())
