"""The session recorder (plan item DPR-07; ADR-0002, Rig runtime: "all persistence").

One SessionRecorder per session writes the tables and logs of the session folder
(docs/data-format-v1.md):

    samples.tsv      one row per device sample, when the runtime receives it
    pose.tsv         one row per pose of the motion worker
    events.jsonl     every non-stream event, in the order received (dispatch order)
    commands.jsonl   every command and ack, every output request and its outcome
    trials.tsv       one row per trial: commanded against acknowledged reward
    frames.tsv       one row per rendered frame
    longtasks.jsonl  long tasks of the stimulus window's main thread

Every input method checks its input and turns it into lines on the caller's thread, raises
RecordError for a value it cannot record (nothing of that call is written then), and hands the
lines to the writer thread (writer.py), which flushes and fsyncs about once a second; none of them
waits for the disk. A sample therefore gets its row as soon as the session receives it from the
reader, whatever the motion worker or the renderer does: v0.3 wrote a row only when the renderer
reported a pose, which is where its four data-logging defects and the stale first row came from
(test/e2e/README.md, Known limits).

Input interface, and who calls it (the link protocol's messages are protocol/v1):

    sample(s), samples(batch)   the session (threemaze/runtime/session.py), once per sample that
                                the motion device's reader (plan item DPR-03) accepted, when the
                                reader hands it over: on the reader's thread, or on the session's
                                event loop. A device sample (device protocol v1, section 7.2) as
                                the link protocol's sample (seq, t_dev_us, dt_us, d, raw, flags,
                                gap) plus t_host_ns, the session clock at the read that completed
                                its line (rule H1); a mapping, or an object with these attributes
                                (such as the reader's DeviceSample, threemaze/core/records.py)
    poses(data)                 the link server (DPR-06b): the data of a pose.batch message
    motion_event(data)          the link server: the data of an event message; stale=True for an
                                event of an old epoch (DPR-06b)
    render_report(data)         the link server: the data of a render.report message (frames,
                                long_tasks; ready and clock go to events.jsonl)
    event(src, kind, ...)       anything else that happens: the task's trial_start and trial_end
                                (TS-13, TS-14), runtime states and warnings, device events
    command(record)             commands and acks (DPR-05b), reward requests and their outcomes
                                (DPR-09)
    close()                     once, when the session ends

Every other method takes t_host_ns, the session clock when the input reached the runtime; without
it the recorder reads the clock itself (a sample carries its own t_host_ns). Inputs are recorded in
the order of the calls, so a caller with an ordered source (the reader, one link connection) keeps
that order. Each method may be called from any thread, but sample() from one thread only (its
sequence check keeps state).
"""
import math
import re
import shutil
import threading
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any

from ..core.clock import SessionClock
from .formats import (COMMAND_KINDS, COMMANDS, COMMANDS_SPEC, EVENT_SOURCES, EVENTS, FRAMES,
                      FRAMES_SPEC, LONG_TASKS, OUTCOMES, POSES, POSES_SPEC, SAMPLES,
                      TIMING_CLASSES, TRIALS, TRIALS_SPEC, samples_spec)
from .tables import RecordError, json_line
from .trials import TrialTable
from .writer import FLUSH_INTERVAL_S, FileWriter

U32 = 1 << 32
MAX_SEQ_WARNINGS = 10
# Names, matched whole (fullmatch: Python's $ also matches before a final line end)
_KIND = re.compile(r"[a-z][a-z0-9_]{0,63}")
_OUTCOME_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,63}")
_COMMAND_SOURCES = ("motion", "runtime", "device", "operator")
_COMMAND_FIELDS = frozenset(COMMANDS_SPEC.names) - {"t_host_ns"}
_COMMAND_INTS = ("cmd_id", "trial", "seq", "epoch", "t_dev_us", "apply_seq", "applied_seq",
                 "width_us")
_STAMP = ("seq", "epoch", "t_dev_us", "world")
_SAMPLE_FIELDS = ("seq", "t_dev_us", "t_host_ns", "dt_us", "gap", "flags", "raw", "d")
_LONG_TASK_EXTRA = ("blocking_us", "render_start_us", "style_layout_start_us")

# Free-disk preflight: a session is not armed unless the data root has room for an hour of its
# data, which covers the 30-min sessions of the week-6 gate (ADR-0003, Decision 2) and of REN-25
# twice over. The hours the free space holds go into the session record (preflight), so that a
# longer run, such as ADR-0003's phase-3 soak of 4 to 8 hours, can be checked before it starts.
PREFLIGHT_HOURS = 1
# Frame rate for the estimate, before the display is known: the experiment-data design measured
# the frames table at 144 Hz (three-maze-notes design/experiment_data.json, section 6)
PREFLIGHT_FRAME_HZ = 144


def _uint(name: str, value: Any, top: int | None = None) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or (
            top is not None and value > top):
        bound = f" up to {top}" if top is not None else ""
        raise RecordError(f"{name}: {value!r} is not an integer from 0{bound}")
    return value


def _opt_uint(name: str, value: Any, top: int | None = None) -> int | None:
    """An optional field: None if absent, otherwise as _uint."""
    return None if value is None else _uint(name, value, top)


def _field(record: Mapping[str, Any], name: str, where: str) -> Any:
    try:
        return record[name]
    except KeyError:
        raise RecordError(f"{where}: no {name}") from None
    except TypeError:
        raise RecordError(f"{where}: {type(record).__name__} is not an object") from None


def _items(record: Mapping[str, Any], name: str, where: str) -> list[Any]:
    """A field that holds an array (poses, frames, entries)."""
    items = _field(record, name, where)
    if not isinstance(items, (list, tuple)):
        raise RecordError(f"{where}: {name} is {type(items).__name__}, not an array")
    return list(items)


def _as_mapping(record: Any, names: tuple[str, ...], where: str) -> Mapping[str, Any]:
    """A mapping as it is; any other object by its attributes (a frozen dataclass, for example)."""
    if isinstance(record, Mapping):
        return record
    try:
        return {name: getattr(record, name) for name in names}
    except AttributeError as exc:
        raise RecordError(f"{where}: {type(record).__name__} has no {exc.name}") from None


class SessionRecorder:
    def __init__(self, folder: str | Path, *, n_axes: int, seq_source: str | None = None,
                 clock=None, flush_interval_s: float = FLUSH_INTERVAL_S,
                 on_error: Callable[[str, OSError], None] | None = None,
                 on_ready: Callable[[Mapping[str, Any], int], None] | None = None):
        """folder: the session folder (it exists, and none of the files does). n_axes: sensor axes
        of the motion device (the columns of its calibration matrix). seq_source: "device" or
        "host" (device protocol v1, section 7.2) to check each sample's seq against the previous
        one and its gap, None not to check. on_error(file, exc): a write failed (writer thread).
        on_ready(data, t_host_ns): a render.report ready arrived (for the session record)."""
        if seq_source not in (None, "device", "host"):
            raise ValueError(f"seq_source {seq_source!r}: device, host or None")
        self.folder = Path(folder)
        self.samples_spec = samples_spec(n_axes)
        self.n_axes = n_axes
        self.seq_source = seq_source
        self.seq_mismatches = 0
        self._clock = clock if clock is not None else SessionClock()
        self._on_ready = on_ready
        self._last_seq: int | None = None
        self._lock = threading.Lock()      # orders events and commands with the trial table
        self._closed = False
        self._summary: dict[str, Any] | None = None
        self._writer = FileWriter(self.folder, flush_interval_s=flush_interval_s,
                                  on_error=on_error)
        try:
            for spec in (self.samples_spec, POSES_SPEC, FRAMES_SPEC, TRIALS_SPEC):
                self._writer.create(spec.file, spec.header())
            for name in (EVENTS, COMMANDS, LONG_TASKS):
                self._writer.create(name)
        except BaseException:
            self._writer.close()
            raise
        self._trials = TrialTable(lambda line: self._writer.put(TRIALS, line))

    def _now(self, t_host_ns: int | None) -> int:
        if t_host_ns is None:
            return self._clock.now_ns()
        return _uint("t_host_ns", t_host_ns)

    # --- samples.tsv -----------------------------------------------------------------------------

    def sample(self, s: Any) -> None:
        """One device sample, when it is received: seq, t_dev_us, t_host_ns, dt_us, gap, flags,
        raw (n_axes counts) and d ([forward cm, left cm, dyaw rad]), as keys or attributes."""
        seq, gap, line = self._sample_line(s)
        self._check_seq(seq, gap)
        self._writer.put(SAMPLES, line)

    def samples(self, batch: Iterable[Any]) -> None:
        """Several samples, in order; if one cannot be recorded, none of them is."""
        lines = [self._sample_line(s) for s in batch]
        for seq, gap, line in lines:
            self._check_seq(seq, gap)
            self._writer.put(SAMPLES, line)

    def _sample_line(self, s: Any) -> tuple[int, int, str]:
        where = "sample"
        s = _as_mapping(s, _SAMPLE_FIELDS, where)
        seq = _uint("seq", _field(s, "seq", where), U32 - 1)
        gap = _uint("gap", _field(s, "gap", where), U32 - 1)
        raw = _field(s, "raw", where)
        d = _field(s, "d", where)
        if not isinstance(raw, (list, tuple)) or len(raw) != self.n_axes:
            raise RecordError(f"sample {seq}: raw needs {self.n_axes} counts, not {raw!r}")
        if not isinstance(d, (list, tuple)) or len(d) != 3:
            raise RecordError(f"sample {seq}: d needs 3 values, not {d!r}")
        return seq, gap, self.samples_spec.row((
            seq, _uint("t_dev_us", _field(s, "t_dev_us", where)),
            _uint("t_host_ns", _field(s, "t_host_ns", where)),
            _uint("dt_us", _field(s, "dt_us", where)), gap,
            _uint("flags", _field(s, "flags", where), 0xFFFF), *raw, *d))

    def _check_seq(self, seq: int, gap: int) -> None:
        """Each accepted sample once and in order (device protocol v1, H3 and H4): a seq that does
        not follow the previous one and its gap means a sample was recorded twice or one was
        skipped by the caller. The row is written all the same; the warning says where."""
        if self.seq_source is None:
            return
        last = self._last_seq
        if self.seq_source == "device":
            expected = gap if last is None else (last + 1 + gap) % U32
        else:
            expected = 0 if last is None else (last + 1) % U32
        self._last_seq = seq
        if seq != expected:
            self.seq_mismatches += 1
            if self.seq_mismatches <= MAX_SEQ_WARNINGS:
                self.event("runtime", "warning", data={
                    "code": "sample_seq", "seq": seq, "expected_seq": expected, "gap": gap,
                    "message": "a sample does not follow the previous one and its gap"})

    # --- pose.tsv --------------------------------------------------------------------------------

    def poses(self, data: Mapping[str, Any], t_host_ns: int | None = None) -> int:
        """A pose.batch message's data ({world, poses}); returns the rows written."""
        t = self._now(t_host_ns)
        world = _field(data, "world", "pose.batch")
        lines = []
        for p in _items(data, "poses", "pose.batch"):
            where = "pose"
            lines.append(POSES_SPEC.row((
                _uint("seq", _field(p, "seq", where), U32 - 1),
                _uint("epoch", _field(p, "epoch", where)),
                _uint("t_dev_us", _field(p, "t_dev_us", where)),
                _field(p, "x", where), _field(p, "feet_y", where), _field(p, "z", where),
                _field(p, "yaw", where), _field(p, "contact", where),
                _field(p, "airborne", where), world, t)))
        for line in lines:
            self._writer.put(POSES, line)
        return len(lines)

    # --- events.jsonl ----------------------------------------------------------------------------

    def event(self, src: str, kind: str, *, data: Mapping[str, Any] | None = None,
              seq: int | None = None, epoch: int | None = None, t_dev_us: int | None = None,
              world: str | None = None, stale: bool = False, t_host_ns: int | None = None) -> None:
        """One event. The stamp (seq, epoch, t_dev_us, world) is that of the sample it belongs
        to, when it has one; data holds its other fields. Events of kind trial_start and trial_end
        need the stamp and data.trial (an integer), trial_end also data.outcome (a name)."""
        if src not in EVENT_SOURCES:
            raise RecordError(f"event source {src!r}: one of {', '.join(EVENT_SOURCES)}")
        if not isinstance(kind, str) or not _KIND.fullmatch(kind):
            raise RecordError(f"event kind {kind!r}: lower-case letters, digits and _")
        record: dict[str, Any] = {"t_host_ns": self._now(t_host_ns), "src": src, "kind": kind}
        for name, value in (("seq", seq), ("epoch", epoch), ("t_dev_us", t_dev_us)):
            if value is not None:
                record[name] = _uint(name, value, U32 - 1 if name == "seq" else None)
        if world is not None:
            if not isinstance(world, str) or not world:
                raise RecordError(f"world {world!r} is not an id")
            record["world"] = world
        if stale:
            record["stale"] = True
        if data:
            if not isinstance(data, Mapping):
                raise RecordError(f"event data: {type(data).__name__} is not an object")
            record["data"] = dict(data)
        if kind in ("trial_start", "trial_end"):
            self._check_trial_event(record)
        line = json_line(record)
        with self._lock:
            self._writer.put(EVENTS, line)
            self._trials.event(record)

    @staticmethod
    def _check_trial_event(record: Mapping[str, Any]) -> None:
        kind = record["kind"]
        missing = [name for name in ("seq", "epoch", "t_dev_us") if name not in record]
        if missing:
            raise RecordError(f"{kind}: needs the stamp of its sample (no {', '.join(missing)})")
        data = record.get("data") or {}
        _uint(f"{kind} data.trial", data.get("trial"))
        if kind == "trial_end":
            outcome = data.get("outcome")
            if not isinstance(outcome, str) or not _OUTCOME_NAME.fullmatch(outcome):
                raise RecordError(f"trial_end data.outcome {outcome!r}: a name from the"
                                  " experiment file (letters, digits and _)")

    def motion_event(self, data: Mapping[str, Any], t_host_ns: int | None = None, *,
                     stale: bool = False) -> None:
        """An event message's data from the motion worker: kind, its stamp, its own fields."""
        if not isinstance(data, Mapping):
            raise RecordError(f"event: {type(data).__name__} is not an object")
        rest = {k: v for k, v in data.items() if k != "kind" and k not in _STAMP}
        self.event("motion", _field(data, "kind", "event"), data=rest, seq=data.get("seq"),
                   epoch=data.get("epoch"), t_dev_us=data.get("t_dev_us"), world=data.get("world"),
                   stale=stale, t_host_ns=t_host_ns)

    # --- render reports: frames.tsv, longtasks.jsonl, events.jsonl -------------------------------

    def render_report(self, data: Mapping[str, Any], t_host_ns: int | None = None) -> None:
        """A render.report message's data. frames and long_tasks go to their files; every other
        kind (ready, clock, or one a later minor version adds) goes to events.jsonl, src render."""
        t = self._now(t_host_ns)
        kind = _field(data, "kind", "render.report")
        origin = _uint("time_origin_us", _field(data, "time_origin_us", "render.report"))
        if kind == "frames":
            self._frames(data, origin, t)
        elif kind == "long_tasks":
            self._long_tasks(data, origin, t)
        else:
            self.event("render", kind, data={k: v for k, v in data.items() if k != "kind"},
                       t_host_ns=t)
            if kind == "ready" and self._on_ready is not None:
                self._on_ready(data, t)

    def _frames(self, data: Mapping[str, Any], origin: int, t: int) -> None:
        world = _field(data, "world", "render.report frames")
        lines = []
        for f in _items(data, "frames", "render.report frames"):
            where = "frame"
            flags = _uint("flags", _field(f, "flags", where), 0xFF)
            lines.append(FRAMES_SPEC.row((
                _uint("frame", _field(f, "frame", where)),
                _uint("t_raf_us", _field(f, "t_raf_us", where)),
                _uint("t_start_us", _field(f, "t_start_us", where)),
                _uint("t_end_us", _field(f, "t_end_us", where)),
                _uint("epoch", _field(f, "epoch", where)),
                _opt_uint("seq", f.get("seq"), U32 - 1),
                _opt_uint("seq_next", f.get("seq_next"), U32 - 1),
                _opt_uint("t_dev_us", f.get("t_dev_us")), flags,
                *(bool(flags >> bit & 1) for bit in range(5)), world, origin, t)))
        for line in lines:
            self._writer.put(FRAMES, line)

    def _long_tasks(self, data: Mapping[str, Any], origin: int, t: int) -> None:
        lines = []
        for e in _items(data, "entries", "render.report long_tasks"):
            where = "long task"
            entry: dict[str, Any] = {"type": _field(e, "entry", where)}
            if "name" in e:
                entry["name"] = e["name"]
            entry["start_us"] = _uint("t_start_us", _field(e, "t_start_us", where))
            entry["duration_us"] = _uint("duration_us", _field(e, "duration_us", where))
            for name in _LONG_TASK_EXTRA:
                if name in e:
                    entry[name] = _uint(name, e[name])
            entry["time_origin_us"] = origin
            entry["t_host_ns"] = t
            if not isinstance(entry["type"], str):
                raise RecordError(f"long task entry {entry['type']!r} is not a name")
            lines.append(json_line(entry))
        for line in lines:
            self._writer.put(LONG_TASKS, line)

    # --- commands.jsonl --------------------------------------------------------------------------

    def command(self, record: Mapping[str, Any], t_host_ns: int | None = None) -> None:
        """One command, ack, output request or outcome, with the fields of docs/data-format-v1.md,
        section 6: src, kind and cmd_id always; a reward request also action "reward" and
        width_us; an outcome also outcome. Record a request before sending it, so that its outcome
        never comes first (trials.tsv matches an outcome to a request recorded before it)."""
        if not isinstance(record, Mapping):
            raise RecordError(f"command: {type(record).__name__} is not an object")
        unknown = sorted(set(record) - _COMMAND_FIELDS)
        if unknown:
            raise RecordError(f"command: unknown fields {', '.join(unknown)} (put them in data)")
        src, kind = record.get("src"), record.get("kind")
        if src not in _COMMAND_SOURCES:
            raise RecordError(f"command src {src!r}: one of {', '.join(_COMMAND_SOURCES)}")
        if kind not in COMMAND_KINDS:
            raise RecordError(f"command kind {kind!r}: one of {', '.join(COMMAND_KINDS)}")
        if "cmd_id" not in record:
            raise RecordError("command: no cmd_id")
        for name in _COMMAND_INTS:
            if name in record:
                _uint(name, record[name], U32 - 1 if name in ("seq", "apply_seq",
                                                                "applied_seq") else None)
        if kind == "outcome" and record.get("outcome") not in OUTCOMES:
            raise RecordError(f"outcome {record.get('outcome')!r}: one of {', '.join(OUTCOMES)}")
        if "timing" in record and record["timing"] not in TIMING_CLASSES:
            raise RecordError(f"timing {record['timing']!r}: one of {', '.join(TIMING_CLASSES)}")
        if kind == "request" and record.get("action") == "reward" and "width_us" not in record:
            raise RecordError("reward request: no width_us (the commanded pulse width)")
        out: dict[str, Any] = {"t_host_ns": self._now(t_host_ns)}
        out.update((name, record[name]) for name in COMMANDS_SPEC.names if name in record)
        line = json_line(out)
        with self._lock:
            self._writer.put(COMMANDS, line)
            self._trials.command(out)

    # --- the end ---------------------------------------------------------------------------------

    @property
    def errors(self) -> list[str]:
        return list(self._writer.errors)

    def close(self, timeout_s: float | None = 10.0) -> dict[str, Any]:
        """Write the remaining trial rows, then every waiting line; flush, fsync and close every
        file. Returns what the session record keeps about the recording. Idempotent."""
        with self._lock:
            if not self._closed:
                self._closed = True
                self._trials.close()
        finished = self._writer.close(timeout_s)
        if self._summary is None:
            files = {name: {"rows": self._writer.lines(name), "dropped": self._writer.dropped(name)}
                     for name in self._writer.names}
            self._summary = {
                "flush_interval_s": self._writer.flush_interval_s,
                "files": files,
                "late": self._writer.late,
                "seq_mismatches": self.seq_mismatches,
                "rewards_outside_trials": self._trials.rewards_outside_trials,
                "trial_warnings": self._trials.warning_count,
                "errors": self.errors if finished else self.errors + ["writer did not finish"],
            }
        return self._summary


# --- free-disk preflight --------------------------------------------------------------------------

def _row_bytes(line: str) -> int:
    return len(line.encode("utf-8"))


def estimate_bytes_per_hour(*, period_us: int, n_axes: int,
                            frame_hz: float = PREFLIGHT_FRAME_HZ) -> int:
    """Bytes a session writes per hour, estimated from rows of the session's own formats: per
    sample a samples.tsv row, a pose.tsv row and a raw-line log line, per frame a frames.tsv row.
    The rows hold long values of a long session: a seq of 8 digits (8 hours at 1,000 samples per
    second), device times of 11 digits, session-clock times of 16 digits (perf_counter_ns some days
    after boot), counts of 4 characters and running totals of 11, and floats of 20 characters,
    such as -0.24430000000000002 (-7 counts times the cm per count of rigs/sim.json). Events,
    commands and trials add little and are not counted."""
    seq, t_us, t_ns, count, total = 28_800_000, 10 ** 10, 10 ** 15, -123, -2147483648
    value = -0.24430000000000002
    sample = samples_spec(n_axes).row((seq, t_us, t_ns, period_us, 0, 0, *[count] * n_axes,
                                       value, value, value))
    pose = POSES_SPEC.row((seq, 99, t_us, value, value, value, value, False, False, "w" * 16,
                           t_ns))
    raw_line = (f"{t_ns}\tS,{seq},{t_us % (1 << 32)},{period_us},0,"
                + ",".join([str(total)] * n_axes) + "*FF\n")
    frame = FRAMES_SPEC.row((10 ** 6, t_us, t_us, t_us, 99, seq, seq, t_us, 0, False, False,
                             False, False, False, "w" * 16, t_ns, t_ns))
    per_sample = _row_bytes(sample) + _row_bytes(pose) + _row_bytes(raw_line)
    samples_per_hour = 3600e6 / period_us
    return math.ceil(per_sample * samples_per_hour + _row_bytes(frame) * frame_hz * 3600)


class PreflightError(RecordError):
    """The data root has no room for the session."""


def disk_preflight(data_root: str | Path, *, period_us: int, n_axes: int,
                   hours: float = PREFLIGHT_HOURS) -> dict[str, Any]:
    """Check that the data root has room for `hours` of this session's data; PreflightError if
    not. Returns the numbers for the session record."""
    per_hour = estimate_bytes_per_hour(period_us=period_us, n_axes=n_axes)
    free = shutil.disk_usage(data_root).free
    result = {"free_bytes": free, "estimate_bytes_per_hour": per_hour, "hours_required": hours,
              "hours_available": round(free / per_hour, 1)}
    if free < per_hour * hours:
        raise PreflightError(
            f"the data root {data_root} has {free / 1e9:.2f} GB free, but a session at"
            f" {1e6 / period_us:g} samples per second writes about {per_hour / 1e9:.3f} GB per"
            f" hour, and a session is armed only with room for {hours:g} h of its data"
            f" ({per_hour * hours / 1e9:.2f} GB)")
    return result
