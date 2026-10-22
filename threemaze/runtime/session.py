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

An invalid rig file fails in configure(), so nothing is opened or written for it. A failure
while arming (a device that does not open, a data root that cannot be created) aborts the
session. Every transition is stamped on the session clock (perf_counter_ns) and anchored to
the wall clock.

Listeners (add_listener) learn of every transition, on_session_state(session, transition), and
get every batch of records a device reads, on_device_batch(session, device name, records), as the
link to the motion worker does (plan item DPR-06b). A session given an asyncio event loop calls
them on that loop, the device batches through loop.call_soon_threadsafe from the devices' reader
threads, in the order the records were read; its blocking calls (arm, start, stop, abort) are then
made from another thread, for example with asyncio.to_thread. Without a loop, listeners are called
on the thread that made the transition or read the records.
"""
import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..api.devices import Device, DeviceContext, InputDevice, OutputDevice
from ..api.registry import driver_class
from ..config.rig import RigConfig, load_rig
from ..core.clock import ClockAnchor, SessionClock
from ..core.states import InvalidTransition, SessionState, StateMachine, Transition
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
    def __init__(self, clock=None, *, loop: asyncio.AbstractEventLoop | None = None):
        self.clock = clock if clock is not None else SessionClock()
        self.loop = loop
        self.listeners: list[Any] = []
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
        self.alarms: list[dict[str, Any]] = []         # raise_alarm(), for the session record
        self.abort_reason: str | None = None

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
        step = self._machine.go(target, anchor.perf_ns, reason)
        self.anchors[target.value] = anchor
        if target is S.ABORTED:
            self.abort_reason = reason
        log.info("session %s: %s%s", self.session_id or "-", target.value,
                 f" ({reason})" if reason else "")
        self._notify("on_session_state", step)

    # --- listeners ---------------------------------------------------------------------------

    def add_listener(self, listener: Any) -> None:
        """Call listener.on_session_state(session, transition) and listener.on_device_batch(
        session, device name, records), where it has them (see the module docstring)."""
        self.listeners.append(listener)

    def _notify(self, method: str, *args: Any) -> None:
        if self.loop is None:
            self._call_listeners(method, args)
            return
        try:
            self.loop.call_soon_threadsafe(self._call_listeners, method, args)
        except RuntimeError:  # the event loop is closed: nobody listens any more
            log.error("session %s: %s not delivered: the event loop is closed",
                      self.session_id or "-", method)

    def _call_listeners(self, method: str, args: tuple) -> None:
        for listener in list(self.listeners):
            call = getattr(listener, method, None)
            if call is None:
                continue
            try:
                call(self, *args)
            except Exception:  # noqa: BLE001 - one listener must not stop the others
                log.exception("session %s: listener %r failed in %s", self.session_id or "-",
                              listener, method)

    def _on_batch(self, device: str, records: list) -> None:
        """A device's batch, on the loop if the session has one (the devices hand it there)."""
        self._call_listeners("on_device_batch", (device, records))

    def raise_alarm(self, source: str, reason: str, **fields: Any) -> dict[str, Any]:
        """Record a session alarm: something that puts the session's data at risk and that the
        operator must see, such as samples the motion worker does not take as fast as they come
        (plan item DPR-06b). The session goes on and keeps the alarm for its record (plan item
        DPR-08a); acting on alarms is the watchdog's (plan item DPR-11)."""
        alarm = {"t_ns": self.clock.now_ns(), "source": source, "reason": reason, **fields}
        self.alarms.append(alarm)
        log.error("session %s: alarm from %s: %s", self.session_id or "-", source, reason)
        return alarm

    def motion_link_device(self) -> dict[str, Any] | None:
        """The motion device's profile and guarantee level as the link protocol's welcome gives
        them (protocol/v1/common.schema.json, MotionDevice): from the open device once the session
        is armed, before that from the rig file; None if its driver cannot say."""
        device = self.inputs.get("motion")
        link_device = getattr(device, "link_device", None)
        info = link_device() if link_device is not None else None
        if info is not None or self.rig is None:
            return info
        name = self.rig.bindings["motion"]
        spec = self.rig.devices[name]
        describe = getattr(driver_class(spec.driver), "link_device_for", None)
        return describe(spec.config, self.rig.calibration.get(name)) if describe else None

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
        """CONFIGURED -> ARMED: create the session folder, copy the rig file and its hash into it,
        open and check every bound device. Returns the session folder."""
        self._require(S.ARMED)
        if self.task is None:
            raise SessionError("no task source: call set_task() before arm()")
        try:
            self.dir = create_session_dir(self.data_root, self.session_id)
            write_rig_copy(self.dir, self.rig.raw, self.rig.sha256)
            self._open_devices()
        except Exception as exc:
            self._shutdown()
            self._go(S.ABORTED, f"arming failed: {exc}")
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
            self._go(S.ABORTED, f"starting failed: {exc}")
            raise SessionError(f"cannot start the session: {exc}") from exc
        self._go(S.RUNNING)

    def stop(self) -> None:
        """RUNNING -> STOPPING -> COMPLETE; ABORTED instead if a device fails while stopping."""
        self._require(S.STOPPING)
        self._go(S.STOPPING)
        failures = self._shutdown()
        if failures:
            self._go(S.ABORTED, "stopping failed: " + "; ".join(
                f"{f.device}.{f.action}: {f.error}" for f in failures))
        else:
            self._go(S.COMPLETE)

    def abort(self, reason: str) -> None:
        """Any state that is not final -> ABORTED, outputs made safe first. Never raises because
        a device fails; the failures are in `failures`."""
        self._require(S.ABORTED)
        self._shutdown()
        self._go(S.ABORTED, reason)

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
                                log=logging.getLogger(f"threemaze.devices.{name}"),
                                loop=self.loop, on_batch=self._on_batch)
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
