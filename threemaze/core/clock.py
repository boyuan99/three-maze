"""The session clock (ADR-0002, "Rig runtime": the runtime owns the session clock).

Every host time stamp of a session is time.perf_counter_ns(): integer nanoseconds on one
monotonic, process-wide clock. Wall-clock time never stamps data; it is read only together with
the session clock, as an anchor, so that a session can be placed on the calendar.
"""
import time
from dataclasses import dataclass
from datetime import datetime, timezone


@dataclass(frozen=True)
class ClockAnchor:
    """The session clock and the wall clock (UTC) read together."""

    perf_ns: int
    wall_utc: str  # ISO 8601 with microseconds and +00:00

    def as_dict(self) -> dict:
        return {"perf_ns": self.perf_ns, "wall_utc": self.wall_utc}


class SessionClock:
    """time.perf_counter_ns(); tests may substitute any object with now_ns() and anchor()."""

    def now_ns(self) -> int:
        return time.perf_counter_ns()

    def anchor(self) -> ClockAnchor:
        before = time.perf_counter_ns()
        wall = datetime.now(timezone.utc)
        after = time.perf_counter_ns()
        return ClockAnchor((before + after) // 2, wall.isoformat(timespec="microseconds"))
