"""The rig runtime's end of the link protocol three-maze/link v1 (protocol/v1/SPEC.md; plan item
DPR-06b): a WebSocket server on the loopback interface for the motion worker of the scene window
(role motion) and for monitors such as the control window (role monitor).

    server = LinkServer()
    port = await server.start()               # 127.0.0.1, a free port unless one is given
    session = Session(loop=asyncio.get_running_loop())
    session.configure(rig, ...)
    server.attach(session, world="hallway")   # the session's state and motion samples

With the rule ids of SPEC.md:
- handshake: hello first, within 2 s (C1); major version 1, the lower minor version (C2); one
  motion client per session, of that session (C3); a welcome with the session, the epoch, the
  world and the motion device's guarantee level, then session.state (C4); the hello's versions
  are logged for the session record (C5); a refused hello gets its error, then the close code of
  section 5 (Q1);
- samples: the session's motion samples, as the device's reader accepted and calibrated them, go
  to the motion client in seq order, each once, never dropped or merged (S1), as soon as they are
  there, up to 1000 in one sample.batch (S2). The queue in between (stream.py) raises a session
  alarm when the client falls behind, instead of dropping anything. Samples that arrive before the
  motion client connects wait for it;
- heartbeats every 20 ms to every client (B1); the motion client's heartbeats are counted and
  their gaps measured (the watchdog that acts on them, B2, is plan item DPR-11);
- received: pose.batch, event and render.report from the motion client go to the link log
  (log.py) with their receipt time. An event of an older epoch than the latest is logged as stale
  and not passed on: the epoch, which the motion worker raises at every teleport or reset it
  applies (and which the runtime raises when it issues one, advance_epoch, from plan item DPR-05b
  on), replaces v0.3's |z| < 10 filter (backend/src/main.py:617-662; ADR-0001 Terms; ADR-0002
  Code tasks). Non-stale events go to the listeners added with add_listener (on_link_event);
- errors (Q2): a frame that is not JSON gets bad_json, a message that does not validate gets
  bad_message with the path of its first problem, a type the client's role may not send gets
  not_permitted; a message type, event kind or render-report kind of a later version is logged and
  ignored, and a request of an unknown type gets unknown_type (E5). None of these closes the
  connection after welcome;
- session.state to every client after welcome and on every change of the session's state, with
  the motion device's guarantee level from armed on (T1; the 10 Hz telemetry is plan item DPR-20).
  When the session ends, every sample already received goes to the motion client first (the batch
  being sent included), then the final session.state, then its connection is closed with 4004;
  samples that can no longer go out (no motion client, arriving after the end, or in a batch that
  could not be sent) are counted as undelivered and raise an alarm;
- bounded waits: websockets waits for a socket's buffer to drain without a time limit, so a
  client that has stopped reading would hold up every send to it. The end of a session gives the
  last samples drain_timeout_s, and the final state and the close send_timeout_s each (the close
  also websockets' own close timeout); a motion client that takes nothing in that time is cut off
  (its connection aborted, with an alarm), and monitors get the final state without holding up
  the end. The server's close() is bounded the same way;
- one session at a time: once the end of a session is through, attach() takes the next one, with
  a fresh link log, epoch, motion client and sample stream, while monitors stay connected
  (section 7).

Nothing here answers a pose with a pose (v0.3 confirmed every position it received,
backend/src/main.py:617-662), and nothing here does motion arithmetic: the runtime sends
displacements and the motion worker alone integrates them (ADR-0001 R1). The session token and
the Origin allow-list are plan item DPR-16a; commands and time.sync, DPR-05b.
"""
import asyncio
import contextlib
import itertools
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed

from .. import __version__
from ..core.clock import SessionClock
from ..core.records import DeviceSample, StreamFault
from .log import LinkLog
from .receive import read_frame, unknown_kind
from .stream import MAX_BATCH, SampleStream, backlog_limit
from .validate import HEARTBEAT_MS, LINK_SCHEMAS, WATCHDOG_MS, link_errors

log = logging.getLogger("threemaze.link")

PROTOCOL = "three-maze/link"
MAJOR, MINOR = 1, 0
HELLO_TIMEOUT_S = 2.0      # rule C1
DRAIN_TIMEOUT_S = 5.0      # how long the end of a session waits for the last samples to go out
SEND_TIMEOUT_S = 2.0       # how long the end of a session waits for a client to take a message
CLOSE_TIMEOUT_S = 2.0      # websockets' wait for the client's answer to a close
_FINAL = ("complete", "aborted")

# What each role may send (SPEC.md section 2); hello only as the first message
_ALLOWED = {"motion": {"heartbeat", "pose.batch", "event", "render.report", "error"},
            "monitor": {"heartbeat", "error"}}

_COMMON = LINK_SCHEMAS["common.schema.json"]["$defs"]
_ID = re.compile(_COMMON["id"]["pattern"])
_REQUEST_ID = re.compile(_COMMON["request_id"]["pattern"])
_POINTER = re.compile(_COMMON["pointer"]["pattern"])
_NOT_TEXT = re.compile(r"[/\\\x00-\x1f\x7f-\x9f  ]")
_PY_NAME = re.compile(r"\.[Pp][Yy]([CcDdOoWw]?)(?![A-Za-z0-9_])")


def text(value: str) -> str:
    """A string the protocol's Text type admits: one line of at most 500 characters, without
    slashes, control characters or .py names (common.schema.json, rule E3)."""
    clean = _NOT_TEXT.sub(" ", value)
    clean = _PY_NAME.sub(r" py\1", clean).strip()
    return (clean or "-")[:500]


def encode(message: dict[str, Any]) -> str:
    """One message as a text frame: compact JSON, no NaN or Infinity (rule E2); floats in their
    shortest round-trip form, so the receiver gets the sender's doubles exactly."""
    return json.dumps(message, allow_nan=False, separators=(",", ":"), ensure_ascii=False)


class LinkProtocolError(Exception):
    """A message this server built does not validate (only with check_outgoing)."""


@dataclass
class _Client:
    ws: ServerConnection
    id: str
    role: str
    hello: dict[str, Any]
    tasks: list[asyncio.Task] = field(default_factory=list)
    sent_heartbeats: int = 0
    heartbeats: int = 0
    missing_heartbeats: int = 0
    last_heartbeat_ns: int | None = None
    max_heartbeat_gap_ns: int = 0
    last_n: int | None = None
    last_seq: int | None = None
    epoch: int | None = None
    cut: bool = False              # aborted because it took no message within the time limit
    gone: asyncio.Event = field(default_factory=asyncio.Event)  # its handler has finished


class LinkServer:
    def __init__(self, *, clock: Any = None, host: str = "127.0.0.1", port: int = 0,
                 hello_timeout_s: float = HELLO_TIMEOUT_S, heartbeat_s: float = HEARTBEAT_MS / 1000,
                 backlog: int | None = None, drain_timeout_s: float = DRAIN_TIMEOUT_S,
                 send_timeout_s: float = SEND_TIMEOUT_S, check_outgoing: bool = False):
        self.clock = clock if clock is not None else SessionClock()
        self.host = host
        self.port = port
        self.hello_timeout_s = hello_timeout_s
        self.heartbeat_s = heartbeat_s
        self.drain_timeout_s = drain_timeout_s
        self.send_timeout_s = send_timeout_s
        self.check_outgoing = check_outgoing   # validate every message sent (tests, rule E4)
        self._backlog = backlog
        self._server: Server | None = None
        self._numbers = itertools.count(1)
        self.clients: dict[str, _Client] = {}
        self.motion: _Client | None = None
        self.motion_hello: dict[str, Any] | None = None
        self.motion_gone = False
        self.session: Any = None
        self.motion_device: str | None = None
        self.world: str | None = None
        self.state = "idle"
        self.reason: str | None = None
        self.epoch = 0
        self.stream: SampleStream | None = None
        self.link_log = LinkLog()
        self.alarms: list[dict[str, Any]] = []
        self.listeners: list[Any] = []
        self.finished: asyncio.Event | None = None
        self.last_pose: dict[str, Any] | None = None
        self.counts = dict.fromkeys(
            ("poses", "pose_batches", "pose_order_errors", "events", "stale_events",
             "render_reports", "client_errors", "errors_sent", "unknown_ignored", "refused"), 0)
        self._last_pose_seq: int | None = None
        self._finishing: asyncio.Task | None = None
        self._ended = False   # the final state went out: no sample can follow it

    # --- the server ---------------------------------------------------------------------------

    async def start(self) -> int:
        """Listen on host:port (port 0: a free one); returns the port."""
        self.finished = asyncio.Event()
        self._server = await serve(self._handle, self.host, self.port, compression=None,
                                   ping_interval=None, close_timeout=CLOSE_TIMEOUT_S)
        self.port = self._server.sockets[0].getsockname()[1]
        log.info("link: listening on ws://%s:%d", self.host, self.port)
        return self.port

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"

    async def close(self) -> None:
        """Close every connection (1001, going away) and stop listening; a client that takes no
        message within the time limit is cut off."""
        if self._finishing is not None:
            await asyncio.shield(self._finishing)
        for client in list(self.clients.values()):
            await self._bounded(client, client.ws.close(1001, "the rig runtime is closing"),
                                "the 1001 close", self.send_timeout_s + CLOSE_TIMEOUT_S,
                                alarm=False)
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
        self.link_log.close()

    def add_listener(self, listener: Any) -> None:
        """listener.on_link_event(server, message, t_ns) for every event that is not stale, and
        listener.on_link_alarm(server, alarm) for every alarm, where it has them."""
        self.listeners.append(listener)

    # --- the session --------------------------------------------------------------------------

    def attach(self, session: Any, *, world: str) -> None:
        """Serve `session`, a configured session that runs on this server's event loop
        (Session(loop=...); ValueError otherwise): its state, its motion samples, the epoch from
        0, in world `world` (phase 1: the experiment's only world). Called on the event loop.

        One session at a time: the next one is attached once the end of this one is through
        (`finished`), and starts afresh (link log, epoch, motion client, sample stream); monitors
        stay connected."""
        if not _ID.search(world):
            raise ValueError(f"world {world!r} is not an id of the link protocol")
        # The session hands its transitions and records to its own loop, and the sample stream's
        # asyncio objects belong to this one: they must be the same (asyncio is not thread-safe)
        if getattr(session, "loop", None) is not asyncio.get_running_loop():
            raise ValueError("the session must run on the link server's event loop"
                             " (Session(loop=asyncio.get_running_loop()))")
        if self.session is not None and (self._finishing is None or not self._finishing.done()):
            raise ValueError(f"the server serves session {self.session.session_id} until its end"
                             " is through")
        device = session.motion_link_device()
        if device is None:  # a configured session whose motion device states its level (C4)
            raise ValueError("the session is not configured, or its motion device does not state"
                             " its guarantee level")
        if self.session is not None:  # nothing of the session before carries over
            self.link_log.close()
            self.link_log = LinkLog()
            self.finished = asyncio.Event()
            self.motion = self.motion_hello = self.last_pose = self._last_pose_seq = None
            self.motion_gone = self._ended = False
            self._finishing = None
            self.state, self.reason = "idle", None
        self.session, self.world, self.epoch = session, world, 0
        self.motion_device = session.rig.bindings["motion"]
        limit = self._backlog or backlog_limit(device.get("period_us"))
        self.stream = SampleStream(limit=limit, on_alarm=self._alarm)
        session.add_listener(self)
        self._set_state(session.state.value, session.abort_reason)

    def advance_epoch(self, epoch: int) -> None:
        """The runtime issued a teleport or reset with this epoch: from now on, events of a lower
        epoch are stale (ADR-0002, Code tasks; commands are plan item DPR-05b)."""
        self.epoch = max(self.epoch, epoch)

    def on_session_state(self, session: Any, transition: Any) -> None:
        """Session listener: every transition, on the event loop."""
        if session is self.session:  # not an earlier session's
            self._set_state(transition.target.value, transition.reason)

    def on_device_batch(self, session: Any, device: str, records: list) -> None:
        """Session listener: the records of one read of a device, on the event loop, in order."""
        if session is not self.session or device != self.motion_device or self.stream is None:
            return
        samples = [r for r in records if type(r) is DeviceSample]
        if samples:
            self.stream.push(samples)
            if self._ended:  # after the final state no sample may go out: reported, not kept
                self.stream.abandon("they arrived after the end of the session was sent")
        for record in records:
            if type(record) is StreamFault:
                self._alarm(f"the motion device's stream failed: {record.reason}",
                            {"device": device})

    def _set_state(self, state: str, reason: str | None) -> None:
        if state == self.state and reason == self.reason:
            return
        self.state, self.reason = state, reason
        now = self.clock.now_ns()
        if self.session is not None and self.session.dir is not None:  # from armed on
            self.link_log.open(self.session.dir / "link.jsonl")
        self.link_log.write(now, "session_state", state=state, reason=reason)
        if state in _FINAL:
            if self._finishing is None:
                self._finishing = asyncio.get_running_loop().create_task(self._finish())
            return
        self._broadcast_state()

    async def _finish(self) -> None:
        """S1 to the end: every sample already received goes to the motion client before the
        final state; then 4004 closes the motion client's connection (section 5). Each wait is
        bounded (see the module docstring), so a client that has stopped reading holds up
        neither the end of the session nor the server's close."""
        stream = self.stream
        if stream is not None and stream.pending:  # waiting, or in a batch still being sent
            if self.motion is not None:
                if not await stream.drained(self.drain_timeout_s):
                    stream.abandon("the motion client did not take the last samples within"
                                   f" {self.drain_timeout_s:g} s of the session's end")
            else:
                stream.abandon("the session ended without a motion client")
        self._ended = True
        frame = self._encode(self._state_message())
        motion = self.motion
        loop = asyncio.get_running_loop()
        for client in list(self.clients.values()):
            if client is not motion:  # a monitor stays connected; one that does not read waits
                client.tasks.append(loop.create_task(self._send_frame(client, frame)))
        if motion is not None:  # the final state, then the 4004 close
            if await self._bounded(motion, self._send_frame(motion, frame), "the final state",
                                   self.send_timeout_s, alarm=True):
                await self._bounded(motion, motion.ws.close(4004, "the session ended"),
                                    "the 4004 close", self.send_timeout_s + CLOSE_TIMEOUT_S,
                                    alarm=False)
            # Its handler settles a batch still in flight (sent or undelivered) before the stream's
            # record below is written
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(motion.gone.wait(), self.send_timeout_s)
        if stream is not None:
            self.link_log.write(self.clock.now_ns(), "stream_end", **stream.stats())
        self.link_log.flush()
        if self.finished is not None:
            self.finished.set()

    def device_entry(self) -> dict[str, Any] | None:
        return self.session.motion_link_device() if self.session is not None else None

    def _state_message(self) -> dict[str, Any]:
        data: dict[str, Any] = {"state": self.state}
        session = self.session
        if session is not None and self.state != "idle":
            data["session"] = session.session_id
            task = getattr(session, "task", None)
            if task is not None and _ID.search(task.ref):
                data["experiment"] = task.ref
            if self.reason and self.state in ("stopping", "aborted"):
                data["reason"] = text(self.reason)
            if self.state not in ("configured",):
                device = self.device_entry()
                if device is not None:
                    data["device"] = device
        return self._message("session.state", data)

    def _broadcast_state(self) -> None:
        if not self.clients:
            return
        frame = self._encode(self._state_message())
        loop = asyncio.get_running_loop()
        for client in list(self.clients.values()):
            client.tasks.append(loop.create_task(self._send_frame(client, frame)))

    # --- messages -----------------------------------------------------------------------------

    def _message(self, kind: str, data: dict[str, Any], *, re_id: str | None = None) -> dict:
        message: dict[str, Any] = {"type": kind, "t": self.clock.now_ns() // 1000}
        if re_id is not None:
            message["re"] = re_id
        message["data"] = data
        return message

    def _encode(self, message: dict[str, Any]) -> str:
        if self.check_outgoing:
            problems = link_errors(message)
            if problems:
                raise LinkProtocolError(f"{message['type']}: {problems}")
        return encode(message)

    async def _send(self, ws: ServerConnection, message: dict[str, Any]) -> None:
        await ws.send(self._encode(message))

    async def _send_frame(self, client: _Client, frame: str) -> None:
        try:
            await client.ws.send(frame)
        except ConnectionClosed:
            pass

    async def _bounded(self, client: _Client, action: Any, what: str, limit_s: float, *,
                       alarm: bool) -> bool:
        """Await a send to `client`, or its close, for at most limit_s; True if it completed. A
        client that took nothing in that time is cut off: its connection is aborted, since
        websockets waits for the socket's buffer to drain without a time limit."""
        try:
            await asyncio.wait_for(action, limit_s)
            return True
        except asyncio.TimeoutError:
            client.cut = True
            reason = f"{client.id} took no message within {limit_s:g} s ({what}): cut off"
            self.link_log.write(self.clock.now_ns(), "cut", client=client.id, waiting_for=what)
            if alarm:
                self._alarm(reason, {"client": client.id})
            else:
                log.warning("link: %s", reason)
            client.ws.transport.abort()
            return False

    def _error(self, code: str, message: str, *, re_id: str | None = None,
               path: str | None = None) -> dict[str, Any]:
        data: dict[str, Any] = {"code": code, "message": text(message)}
        if path and _POINTER.search(path):
            data["path"] = path
        self.counts["errors_sent"] += 1
        if re_id is not None and not _REQUEST_ID.search(re_id):
            re_id = None
        return self._message("error", data, re_id=re_id)

    async def _refuse(self, ws: ServerConnection, number: int, code: str, message: str,
                      close_code: int, re_id: str | None = None, path: str | None = None) -> None:
        self.counts["refused"] += 1
        self.link_log.write(self.clock.now_ns(), "refused", connection=number, code=code,
                            message=message, close_code=close_code)
        log.warning("link: connection %d refused (%s): %s", number, code, message)
        try:
            await self._send(ws, self._error(code, message, re_id=re_id, path=path))
            await ws.close(close_code, code)
        except ConnectionClosed:
            pass

    # --- connections --------------------------------------------------------------------------

    async def _handle(self, ws: ServerConnection) -> None:
        number = next(self._numbers)
        client = await self._handshake(ws, number)
        if client is None:
            return
        loop = asyncio.get_running_loop()
        try:
            client.tasks.append(loop.create_task(self._heartbeat(client)))
            if client.role == "motion":
                client.tasks.append(loop.create_task(self._send_samples(client)))
            await self._receive(client)
        finally:
            await self._gone(client)

    async def _handshake(self, ws: ServerConnection, number: int) -> _Client | None:
        try:
            frame = await asyncio.wait_for(ws.recv(), self.hello_timeout_s)
        except asyncio.TimeoutError:
            self.counts["refused"] += 1
            self.link_log.write(self.clock.now_ns(), "refused", connection=number, code="no_hello",
                                close_code=4000)
            await ws.close(4000, f"no hello within {self.hello_timeout_s:g} s")
            return None
        except ConnectionClosed:
            return None
        message, issues = read_frame(frame)
        if issues:  # C1: anything before hello gets bad_message, then 4000
            await self._refuse(ws, number, "bad_message",
                               "the first message must be a valid hello: " + issues[0].message,
                               4000, path=issues[0].path)
            return None
        if message["type"] != "hello":
            await self._refuse(ws, number, "bad_message",
                               f"the first message must be hello, not {message['type']}", 4000)
            return None
        rid, data = message["id"], message["data"]
        major, minor = (int(part) for part in data["version"].split("."))
        if major != MAJOR:
            await self._refuse(ws, number, "version_mismatch",
                               f"hello asked for version {data['version']}; this runtime speaks"
                               f" {MAJOR}.{MINOR}", 4002, re_id=rid)
            return None
        role = data["role"]
        if role == "motion":
            session_id = self.session.session_id if self.session is not None else None
            if session_id is None or self.state in ("idle",) + _FINAL:
                await self._refuse(ws, number, "session_mismatch", "no session is running here",
                                   4005, re_id=rid)
                return None
            if data["session"] != session_id:
                await self._refuse(ws, number, "session_mismatch",
                                   f"the session here is {session_id}, not {data['session']}",
                                   4005, re_id=rid)
                return None
            if self.motion is not None or self.motion_gone:
                why = ("the session has a motion client" if self.motion is not None else
                       "the session's motion client has gone; resuming is not supported yet")
                await self._refuse(ws, number, "role_conflict", why, 4003, re_id=rid)
                return None
        client = _Client(ws, f"{role}-{number}", role, message)
        welcome = {"protocol": PROTOCOL, "version": f"{MAJOR}.{min(minor, MINOR)}", "role": role,
                   "client_id": client.id, "runtime": {"impl": "threemaze", "version": __version__},
                   "heartbeat_ms": HEARTBEAT_MS, "watchdog_ms": WATCHDOG_MS, "epoch": self.epoch}
        if self.session is not None and self.state != "idle":
            welcome["session"] = self.session.session_id
        if role == "motion":
            welcome["world"] = self.world
            welcome["device"] = self.device_entry()
        now = self.clock.now_ns()
        self.link_log.write(now, "hello", client=client.id, message=message)
        try:
            await self._send(ws, self._message("welcome", welcome, re_id=rid))
            await self._send(ws, self._state_message())
        except ConnectionClosed:
            return None
        self.clients[client.id] = client
        if role == "motion":
            self.motion = client
            self.motion_hello = message
        self.link_log.write(self.clock.now_ns(), "welcome", client=client.id, epoch=self.epoch,
                            device=welcome.get("device"))
        log.info("link: %s connected", client.id)
        return client

    async def _gone(self, client: _Client) -> None:
        for task in client.tasks:
            task.cancel()
        self.clients.pop(client.id, None)
        code = client.ws.close_code
        self.link_log.write(self.clock.now_ns(), "closed", client=client.id, close_code=code,
                            heartbeats=client.heartbeats,
                            missing_heartbeats=client.missing_heartbeats,
                            max_heartbeat_gap_us=client.max_heartbeat_gap_ns // 1000)
        log.info("link: %s closed (%s)", client.id, code)
        if client is self.motion:
            self.motion = None
            self.motion_gone = True
            if self.state not in _FINAL:
                self._alarm(f"the motion client closed its connection ({code}) while the session"
                            f" is {self.state}", {"client": client.id, "close_code": code})
        if client.tasks:  # cancelled: a batch the sender had in flight is settled first
            await asyncio.wait(client.tasks)
        client.gone.set()

    async def _heartbeat(self, client: _Client) -> None:
        """B1: a heartbeat every heartbeat_s from welcome until the connection closes; to the
        motion client with the last sample sent."""
        loop = asyncio.get_running_loop()
        due = loop.time()
        while True:
            data: dict[str, Any] = {"n": client.sent_heartbeats}
            if client.role == "motion" and self.stream is not None \
                    and self.stream.last_sent_seq is not None:
                data["last_seq"] = self.stream.last_sent_seq
            try:
                await self._send(client.ws, self._message("heartbeat", data))
            except ConnectionClosed:
                return
            client.sent_heartbeats += 1
            due += self.heartbeat_s
            await asyncio.sleep(max(0.0, due - loop.time()))

    async def _send_samples(self, client: _Client) -> None:
        """S1, S2: every sample, in order, as soon as it is there. A batch that cannot be sent is
        reported as undelivered, never silently lost, and the samples after it go on."""
        stream = self.stream
        if stream is None:
            return
        seq_source = self.session.motion_link_device().get("seq_source", "device")
        while True:
            batch = await stream.take(MAX_BATCH)
            try:
                frame = self._encode(self._message("sample.batch", {
                    "seq_source": seq_source, "samples": [s.link() for s in batch]}))
                await client.ws.send(frame)
            except ConnectionClosed:
                stream.not_sent(batch, f"the connection of {client.id} closed")
                return
            except asyncio.CancelledError:
                stream.not_sent(batch, f"{client.id} was dropped while a batch was being sent")
                raise
            except Exception as exc:  # noqa: BLE001 - for example a value JSON cannot hold
                log.exception("link: a sample batch for %s failed", client.id)
                stream.not_sent(batch, f"the batch could not be sent: {type(exc).__name__}: {exc}")
                continue
            if client.cut:  # aborted while the batch waited in the socket's buffer
                stream.not_sent(batch, f"the connection of {client.id} was cut")
                return
            stream.sent_ok(batch)

    async def _receive(self, client: _Client) -> None:
        handlers = {"heartbeat": self._on_heartbeat, "pose.batch": self._on_poses,
                    "event": self._on_event, "render.report": self._on_report,
                    "error": self._on_client_error}
        try:
            async for frame in client.ws:
                t_ns = self.clock.now_ns()
                message, issues = read_frame(frame)
                if issues:
                    await self._invalid(client, message, issues, t_ns)
                    continue
                kind = message["type"]
                if kind not in _ALLOWED[client.role]:
                    rid = message.get("id")
                    self.link_log.write(t_ns, "not_permitted", client=client.id, type=kind)
                    await self._reply(client, self._error(
                        "not_permitted", f"a {client.role} client does not send {kind}",
                        re_id=rid if isinstance(rid, str) else None))
                    continue
                handlers[kind](client, message, t_ns)
        except ConnectionClosed:
            pass

    async def _reply(self, client: _Client, message: dict[str, Any]) -> None:
        try:
            await self._send(client.ws, message)
        except ConnectionClosed:
            pass

    async def _invalid(self, client: _Client, value: Any, issues: list, t_ns: int) -> None:
        unknown = unknown_kind(value)
        if unknown is not None:  # E5: a later version's type or kind: logged, otherwise ignored
            self.counts["unknown_ignored"] += 1
            self.link_log.write(t_ns, "ignored", client=client.id, unknown=unknown, message=value)
            rid = value.get("id")
            if unknown == "type" and isinstance(rid, str):
                await self._reply(client, self._error(
                    "unknown_type", f"this runtime does not know the type {value['type']}",
                    re_id=rid))
            return
        first = issues[0]
        if first.keyword == "json":
            self.link_log.write(t_ns, "bad_json", client=client.id, problem=first.message)
            await self._reply(client, self._error("bad_json", first.message))
            return
        self.link_log.write(t_ns, "bad_message", client=client.id,
                            problems=[[i.path, i.keyword, i.message] for i in issues],
                            message=value)
        await self._reply(client, self._error(
            "bad_message", f"the message does not validate ({first.keyword}: {first.message})",
            path=first.path))

    # --- what a client sends ------------------------------------------------------------------

    def _on_heartbeat(self, client: _Client, message: dict[str, Any], t_ns: int) -> None:
        data = message["data"]
        if client.last_heartbeat_ns is not None:
            gap = t_ns - client.last_heartbeat_ns
            if gap > client.max_heartbeat_gap_ns:
                client.max_heartbeat_gap_ns = gap
        if client.last_n is not None and data["n"] > client.last_n + 1:
            client.missing_heartbeats += data["n"] - client.last_n - 1
        client.last_heartbeat_ns, client.last_n = t_ns, data["n"]
        client.heartbeats += 1
        client.last_seq = data.get("last_seq", client.last_seq)
        client.epoch = data.get("epoch", client.epoch)

    def _on_poses(self, client: _Client, message: dict[str, Any], t_ns: int) -> None:
        poses = message["data"]["poses"]
        self.counts["pose_batches"] += 1
        self.counts["poses"] += len(poses)
        previous = self._last_pose_seq
        for pose in poses:  # P1: one pose per sample, in seq order
            if previous is not None and not 0 < (pose["seq"] - previous) % (1 << 32) < (1 << 31):
                self.counts["pose_order_errors"] += 1
            previous = pose["seq"]
        self._last_pose_seq = previous
        last = poses[-1]
        self.last_pose = {"seq": last["seq"], "x": last["x"], "z": last["z"], "yaw": last["yaw"]}
        self.link_log.write(t_ns, "pose.batch", client=client.id, message=message)

    def _on_event(self, client: _Client, message: dict[str, Any], t_ns: int) -> None:
        data = message["data"]
        stale = data["epoch"] < self.epoch
        self.counts["events"] += 1
        if stale:
            self.counts["stale_events"] += 1
        else:
            self.epoch = data["epoch"]
        self.link_log.write(t_ns, "event", client=client.id, stale=stale, epoch_in_force=self.epoch,
                            message=message)
        if stale:
            log.info("link: stale %s event of epoch %d (epoch %d in force) logged, not passed on",
                     data["kind"], data["epoch"], self.epoch)
            return
        for listener in list(self.listeners):
            call = getattr(listener, "on_link_event", None)
            if call is not None:
                try:
                    call(self, message, t_ns)
                except Exception:  # noqa: BLE001 - one listener must not stop the others
                    log.exception("link: listener %r failed on an event", listener)

    def _on_report(self, client: _Client, message: dict[str, Any], t_ns: int) -> None:
        self.counts["render_reports"] += 1
        self.link_log.write(t_ns, "render.report", client=client.id, message=message)

    def _on_client_error(self, client: _Client, message: dict[str, Any], t_ns: int) -> None:
        self.counts["client_errors"] += 1
        self.link_log.write(t_ns, "client_error", client=client.id, message=message)
        log.warning("link: %s reported %s: %s", client.id, message["data"]["code"],
                    message["data"]["message"])

    # --- alarms and numbers -------------------------------------------------------------------

    def _alarm(self, reason: str, fields: dict[str, Any]) -> None:
        """A session alarm: in the link log, the session's alarms (Session.raise_alarm) and to
        the listeners; never silent."""
        alarm = {"t_ns": self.clock.now_ns(), "reason": reason, **fields}
        self.alarms.append(alarm)
        self.link_log.write(alarm["t_ns"], "alarm", reason=reason, **fields)
        raise_alarm = getattr(self.session, "raise_alarm", None)
        if raise_alarm is not None:
            raise_alarm("link", reason, **fields)
        else:
            log.error("link alarm: %s", reason)
        for listener in list(self.listeners):
            call = getattr(listener, "on_link_alarm", None)
            if call is not None:
                try:
                    call(self, alarm)
                except Exception:  # noqa: BLE001
                    log.exception("link: listener %r failed on an alarm", listener)

    def stats(self) -> dict[str, Any]:
        clients = {cid: {"role": c.role, "heartbeats_received": c.heartbeats,
                         "heartbeats_sent": c.sent_heartbeats,
                         "missing_heartbeats": c.missing_heartbeats,
                         "max_heartbeat_gap_us": c.max_heartbeat_gap_ns // 1000}
                   for cid, c in self.clients.items()}
        out: dict[str, Any] = {"state": self.state, "epoch": self.epoch, **self.counts,
                               "alarms": len(self.alarms), "clients": clients}
        if self.stream is not None:
            out["stream"] = self.stream.stats()
        return out
