"""Driver "simulated": the reference simulated device of device protocol v1, in the runtime's own
process, so that a session runs on any PC without hardware (`--rig sim`, rigs/sim.json).

With `periodUs` the device streams samples and can serve the motion role; with `outputs` it
drives output channels and can serve the reward role. Every call the runtime makes is written
to the device's sim log, <session>/sim/<device>.jsonl (one JSON object per line, flushed at once,
each with t_ns on the session clock).
"""
import json
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..api import DeviceContext, InputDevice, OutputDevice, register

AXES = 3  # lateral, forward and yaw counts, in the order of the v0.3 stream's fields 7, 8, 9


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
class SimulatedDevice(InputDevice, OutputDevice):

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
        if not cls.roles(config):
            return [("", "a simulated device needs periodUs (to stream samples) or outputs >= 1"
                         " (to drive outputs)")]
        return []

    def __init__(self, name: str, config: Mapping[str, Any], ctx: DeviceContext):
        super().__init__(name, config, ctx)
        self.log = SimLog(ctx.session_dir / "sim" / f"{name}.jsonl", ctx.clock)
        self.is_open = False
        self.streaming = False

    def open(self) -> None:
        self.log.write("open", device=self.name, config=self.config)
        self.is_open = True

    def start(self) -> None:
        self.log.write("start")
        self.streaming = True

    def stop(self) -> None:
        if self.streaming:
            self.log.write("stop")
        self.streaming = False

    def safe_state(self) -> None:
        self.log.write("safe_state")

    def close(self) -> None:
        if self.is_open:
            self.log.write("close")
        self.is_open = False
        self.log.close()

    def describe(self) -> dict[str, Any]:
        return {**super().describe(), "device_id": self.config["deviceId"],
                "period_us": self.config.get("periodUs", 0),
                "axes": self.axis_count(self.config), "outputs": self.config.get("outputs", 0)}
