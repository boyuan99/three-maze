"""Driver "simulated": the reference simulated device of device protocol v1 (threemaze/devices/sim)
in the runtime's own process, so that a session runs on any PC without hardware (`--rig sim`,
rigs/sim.json), the rig PC included.

With `periodUs` the device streams samples and can serve the motion role; with `outputs` it
drives output channels and can serve the reward role. Its motion comes from `trajectory`
(segments, a per-sample file or the replay of a recorded stream) and `faults` injects transport
faults; docs/rig-file-v1.md lists the fields.

The device sits behind SimPort, an in-process serial port. Until the serial reader of plan item
DPR-03 reads every device, this driver plays the host's part of device-v1.md section 6 itself, and
only that part: open() sends stop and hello and checks the H line against the rig file (device
id, period, axes, the calibration's columns) and refuses a heartbeat timeout below 300 ms (rule
H5), start() sends start, stop() sends stop and waits for the stop report, safe_state() sends stop
to a device with outputs (and waits for the stop report if that device also streams), pulse()
sends one pulse. It does not parse samples and sends no heartbeat (rule H7: plan items DPR-03 and
DPR-09). A reader thread writes every line the device sends, and every command, to
<session>/raw/<device>.tsv in the format of the raw capture tool ("three-maze raw capture 1"),
each line stamped with the session clock at the read that completed it. The device logs every
command, fault and pulse to <session>/sim/<device>.jsonl.
"""
import hashlib
import json
import threading
import time
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..api import DeviceContext, DeviceError, InputDevice, OutputDevice, register
from .sim.frame import frame, unframe
from .sim.model import SimDevice, config_from_entry, config_problems
from .sim.motion import AXES, MotionError
from .sim.port import SimPort

# device-v1.md section 6, steps 3 and 7: proposed defaults of the host's waits
HELLO_TIMEOUT_S = 5.0
STOP_REPORT_TIMEOUT_S = 0.5
READ_TIMEOUT_S = 0.05
RAW_FORMAT = "three-maze raw capture 1"
MIN_HEARTBEAT_MS = 300  # rule H5: three of the host's 100 ms heartbeat periods (rule H7)


def _resolve(rig_dir: Path, path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else rig_dir / p


def _json_value(value: Any) -> Any:
    if isinstance(value, Mapping):  # the rig file's read-only mappings
        return dict(value)
    raise TypeError(f"{type(value).__name__} is not JSON serialisable")


class SimLog:
    """Append-only JSON lines; every record is flushed, so a crash keeps what was logged."""

    def __init__(self, path, clock):
        self.path = path
        self._clock = clock
        self._lock = threading.Lock()
        self._fh = None

    def write(self, event: str, **fields: Any) -> None:
        record = {"t_ns": self._clock.now_ns(), "event": event}
        record.update(fields)
        line = json.dumps(record, separators=(",", ":"), default=_json_value) + "\n"
        with self._lock:
            if self._fh is None:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._fh = open(self.path, "a", encoding="utf-8", newline="\n")
            self._fh.write(line)
            self._fh.flush()

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                self._fh.close()
                self._fh = None


class RawCapture:
    """The raw-line log: '# {json}' comments (settings, clock anchors, every write to the device,
    totals), then '<t_ns> TAB <line as received>' per line."""

    def __init__(self, path, info: dict[str, Any]):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._fh = open(path, "xb")
        self._lock = threading.Lock()
        self._flushed = time.monotonic()
        self.lines = 0
        self._comment({"format": RAW_FORMAT, "tool": "threemaze/devices/simulated.py", **info,
                       "columns": "host perf_counter_ns<TAB>raw line bytes as received (line ending"
                                  " included)"})
        self._comment({"opened": _anchor()})

    def _comment(self, obj: dict[str, Any]) -> None:
        self._fh.write(b"# " + json.dumps(obj, ensure_ascii=True, default=_json_value).encode("ascii")
                       + b"\n")

    def wrote(self, t_ns: int, data: bytes) -> None:
        with self._lock:
            self._comment({"wrote_to_device": {"perf_counter_ns": t_ns, "bytes": data.decode("ascii")}})
            self._fh.flush()

    def line(self, t_ns: int, data: bytes) -> None:
        with self._lock:
            self._fh.write(b"%d\t" % t_ns + data)
            self.lines += 1
            if time.monotonic() - self._flushed >= 1.0:
                self._fh.flush()
                self._flushed = time.monotonic()

    def close(self, t_ns: int, partial: bytes) -> None:
        with self._lock:
            if self._fh.closed:
                return
            if partial:
                self._fh.write(b"%d\t" % t_ns + partial + b"\n")
            self._comment({"closed": _anchor(), "lines": self.lines,
                           "incomplete_last_line_bytes": len(partial)})
            self._fh.close()


def _anchor() -> dict[str, Any]:
    return {"wall_utc": datetime.now(timezone.utc).isoformat(timespec="microseconds"),
            "perf_counter_ns": time.perf_counter_ns()}


@register("simulated")
class SimulatedDevice(InputDevice, OutputDevice):
    driver_version = "1"

    @classmethod
    def roles(cls, config: Mapping[str, Any]) -> frozenset[str]:
        roles = set()
        if "periodUs" in config:
            roles.add("motion")
        if config.get("outputs", 0) >= 1:
            roles.add("reward")
        return frozenset(roles)

    @classmethod
    def axis_count(cls, config: Mapping[str, Any]) -> int | None:
        return AXES if "periodUs" in config else 0

    @classmethod
    def check_config(cls, config: Mapping[str, Any], rig_dir: Path) -> list[tuple[str, str]]:
        problems = config_problems(config)
        if not cls.roles(config):
            problems.append(("", "a simulated device needs periodUs (to stream samples) or"
                                 " outputs >= 1 (to drive outputs)"))
        trajectory = config.get("trajectory")
        if not problems and trajectory:
            # A trajectory file that cannot be read or used refuses the rig file, before arming
            try:
                config_from_entry(config, lambda path: _resolve(rig_dir, path))
            except MotionError as exc:
                problems.append(("/trajectory/file" if "file" in trajectory else "/trajectory",
                                 str(exc)))
        return problems

    def __init__(self, name: str, config: Mapping[str, Any], ctx: DeviceContext):
        super().__init__(name, config, ctx)
        self.log = SimLog(ctx.session_dir / "sim" / f"{name}.jsonl", ctx.clock)
        self.raw_path = ctx.session_dir / "raw" / f"{name}.tsv"
        self.port: SimPort | None = None
        self.raw: RawCapture | None = None
        self.hello: dict[str, Any] | None = None
        self.files: dict[str, dict[str, str]] = {}
        self.streaming = False
        self.stop_report: str | None = None
        self._cmd_id = 0
        self._cv = threading.Condition()
        self._want: str | None = None
        self._found: str | None = None
        self._reading = False
        self._reader: threading.Thread | None = None
        self._partial = b""

    # --- lifecycle ---------------------------------------------------------------------------

    def open(self) -> None:
        try:
            cfg = config_from_entry(self.config, self.ctx.resolve)
        except MotionError as exc:
            raise DeviceError(f"device {self.name!r}: {exc}") from None
        self.files = {role: {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                      for role, path in cfg.files.items()}
        self.log.write("open", device=self.name, config=self.config, files=self.files)
        self.raw = RawCapture(self.raw_path, {"device": self.name, "driver": self.driver})
        self.port = SimPort(SimDevice(cfg, log=self.log.write), timeout=READ_TIMEOUT_S,
                            name=f"sim-{self.name}", on_drop=self._dropped)
        self._reading = True
        self._reader = threading.Thread(target=self._read_loop, name=f"sim-reader-{self.name}",
                                        daemon=True)
        self._reader.start()
        self._send("stop")
        record = self._request("hello", "H", HELLO_TIMEOUT_S)
        if record is None:
            raise DeviceError(f"device {self.name!r} did not answer hello within {HELLO_TIMEOUT_S} s")
        self.hello = self._check_hello(record)

    def start(self) -> None:
        self.log.write("start")
        if self.port is None or "periodUs" not in self.config:
            return
        self._send("start")
        self.streaming = True

    def stop(self) -> None:
        if not self.streaming:
            return
        self.log.write("stop")
        self.streaming = False
        self.stop_report = self._request("stop", "Z", STOP_REPORT_TIMEOUT_S)
        if self.stop_report is None:
            self.log.write("no_stop_report", timeout_s=STOP_REPORT_TIMEOUT_S)

    def safe_state(self) -> None:
        self.log.write("safe_state")
        if self.port is None or not self.port.is_open or not self.config.get("outputs", 0):
            return
        if self.streaming:
            # One device for motion and reward: this stop ends its stream too, so wait for the
            # stop report here; a second stop would get none
            self.stop()
        else:
            self._send("stop")  # the device closes every output on stop

    def close(self) -> None:
        self._reading = False
        if self._reader is not None:
            self._reader.join(1.0)
            self._reader = None
        if self.port is not None:
            self.port.close()
        if self.raw is not None:
            self.raw.close(self.ctx.clock.now_ns(), self._partial)
            self.raw = None
        if self.port is not None:
            self.log.write("close")
            self.port = None
        self.log.close()

    def pulse(self, channel: int, width_us: int) -> int:
        """Send one pulse command; returns its cmd_id (from 1, increasing: rule H8). The outcome
        (A or X line) is in the raw log. Interim: plan items DPR-09 and DPR-10 add the output path
        with the safety envelope."""
        if self.port is None:
            raise DeviceError(f"device {self.name!r} is not open")
        self._cmd_id += 1
        self._send(f"pulse,{self._cmd_id},{channel},{width_us}")
        return self._cmd_id

    def describe(self) -> dict[str, Any]:
        return {**super().describe(), "device_id": self.config["deviceId"],
                "period_us": self.config.get("periodUs", 0), "axes": self.axis_count(self.config),
                "outputs": self.config.get("outputs", 0), "hello": self.hello, "files": self.files,
                "raw_log": f"raw/{self.name}.tsv", "sim_log": f"sim/{self.name}.jsonl",
                "stop_report": self.stop_report}

    # --- host side ---------------------------------------------------------------------------

    def _send(self, record: str) -> None:
        data = frame(record) + b"\n"
        self.raw.wrote(self.ctx.clock.now_ns(), data)
        self.port.write(data)

    def _request(self, record: str, want: str, timeout_s: float) -> str | None:
        """Send a command and wait for the first line of type `want` after it."""
        with self._cv:
            self._want, self._found = want, None
        self._send(record)
        deadline = time.monotonic() + timeout_s
        with self._cv:
            while self._found is None and self._reading:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cv.wait(remaining)
            found, self._want = self._found, None
        return found

    def _check_hello(self, record: str) -> dict[str, Any]:
        fields = record.split(",")
        try:
            hello = {"protocol": fields[1], "version": fields[2], "device_id": fields[3],
                     "period_us": int(fields[4]), "n_axes": int(fields[5]),
                     "keys": dict(item.split("=", 1) for item in fields[6:])}
        except (IndexError, ValueError):
            raise DeviceError(f"device {self.name!r}: malformed hello {record!r}") from None
        expected = {"protocol": "threemaze-device", "device_id": self.config["deviceId"],
                    "period_us": self.config.get("periodUs", 0), "n_axes": self.axis_count(self.config)}
        wrong = [f"{key} {hello[key]!r} (rig file: {value!r})" for key, value in expected.items()
                 if hello[key] != value]
        if not hello["version"].startswith("1."):
            wrong.append(f"version {hello['version']!r} (rig file: 1.x)")
        matrix = (self.ctx.calibration or {}).get("matrix")
        if matrix and len(matrix[0]) != hello["n_axes"]:
            wrong.append(f"n_axes {hello['n_axes']} (calibration: {len(matrix[0])} columns)")
        hb = hello["keys"].get("hb")
        if hb is not None and not (hb.isdigit() and int(hb) >= MIN_HEARTBEAT_MS):
            wrong.append(f"hb {hb!r}: a heartbeat timeout below {MIN_HEARTBEAT_MS} ms (rule H5)")
        self.log.write("hello", hello=hello)
        if wrong:
            raise DeviceError(f"device {self.name!r} does not match the rig file: {'; '.join(wrong)}")
        return hello

    def _read_loop(self) -> None:
        port, buf = self.port, b""
        while self._reading:
            try:
                chunk = port.read(port.in_waiting or 1)
            except OSError:
                break
            if not chunk:
                continue
            t_ns = self.ctx.clock.now_ns()
            buf += chunk
            while True:
                end = buf.find(b"\n")
                if end < 0:
                    break
                line, buf = buf[:end + 1], buf[end + 1:]
                self.raw.line(t_ns, line)
                self._match(line)
            self._partial = buf

    def _match(self, line: bytes) -> None:
        if self._want is None:
            return
        record = unframe(line)
        if record is not None and record[:1] == self._want and (len(record) == 1 or record[1] == ","):
            with self._cv:
                if self._found is None:
                    self._found = record
                    self._cv.notify_all()

    def _dropped(self, delivery) -> None:
        self.log.write("dropped", reason="input buffer full", seq=delivery.seq, kind=delivery.kind)
