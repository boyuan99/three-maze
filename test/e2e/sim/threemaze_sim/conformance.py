"""Conformance checker for device protocol v1 (docs/protocol/device-v1.md; the SIM- tests of its
section 9).

Reads what passed between a host and a device and reports every protocol rule the device's lines
break, plus what the stream shows (samples, sequence gaps, clock wraps, pulse outcomes). It is
written apart from the reference device in threemaze/devices/sim, with its own framing and
parsing code, so that it checks that device instead of repeating it. A rig builder checks a
device the same way: capture its output, run this on the capture.

Input: a raw capture ("three-maze raw capture 1": tools/capture_raw.py, and the raw log of the
rig driver "simulated"): comment lines "# {json}", of which {"wrote_to_device": {"perf_counter_ns",
"bytes"}} are the host's writes, and data lines "<perf_counter_ns> TAB <line as received>". A
plain file of device lines works too; the checks that need the host's commands (D1, D8, D10, H7)
are then skipped.

    python conformance.py <capture> [--period-tolerance-us N] [--json]

Exit code 0 if no rule is broken, 1 otherwise, 2 if the file cannot be read.
"""
import argparse
import json
import re
import sys
from dataclasses import dataclass, field

U32 = 1 << 32
HALF = 1 << 31
MAX_LINE = 254

_UINT = re.compile(r"^(0|[1-9][0-9]*)$")
_INT = re.compile(r"^(0|-?[1-9][0-9]*)$")
_DEVICE_ID = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
_KEY = re.compile(r"^[a-z0-9_]+$")
_VALUE = re.compile(r"^[A-Za-z0-9._+-]{1,32}$")
_WORD = re.compile(r"^[a-z0-9_]{1,16}$")
_VERSION = re.compile(r"^1\.(0|[1-9][0-9]*)$")


def crc8(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


@dataclass
class Entry:
    n: int              # line number in the capture file
    who: str            # "host" or "device"
    t_ns: int | None
    data: bytes         # one line, with its line ending if it had one


@dataclass
class Finding:
    rule: str
    n: int
    message: str
    details: dict = field(default_factory=dict)

    def __str__(self):
        return f"{self.rule} line {self.n}: {self.message}"


@dataclass
class Report:
    findings: list      # rules broken
    notes: list         # departures from what the hello declares that no MUST rule forbids
    stats: dict
    samples: list       # (seq, t_us, dt_us, flags, totals, t_ns) of every S line accepted
    host_commands: bool

    @property
    def ok(self):
        return not self.findings

    def rules(self):
        return sorted({f.rule for f in self.findings})


def read_capture(path):
    """Entries of a raw capture or of a plain file of device lines."""
    with open(path, "rb") as fh:
        data = fh.read()
    return parse_capture(data)


def parse_capture(data):
    entries = []
    for n, line in enumerate(_split_keep(data), 1):
        if line.startswith(b"#"):
            try:
                obj = json.loads(line[1:].decode("utf-8"))
            except (UnicodeDecodeError, ValueError):
                continue
            wrote = obj.get("wrote_to_device") if isinstance(obj, dict) else None
            if wrote:
                for part in _split_keep(wrote["bytes"].encode("latin-1")):
                    entries.append(Entry(n, "host", wrote.get("perf_counter_ns"), part))
            continue
        stamp, tab, rest = line.partition(b"\t")
        if tab and stamp.isdigit():
            entries.append(Entry(n, "device", int(stamp), rest))
        elif line.strip():
            entries.append(Entry(n, "device", None, line))
    return entries


def _split_keep(data):
    out, start = [], 0
    while start < len(data):
        end = data.find(b"\n", start)
        end = len(data) if end < 0 else end + 1
        out.append(data[start:end])
        start = end
    return out


def _signed(delta):
    delta %= U32
    return delta - U32 if delta >= HALF else delta


class Checker:
    def __init__(self, period_tolerance_us=0):
        self.tolerance = period_tolerance_us
        self.findings = []
        self.notes = []
        self.samples = []
        self.stats = {"device_lines": 0, "host_lines": 0, "samples": 0, "streams": 0, "seq_gaps": 0,
                      "samples_missing": 0, "seq_regressions": 0, "crc_errors": 0, "overflow": 0,
                      "unknown": 0, "clock_wraps": 0, "hellos": 0, "h_lines": 0, "z_lines": 0,
                      "lick_edges": 0, "frame_edges": 0, "pulses": 0, "acks": 0, "refusals": 0,
                      "e_lines": 0, "dt_us": [], "lost_at_end": None}
        self.hello = None
        self.host_seen = False
        self.h_since_hello = None
        self.stream = None          # dict while a stream may send lines
        self.stopping = False
        self.pulses = {}            # cmd_id -> number of outcomes
        self.beats = []
        self.last_host_ns = None

    def find(self, rule, entry, message, **details):
        self.findings.append(Finding(rule, entry.n if entry else 0, message, details))

    # --- host --------------------------------------------------------------------------------

    def host(self, entry):
        self.host_seen = True
        self.stats["host_lines"] += 1
        self.last_host_ns = entry.t_ns if entry.t_ns is not None else self.last_host_ns
        text = entry.data.rstrip(b"\n").rstrip(b"\r").decode("ascii", "replace")
        record = text[:-3] if len(text) > 3 and text[-3] == "*" else text
        fields = record.split(",")
        name = fields[0]
        if name == "hello":
            self._end_hello(entry)
            self.h_since_hello = 0
            self.stats["hellos"] += 1
        elif name == "start":
            self.stream = {"first": True, "prev": None, "events": [], "last_ev": {}}
            self.stopping = False
            self.stats["streams"] += 1
        elif name == "stop":
            if self.stream is not None:
                self.stopping = True
            else:
                self.stream = None
        elif name == "beat":
            if entry.t_ns is not None:
                self.beats.append((entry, entry.t_ns))
        elif name == "pulse" and len(fields) == 4:
            self.pulses[fields[1]] = 0
            self.stats["pulses"] += 1

    def _end_hello(self, entry):
        if self.h_since_hello is not None and self.h_since_hello != 1:
            self.find("D1", entry, f"{self.h_since_hello} H lines answered one hello; expected 1")

    # --- device ------------------------------------------------------------------------------

    def device(self, entry):
        self.stats["device_lines"] += 1
        line = entry.data
        if not line.endswith(b"\n"):
            self.find("F1", entry, "line does not end with LF")
        body = line.rstrip(b"\n")
        body = body[:-1] if body.endswith(b"\r") else body
        if len(body) > MAX_LINE:
            self.stats["overflow"] += 1
            self.find("F2", entry, f"{len(body)} bytes; at most {MAX_LINE}")
            return
        if any(b < 0x20 or b > 0x7E for b in body):
            self.find("F1", entry, "byte outside printable ASCII")
            return
        if len(body) < 4 or body[-3:-2] != b"*" or b"*" in body[:-3]:
            self.stats["crc_errors"] += 1
            self.find("F3", entry, "no '*' and two checksum digits at the end of the line")
            return
        record, digits = body[:-3], body[-2:].decode("ascii")
        if not re.fullmatch(r"[0-9A-Fa-f]{2}", digits) or int(digits, 16) != crc8(record):
            self.stats["crc_errors"] += 1
            self.find("F3", entry, f"checksum {digits} does not match the record"
                                   f" (CRC-8 {crc8(record):02X})")
            return
        if digits != digits.upper():
            self.find("F3", entry, "checksum digits not in upper case")
        text = record.decode("ascii")
        kind = text.split(",", 1)[0]
        if not re.fullmatch(r"[A-Z]", kind):
            self.find("F4", entry, f"type token {kind!r} is not one upper-case letter")
            return
        if kind == "E":
            self._e_line(entry, text)
            return
        fields = text.split(",")
        if any(" " in f for f in fields):
            self.find("F4", entry, "a field contains a space")
            return
        handler = getattr(self, f"_{kind.lower()}_line", None)
        if handler is None:
            self.stats["unknown"] += 1
            return
        handler(entry, fields)

    def _uint(self, entry, value, name, low=0, high=U32 - 1):
        if not _UINT.match(value) or not low <= int(value) <= high:
            self.find("F4", entry, f"{name} {value!r} is not an integer from {low} to {high}")
            return None
        return int(value)

    def _int32(self, entry, value, name):
        if not _INT.match(value) or not -HALF <= int(value) < HALF:
            self.find("F4", entry, f"{name} {value!r} is not an int32")
            return None
        return int(value)

    def _h_line(self, entry, fields):
        self.stats["h_lines"] += 1
        if self.host_seen:
            if self.h_since_hello is None:
                self.find("D1", entry, "H line without a hello")
            else:
                self.h_since_hello += 1
        if len(fields) < 6:
            self.find("F4", entry, f"H line with {len(fields)} fields; at least 6")
            return
        _, name, version, device_id, period, axes = fields[:6]
        ok = True
        if name != "threemaze-device":
            self.find("F4", entry, f"protocol name {name!r}")
            ok = False
        if not _VERSION.match(version):
            self.find("F4", entry, f"version {version!r} is not 1.<minor>")
            ok = False
        if not _DEVICE_ID.match(device_id):
            self.find("F4", entry, f"device id {device_id!r}")
            ok = False
        period = self._uint(entry, period, "period_us")
        axes = self._uint(entry, axes, "n_axes", 0, 16)
        keys = {}
        for item in fields[6:]:
            key, eq, value = item.partition("=")
            if not eq or not _KEY.match(key) or not _VALUE.match(value):
                self.find("F4", entry, f"key {item!r} is not key=value")
                ok = False
                continue
            keys[key] = value
        for key, (low, high) in {"flags": (0, 255), "lick": (0, 255), "fclk": (0, 1), "out": (0, 255),
                                 "ack": (0, 1), "hb": (1, U32 - 1)}.items():
            if key in keys and self._uint(entry, keys[key], key, low, high) is None:
                ok = False
        if ok and period is not None and axes is not None:
            self.hello = {"device_id": device_id, "period_us": period, "n_axes": axes, "keys": keys}

    def _s_line(self, entry, fields):
        axes = self.hello["n_axes"] if self.hello else len(fields) - 5
        if len(fields) != 5 + axes:
            self.find("F4", entry, f"S line with {len(fields) - 5} totals; the hello declared {axes}")
            return
        seq = self._uint(entry, fields[1], "seq")
        t_us = self._uint(entry, fields[2], "t_us")
        dt = self._uint(entry, fields[3], "dt_us", 1)
        flags = self._uint(entry, fields[4], "flags", 0, 255)
        totals = [self._int32(entry, v, f"total {i + 1}") for i, v in enumerate(fields[5:])]
        if None in (seq, t_us, dt, flags) or None in totals:
            return
        if flags & 0xFC:
            self.find("D7", entry, f"reserved flag bits set ({flags})")
        if self.stream is None:
            if self.host_seen:
                self.find("D8", entry, "S line outside a stream (no start, or after the stop report)")
                return
            self.stream = {"first": True, "prev": None, "events": [], "last_ev": {}}
            self.stats["streams"] += 1
        st = self.stream
        prev = st["prev"]
        consecutive = False
        if prev is None:
            if st["first"] and seq != 0 and self.host_seen:
                self.stats["seq_gaps"] += 1
                self.stats["samples_missing"] += seq
                self.find("D3", entry, f"first sample of the stream has seq {seq}, not 0",
                          seq=seq, missing=list(range(seq)))
        else:
            d = (seq - prev["seq"]) % U32
            if d == 0 or d >= HALF:
                self.stats["seq_regressions"] += 1
                self.find("D3", entry, f"seq {seq} after {prev['seq']}: duplicate or older", seq=seq)
                return
            if d > 1:
                self.stats["seq_gaps"] += 1
                self.stats["samples_missing"] += d - 1
                missing = [(prev["seq"] + i) % U32 for i in range(1, d)]
                self.find("D3", entry, f"seq {seq} after {prev['seq']}: {d - 1} missing",
                          seq=seq, missing=missing)
            delta = (t_us - prev["t_us"]) % U32
            if delta == 0 or delta >= HALF:
                self.find("D4", entry, f"t_us {t_us} after {prev['t_us']}: the clock went back")
                return
            if t_us < prev["t_us"]:
                self.stats["clock_wraps"] += 1
            consecutive = d == 1
            if consecutive and dt != delta:
                self.find("D5", entry, f"dt_us {dt} but the window since the previous sample is {delta}")
        period = self.hello["period_us"] if self.hello else None
        if period and abs(dt - period) > self.tolerance and (consecutive or prev is None):
            self.find("D2", entry, f"window of {dt} us; the declared period is {period} us")
        for ev_entry, kind, t_ev in st["events"]:
            if _signed(t_ev - t_us) > 0:
                self.find("D9", ev_entry, f"{kind} at {t_ev} sent before the S line of an earlier"
                                          f" window (t_us {t_us})")
            elif prev is not None and _signed(t_ev - prev["t_us"]) <= 0:
                self.find("D9", ev_entry, f"{kind} at {t_ev} belongs to a window already sent")
        st["events"] = []
        st["first"] = False
        st["prev"] = {"seq": seq, "t_us": t_us}
        self.stats["samples"] += 1
        self.stats["dt_us"].append(dt)
        self.samples.append((seq, t_us, dt, flags, totals, entry.t_ns))

    def _event(self, entry, kind, t_ev):
        if self.stream is None:
            if self.host_seen:
                self.find("D8", entry, f"{kind} line outside a stream")
                return
            self.stream = {"first": True, "prev": None, "events": [], "last_ev": {}}
        last = self.stream["last_ev"].get(kind)
        if last is not None and _signed(t_ev - last) < 0:
            self.find("D9", entry, f"{kind} at {t_ev} before the previous {kind} at {last}")
        self.stream["last_ev"][kind] = t_ev
        self.stream["events"].append((entry, kind, t_ev))

    def _l_line(self, entry, fields):
        if len(fields) != 4:
            self.find("F4", entry, f"L line with {len(fields)} fields; expected 4")
            return
        channel = self._uint(entry, fields[1], "channel", 0, 255)
        t_ev = self._uint(entry, fields[2], "t_us")
        level = self._uint(entry, fields[3], "level", 0, 1)
        if None in (channel, t_ev, level):
            return
        lick = int(self.hello["keys"].get("lick", "0")) if self.hello else None
        if lick is not None and channel >= lick:
            # Section 4.4 says the channel is below the hello's lick value, but the protocol's own
            # golden lines (sections 2 and 11.1) send L lines after a hello without lick
            self.notes.append(Finding("4.4", entry.n,
                                      f"lick channel {channel}; the hello declared lick={lick}"))
        self.stats["lick_edges"] += 1
        self._event(entry, "L", t_ev)

    def _f_line(self, entry, fields):
        if len(fields) != 3:
            self.find("F4", entry, f"F line with {len(fields)} fields; expected 3")
            return
        count, t_ev = self._uint(entry, fields[1], "count", 1), self._uint(entry, fields[2], "t_us")
        if None in (count, t_ev):
            return
        self.stats["frame_edges"] += 1
        self._event(entry, "F", t_ev)

    def _z_line(self, entry, fields):
        self.stats["z_lines"] += 1
        if len(fields) != 3:
            self.find("F4", entry, f"Z line with {len(fields)} fields; expected 3")
            return
        n, t_z = self._uint(entry, fields[1], "n_samples"), self._uint(entry, fields[2], "t_us")
        if None in (n, t_z):
            return
        st = self.stream
        if self.host_seen and not self.stopping:
            self.find("F4", entry, "Z line without a stop")
        if st is not None and st["prev"] is not None:
            last = st["prev"]
            lost = (n - 1 - last["seq"]) % U32
            if lost >= HALF:
                self.find("F4", entry, f"stop report says {n} samples, but seq {last['seq']} arrived")
            else:
                self.stats["lost_at_end"] = lost
            if _signed(t_z - last["t_us"]) < 0:
                self.find("D4", entry, f"stop report time {t_z} before the last sample's {last['t_us']}")
        elif st is not None:
            self.stats["lost_at_end"] = n
        self.stream = None
        self.stopping = False

    def _a_line(self, entry, fields):
        if len(fields) != 4:
            self.find("F4", entry, f"A line with {len(fields)} fields; expected 4")
            return
        t_on, t_off = self._uint(entry, fields[2], "t_on_us"), self._uint(entry, fields[3], "t_off_us")
        if None in (t_on, t_off) or self._uint(entry, fields[1], "cmd_id") is None:
            return
        if _signed(t_off - t_on) < 0:
            self.find("F4", entry, f"pulse off at {t_off} before on at {t_on}")
        self.stats["acks"] += 1
        self._outcome(entry, fields[1])

    def _x_line(self, entry, fields):
        if len(fields) != 3 or not _WORD.match(fields[2]):
            self.find("F4", entry, "X line is not X,<cmd_id>,<reason>")
            return
        if self._uint(entry, fields[1], "cmd_id") is None:
            return
        self.stats["refusals"] += 1
        self._outcome(entry, fields[1])

    def _outcome(self, entry, cmd_id):
        if not self.host_seen:
            return
        if cmd_id not in self.pulses:
            self.find("D10", entry, f"outcome for cmd_id {cmd_id}, which no pulse command had")
            return
        self.pulses[cmd_id] += 1
        if self.pulses[cmd_id] > 1:
            self.find("D10", entry, f"second outcome for cmd_id {cmd_id}")

    def _e_line(self, entry, text):
        self.stats["e_lines"] += 1
        parts = text.split(",", 2)
        if len(parts) != 3 or not _WORD.match(parts[1]):
            self.find("F4", entry, "E line is not E,<code>,<text>")

    # --- end ---------------------------------------------------------------------------------

    def finish(self):
        if not self.host_seen:
            return
        self._end_hello(None)
        acks = self.hello is not None and self.hello["keys"].get("ack") == "1"
        if acks:
            for cmd_id, count in self.pulses.items():
                if count == 0:
                    self.find("D10", None, f"pulse {cmd_id} has no A or X line")
        if self.hello is not None and "hb" in self.hello["keys"]:
            for (entry, t), (_, t_next) in zip(self.beats, self.beats[1:]):
                if t_next - t > 100_000_000:
                    self.find("H7", entry, f"{(t_next - t) / 1e6:.1f} ms to the next beat; at most 100")


def check(entries, period_tolerance_us=0):
    checker = Checker(period_tolerance_us)
    for entry in entries:
        (checker.host if entry.who == "host" else checker.device)(entry)
    checker.finish()
    stats = dict(checker.stats)
    dts = stats.pop("dt_us")
    stats["dt_us_min"], stats["dt_us_max"] = (min(dts), max(dts)) if dts else (None, None)
    stats["hello"] = checker.hello
    return Report(checker.findings, checker.notes, stats, checker.samples, checker.host_seen)


def check_file(path, period_tolerance_us=0):
    return check(read_capture(path), period_tolerance_us)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check a captured device stream against device protocol v1.")
    ap.add_argument("capture")
    ap.add_argument("--period-tolerance-us", type=int, default=0,
                    help="how far a window may differ from the declared period (default 0)")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    args = ap.parse_args(argv)
    try:
        report = check_file(args.capture, args.period_tolerance_us)
    except OSError as exc:
        print(f"cannot read {args.capture}: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"ok": report.ok, "stats": report.stats,
                          "findings": [f.__dict__ for f in report.findings],
                          "notes": [f.__dict__ for f in report.notes]}, indent=1))
    else:
        for finding in report.findings:
            print(finding)
        for note in report.notes:
            print(f"note: {note}")
        print(json.dumps(report.stats))
        print("conforms" if report.ok else f"{len(report.findings)} findings: {', '.join(report.rules())}")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
