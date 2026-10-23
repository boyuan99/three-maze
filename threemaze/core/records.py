"""What a device's reader hands to the rig runtime (plan item DPR-03; docs/protocol/device-v1.md).

Pure data, shared by the device drivers (threemaze/devices), the link to the motion worker
(threemaze/link) and, later, the recorder. A reader turns the lines of a device's stream into these
records, in the order the lines arrived, and hands them on in batches (threemaze/devices/
serial_lines.py):

    DeviceSample   one accepted sample, the device sample of device-v1.md section 7.2
    DeviceEvent    a lick edge (L line) or an external frame-clock edge (F line), section 4.4
    StopReport     the end of a stream (Z line), section 4.3
    Hello          the device's identity (H line), section 4.1
    PulseOutcome   a pulse done (A line) or refused (X line), section 4.5
    DeviceMessage  a diagnostic message (E line), section 4.6
    StreamFault    the stream cannot go on: the device clock went backward (rule H6), or the
                   port failed and the reader stopped

Times: t_dev_us is the device clock, unwrapped to 64 bits (rule H6), in integer microseconds;
t_host_ns is the session clock (time.perf_counter_ns) at the read that completed the line (rule H1).
"""
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: DeviceSample.flags above the device's own flags byte (link protocol v1, section 8): dt_us is an
#: estimate, not a measured window (a stream's first sample, device-v1.md section 7.2)
DT_ESTIMATED = 1 << 8
#: DeviceSample.flags: the line's dt_us disagreed with its device clock (rule H6)
DT_MISMATCH = 1 << 9


@dataclass(frozen=True, slots=True)
class DeviceSample:
    """One accepted sample. raw holds the counts per sensor axis since the previous accepted sample
    (the differences of the device's running totals, rule D6); d = C · raw is the body-frame
    displacement [forward cm, left cm, dyaw rad] with the rig file's calibration C; flags are the
    device's flags byte (bits 0-7) with DT_ESTIMATED and DT_MISMATCH; gap is the number of samples
    lost just before this one (rules H3, H4)."""

    seq: int
    t_dev_us: int
    dt_us: int
    raw: tuple[int, ...]
    d: tuple[float, float, float]
    flags: int
    gap: int
    t_host_ns: int

    def link(self) -> dict[str, Any]:
        """The sample as the link protocol carries it (protocol/v1/sample.batch.schema.json)."""
        return {"seq": self.seq, "t_dev_us": self.t_dev_us, "dt_us": self.dt_us, "d": list(self.d),
                "raw": list(self.raw), "flags": self.flags, "gap": self.gap}


@dataclass(frozen=True, slots=True)
class DeviceEvent:
    """A lick edge (kind "lick": channel, level 1 for contact onset or 0 for its end) or an edge of
    an external frame clock (kind "frame": count, the edges since start, 1 for the first).

    seq is the sample the event is assigned to: the next S line the reader received after it (rule
    D9), or None when the stream ended before one arrived. late is True when the event arrived after
    the S line of its window (counted as late_events, device-v1.md section 4.4)."""

    kind: str
    t_dev_us: int
    seq: int | None
    t_host_ns: int
    channel: int = 0
    level: int = 0
    count: int = 0
    late: bool = False


@dataclass(frozen=True, slots=True)
class StopReport:
    """The device's stop report: the stream had n_samples samples; lost_at_end of them came after
    the last sample the reader accepted (device-v1.md section 4.3). record is the line's record."""

    n_samples: int
    t_dev_us: int
    lost_at_end: int
    t_host_ns: int
    record: str


@dataclass(frozen=True, slots=True)
class Hello:
    """The device's hello (device-v1.md section 4.1), parsed but not yet checked against the rig
    file (that is rule H5). record is the line's record."""

    protocol: str
    version: str
    device_id: str
    period_us: int
    n_axes: int
    keys: Mapping[str, str]
    t_host_ns: int
    record: str

    def as_dict(self) -> dict[str, Any]:
        """For the session record (device-v1.md section 8.3, `hello`)."""
        return {"protocol": self.protocol, "version": self.version, "device_id": self.device_id,
                "period_us": self.period_us, "n_axes": self.n_axes, "keys": dict(self.keys)}


@dataclass(frozen=True, slots=True)
class PulseOutcome:
    """The outcome a device reported for a pulse command: done (an A line, with the on and off
    times it measured on its own clock) or refused (an X line, with its reason)."""

    cmd_id: int
    done: bool
    t_host_ns: int
    t_on_dev_us: int | None = None
    t_off_dev_us: int | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class DeviceMessage:
    """A diagnostic message (E line): logged as a device warning, never interpreted."""

    code: str
    text: str
    t_host_ns: int


@dataclass(frozen=True, slots=True)
class StreamFault:
    """The stream cannot go on. After a device clock that went backward (rule H6) the profile
    accepts no further sample until the next start; after a port that failed the reader has
    stopped and reads nothing more. reason says which."""

    reason: str
    t_host_ns: int


Record = (DeviceSample | DeviceEvent | StopReport | Hello | PulseOutcome | DeviceMessage
          | StreamFault)
