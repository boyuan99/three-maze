"""Device profiles: the rules the rig runtime reads one kind of device by (docs/protocol/
device-v1.md, Terms). The rig file names the profile of each device.

A profile does three things for the reader of one device (threemaze/devices/serial_lines.py):

- it turns each line of the device's stream into records (threemaze.core.records) and keeps the
  state of the stream: sequence numbers, the unwrapped device clock, the running totals, the events
  waiting for their sample; parse() runs on the reader thread, for every line, in arrival order;
- it runs the host's side of the session sequence (device-v1.md section 6) through the operations
  the reader's device offers (Host): open() when the session is armed, start() and stop() with the
  stream;
- it says what the stream guarantees (section 8): record() gives the fields of the session record
  (section 8.3) and link_device() the motion device's entry of the link protocol's welcome.

Phase 1 reads two profiles (owner, 2026-10-09; three-maze-notes decision log DEC-039): v1 (device
protocol v1, profiles/v1.py) and legacy-v0.3 (the v0.3 device stream, plan item DPR-04). A
configurable text-line profile and drivers written by rig builders follow in phase 2 (DPR-28).
"""
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any, ClassVar, Protocol

from ...core.records import Record, StopReport

#: Counters of the session record (device-v1.md section 8.3); `ignored` is the legacy profile's
COUNTERS = ("lines", "samples", "seq_gaps", "samples_lost", "seq_regressions", "crc_errors",
            "parse_errors", "overflow", "unknown", "dt_mismatch", "late_events")


class Host(Protocol):
    """What a profile may do with its device's port (implemented by SerialLineSource)."""

    name: str

    def write(self, data: bytes) -> None:
        """Send bytes to the device (logged in the raw-line log)."""

    def discard(self) -> None:
        """Drop everything received so far, on the reader thread."""

    def restart(self, data: bytes) -> None:
        """On the reader thread: drop everything received so far, call begin_stream(), send data
        (rule H4: nothing received before the start command enters the stream)."""

    def end_stream(self) -> None:
        """On the reader thread: end the stream without a stop report (end_stream())."""

    def request(self, data: bytes, match: Callable[[Record], bool], *, timeout_s: float,
                retry_s: float | None = None) -> Record | None:
        """Send data, sending it again every retry_s, until a record that matches arrives; None
        after timeout_s."""

    def heartbeat(self, data: bytes, period_s: float) -> None:
        """Send data every period_s from now until the device is closed."""


class Profile(ABC):
    name: ClassVar[str]           # as the rig file and the session record name it
    seq_source: ClassVar[str]     # "device" or "host" (device-v1.md section 7.2)

    def __init__(self) -> None:
        self.counters: dict[str, int] = dict.fromkeys(COUNTERS, 0)
        # Beyond the session record's counters, for diagnostics and the tests
        self.stats: dict[str, int] = {}

    # --- reading: on the reader thread -------------------------------------------------------

    @abstractmethod
    def parse(self, line: bytes, t_host_ns: int) -> list[Record]:
        """The records of one line (without its LF and a CR before it), stamped t_host_ns."""

    def overflow(self, t_host_ns: int) -> None:
        """A line longer than the profile allows was cut off by the reader (rule F2)."""
        self.counters["lines"] += 1
        self.counters["overflow"] += 1

    @abstractmethod
    def begin_stream(self) -> None:
        """The host is about to start a stream; everything received before was discarded."""

    @abstractmethod
    def end_stream(self, t_host_ns: int) -> list[Record]:
        """The stream ended without a stop report; returns the records still waiting."""

    # --- the session sequence: on the runtime's thread ---------------------------------------

    @abstractmethod
    def open(self, host: Host) -> None:
        """Check the device before the session is armed; raise DeviceError to refuse to arm."""

    @abstractmethod
    def start(self, host: Host) -> None:
        """Start the stream."""

    @abstractmethod
    def stop(self, host: Host) -> StopReport | None:
        """End the stream; the stop report, or None if none arrived."""

    def stop_outputs(self, host: Host) -> None:
        """Put every output in its safe state (a device that drives outputs)."""

    def pulse(self, host: Host, cmd_id: int, channel: int, width_us: int) -> None:
        raise NotImplementedError(f"profile {self.name} drives no outputs")

    # --- what the session records -------------------------------------------------------------

    @abstractmethod
    def record(self) -> dict[str, Any]:
        """The device's fields of the session record (device-v1.md section 8.3)."""

    @abstractmethod
    def link_device(self) -> dict[str, Any]:
        """The motion device's profile and guarantee level for the link protocol's welcome
        (protocol/v1/common.schema.json, MotionDevice)."""


__all__ = ["COUNTERS", "Host", "Profile"]
