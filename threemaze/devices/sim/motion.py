"""What the simulated device measures: per sample, the counts of its three sensor axes and the
level of lick channel 0.

The axes are lateral (left positive), forward and yaw (counter-clockwise positive) counts, in the
order of the v0.3 stream's fields 7, 8 and 9 (docs/protocol/device-v1.md section 10.3), so one
calibration matrix serves the simulated device in both of its protocols. Three sources:

- segments: piecewise-constant speeds (straight runs, turns, stops), looped or not;
- samples: a file with one displacement per sample (forward_cm, left_cm, dyaw_rad[, lick]);
- replay: the counts of a recorded stream, sample by sample, at the simulated device's own
  period: a raw capture ("three-maze raw capture 1", tools/capture_raw.py) or a plain text file of
  device lines, either device protocol v1 S lines with three axes or v0.3 13-field lines.

Displacements in cm and rad become integer counts through the device's sensor resolution, with
each axis's running total rounded half up from the exact sum, so counts never drift. A source
that is not looped holds still (no counts, lick 0) once it has run out.
"""
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from .frame import int32, unframe

AXES = 3
Counts = tuple[int, int, int]

# v0.3's parser skips lines containing one of these (experiments/hallway04_experiment.py:341-346)
_V03_SKIP = ("[CMD]", "[CONFIG]", "[INFO]", "[START]", "[RUNNING]", "[STOP]", "Time(us)",
             "Data Header", "Data Start", "---", "===")


class MotionError(ValueError):
    """A motion source cannot be built (an unreadable file, a malformed line)."""


@dataclass(frozen=True)
class Sensor:
    """Resolution of the simulated sensor: what one count of each axis is."""

    cm_per_count: float
    rad_per_count: float


@dataclass(frozen=True)
class Segment:
    duration_s: float
    forward_cm_per_s: float = 0.0
    left_cm_per_s: float = 0.0
    yaw_deg_per_s: float = 0.0
    lick: int = 0


class MotionSource:
    """Yields (counts, lick level) per sample; reset() starts again at the first sample (each
    stream does)."""

    def reset(self) -> None:
        raise NotImplementedError

    def next(self) -> tuple[Counts, int]:
        raise NotImplementedError


class Still(MotionSource):
    def reset(self) -> None:
        pass

    def next(self) -> tuple[Counts, int]:
        return (0, 0, 0), 0


class _Table(MotionSource):
    """A finite list of per-sample entries, looped or held still at the end."""

    def __init__(self, loop: bool):
        self.loop = loop
        self._index = 0

    def __len__(self) -> int:
        raise NotImplementedError

    def _entry(self, index: int) -> tuple[Counts, int]:
        raise NotImplementedError

    def _restart(self) -> None:
        pass

    def reset(self) -> None:
        self._index = 0
        self._restart()

    def next(self) -> tuple[Counts, int]:
        if self._index >= len(self):
            if not self.loop:
                return (0, 0, 0), 0
            self._index = 0
        entry = self._entry(self._index)
        self._index += 1
        return entry


class _Displacements(_Table):
    """Per-sample displacements (left cm, forward cm, yaw rad) -> counts, rounding running totals."""

    def __init__(self, rows: Sequence[tuple[float, float, float, int]], sensor: Sensor, loop: bool):
        super().__init__(loop)
        if not rows:
            raise MotionError("no samples")
        self._rows = rows
        self._resolution = (sensor.cm_per_count, sensor.cm_per_count, sensor.rad_per_count)
        self._restart()

    def __len__(self) -> int:
        return len(self._rows)

    def _restart(self) -> None:
        self._exact = [0.0] * AXES
        self._sent = [0] * AXES

    def _entry(self, index: int) -> tuple[Counts, int]:
        *move, lick = self._rows[index]
        counts = []
        for axis in range(AXES):
            self._exact[axis] += move[axis] / self._resolution[axis]
            total = math.floor(self._exact[axis] + 0.5)
            counts.append(total - self._sent[axis])
            self._sent[axis] = total
        return (counts[0], counts[1], counts[2]), lick


class Segments(_Displacements):
    def __init__(self, segments: Sequence[Segment], period_us: int, sensor: Sensor, loop: bool):
        dt = period_us / 1e6
        rows = []
        for seg in segments:
            n = max(1, math.floor(seg.duration_s / dt + 0.5))
            rows += [(seg.left_cm_per_s * dt, seg.forward_cm_per_s * dt,
                      math.radians(seg.yaw_deg_per_s) * dt, seg.lick)] * n
        super().__init__(rows, sensor, loop)


class SampleFile(_Displacements):
    """A text file: a header naming the columns forward_cm, left_cm, dyaw_rad and optionally
    lick, then one row per sample; tab or comma separated; lines starting with # are comments."""

    def __init__(self, path: Path, sensor: Sensor, loop: bool):
        lines = [(n, line.strip()) for n, line in enumerate(_read_text(path).splitlines(), 1)]
        lines = [(n, line) for n, line in lines if line and not line.startswith("#")]
        if not lines:
            raise MotionError(f"{path}: empty")
        sep = "\t" if "\t" in lines[0][1] else ","
        header = [name.strip() for name in lines[0][1].split(sep)]
        missing = {"forward_cm", "left_cm", "dyaw_rad"} - set(header)
        if missing:
            raise MotionError(f"{path}: the header lacks {', '.join(sorted(missing))}")
        rows = []
        for n, line in lines[1:]:
            values = dict(zip(header, (v.strip() for v in line.split(sep))))
            try:
                move = [float(values[key]) for key in ("left_cm", "forward_cm", "dyaw_rad")]
                lick = int(values.get("lick", "0"))
            except (KeyError, ValueError) as exc:
                raise MotionError(f"{path}:{n}: {exc}") from None
            if not all(math.isfinite(v) for v in move):
                raise MotionError(f"{path}:{n}: not a finite number")
            rows.append((move[0], move[1], move[2], lick))
        super().__init__(rows, sensor, loop)


class Replay(_Table):
    """The per-sample counts and lick levels of a recorded stream."""

    def __init__(self, entries: Sequence[tuple[Counts, int]], loop: bool):
        super().__init__(loop)
        self.entries = entries

    @staticmethod
    def load(path: Path) -> list[tuple[Counts, int]]:
        entries = recorded_counts(_data_lines(path), str(path))
        if not entries:
            raise MotionError(f"{path}: no samples found")
        return entries

    def __len__(self) -> int:
        return len(self.entries)

    def _entry(self, index: int) -> tuple[Counts, int]:
        return self.entries[index]


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise MotionError(f"cannot read {path}: {getattr(exc, 'strerror', None) or exc}") from None


def _data_lines(path: Path) -> list[tuple[int, str]]:
    """(line number, device line) from a raw capture (lines '<ns>TAB<line>', comments '#') or a
    plain file of device lines."""
    out = []
    for n, line in enumerate(_read_text(path).splitlines(), 1):
        if line.startswith("#"):
            continue
        stamp, tab, rest = line.partition("\t")
        if tab and stamp.isdigit():
            line = rest
        line = line.strip()
        if line:
            out.append((n, line))
    return out


def recorded_counts(lines: Iterable[tuple[int, str]], source: str) -> list[tuple[Counts, int]]:
    """Per-sample counts from device lines: v1 S lines (checksum right, three totals; counts are
    the differences of running totals, so samples lost in the recording keep their motion) with L
    lines for lick channel 0, or v0.3 lines as v0.3 accepted them (fields 7, 8, 9 must be whole
    numbers; field 10 is the lick level)."""
    out: list[tuple[Counts, int]] = []
    kind = None
    previous = [0] * AXES
    lick = 0
    for n, line in lines:
        record = unframe(line.encode("ascii", "replace"))
        if record is not None:
            fields = record.split(",")
            if fields[0] == "S":
                kind = _same_kind(kind, "v1", source, n)
                if len(fields) != 5 + AXES:
                    raise MotionError(f"{source}:{n}: an S line with {len(fields) - 5} axes;"
                                      " replay needs 3")
                try:
                    seq, totals = int(fields[1]), [int(v) for v in fields[5:]]
                except ValueError:
                    raise MotionError(f"{source}:{n}: malformed S line") from None
                if seq == 0:  # a new stream: totals start again at 0
                    previous = [0] * AXES
                counts = tuple(int32(t - p) for t, p in zip(totals, previous))
                previous = totals
                out.append(((counts[0], counts[1], counts[2]), lick))
            elif fields[0] == "L" and len(fields) == 4 and fields[1] == "0":
                lick = 1 if fields[3] == "1" else 0
            continue
        if any(p in line for p in _V03_SKIP) or not line[0].isdigit():
            continue
        fields = line.split(",")
        if len(fields) < 13:
            continue
        kind = _same_kind(kind, "v0.3", source, n)
        try:  # every field as v0.3 parses it (experiments/hallway04_experiment.py:358-374)
            numbers = {i: float(fields[i]) for i in (1, 2, 3, 4, 5, 6, 7, 8, 9, 11)}
            level, _ = int(fields[10]), int(fields[12])
        except ValueError:
            continue  # v0.3 skipped such a line too (:379-381)
        values = [numbers[i] for i in (7, 8, 9)]
        if not all(math.isfinite(v) and v == int(v) for v in values):
            raise MotionError(f"{source}:{n}: fields 7 to 9 are not whole counts")
        out.append(((int(values[0]), int(values[1]), int(values[2])), 1 if level else 0))
    return out


def _same_kind(kind: str | None, new: str, source: str, n: int) -> str:
    if kind is not None and kind != new:
        raise MotionError(f"{source}:{n}: {new} line in a recording of {kind} lines")
    return new
