"""Reading a device line by line from a serial port (plan item DPR-03; docs/protocol/device-v1.md).

One reader thread per device owns the port's reading side. It blocks in read() with a short
timeout (it wakes at the driver's completion of a read, never on a polling tick), splits what
arrives into lines and reassembles lines cut across reads (rule H1), stamps each line with the
session clock at the read that completed it (t_host_ns, rule H1), cuts off a line longer than 254
bytes and resynchronises at the next LF (rule F2), writes every line to the raw-line log, hands the
lines to the device's profile (threemaze/devices/profiles), and hands the records the profile makes
to the runtime in one batch per read: with loop.call_soon_threadsafe when the runtime has an
asyncio event loop, else by a direct call. The event loop is never polled and never sleeps for the
reader.

    LineFramer        bytes in, lines out (H1, F2), bounded buffer
    RawLineLog        the raw-line log, "three-maze raw capture 1", written by its own thread
    LineReader        the reader thread
    SerialLineSource  a device read this way: the host's side of the protocol through its
                      profile (open, start, stop, pulse), the heartbeat (rule H7) and the hand-off
                      of records
    driver "serial_lines": a device on a serial port of this computer (pySerial)

The driver "simulated" (simulated.py) is a SerialLineSource too, on an in-process port. This module
replaces, for the v1 rig runtime, the serial reading of v0.3 (experiments/hallway04_experiment.py:
263-327 and its copies in hallway01/02, backend/src/hardware/serial_manager.py:141-194), which
polled the port from the event loop, sleeping 1 ms between turns, about 15.6 ms on Windows.
"""
import collections
import json
import logging
import queue
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, ClassVar

from ..api import DeviceContext, DeviceError, InputDevice, OutputDevice, register
from ..config.rig import device_defaults
from ..core.records import Record, StreamFault
from .profiles import Profile
from .profiles.v1 import MAX_LINE, V1Profile, V1Settings

log = logging.getLogger("threemaze.devices.serial_lines")

RAW_FORMAT = "three-maze raw capture 1"
READ_TIMEOUT_S = 0.05   # a read waits at most this long, so that stop and requests are served
WRITE_TIMEOUT_S = 1.0
CALL_TIMEOUT_S = 2.0    # how long a request to the reader thread may wait for it
FLUSH_EVERY_S = 1.0


@dataclass(frozen=True, slots=True)
class Line:
    """One line as received: data with its line ending (for an overlong line, what was kept), and
    body without the LF and a CR before it, or None when the line is longer than allowed (F2)."""

    data: bytes
    body: bytes | None


class LineFramer:
    """Splits bytes into lines at LF, however they arrive (rule H1). Holds at most one line: a
    line with more than max_line bytes before its CR LF is cut off and reported once, and the bytes
    up to the next LF are dropped (rule F2)."""

    def __init__(self, max_line: int = MAX_LINE):
        self.max_line = max_line
        self._buf = bytearray()
        self._skipping = False   # inside an overlong line that was already reported

    @property
    def partial(self) -> bytes:
        """The incomplete line held so far."""
        return bytes(self._buf)

    def clear(self) -> None:
        self._buf.clear()
        self._skipping = False

    def feed(self, chunk: bytes) -> list[Line]:
        lines = []
        start = 0
        while True:
            end = chunk.find(b"\n", start)
            if end < 0:
                break
            if self._skipping:
                self._skipping = False
            else:
                if self._buf:
                    self._buf += chunk[start:end + 1]
                    data = bytes(self._buf)
                    self._buf.clear()
                else:
                    data = bytes(chunk[start:end + 1])
                body = data[:-1]
                if body.endswith(b"\r"):
                    body = body[:-1]
                lines.append(Line(data, body if len(body) <= self.max_line else None))
            start = end + 1
        if start < len(chunk) and not self._skipping:
            self._buf += chunk[start:]
            if len(self._buf) > self.max_line + 1:   # too long, even if a CR waits for its LF
                lines.append(Line(bytes(self._buf), None))
                self._buf.clear()
                self._skipping = True
        return lines


def _anchor() -> dict[str, Any]:
    return {"wall_utc": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
            "perf_counter_ns": time.perf_counter_ns()}


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):  # the rig file's read-only mappings
        return dict(value)
    if isinstance(value, tuple):
        return list(value)
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


class RawLineLog:
    """The raw-line log of one device, in the format of tools/capture_raw.py ("three-maze raw
    capture 1"): comment lines '# {json}' (settings, clock anchors, every write to the device,
    totals), then '<t_host_ns> TAB <the line's bytes as received, its line ending included>' for
    every line read. An overlong line is logged as far as it was kept, with a newline added and a
    comment saying so; a line still incomplete at the end is written with a newline added.

    A thread of its own does the writing, so a slow disk never holds up the reader; it flushes
    about every second and when the log is closed. Rejected lines stay in the log (rule H2)."""

    _LINE, _WROTE, _COMMENT, _CLOSE = range(4)

    def __init__(self, path: Path, info: dict[str, Any]):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._fh = open(path, "xb")
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self.lines = 0
        self._closed = False
        self._comment({"format": RAW_FORMAT, "tool": "threemaze/devices/serial_lines.py", **info,
                       "columns": "host perf_counter_ns<TAB>raw line bytes as received (line ending"
                                  " included)"})
        self._comment({"opened": _anchor()})
        self._thread = threading.Thread(target=self._run, name=f"raw-log-{path.stem}", daemon=True)
        self._thread.start()

    def line(self, t_ns: int, data: bytes) -> None:
        self._queue.put((self._LINE, t_ns, data))

    def wrote(self, t_ns: int, data: bytes) -> None:
        self._queue.put((self._WROTE, t_ns, data))

    def comment(self, obj: dict[str, Any]) -> None:
        self._queue.put((self._COMMENT, obj))

    def close(self, t_ns: int, partial: bytes = b"") -> None:
        if self._closed:
            return
        self._closed = True
        self._queue.put((self._CLOSE, t_ns, partial))
        self._thread.join(10.0)

    def _comment(self, obj: dict[str, Any]) -> None:
        text = json.dumps(obj, ensure_ascii=True, default=_json_value)
        self._fh.write(b"# " + text.encode("ascii") + b"\n")

    def _run(self) -> None:
        fh = self._fh
        flushed = time.monotonic()
        while True:
            try:
                item = self._queue.get(timeout=FLUSH_EVERY_S)
            except queue.Empty:
                fh.flush()
                flushed = time.monotonic()
                continue
            kind = item[0]
            if kind == self._LINE:
                _, t_ns, data = item
                fh.write(b"%d\t" % t_ns + data)
                if not data.endswith(b"\n"):
                    fh.write(b"\n")
                self.lines += 1
            elif kind == self._WROTE:
                _, t_ns, data = item
                text = data.decode("ascii", "backslashreplace")
                self._comment({"wrote_to_device": {"perf_counter_ns": t_ns, "bytes": text}})
            elif kind == self._COMMENT:
                self._comment(item[1])
            else:
                _, t_ns, partial = item
                if partial:
                    fh.write(b"%d\t" % t_ns + partial + b"\n")
                self._comment({"closed": _anchor(), "lines": self.lines,
                               "incomplete_last_line_bytes": len(partial)})
                fh.close()
                return
            if time.monotonic() - flushed >= FLUSH_EVERY_S:
                fh.flush()
                flushed = time.monotonic()


Deliver = Callable[[list[Record]], None]


class LineReader:
    """The reader thread of one device: read, frame, log, parse, hand on (see the module docstring).

    The port is anything with pySerial's reading interface: read(size) that waits at most its
    timeout for the bytes asked for, in_waiting, reset_input_buffer() and, optionally,
    cancel_read(). call() runs a function on the reader thread between two reads, so that a discard
    and the command that follows it are never interleaved with the processing of a read."""

    def __init__(self, port: Any, profile: Profile, clock: Any, deliver: Deliver, *,
                 raw: RawLineLog | None = None, name: str = "serial-reader",
                 max_line: int = MAX_LINE):
        self.port = port
        self.profile = profile
        self.clock = clock
        self.raw = raw
        self.framer = LineFramer(max_line)
        self.stats = {"reads": 0, "bytes": 0, "batches": 0, "timeouts": 0, "discarded_bytes": 0}
        self.error: BaseException | None = None
        self.failure: str | None = None   # why the thread ended early, as its StreamFault says
        self._deliver = deliver
        self._actions: collections.deque[Callable[[], None]] = collections.deque()
        self._running = False
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)

    @property
    def alive(self) -> bool:
        return self._thread.is_alive()

    def start(self) -> None:
        self._running = True
        self._thread.start()

    def stop(self, timeout_s: float = CALL_TIMEOUT_S) -> None:
        """Ask the thread to end and wait for it (the port is closed after this)."""
        self._running = False
        self._wake()
        if self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(timeout_s)

    def call(self, fn: Callable[[], Any], timeout_s: float = CALL_TIMEOUT_S) -> Any:
        """Run fn on the reader thread between two reads (or here, if the thread has ended)."""
        if threading.current_thread() is self._thread or not self._thread.is_alive():
            return fn()
        once = threading.Lock()
        done = threading.Event()
        box: dict[str, Any] = {}

        def task() -> None:
            if not once.acquire(blocking=False):
                return
            try:
                box["value"] = fn()
            except BaseException as exc:  # noqa: BLE001 - re-raised in the caller's thread
                box["error"] = exc
            finally:
                done.set()

        self._actions.append(task)
        self._wake()
        deadline = time.monotonic() + timeout_s
        while not done.wait(0.05):
            if not self._thread.is_alive():
                task()  # the thread ended before it ran the task: run it here
            elif time.monotonic() > deadline:
                raise TimeoutError(f"{self._thread.name}: no answer within {timeout_s} s")
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def discard(self) -> None:
        """Drop everything received so far: the driver's input buffer and the partial line."""
        try:
            self.port.reset_input_buffer()
        except Exception as exc:  # noqa: BLE001 - a port without input buffer to reset
            log.debug("%s: reset_input_buffer: %r", self._thread.name, exc)
        partial = self.framer.partial
        self.framer.clear()
        if partial:
            self.stats["discarded_bytes"] += len(partial)
            if self.raw is not None:
                text = partial.decode("ascii", "backslashreplace")
                self.raw.comment({"discarded": {"perf_counter_ns": self.clock.now_ns(),
                                                "bytes": text}})

    def restart(self, send: Callable[[], None]) -> None:
        """Discard, begin the profile's stream, then send (on the reader thread, rule H4)."""
        self.discard()
        self.profile.begin_stream()
        send()

    def end_stream(self) -> None:
        records = self.profile.end_stream(self.clock.now_ns())
        if records:
            self._deliver(records)

    def _wake(self) -> None:
        cancel = getattr(self.port, "cancel_read", None)
        if cancel is not None:
            try:
                cancel()
            except Exception as exc:  # noqa: BLE001 - the read then ends at its timeout
                log.debug("%s: cancel_read: %r", self._thread.name, exc)

    def _run_actions(self) -> None:
        while self._actions:
            self._actions.popleft()()

    def _run(self) -> None:
        port, clock, framer, profile = self.port, self.clock, self.framer, self.profile
        raw, stats = self.raw, self.stats
        try:
            while self._running:
                if self._actions:
                    self._run_actions()
                try:
                    chunk = port.read(port.in_waiting or 1)
                except Exception as exc:  # noqa: BLE001 - OSError, SerialException: port gone
                    if self._running:
                        log.error("%s: reading the port failed, it reads no more: %r",
                                  self._thread.name, exc)
                        self._fail(f"reading the port failed: {type(exc).__name__}: {exc}", exc)
                    break
                t_ns = clock.now_ns()
                if not chunk:
                    stats["timeouts"] += 1
                    continue
                stats["reads"] += 1
                stats["bytes"] += len(chunk)
                records: list[Record] = []
                for line in framer.feed(chunk):
                    if raw is not None:
                        raw.line(t_ns, line.data)
                    if line.body is None:
                        profile.overflow(t_ns)
                        if raw is not None and not line.data.endswith(b"\n"):
                            raw.comment({"cut_off": {"perf_counter_ns": t_ns,
                                                     "kept_bytes": len(line.data)}})
                    else:
                        records += profile.parse(line.body, t_ns)
                if records:
                    stats["batches"] += 1
                    self._deliver(records)
        except Exception as exc:  # noqa: BLE001 - a bug must not end the stream silently
            log.exception("%s: reader thread failed", self._thread.name)
            self._fail(f"the reader failed: {type(exc).__name__}: {exc}", exc)
        finally:
            self._running = False
            self._run_actions()

    def _fail(self, reason: str, exc: BaseException) -> None:
        self.error, self.failure = exc, reason
        try:
            self._deliver([StreamFault(reason, self.clock.now_ns())])
        except Exception:  # noqa: BLE001 - nothing more can be done from here
            log.exception("%s: could not report %s", self._thread.name, reason)


class _Heartbeat:
    """Sends a heartbeat command every period from its own thread (rule H7)."""

    def __init__(self, send: Callable[[], None], period_s: float, name: str):
        self._send = send
        self._period = period_s
        self._stop = threading.Event()
        self.sent = 0
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread.is_alive():
            self._thread.join(1.0)

    def _run(self) -> None:
        while True:
            try:
                self._send()
            except OSError as exc:  # the port is gone; the session's shutdown follows
                log.warning("%s: heartbeat stopped: %r", self._thread.name, exc)
                return
            self.sent += 1
            if self._stop.wait(self._period):
                return


class SerialLineSource(InputDevice, OutputDevice):
    """A device whose port is read line by line (see the module docstring). A subclass supplies the
    port (open_port) and the profile (profile_for); this class runs the reader thread, the
    raw-line log at <session>/raw/<device>.tsv, the host's side of the session sequence through the
    profile, the heartbeat, and hands every record to the runtime: ctx.on_batch(device name,
    records), on ctx.loop with call_soon_threadsafe when the runtime has one.

    With periodUs in its configuration the device streams samples (role motion); with outputs >= 1
    it drives outputs (role reward). One device may do both."""

    driver_version = "1"
    read_timeout_s: ClassVar[float] = READ_TIMEOUT_S

    @classmethod
    def roles(cls, config: Mapping[str, Any]) -> frozenset[str]:
        found = set()
        if "periodUs" in config:
            found.add("motion")
        if config.get("outputs", 0) >= 1:
            found.add("reward")
        return frozenset(found)

    def __init__(self, name: str, config: Mapping[str, Any], ctx: DeviceContext):
        super().__init__(name, config, ctx)
        self.raw_path = ctx.session_dir / "raw" / f"{name}.tsv"
        self.profile: Profile | None = None
        self.port: Any = None
        self.raw: RawLineLog | None = None
        self.reader: LineReader | None = None
        self.hello: dict[str, Any] | None = None
        self.streaming = False
        self.stop_report: str | None = None    # the record of the last stream's stop report
        self.undelivered = 0                   # records the runtime's loop could not take any more
        self._write_lock = threading.Lock()
        self._cv = threading.Condition()
        self._want: Callable[[Record], bool] | None = None
        self._found: Record | None = None
        self._beat: _Heartbeat | None = None
        self._cmd_id = 0

    # --- what a subclass supplies -------------------------------------------------------------

    @classmethod
    def profile_for(cls, config: Mapping[str, Any],
                    calibration: Mapping[str, Any] | None) -> Profile:
        """A new profile for a device with this rig-file entry and calibration entry."""
        raise NotImplementedError

    @classmethod
    def link_device_for(cls, config: Mapping[str, Any],
                        calibration: Mapping[str, Any] | None) -> dict[str, Any]:
        """The link protocol's MotionDevice from the rig file alone, before the device is open."""
        return cls.profile_for(config, calibration).link_device()

    def open_port(self) -> Any:
        """The open port: pySerial's interface (see LineReader), with the read timeout
        read_timeout_s. Raise DeviceError if it cannot be opened."""
        raise NotImplementedError

    def raw_log_enabled(self) -> bool:
        return True

    def raw_log_info(self) -> dict[str, Any]:
        return {"device": self.name, "driver": self.driver}

    # --- lifecycle ----------------------------------------------------------------------------

    def open(self) -> None:
        self.profile = self.profile_for(self.config, self.ctx.calibration)
        self.port = self.open_port()
        if self.raw_log_enabled():
            self.raw = RawLineLog(self.raw_path, self.raw_log_info())
        self.reader = LineReader(self.port, self.profile, self.ctx.clock, self._records,
                                 raw=self.raw, name=f"reader-{self.name}")
        self.reader.start()
        try:
            self.profile.open(self)
        except DeviceError:
            if self.reader.failure is not None:  # the port failed, not the device's answer
                raise DeviceError(f"device {self.name!r}: {self.reader.failure}") from None
            raise
        self.hello = self.profile.record()["hello"]

    def start(self) -> None:
        if self.port is None or "motion" not in self.roles(self.config):
            return
        self.profile.start(self)
        self.streaming = True

    def stop(self) -> None:
        if not self.streaming:
            return
        self.streaming = False
        report = self.profile.stop(self)
        self.stop_report = report.record if report is not None else None

    def safe_state(self) -> None:
        if self.port is None or self.reader is None or not self.config.get("outputs", 0):
            return
        if self.streaming:
            # One device for motion and reward: this stop ends its stream too, so wait for the
            # stop report here; a second stop would get none
            self.stop()
        else:
            self.profile.stop_outputs(self)

    def close(self) -> None:
        # A closed device has no port: safe_state(), start() and stop() then do nothing and pulse()
        # refuses, as the OutputDevice contract asks (safe_state must not raise once closed)
        self.streaming = False
        if self._beat is not None:
            self._beat.stop()
            self._beat = None
        if self.reader is not None:
            self.reader.stop()
        port, self.port = self.port, None
        if port is not None:
            try:
                port.close()
            except Exception as exc:  # noqa: BLE001 - closing must go on
                log.warning("device %s: closing the port: %r", self.name, exc)
        if self.raw is not None:
            partial = self.reader.framer.partial if self.reader is not None else b""
            self.raw.close(self.ctx.clock.now_ns(), partial)
            self.raw = None

    def pulse(self, channel: int, width_us: int) -> int:
        """Send one pulse command; returns its cmd_id (from 1, increasing: rule H8). The outcome
        arrives as a PulseOutcome record. Interim: plan items DPR-09 and DPR-10 add the output path
        with the safety envelope."""
        if self.port is None:
            raise DeviceError(f"device {self.name!r} is not open")
        self._cmd_id += 1
        self.profile.pulse(self, self._cmd_id, channel, width_us)
        return self._cmd_id

    def describe(self) -> dict[str, Any]:
        out = {**super().describe(), "hello": self.hello, "stop_report": self.stop_report,
               "raw_log": f"raw/{self.name}.tsv" if self.raw_log_enabled() else None}
        if self.profile is not None:
            # The device's fields of the session record, where device-v1.md section 8.3 puts
            # them (rule H9): profile, hello, guarantees, the levels, counters, output_timing
            out.update(self.profile.record())
        if self.reader is not None:
            out["reader"] = {**self.reader.stats, "failure": self.reader.failure,
                             "undelivered_records": self.undelivered}
        return out

    def link_device(self) -> dict[str, Any] | None:
        """The motion device's entry of the link protocol's welcome, once the device is open."""
        return self.profile.link_device() if self.profile is not None else None

    # --- the Host interface the profile uses --------------------------------------------------

    def write(self, data: bytes) -> None:
        with self._write_lock:
            if self.raw is not None:
                self.raw.wrote(self.ctx.clock.now_ns(), data)
            self.port.write(data)

    def discard(self) -> None:
        self.reader.call(self.reader.discard)

    def restart(self, data: bytes) -> None:
        self.reader.call(lambda: self.reader.restart(lambda: self.write(data)))

    def end_stream(self) -> None:
        self.reader.call(self.reader.end_stream)

    def request(self, data: bytes, match: Callable[[Record], bool], *, timeout_s: float,
                retry_s: float | None = None) -> Record | None:
        with self._cv:
            self._want, self._found = match, None
        try:
            deadline = time.monotonic() + timeout_s
            while True:
                self.write(data)
                until = deadline if retry_s is None else min(deadline, time.monotonic() + retry_s)
                with self._cv:
                    while self._found is None and self.reader.alive:
                        remaining = until - time.monotonic()
                        if remaining <= 0:
                            break
                        self._cv.wait(remaining)
                    if self._found is not None:
                        return self._found
                if not self.reader.alive or time.monotonic() >= deadline:
                    return None
        finally:
            with self._cv:
                self._want = None

    def heartbeat(self, data: bytes, period_s: float) -> None:
        if self._beat is None:
            self._beat = _Heartbeat(lambda: self.write(data), period_s, name=f"beat-{self.name}")
            self._beat.start()

    # --- records, on the reader thread --------------------------------------------------------

    def _records(self, records: list[Record]) -> None:
        want = self._want
        if want is not None:
            for record in records:
                if want(record):
                    with self._cv:
                        if self._want is want and self._found is None:
                            self._found = record
                            self._cv.notify_all()
                    break
        on_batch = self.ctx.on_batch
        if on_batch is None:
            return
        loop = self.ctx.loop
        if loop is None:
            on_batch(self.name, records)
            return
        try:
            loop.call_soon_threadsafe(on_batch, self.name, records)
        except RuntimeError:  # the runtime's event loop is closed: say so, never silently
            self.undelivered += len(records)
            log.error("device %s: %d records not delivered: the runtime's event loop is closed"
                      " (%d so far)", self.name, len(records), self.undelivered)


@register("serial_lines")
class SerialLinesDevice(SerialLineSource):
    """Driver "serial_lines": a device on a serial port of this computer (USB CDC or a UART), read
    in the profile its rig-file entry names (v1; plan item DPR-04 adds legacy-v0.3). The port is a
    port name or a pySerial URL (serial.serial_for_url), so "loop://" serves the tests without
    hardware. docs/rig-file-v1.md lists the fields; their defaults come from the rig file's schema
    ($defs/serialLinesDevice)."""

    @classmethod
    def check_config(cls, config: Mapping[str, Any], rig_dir: Path) -> list[tuple[str, str]]:
        if not cls.roles(config):
            return [("", "a serial_lines device needs periodUs (to stream samples) or outputs >= 1"
                         " (to drive outputs)")]
        return []

    def __init__(self, name: str, config: Mapping[str, Any], ctx: DeviceContext):
        super().__init__(name, config, ctx)
        self.settings = {**device_defaults("serialLinesDevice"), **config}

    @classmethod
    def profile_for(cls, config: Mapping[str, Any],
                    calibration: Mapping[str, Any] | None) -> Profile:
        s = {**device_defaults("serialLinesDevice"), **config}
        if s["profile"] != V1Profile.name:  # the schema admits no other in this version
            raise DeviceError(f"profile {s['profile']!r} is not available")
        return V1Profile(V1Settings(
            device_id=s.get("deviceId"), period_us=s.get("periodUs", 0),
            matrix=(calibration or {}).get("matrix"), outputs=s.get("outputs", 0),
            open_delay_ms=s["openDelayMs"], hello_interval_ms=s["helloIntervalMs"],
            hello_timeout_ms=s["helloTimeoutMs"], stop_timeout_ms=s["stopTimeoutMs"]))

    def open_port(self) -> Any:
        import serial  # pySerial (requirements.txt)
        port = self.settings["port"]
        try:
            return serial.serial_for_url(port, baudrate=self.settings["baud"],
                                         timeout=self.read_timeout_s, write_timeout=WRITE_TIMEOUT_S)
        except (OSError, ValueError) as exc:  # serial.SerialException is an OSError
            raise DeviceError(f"device {self.name!r}: cannot open port {port!r}: {exc}") from None

    def raw_log_enabled(self) -> bool:
        return bool(self.settings["rawLog"])

    def raw_log_info(self) -> dict[str, Any]:
        s = self.settings
        return {**super().raw_log_info(), "port": s["port"], "baud": s["baud"],
                "profile": s["profile"]}

    def describe(self) -> dict[str, Any]:
        config = self.config
        return {**super().describe(), "port": self.settings["port"],
                "device_id": config.get("deviceId"), "period_us": config.get("periodUs", 0),
                "outputs": config.get("outputs", 0)}
