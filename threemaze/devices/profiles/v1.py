"""Profile v1: the host's side of device protocol v1 (docs/protocol/device-v1.md).

Reading (parse, on the reader thread), with the rule ids of the protocol:
- F1-F4: a line is a record of printable ASCII without '*', then '*' and two hexadecimal digits of
  CRC-8/SMBUS over the record (either case); fields are separated by single commas, hold no space
  (but for the text of an E line), and integers are decimal, leading zeros accepted;
- H2: a line that breaks F1-F4 or the field rules of its type is never used and is counted by
  cause: crc_errors (a wrong or missing checksum), parse_errors (anything else), unknown (a well
  formed line of an unknown type); overflow (F2) is counted by the reader, which cuts the line off;
- H3: each sample once, in seq order; a gap of d - 1 samples is counted (seq_gaps, samples_lost)
  and recorded in the sample's gap; a duplicate or older sample is discarded (seq_regressions);
- H4: S, L and F lines count only between the start the host sent (begin_stream) and the stop
  report (others are left out and counted in stats["outside_stream"]); the first sample of a
  stream with seq n > 0 counts n samples lost;
- section 4.3: the stop report ends the stream and counts the samples lost after the last
  accepted one (samples_lost); events still waiting for a sample then belong to none (seq None);
- H6: t_us is unwrapped into a 64-bit device time; a clock that went backward (or did not
  advance) faults the stream; for consecutive samples a dt_us that differs from the clock's step is
  flagged and counted (dt_mismatch); the times of L, F, Z and A lines are unwrapped to the value
  nearest their reference sample;
- D6: raw is the difference of the running totals from the previous accepted sample, in int32
  arithmetic, and d = C · raw with the rig file's calibration C (section 7.2);
- D9: an L or F line is assigned to the next S line received; one that arrives after the S line of
  its window is counted (late_events) and assigned to the next sample all the same;
- section 4.4: L lines only on the lick channels the hello declares, F lines only with fclk=1.

The session sequence (section 6) is open(), start() and stop(); the host's heartbeat (rule H7)
starts when the session is armed, if the hello declares hb.
"""
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from ...api.devices import DeviceError
from ...core.records import (DT_ESTIMATED, DT_MISMATCH, DeviceEvent, DeviceMessage, DeviceSample,
                             Hello, PulseOutcome, Record, StopReport, StreamFault)
from ..guarantees import levels, protocol_record, v1_flags
from . import Host, Profile

U32 = 1 << 32
HALF = 1 << 31
MAX_SAFE_INTEGER = (1 << 53) - 1  # the link protocol's largest integer (SPEC.md, rule E2)
PROTOCOL = "threemaze-device"
MAX_LINE = 254           # bytes of a line, not counting CR and LF (rule F2)
MAX_AXES = 16
MIN_HEARTBEAT_MS = 300   # rule H5: three of the host's 100 ms heartbeat periods (rule H7)
BEAT_PERIOD_S = 0.05     # rule H7 asks for at least every 100 ms; half that leaves room for delays


def _crc_table() -> tuple[int, ...]:
    table = []
    for value in range(256):
        crc = value
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
        table.append(crc)
    return tuple(table)


_CRC = _crc_table()


def crc8(data: bytes) -> int:
    """CRC-8/SMBUS (polynomial 0x07, initial value 0, no reflection, no final XOR; rule F3)."""
    crc = 0
    for byte in data:
        crc = _CRC[crc ^ byte]
    return crc


def command(record: str) -> bytes:
    """A host command as it goes on the wire: the record, '*', its checksum, LF (section 5)."""
    data = record.encode("ascii")
    return data + b"*%02X\n" % crc8(data)


def _int32(value: int) -> int:
    """value modulo 2^32 as a signed 32-bit integer."""
    return (value + HALF) % U32 - HALF


def _signed(delta: int) -> int:
    """delta modulo 2^32, read as a signed value from -2^31 to 2^31 - 1 (rule H6)."""
    delta %= U32
    return delta - U32 if delta >= HALF else delta


_RECORD = re.compile(rb"[\x20-\x29\x2b-\x7e]*")     # printable ASCII without '*' (F1)
_DIGITS = re.compile(rb"[0-9A-Fa-f]{2}")
_UINT = re.compile(r"[0-9]+")                      # F4: leading zeros are accepted
_INT = re.compile(r"-?[0-9]+")
_VERSION = re.compile(r"[0-9]+\.[0-9]+")
_DEVICE_ID = re.compile(r"[A-Za-z0-9._-]{1,32}")
_KEY = re.compile(r"[a-z0-9_]+")
_VALUE = re.compile(r"[A-Za-z0-9._+-]{1,32}")
_WORD = re.compile(r"[a-z0-9_]{1,16}")
# Hello keys of version 1.0 that hold integers, with their ranges (section 4.1)
_INT_KEYS = {"flags": (0, 255), "lick": (0, 255), "fclk": (0, 1), "out": (0, 255), "ack": (0, 1),
             "hb": (1, U32 - 1)}


class _Reject(Exception):
    """The line breaks F4 or the field rules of its type: a parse error."""


def _uint(text: str, low: int = 0, high: int = U32 - 1) -> int:
    if not _UINT.fullmatch(text):
        raise _Reject
    value = int(text)
    if not low <= value <= high:
        raise _Reject
    return value


def _total(text: str) -> int:
    if not _INT.fullmatch(text):
        raise _Reject
    value = int(text)
    if not -HALF <= value < HALF:
        raise _Reject
    return value


@dataclass(frozen=True)
class V1Settings:
    """What the rig file says about a v1 device, and the host's waits of the session sequence
    (section 6: proposed defaults, which the serial_lines driver takes from the rig file).

    device_id, period_us, n_axes: checked against the hello when given (rule H5); n_axes is what
    the driver itself knows (the simulated device has 3), the calibration's columns are checked too.
    matrix: the calibration C of a motion device, 3 rows of n_axes columns; None for a device that
    only drives outputs. outputs: the output channels the rig file uses.
    """

    device_id: str | None = None
    period_us: int = 0
    matrix: Sequence[Sequence[float]] | None = None
    n_axes: int | None = None
    outputs: int = 0
    open_delay_ms: int = 0
    hello_interval_ms: int = 500
    hello_timeout_ms: int = 5000
    stop_timeout_ms: int = 500


class _Stream:
    """State of the stream the host started (rule H4) until its stop report."""

    __slots__ = ("last_seq", "last_t_us", "last_t_dev", "last_totals", "pending", "faulted",
                 "report")

    def __init__(self) -> None:
        self.last_seq: int | None = None
        self.last_t_us = 0
        self.last_t_dev = 0
        self.last_totals: tuple[int, ...] = ()
        self.pending: list[tuple[str, int, int, bool, dict[str, int]]] = []
        self.faulted = False
        self.report: StopReport | None = None


class V1Profile(Profile):
    name = "v1"
    seq_source = "device"

    def __init__(self, settings: V1Settings):
        super().__init__()
        self.settings = settings
        self.matrix: tuple[tuple[float, ...], ...] | None = None
        if settings.matrix:
            self.matrix = tuple(tuple(float(c) for c in row) for row in settings.matrix)
        self.n_axes: int | None = len(self.matrix[0]) if self.matrix else settings.n_axes
        self.hello: Hello | None = None     # the hello that passed rule H5
        self.received_hello: Hello | None = None  # the hello open() received, matching or not
        self.stop_report = False            # guarantees.stop_report: the last stream ended with Z
        self._stream: _Stream | None = None
        self._last_report: StopReport | None = None
        self._ref: tuple[int, int] | None = None  # (t_us, t_dev_us) of the last accepted sample
        self.stats.update(dict.fromkeys(("outside_stream", "lick_edges", "frame_edges", "hellos",
                                         "stop_reports", "outcomes", "messages", "faults"), 0))
        self._handlers: dict[str, Callable[[list[str], int, str], list[Record]]] = {
            "S": self._s, "L": self._l, "F": self._f, "Z": self._z, "H": self._h, "A": self._a,
            "X": self._x}

    # --- reading ------------------------------------------------------------------------------

    def parse(self, line: bytes, t_host_ns: int) -> list[Record]:
        counters = self.counters
        counters["lines"] += 1
        n = len(line)
        if n < 3 or line[n - 3] != 0x2A or not _DIGITS.fullmatch(line, n - 2):
            counters["crc_errors"] += 1          # F3: no checksum
            return []
        record = line[:n - 3]
        if crc8(record) != int(line[n - 2:], 16):
            counters["crc_errors"] += 1          # F3: corrupted
            return []
        if not _RECORD.fullmatch(record):
            counters["parse_errors"] += 1        # F1: a byte outside printable ASCII, or a '*'
            return []
        text = record.decode("ascii")
        kind = text[:1]
        if not "A" <= kind <= "Z" or text[1:2] not in ("", ","):
            counters["parse_errors"] += 1        # F4: the type token is one upper-case letter
            return []
        try:
            if kind == "E":
                return self._e(text.split(",", 2), t_host_ns, text)
            if " " in text:
                raise _Reject                    # F4: no field holds a space
            handler = self._handlers.get(kind)
            if handler is None:
                counters["unknown"] += 1         # a later minor version's line type
                return []
            return handler(text.split(","), t_host_ns, text)
        except _Reject:
            counters["parse_errors"] += 1
            return []

    def begin_stream(self) -> None:
        self._stream = _Stream()
        self.stop_report = False
        # Each stream's device time starts at its first sample's t_us (H6), so a Z, A, L or F line
        # is unwrapped against a sample of its own stream, or recorded as sent before one arrives
        self._ref = None

    def end_stream(self, t_host_ns: int) -> list[Record]:
        stream, self._stream = self._stream, None
        return self._flush(stream) if stream is not None else []

    def _s(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        axes = self.n_axes if self.n_axes is not None else len(fields) - 5
        if len(fields) != 5 + axes or not 0 <= axes <= MAX_AXES:
            raise _Reject
        seq = _uint(fields[1])
        t_us = _uint(fields[2])
        dt_us = _uint(fields[3], 1)
        flags = _uint(fields[4], 0, 255)
        totals = tuple(_total(v) for v in fields[5:])
        stream = self._stream
        if stream is None or stream.faulted:
            self.stats["outside_stream"] += 1    # H4, D8: not part of a stream the host started
            return []
        counters = self.counters
        mismatch = estimated = False
        if stream.last_seq is None:              # the first sample of the stream (H4)
            gap = seq
            t_dev = t_us
            if seq == 0:
                dt = dt_us
            else:
                dt, estimated = min((seq + 1) * self.settings.period_us, MAX_SAFE_INTEGER), True
            raw = tuple(_int32(v) for v in totals)
        else:
            step = (seq - stream.last_seq) % U32
            if step == 0 or step >= HALF:
                counters["seq_regressions"] += 1  # H3: a duplicate or an older sample
                return []
            delta = (t_us - stream.last_t_us) % U32
            if delta == 0 or delta >= HALF:      # H6: the device clock went backward
                stream.faulted = True
                self.stats["faults"] += 1
                return [StreamFault(f"sample {seq}: the device clock went from {stream.last_t_us}"
                                    f" to {t_us} us (rule H6); the stream is faulted", t_host_ns)]
            gap = step - 1
            t_dev = stream.last_t_dev + delta
            dt = delta
            if step == 1 and dt_us != delta:
                mismatch = True
                counters["dt_mismatch"] += 1
            raw = tuple(_int32(a - b) for a, b in zip(totals, stream.last_totals))
        if gap:
            counters["seq_gaps"] += 1
            counters["samples_lost"] += gap
        counters["samples"] += 1
        flags |= (DT_ESTIMATED if estimated else 0) | (DT_MISMATCH if mismatch else 0)
        sample = DeviceSample(seq, t_dev, dt, raw, self._calibrate(raw), flags, gap, t_host_ns)
        out = self._assign(stream, seq, t_us, t_dev) if stream.pending else []
        out.append(sample)
        stream.last_seq, stream.last_t_us, stream.last_t_dev = seq, t_us, t_dev
        stream.last_totals = totals
        self._ref = (t_us, t_dev)
        return out

    def _calibrate(self, raw: tuple[int, ...]) -> tuple[float, float, float]:
        """d_i = sum over j ascending of C_ij * raw_j, in double precision, from 0.0 (section 7.2:
        the same bits in every run)."""
        out = []
        for row in self.matrix:
            acc = 0.0
            for c, count in zip(row, raw):
                acc += c * count
            out.append(acc)
        return out[0], out[1], out[2]

    def _event(self, t_host_ns: int, kind: str, t_us: int, fields: dict[str, int]) -> list[Record]:
        stream = self._stream
        if stream is None or stream.faulted:
            self.stats["outside_stream"] += 1
            return []
        late = stream.last_seq is not None and _signed(t_us - stream.last_t_us) <= 0
        if late:
            self.counters["late_events"] += 1   # D9: its window's S line came first
        stream.pending.append((kind, t_us, t_host_ns, late, fields))
        return []

    def _assign(self, stream: _Stream, seq: int, t_us: int, t_dev: int) -> list[Record]:
        """The events waiting for this sample (D9), on its unwrapped clock (H6)."""
        out: list[Record] = [DeviceEvent(kind, t_dev + _signed(t_ev - t_us), seq, t_host, late=late,
                                         **fields)
                             for kind, t_ev, t_host, late, fields in stream.pending]
        stream.pending = []
        for event in out:
            self.stats["lick_edges" if event.kind == "lick" else "frame_edges"] += 1
        return out

    def _flush(self, stream: _Stream) -> list[Record]:
        """Events left when a stream ends: no sample follows them (seq None)."""
        out: list[Record] = [DeviceEvent(kind, self._device_time(t_ev), None, t_host, late=late,
                                         **fields)
                             for kind, t_ev, t_host, late, fields in stream.pending]
        stream.pending = []
        for event in out:
            self.stats["lick_edges" if event.kind == "lick" else "frame_edges"] += 1
        return out

    def _device_time(self, t_us: int) -> int:
        """A device time unwrapped to the 64-bit value nearest the last accepted sample, or as sent
        when no sample was accepted yet (rule H6)."""
        if self._ref is None:
            return t_us
        ref_t_us, ref_t_dev = self._ref
        return ref_t_dev + _signed(t_us - ref_t_us)

    def _declared(self, key: str) -> int:
        return int(self.hello.keys.get(key, "0")) if self.hello is not None else 0

    def _l(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 4:
            raise _Reject
        channel, t_us, level = _uint(fields[1], 0, 255), _uint(fields[2]), _uint(fields[3], 0, 1)
        if channel >= self._declared("lick"):
            raise _Reject                        # section 4.4: a channel the hello does not declare
        return self._event(t_host_ns, "lick", t_us, {"channel": channel, "level": level})

    def _f(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 3:
            raise _Reject
        count, t_us = _uint(fields[1], 1), _uint(fields[2])
        if self._declared("fclk") != 1:
            raise _Reject                        # section 4.4: no frame clock declared
        return self._event(t_host_ns, "frame", t_us, {"count": count})

    def _z(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 3:
            raise _Reject
        n_samples, t_us = _uint(fields[1]), _uint(fields[2])
        stream = self._stream
        if stream is None:
            self.stats["outside_stream"] += 1    # e.g. the answer to the stop sent at open
            return []
        if stream.last_seq is None:
            lost = n_samples
        else:
            lost = (n_samples - 1 - stream.last_seq) % U32
            if lost >= HALF:
                raise _Reject                    # fewer samples than the stream delivered
        self.counters["samples_lost"] += lost
        out = self._flush(stream)
        report = StopReport(n_samples, self._device_time(t_us), lost, t_host_ns, text)
        out.append(report)
        self._stream = None
        self._last_report = report
        self.stop_report = True
        self.stats["stop_reports"] += 1
        return out

    def _h(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) < 6:
            raise _Reject
        _, name, version, device_id, period, axes = fields[:6]
        if not name or not _VERSION.fullmatch(version) or not _DEVICE_ID.fullmatch(device_id):
            raise _Reject
        period_us, n_axes = _uint(period), _uint(axes, 0, MAX_AXES)
        keys: dict[str, str] = {}
        for item in fields[6:]:
            key, eq, value = item.partition("=")
            if not eq or not _KEY.fullmatch(key) or not _VALUE.fullmatch(value):
                raise _Reject
            keys[key] = value
        for key, (low, high) in _INT_KEYS.items():
            if key in keys:
                _uint(keys[key], low, high)
        self.stats["hellos"] += 1
        return [Hello(name, version, device_id, period_us, n_axes, keys, t_host_ns, text)]

    def _a(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 4:
            raise _Reject
        cmd_id, t_on, t_off = _uint(fields[1]), _uint(fields[2]), _uint(fields[3])
        if _signed(t_off - t_on) < 0:
            raise _Reject                        # off before on
        self.stats["outcomes"] += 1
        return [PulseOutcome(cmd_id, True, t_host_ns, t_on_dev_us=self._device_time(t_on),
                             t_off_dev_us=self._device_time(t_off))]

    def _x(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 3 or not _WORD.fullmatch(fields[2]):
            raise _Reject
        cmd_id = _uint(fields[1])
        self.stats["outcomes"] += 1
        return [PulseOutcome(cmd_id, False, t_host_ns, reason=fields[2])]

    def _e(self, fields: list[str], t_host_ns: int, text: str) -> list[Record]:
        if len(fields) != 3 or not _WORD.fullmatch(fields[1]):
            raise _Reject
        self.stats["messages"] += 1
        return [DeviceMessage(fields[1], fields[2], t_host_ns)]

    # --- the session sequence (section 6) -----------------------------------------------------

    def open(self, host: Host) -> None:
        s = self.settings
        if s.open_delay_ms:
            time.sleep(s.open_delay_ms / 1000)  # step 1: boards that reset when the port opens
        host.write(command("stop"))             # step 2
        host.discard()
        hello = host.request(command("hello"), lambda r: isinstance(r, Hello),
                             timeout_s=s.hello_timeout_ms / 1000,
                             retry_s=s.hello_interval_ms / 1000)
        if hello is None:                       # step 3
            # What the port did deliver tells a silent device from a wrong port or a garbled
            # stream (wrong baud rate, debug prints, a malformed H line)
            c = self.counters
            rejected = ", ".join(f"{key} {c[key]}" for key in ("crc_errors", "parse_errors",
                                                                "overflow", "unknown") if c[key])
            raise DeviceError(f"device {host.name!r} did not answer hello within"
                              f" {s.hello_timeout_ms / 1000:g} s ({c['lines']} lines read"
                              f"{'; rejected: ' + rejected if rejected else ''})")
        self.received_hello = hello
        problems = self.check_hello(hello)
        if problems:
            raise DeviceError(f"device {host.name!r} does not match the rig file:"
                              f" {'; '.join(problems)}")
        self.hello = hello
        if self.n_axes is None:
            self.n_axes = hello.n_axes
        if "hb" in hello.keys:
            host.heartbeat(command("beat"), BEAT_PERIOD_S)  # step 4, rule H7

    def check_hello(self, hello: Hello) -> list[str]:
        """Rule H5: the hello against the rig file; [] if it matches."""
        s = self.settings
        problems = []
        expected = {"protocol": PROTOCOL, "device_id": s.device_id, "period_us": s.period_us,
                    "n_axes": s.n_axes}
        for key, value in expected.items():
            if value is not None and getattr(hello, key) != value:
                problems.append(f"{key} {getattr(hello, key)!r} (rig file: {value!r})")
        if hello.version.split(".")[0] != "1":
            problems.append(f"version {hello.version!r} (rig file: 1.x)")
        if self.matrix and len(self.matrix[0]) != hello.n_axes:
            problems.append(f"n_axes {hello.n_axes} (calibration: {len(self.matrix[0])} columns)")
        hb = hello.keys.get("hb")
        if hb is not None and int(hb) < MIN_HEARTBEAT_MS:
            problems.append(f"hb {hb!r}: a heartbeat timeout below {MIN_HEARTBEAT_MS} ms (rule H5)")
        out = int(hello.keys.get("out", "0"))
        if out < s.outputs:
            problems.append(f"out {out}: the rig file uses {s.outputs} output channels")
        return problems

    def start(self, host: Host) -> None:
        if self.matrix is None:
            raise DeviceError(f"device {host.name!r} has no calibration: it cannot stream samples")
        self._last_report = None
        host.restart(command("start"))           # step 5, rule H4

    def stop(self, host: Host) -> StopReport | None:
        report = host.request(command("stop"), lambda r: isinstance(r, StopReport),
                              timeout_s=self.settings.stop_timeout_ms / 1000)  # step 7
        if report is None:
            host.end_stream()
            report = self._last_report  # a stop report that came just after the wait ended
        return report

    def stop_outputs(self, host: Host) -> None:
        host.write(command("stop"))              # a device closes every output on stop

    def pulse(self, host: Host, cmd_id: int, channel: int, width_us: int) -> None:
        host.write(command(f"pulse,{cmd_id},{channel},{width_us}"))

    # --- what the session records -------------------------------------------------------------

    def flags(self) -> dict[str, bool]:
        """The guarantee flags in force (section 8.1): hello once a hello passed rule H5,
        stop_report once the last stream ended with its stop report; the others hold by rule."""
        return v1_flags(hello=self.hello is not None, stop_report=self.stop_report)

    def record(self) -> dict[str, Any]:
        out = {**protocol_record(self.name, self.flags()),
               "hello": self.hello.as_dict() if self.hello else None,
               "counters": dict(self.counters)}
        if self.settings.outputs:
            # Section 8.4: the device reports the times it measured (A lines) only if its hello
            # declares ack=1; without such a hello nothing better is claimed (rule H9)
            out["output_timing"] = "hardware" if self._declared("ack") == 1 else "unreported"
        return out

    def link_device(self) -> dict[str, Any]:
        out: dict[str, Any] = {"profile": self.name, **levels(self.flags()),
                               "period_us": self.settings.period_us}
        if self.n_axes:
            out["n_axes"] = self.n_axes
        device_id = self.hello.device_id if self.hello else self.settings.device_id
        if device_id:
            out["device_id"] = device_id
        return out
