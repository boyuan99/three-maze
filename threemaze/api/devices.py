"""Base classes of device drivers (backend-modules design, "Driver interface (L3)").

A driver is a class registered under a name (`register`); a rig file's device entry names its
driver, and the rest of the entry is the driver's configuration. The runtime creates one
instance per device bound to a role and calls, in this order:

    open()        before the session is armed: open the port, check the device; raise
                  DeviceError to refuse to arm
    start()       input devices, when the session starts running
    stop()        input devices, when it stops
    safe_state()  output devices: whenever the session stops or aborts, first; idempotent
    close()       always, last; idempotent

Later plan items add the reading side of input devices (SerialLineSource, DPR-03) and the pulse
side of output devices (configure and fire, DPR-09).
"""
import logging
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Protocol


class DeviceError(Exception):
    """A device cannot be opened, started or stopped, or does not match the rig file."""


class Clock(Protocol):
    def now_ns(self) -> int: ...


@dataclass(frozen=True)
class DeviceContext:
    """What the runtime gives a device: the session clock, the session folder, the folder that
    relative paths in the rig file start from, the device's calibration entry and a logger."""

    clock: Clock
    session_dir: Path
    rig_dir: Path
    calibration: Mapping[str, Any] | None = None
    log: logging.Logger = field(default_factory=lambda: logging.getLogger("threemaze.devices"))

    def resolve(self, path: str) -> Path:
        """A path from the rig file: relative paths are relative to the rig file's folder."""
        p = Path(path)
        return p if p.is_absolute() else self.rig_dir / p


class Device:
    """Common part of input and output devices."""

    driver: ClassVar[str] = ""        # set by register()
    driver_version: ClassVar[str] = "1"

    def __init__(self, name: str, config: Mapping[str, Any], ctx: DeviceContext):
        self.name = name
        self.config = config
        self.ctx = ctx

    @classmethod
    def roles(cls, config: Mapping[str, Any]) -> frozenset[str]:
        """The roles a device with this configuration can serve."""
        found: set[str] = set()
        if issubclass(cls, InputDevice):
            found.add("motion")
        if issubclass(cls, OutputDevice):
            found.add("reward")
        return frozenset(found)

    @classmethod
    def axis_count(cls, config: Mapping[str, Any]) -> int | None:
        """Sensor axes per sample, when the configuration fixes it; None when only the device
        knows (it then reports it in its hello, which open() checks against the calibration)."""
        return None

    @classmethod
    def check_config(cls, config: Mapping[str, Any], rig_dir: Path) -> list[tuple[str, str]]:
        """Checks the schema cannot express: (JSON pointer below the device entry, message).
        rig_dir is the folder that relative paths in the rig file start from, so a driver can
        check here the files its entry names; the session is then refused before it is armed."""
        return []

    def open(self) -> None:
        pass

    def close(self) -> None:
        pass

    def describe(self) -> dict[str, Any]:
        """Identity for the session record."""
        return {"driver": self.driver, "driver_version": self.driver_version}


class InputDevice(Device, ABC):
    """A device whose stream the session reads (role motion)."""

    @abstractmethod
    def start(self) -> None:
        """Begin the stream."""

    @abstractmethod
    def stop(self) -> None:
        """End the stream; idempotent."""


class OutputDevice(Device, ABC):
    """A device the session drives (role reward)."""

    @abstractmethod
    def safe_state(self) -> None:
        """Put every output in its safe state (a valve closed). Idempotent; must not raise
        because the device is already closed."""
