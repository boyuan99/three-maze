"""The reference simulated device of device protocol v1 (plan item DPR-02;
docs/protocol/device-v1.md).

SimDevice is the device side of one serial port, as a pure state machine on a microsecond time
line that the caller drives: write() hands it the host's bytes, advance() returns the bytes it
sends up to a given time, next_due() says when it next has something to send. No thread, no
clock and no input or output of its own, so tests run it in virtual time and SimPort
(port.py) runs it in real time.

What it does (rule ids of the protocol):
- answers every framed `hello` with one H line (D1), ignores commands with a missing or wrong
  checksum (D11) and answers unknown commands with an E line;
- `start` begins a stream: one S line per period whether or not anything moved (D2), seq from 0
  (D3), t_us the end of the window on a free-running microsecond clock (D4), contiguous windows
  (D5), running totals of integer counts that wrap like int32 (D6), flags 0 (D7), and only
  between start and stop (D8); lick edges as L lines on channel 0 before the S line of their
  window (D9), only when its hello declares lick=1, and no F lines, since it declares no frame
  clock (section 4.4); `stop` ends the stream with a Z line;
- with outputs: `pulse` opens a channel for the commanded width and answers with one A line
  carrying the on and off times on its clock, or one X line (busy, range, channel, fault) (D10);
  a declared heartbeat timeout closes an open output when `beat`s stop; `stop` closes outputs;
- fault injection on request, each logged with its sample number: dropped samples, a corrupted
  digit under the original checksum, a partial line, a line delivered in pieces, a burst of held
  lines, silence, and the uint32 wrap of the device clock.

Every event goes to the log callback: log(event, **fields), times as t_dev_us on the device clock
(64 bits, before the low 32 bits are sent).
"""
import functools
import heapq
import itertools
import math
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .frame import U32, frame, int32, unframe
from .motion import (AXES, MotionError, MotionSource, Replay, SampleFile, Segment, Segments, Sensor,
                     Still)

PROTOCOL = "threemaze-device"
VERSION = "1.0"
MAX_LINE = 254  # bytes before CR LF (rule F2)
FAULT_TYPES = ("drop", "badCrc", "truncate", "split", "burst", "silence", "wrap")

Log = Callable[..., None]


@dataclass(frozen=True)
class Fault:
    """One requested fault, at sample `seq` of every stream (wrap: of the first stream)."""

    kind: str
    seq: int
    count: int = 1          # drop, burst: how many samples
    keep_bytes: int = 0     # truncate: bytes of the line that are sent
    pieces: int = 0         # split: into how many pieces
    gap_us: int = 0         # split: time between pieces
    duration_ms: int = 0    # silence: how long

    def samples(self, period_us: int) -> range:
        """The samples it touches."""
        if self.kind in ("drop", "burst"):
            return range(self.seq, self.seq + self.count)
        if self.kind == "silence":
            return range(self.seq, self.seq + math.ceil(self.duration_ms * 1000 / period_us))
        if self.kind == "wrap":
            return range(0)
        return range(self.seq, self.seq + 1)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.kind, "seq": self.seq}
        extra = {"drop": ("count",), "burst": ("count",), "truncate": ("keep_bytes",),
                 "split": ("pieces", "gap_us"), "silence": ("duration_ms",)}.get(self.kind, ())
        out.update({name: getattr(self, name) for name in extra})
        return out


@dataclass(frozen=True)
class SimConfig:
    """A simulated device. The defaults are the rig schema's ($defs/simulatedDevice)."""

    device_id: str
    period_us: int | None = None
    outputs: int = 0
    ack: bool = True
    max_pulse_us: int | None = None
    on_latency_us: int = 0
    hb_ms: int | None = None
    fw: str | None = None
    lick: int = 0
    clock_start_us: int = 0
    line_ending: str = "lf"
    faults: tuple[Fault, ...] = ()
    motion: Callable[[], MotionSource] = Still
    files: Mapping[str, Path] = field(default_factory=dict)  # what the motion source read

    @property
    def axes(self) -> int:
        return AXES if self.period_us else 0

    @property
    def eol(self) -> bytes:
        return b"\r\n" if self.line_ending == "crlf" else b"\n"


def config_problems(entry: Mapping[str, Any]) -> list[tuple[str, str]]:
    """What the schema cannot check in a simulated device's entry: (pointer below it, message)."""
    problems = []
    period = entry.get("periodUs")
    trajectory = entry.get("trajectory")
    if period is None:
        for key in ("trajectory", "faults", "lick", "sensor"):
            if key in entry:
                problems.append((f"/{key}", "needs periodUs: only a device that streams samples has it"))
        return problems
    if trajectory and trajectory.get("kind") in ("segments", "samples") and "sensor" not in entry:
        problems.append(("/sensor", "missing: a segments or samples trajectory needs the sensor"
                                    " resolution to turn cm and rad into counts"))
    taken: dict[int, int] = {}
    wraps = 0
    for index, item in enumerate(entry.get("faults", ())):
        fault = _fault(item)
        if fault.kind == "wrap":
            wraps += 1
            if wraps > 1:
                problems.append((f"/faults/{index}", "only one wrap per device"))
        if fault.kind == "split" and (fault.pieces - 1) * fault.gap_us >= period:
            problems.append((f"/faults/{index}/gapUs", "the pieces must all arrive within one"
                                                       f" period: (pieces - 1) x gapUs < {period}"))
        for seq in fault.samples(period):
            if seq in taken:
                problems.append((f"/faults/{index}", f"sample {seq} already has fault {taken[seq]}"))
                break
            taken[seq] = index
    return problems


def _fault(item: Mapping[str, Any]) -> Fault:
    return Fault(kind=item["type"], seq=item["seq"], count=item.get("count", 1),
                 keep_bytes=item.get("keepBytes", 0), pieces=item.get("pieces", 0),
                 gap_us=item.get("gapUs", 0), duration_ms=item.get("durationMs", 0))


def config_from_entry(entry: Mapping[str, Any], resolve: Callable[[str], Path]) -> SimConfig:
    """A SimConfig from a validated rig-file entry (or a THREEMAZE_SIM_DEVICE file); file names
    in it go through resolve(). Raises MotionError if a trajectory file cannot be used."""
    period = entry.get("periodUs")
    sensor = entry.get("sensor")
    sensor = Sensor(sensor["cmPerCount"], sensor["radPerCount"]) if sensor else None
    trajectory = entry.get("trajectory")
    files: dict[str, Path] = {}
    motion: Callable[[], MotionSource] = Still
    if trajectory:
        kind, loop = trajectory["kind"], trajectory.get("loop", kind_loops(trajectory["kind"]))
        # Each factory is called once here, so that a bad trajectory fails now, not at start
        if kind == "segments":
            segments = [Segment(duration_s=s["durationS"],
                                forward_cm_per_s=s.get("forwardCmPerS", 0.0),
                                left_cm_per_s=s.get("leftCmPerS", 0.0),
                                yaw_deg_per_s=s.get("yawDegPerS", 0.0), lick=s.get("lick", 0))
                        for s in trajectory["segments"]]
            motion = functools.partial(Segments, segments, period, sensor, loop)
        else:
            path = resolve(trajectory["file"])
            files["trajectory"] = path
            if kind == "samples":
                motion = functools.partial(SampleFile, path, sensor, loop)
            else:
                motion = functools.partial(Replay, Replay.load(path), loop)
        motion()
    return SimConfig(
        device_id=entry["deviceId"], period_us=period, outputs=entry.get("outputs", 0),
        ack=entry.get("ack", True), max_pulse_us=entry.get("maxPulseUs"),
        on_latency_us=entry.get("onLatencyUs", 0), hb_ms=entry.get("hbMs"), fw=entry.get("fw"),
        lick=entry.get("lick", 0), clock_start_us=entry.get("clockStartUs", 0),
        line_ending=entry.get("lineEnding", "lf"),
        faults=tuple(_fault(item) for item in entry.get("faults", ())), motion=motion, files=files)


def kind_loops(kind: str) -> bool:
    """Default of `loop`: segments repeat, files play once."""
    return kind == "segments"


@dataclass(frozen=True)
class Delivery:
    """Bytes the device sends at device-internal time t_us (µs since the device was created)."""

    t_us: int
    data: bytes
    seq: int | None = None   # the sample these bytes belong to
    kind: str = ""           # line type, or "piece" for part of a line


@dataclass
class _Stream:
    t0: int
    source: MotionSource
    k: int = 0
    totals: list[int] = field(default_factory=lambda: [0] * AXES)
    lick: int = 0

    def end(self, k: int, period: int) -> int:
        return self.t0 + (k + 1) * period


@dataclass
class _Pulse:
    cmd_id: int
    channel: int
    width_us: int
    t_on: int
    t_off: int


class SimDevice:
    def __init__(self, config: SimConfig, log: Log | None = None):
        self.cfg = config
        self._log = log or (lambda event, **fields: None)
        self._rx = bytearray()
        self._queue: list[tuple[int, int, Delivery]] = []
        self._order = itertools.count()
        self._offset = config.clock_start_us   # device clock = internal time + offset
        self._now = 0
        self._stream: _Stream | None = None
        self._streams = 0
        self._motion = config.motion()
        self._pulses: dict[int, _Pulse] = {}
        self._last_beat: int | None = None
        self._faults = {seq: fault for fault in config.faults if fault.kind != "wrap"
                        for seq in fault.samples(config.period_us or 1)}
        self._wrap = next((fault for fault in config.faults if fault.kind == "wrap"), None)
        self.samples_produced = 0

    # --- time --------------------------------------------------------------------------------

    def clock(self, t: int) -> int:
        """Device clock (µs, 64 bits) at internal time t."""
        return t + self._offset

    def next_due(self) -> int | None:
        """Internal time of the next thing the device will send or do; None if nothing is due."""
        times = [self._queue[0][0]] if self._queue else []
        if self._stream is not None:
            times.append(self._stream.end(self._stream.k, self.cfg.period_us))
        times += [self._pulse_end(p)[0] for p in self._pulses.values()]
        return min(times) if times else None

    def advance(self, now: int) -> list[Delivery]:
        """Everything the device sends up to internal time `now`, in order."""
        self._run_until(now)
        out = []
        while self._queue and self._queue[0][0] <= now:
            out.append(heapq.heappop(self._queue)[2])
        return out

    # --- host -> device ----------------------------------------------------------------------

    def write(self, data: bytes, now: int) -> None:
        """Bytes from the host at internal time `now`."""
        self._run_until(now)
        self._rx += data
        while True:
            end = self._rx.find(b"\n")
            if end < 0:
                break
            line = bytes(self._rx[:end]).rstrip(b"\r")
            del self._rx[:end + 1]
            if line:
                self._command(line, now)

    def _command(self, line: bytes, now: int) -> None:
        record = unframe(line)
        text = line.decode("ascii", "backslashreplace")
        if record is None:
            self._log("command_rejected", t_dev_us=self.clock(now), line=text,
                      reason="missing or wrong checksum")  # D11
            return
        fields = record.split(",")
        name = fields[0]
        self._log("command", t_dev_us=self.clock(now), command=record)
        if name == "hello" and len(fields) == 1:
            self._send(now, self._hello(), "H")
        elif name == "start" and len(fields) == 1 and self.cfg.period_us:
            self._start(now)
        elif name == "stop" and len(fields) == 1:
            self._stop(now)
        elif name == "beat" and len(fields) == 1:
            self._last_beat = now
        elif name == "pulse" and self.cfg.outputs:
            self._pulse(fields, now)
        else:
            self._log("command_ignored", t_dev_us=self.clock(now), command=record)
            self._send(now, f"E,unknown_command,{_text(record)}", "E")

    def _hello(self) -> str:
        cfg = self.cfg
        fields = ["H", PROTOCOL, VERSION, cfg.device_id, str(cfg.period_us or 0), str(cfg.axes)]
        if cfg.fw:
            fields.append(f"fw={cfg.fw}")
        if cfg.lick:
            fields.append(f"lick={cfg.lick}")
        if cfg.outputs:
            fields.append(f"out={cfg.outputs}")
            if cfg.ack:
                fields.append("ack=1")
        if cfg.hb_ms:
            fields.append(f"hb={cfg.hb_ms}")
        return ",".join(fields)

    # --- streams -----------------------------------------------------------------------------

    def _start(self, now: int) -> None:
        period = self.cfg.period_us
        if self._stream is not None:  # a start while streaming: the old stream's lines go first
            self._release_held(now)
        self._stream = _Stream(t0=now, source=self._motion)
        self._motion.reset()
        self._streams += 1
        if self._wrap is not None and self._streams == 1:
            # Place the clock so that t_us wraps between sample seq - 1 and sample seq
            s = self._wrap.seq
            self._offset = U32 - (period - period // 2) - s * period - now
            self._log("fault", t_dev_us=self.clock(now), **self._wrap.as_dict(),
                      t_dev_us_before=self.clock(self._stream.end(s - 1, period)),
                      t_dev_us_after=self.clock(self._stream.end(s, period)))
        self._log("stream_start", t_dev_us=self.clock(now), period_us=period)

    def _stop(self, now: int) -> None:
        for channel in list(self._pulses):
            self._finish_pulse(channel, now, "stop")
        stream, self._stream = self._stream, None
        if stream is None:
            return
        self._release_held(now)  # before the stop report
        self._send(now, f"Z,{stream.k % U32},{self.clock(now) % U32}", "Z")
        self._log("stream_stop", t_dev_us=self.clock(now), n_samples=stream.k)

    def _release_held(self, now: int) -> None:
        """Send at `now` what is due later: the lines a burst holds and the rest of a split line,
        so that no line of a stream that ends now goes out after it (rule D8)."""
        held = [entry for entry in self._queue if entry[0] > now]
        if held:
            self._queue = [entry for entry in self._queue if entry[0] <= now]
            for _, _, delivery in sorted(held):
                self._push(Delivery(now, delivery.data, delivery.seq, delivery.kind))
            heapq.heapify(self._queue)

    def _run_until(self, now: int) -> None:
        now = max(now, self._now)
        self._now = now
        period = self.cfg.period_us
        while True:
            t_sample = self._stream.end(self._stream.k, period) if self._stream else None
            ends = [(self._pulse_end(p), p.channel) for p in self._pulses.values()]
            pulse = min(ends) if ends else None
            t_pulse = pulse[0][0] if pulse is not None else None
            if t_pulse is not None and t_pulse <= now and (t_sample is None or t_pulse <= t_sample):
                (t_off, reason), channel = pulse
                self._finish_pulse(channel, t_off, reason)
            elif t_sample is not None and t_sample <= now:
                self._sample(t_sample)
            else:
                return

    def _sample(self, t_end: int) -> None:
        st, cfg = self._stream, self.cfg
        k = st.k
        st.k += 1
        self.samples_produced += 1
        counts, lick = st.source.next()
        st.totals = [total + count for total, count in zip(st.totals, counts)]
        t_us = self.clock(t_end)
        lines: list[tuple[bytes, str]] = []
        if cfg.lick and lick != st.lick:
            st.lick = lick
            edge = t_us - cfg.period_us // 2
            lines.append((frame(f"L,0,{edge % U32},{lick}") + cfg.eol, "L"))
            self._log("lick", t_dev_us=edge, seq=k, level=lick)
        totals = ",".join(str(int32(total)) for total in st.totals)
        record = f"S,{k % U32},{t_us % U32},{cfg.period_us},0,{totals}"
        line = frame(record) + cfg.eol
        fault = self._faults.get(k)
        when = t_end
        if fault is not None:
            first = k == fault.seq
            if fault.kind in ("drop", "silence"):
                if first:
                    self._log("fault", t_dev_us=t_us, **fault.as_dict(),
                              samples=list(fault.samples(cfg.period_us)))
                lines = lines if fault.kind == "drop" else []
                line = b""
            elif fault.kind == "badCrc":
                bad = record[:-1] + str((int(record[-1]) + 1) % 10)
                line = bad.encode("ascii") + frame(record)[-3:] + cfg.eol
                self._log("fault", t_dev_us=t_us, **fault.as_dict(), line=record, sent=bad)
            elif fault.kind == "truncate":
                keep = min(fault.keep_bytes, len(line) - len(cfg.eol) - 1)
                line = line[:keep]
                self._log("fault", t_dev_us=t_us, **fault.as_dict(), sent_bytes=keep)
            elif fault.kind == "split":
                size = math.ceil(len(line) / fault.pieces)
                pieces = [line[i:i + size] for i in range(0, len(line), size)]
                self._log("fault", t_dev_us=t_us, **fault.as_dict(),
                          piece_bytes=[len(p) for p in pieces])
                for line_out, kind in lines:
                    self._push(Delivery(t_end, line_out, k, kind))
                for index, piece in enumerate(pieces):
                    self._push(Delivery(t_end + index * fault.gap_us, piece, k, "piece"))
                return
            elif fault.kind == "burst":
                when = st.end(fault.seq + fault.count - 1, cfg.period_us)
                if first:
                    self._log("fault", t_dev_us=t_us, **fault.as_dict(),
                              samples=list(fault.samples(cfg.period_us)), t_dev_us_sent=self.clock(when))
        for line_out, kind in lines:
            self._push(Delivery(when, line_out, k, kind))
        if line:
            self._push(Delivery(when, line, k, "S"))

    # --- outputs -----------------------------------------------------------------------------

    def _pulse(self, fields: list[str], now: int) -> None:
        cfg = self.cfg
        try:
            cmd_id, channel, width = (int(v) for v in fields[1:])
            if not all(0 <= v < U32 for v in (cmd_id, channel, width)):
                raise ValueError
        except ValueError:
            self._log("command_ignored", t_dev_us=self.clock(now), command=",".join(fields))
            self._send(now, f"E,bad_command,{_text(','.join(fields))}", "E")
            return
        self._log("pulse_commanded", t_dev_us=self.clock(now), cmd_id=cmd_id, channel=channel,
                  width_us=width)
        reason = None
        if channel >= cfg.outputs:
            reason = "channel"
        elif width == 0 or (cfg.max_pulse_us is not None and width > cfg.max_pulse_us):
            reason = "range"
        elif channel in self._pulses:
            reason = "busy"
        elif self._heartbeat_lapsed(now):
            reason = "fault"
        if reason is not None:
            self._log("pulse_refused", t_dev_us=self.clock(now), cmd_id=cmd_id, reason=reason)
            if cfg.ack:
                self._send(now, f"X,{cmd_id},{reason}", "X")
            return
        t_on = now + cfg.on_latency_us
        self._pulses[channel] = _Pulse(cmd_id, channel, width, t_on, t_on + width)
        self._log("pulse_on", t_dev_us=self.clock(t_on), cmd_id=cmd_id, channel=channel)

    def _heartbeat_lapsed(self, now: int) -> bool:
        return (self.cfg.hb_ms is not None and self._last_beat is not None
                and now > self._last_beat + self.cfg.hb_ms * 1000)

    def _pulse_end(self, pulse: _Pulse) -> tuple[int, str]:
        """When an open pulse ends, and why: its width, or missing heartbeats."""
        if self.cfg.hb_ms is not None and self._last_beat is not None:
            deadline = self._last_beat + self.cfg.hb_ms * 1000
            if deadline < pulse.t_off:
                return max(deadline, pulse.t_on), "heartbeat"
        return pulse.t_off, "done"

    def _finish_pulse(self, channel: int, t_off: int, reason: str) -> None:
        pulse = self._pulses.pop(channel)
        t_off = max(t_off, pulse.t_on)
        t_on_dev, t_off_dev = self.clock(pulse.t_on), self.clock(t_off)
        self._log("pulse_off", t_dev_us=t_off_dev, cmd_id=pulse.cmd_id, channel=channel,
                  t_on_dev_us=t_on_dev, width_us=t_off - pulse.t_on,
                  commanded_width_us=pulse.width_us, reason=reason)
        if self.cfg.ack:
            self._send(t_off, f"A,{pulse.cmd_id},{t_on_dev % U32},{t_off_dev % U32}", "A")

    # --- sending -----------------------------------------------------------------------------

    def _send(self, t: int, record: str, kind: str) -> None:
        self._push(Delivery(t, frame(record) + self.cfg.eol, None, kind))

    def _push(self, delivery: Delivery) -> None:
        heapq.heappush(self._queue, (delivery.t_us, next(self._order), delivery))


def _text(text: str) -> str:
    """Free text for an E line: printable, no '*', short enough for one line."""
    clean = "".join(c if " " <= c <= "~" and c != "*" else "?" for c in text)
    return clean[:64]


__all__ = ["Delivery", "FAULT_TYPES", "Fault", "MAX_LINE", "MotionError", "SimConfig", "SimDevice",
           "config_from_entry", "config_problems"]
