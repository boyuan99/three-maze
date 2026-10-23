"""Driver "simulated": the reference simulated device of device protocol v1 (threemaze/devices/sim)
in the runtime's own process, so that a session runs on any PC without hardware (`--rig sim`,
rigs/sim.json), the rig PC included.

With `periodUs` the device streams samples and can serve the motion role; with `outputs` it
drives output channels and can serve the reward role. Its motion comes from `trajectory`
(segments, a per-sample file or the replay of a recorded stream) and `faults` injects transport
faults; docs/rig-file-v1.md lists the fields.

The device sits behind SimPort, an in-process serial port, and is read like a device on a real
port: it is a SerialLineSource (serial_lines.py) in profile v1, so the reader thread of plan item
DPR-03 frames, checks and parses its lines, and the host's side of device-v1.md section 6 runs as
for any v1 device: stop and hello when the session is armed, with the hello checked against the
rig file (rule H5); a heartbeat to a device that declares one (rule H7); start; stop and its stop
report; stop to a device with outputs whenever outputs are made safe. Every line the device sends,
and every command, is written to <session>/raw/<device>.tsv ("three-maze raw capture 1"), each
line stamped with the session clock at the read that completed it. The device logs every command,
fault and pulse to <session>/sim/<device>.jsonl, and this driver logs there the runtime's calls
(open, start, safe_state, stop, close) and the hello it received.
"""
import hashlib
import json
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..api import DeviceContext, DeviceError, register
from .profiles import Profile
from .profiles.v1 import V1Profile, V1Settings
from .serial_lines import SerialLineSource
from .sim.model import SimDevice, config_from_entry, config_problems
from .sim.motion import AXES, MotionError
from .sim.port import SimPort


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


@register("simulated")
class SimulatedDevice(SerialLineSource):
    driver_version = "1"

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
        self.files: dict[str, dict[str, str]] = {}

    # --- SerialLineSource ---------------------------------------------------------------------

    @classmethod
    def profile_for(cls, config: Mapping[str, Any],
                    calibration: Mapping[str, Any] | None) -> Profile:
        return V1Profile(V1Settings(
            device_id=config["deviceId"], period_us=config.get("periodUs", 0),
            matrix=(calibration or {}).get("matrix"), n_axes=cls.axis_count(config),
            outputs=config.get("outputs", 0)))

    def open_port(self) -> SimPort:
        try:
            cfg = config_from_entry(self.config, self.ctx.resolve)
        except MotionError as exc:
            raise DeviceError(f"device {self.name!r}: {exc}") from None
        self.files = {role: {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                      for role, path in cfg.files.items()}
        self.log.write("open", device=self.name, config=self.config, files=self.files)
        return SimPort(SimDevice(cfg, log=self.log.write), timeout=self.read_timeout_s,
                       name=f"sim-{self.name}", on_drop=self._dropped)

    # --- lifecycle, logged in the device's log ------------------------------------------------

    def open(self) -> None:
        try:
            super().open()
        finally:
            received = getattr(self.profile, "received_hello", None)
            if received is not None:
                self.log.write("hello", hello=received.as_dict())

    def start(self) -> None:
        self.log.write("start")
        super().start()

    def stop(self) -> None:
        if not self.streaming:
            return
        self.log.write("stop")
        super().stop()
        if self.stop_report is None:
            self.log.write("no_stop_report", timeout_s=self.profile.settings.stop_timeout_ms / 1000)

    def safe_state(self) -> None:
        self.log.write("safe_state")
        super().safe_state()

    def close(self) -> None:
        opened = self.port is not None
        super().close()
        if opened:
            self.log.write("close")
        self.log.close()

    def describe(self) -> dict[str, Any]:
        return {**super().describe(), "device_id": self.config["deviceId"],
                "period_us": self.config.get("periodUs", 0), "axes": self.axis_count(self.config),
                "outputs": self.config.get("outputs", 0), "files": self.files,
                "sim_log": f"sim/{self.name}.jsonl"}

    def _dropped(self, delivery) -> None:
        self.log.write("dropped", reason="input buffer full", seq=delivery.seq, kind=delivery.kind)
