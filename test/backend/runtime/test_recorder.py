"""The session recorder (plan item DPR-07): a header with units in every table, integer device
times, one samples.tsv row per sample in the order received, floats that read back exactly, poses,
events, commands and render reports from the link protocol's messages, trials.tsv with commanded
against acknowledged reward, the writer's flush about every second, and the free-disk preflight.

Crash durability (kills) and recording through a render stall are in test_recorder_crash.py and
test_recorder_stall.py.
"""
import json
import math
import os
import random
import shutil
import struct
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace

import pytest

from threemaze.devices.simulated import SimulatedDevice
from threemaze.link.validate import link_errors
from threemaze.record import (DataFileError, PreflightError, RecordError, SessionRecorder,
                              estimate_bytes_per_hour, read_log, read_table)
from threemaze.record import formats, recorder as recorder_module
from threemaze.record.formats import (COMMANDS, EVENTS, FRAMES, LONG_TASKS, POSES, SAMPLES,
                                      TRIALS)
from threemaze.runtime import Session, SessionError, TaskSource

REPO = Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "protocol" / "v1" / "examples"
ALL_FILES = (SAMPLES, POSES, FRAMES, TRIALS, EVENTS, COMMANDS, LONG_TASKS)


def example(name):
    message = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
    assert link_errors(message) == [], name
    return message["data"]


class FakeClock:
    def __init__(self):
        self.t = 1_000_000

    def now_ns(self):
        self.t += 1000
        return self.t


@pytest.fixture
def rec(tmp_path):
    """rec(n_axes=4, **kw) -> a recorder on a fresh folder, closed when the test ends."""
    made = []

    def make(n_axes=4, **kwargs):
        folder = tmp_path / f"session{len(made)}"
        folder.mkdir()
        kwargs.setdefault("clock", FakeClock())
        recorder = SessionRecorder(folder, n_axes=n_axes, **kwargs)
        made.append(recorder)
        return recorder

    yield make
    for recorder in made:
        recorder.close()


def sample(seq, t_host_ns=None, **fields):
    s = {"seq": seq, "t_dev_us": 1_000_000 + 4000 * seq, "t_host_ns": t_host_ns or 10 ** 9 + seq,
         "dt_us": 4000, "gap": 0, "flags": 0, "raw": [seq, -seq, 3, 0],
         "d": [0.1 * seq, -0.0, 1e-3]}
    s.update(fields)
    return s


# --- headers, units, integer device time ----------------------------------------------------------

UNITLESS = {"seq", "epoch", "gap", "flags", "frame", "seq_next", "contact", "airborne", "world",
            "blank", "frozen", "hidden", "context_lost", "post_ready_rise", "trial", "start_seq",
            "start_epoch", "end_seq", "end_epoch", "outcome", "ended", "rewards_requested",
            "rewards_done", "rewards_truncated", "rewards_refused", "rewards_failed",
            "rewards_unresolved"}


def test_every_table_has_a_header_and_every_log_exists(rec):
    recorder = rec(n_axes=3)
    summary = recorder.close()
    assert sorted(summary["files"]) == sorted(ALL_FILES)
    for name in (SAMPLES, POSES, FRAMES, TRIALS):
        table = read_table(recorder.folder / name)
        assert table.rows == [] and not table.partial
        assert table.columns == list(formats.table_spec(name, table.columns).names)
    assert read_table(recorder.folder / SAMPLES).columns == [
        "seq", "t_dev_us", "t_host_ns", "dt_us", "gap", "flags", "raw_0_counts", "raw_1_counts",
        "raw_2_counts", "d_fwd_cm", "d_left_cm", "d_yaw_rad"]
    for name in (EVENTS, COMMANDS, LONG_TASKS):
        assert (recorder.folder / name).read_bytes() == b""


@pytest.mark.parametrize("spec", [formats.samples_spec(16), formats.POSES_SPEC,
                                  formats.FRAMES_SPEC, formats.TRIALS_SPEC], ids=lambda s: s.file)
def test_units_in_column_names_and_integer_times(spec):
    for column in spec.columns:
        if column.unit is None:
            assert column.name in UNITLESS, f"{spec.file}: {column.name} needs a unit"
        else:
            assert column.name.endswith(f"_{column.unit}"), column.name
        if column.unit in ("us", "ns"):
            assert column.kind == "int", f"{spec.file}: {column.name} is a time, so an integer"
    assert len(set(spec.names)) == len(spec.names)


def test_device_time_must_be_an_integer(rec):
    recorder = rec()
    with pytest.raises(RecordError, match="t_dev_us"):
        recorder.sample(sample(0, t_dev_us=1_000_000.0))
    with pytest.raises(RecordError, match="t_dev_us"):
        recorder.poses({"world": "w", "poses": [
            {"seq": 0, "epoch": 0, "t_dev_us": 1.5, "x": 0, "feet_y": 0, "z": 0, "yaw": 0,
             "contact": False, "airborne": False}]})
    recorder.close()
    assert read_table(recorder.folder / SAMPLES).rows == []
    assert read_table(recorder.folder / POSES).rows == []


# --- samples.tsv ----------------------------------------------------------------------------------

def test_one_row_per_sample_in_the_order_received(rec):
    """The golden samples of device protocol v1, section 11.1, as the link protocol carries them
    (examples/sample.batch--v1-device.json), each with its receive time."""
    recorder = rec(seq_source="device")
    batch = example("sample.batch--v1-device.json")["samples"]
    recorder.samples({**s, "t_host_ns": 5_000_000 + 1000 * i} for i, s in enumerate(batch))
    summary = recorder.close()
    rows = read_table(recorder.folder / SAMPLES).rows
    assert [r["seq"] for r in rows] == [0, 1, 2, 5]
    for row, s, i in zip(rows, batch, range(4)):
        assert row["t_host_ns"] == 5_000_000 + 1000 * i
        assert (row["t_dev_us"], row["dt_us"], row["gap"], row["flags"]) == (
            s["t_dev_us"], s["dt_us"], s["gap"], s["flags"])
        assert [row[f"raw_{j}_counts"] for j in range(4)] == s["raw"]
        assert [row["d_fwd_cm"], row["d_left_cm"], row["d_yaw_rad"]] == s["d"]
    assert summary["files"][SAMPLES]["rows"] == 4 and summary["seq_mismatches"] == 0
    assert read_log(recorder.folder / EVENTS).records == []


def test_legacy_samples_numbered_by_the_host(rec):
    recorder = rec(n_axes=3, seq_source="host")
    batch = example("sample.batch--legacy-v0.3.json")["samples"]
    recorder.samples({**s, "t_host_ns": 7 + i} for i, s in enumerate(batch))
    recorder.close()
    rows = read_table(recorder.folder / SAMPLES).rows
    assert [(r["seq"], r["gap"], r["flags"]) for r in rows] == [
        (s["seq"], s["gap"], s["flags"]) for s in batch]
    assert rows[2]["d_yaw_rad"] == -0.15000000000000002  # -3 x 0.05 in double precision
    assert read_log(recorder.folder / EVENTS).records == []


@pytest.mark.parametrize("seq_source, seqs, gaps, warned", [
    ("device", [0, 1, 1, 2], [0, 0, 0, 0], [(2, 1)]),                 # recorded twice
    ("device", [0, 1, 4], [0, 0, 1], [(3, 4)]),                       # a sample left out
    ("device", [3, 4], [3, 0], []),                                   # losses before the first
    ("device", [4294967295, 0, 2], [4294967295, 0, 1], []),           # seq wraps; 1 lost
    ("host", [0, 1, 3], [0, 0, 2], [(2, 3)]),                         # host seq ignores gaps
], ids=["twice", "left-out", "first-gap", "wrap", "host"])
def test_a_sample_that_does_not_follow_is_written_and_warned(rec, seq_source, seqs, gaps, warned):
    """Rules H3 and H4: seq follows the previous seq and the gap (the first sample's gap is its
    seq); a host numbers every sample it accepts."""
    recorder = rec(n_axes=4, seq_source=seq_source)
    for seq, gap in zip(seqs, gaps):
        recorder.sample(sample(seq, gap=gap))
    summary = recorder.close()
    assert [r["seq"] for r in read_table(recorder.folder / SAMPLES).rows] == seqs
    warnings = [r["data"] for r in read_log(recorder.folder / EVENTS).records]
    assert [(w["code"], w["expected_seq"], w["seq"]) for w in warnings] == [
        ("sample_seq", expected, seq) for expected, seq in warned]
    assert summary["seq_mismatches"] == len(warned)


@pytest.mark.parametrize("change, message", [
    ({"raw": [1, 2, 3]}, "raw needs 4"),
    ({"d": [0.0, 0.0]}, "d needs 3"),
    ({"seq": 2 ** 32}, "seq"),
    ({"gap": -1}, "gap"),
    ({"flags": 70000}, "flags"),
    ({"d": [math.nan, 0.0, 0.0]}, "not a finite number"),
    ({"d": [math.inf, 0.0, 0.0]}, "not a finite number"),
    ({"raw": [1, True, 3, 4]}, "raw_1_counts"),
    ({"t_host_ns": -5}, "t_host_ns"),
    ({"t_host_ns": None}, "no t_host_ns"),
])
def test_a_sample_that_cannot_be_recorded_is_refused_whole(rec, change, message):
    recorder = rec()
    bad = {**sample(0), **change}
    if bad["t_host_ns"] is None:
        del bad["t_host_ns"]
    with pytest.raises(RecordError, match=message):
        recorder.sample(bad)
    recorder.close()
    assert read_table(recorder.folder / SAMPLES).rows == []


def test_a_batch_with_a_sample_that_cannot_be_recorded_writes_none(rec):
    recorder = rec(seq_source="device")
    with pytest.raises(RecordError, match="raw needs 4"):
        recorder.samples([sample(0), sample(1), sample(2, raw=[0])])
    recorder.samples([sample(0), sample(1)])
    summary = recorder.close()
    assert [r["seq"] for r in read_table(recorder.folder / SAMPLES).rows] == [0, 1]
    assert summary["seq_mismatches"] == 0


@dataclass(frozen=True, slots=True)
class DeviceSample:
    """A reader's own record type, with the device sample's fields as attributes."""

    seq: int
    t_dev_us: int
    dt_us: int
    raw: tuple[int, ...]
    d: tuple[float, float, float]
    flags: int
    gap: int
    t_host_ns: int


def test_a_sample_with_attributes_is_recorded_like_a_mapping(rec):
    recorder = rec(seq_source="device")
    as_object = {**sample(1), "raw": tuple(sample(1)["raw"]), "d": tuple(sample(1)["d"])}
    recorder.samples([sample(0), DeviceSample(**as_object)])
    with pytest.raises(RecordError, match="sample: SimpleNamespace has no gap"):
        recorder.sample(SimpleNamespace(**{k: v for k, v in sample(2).items() if k != "gap"}))
    recorder.close()
    lines = (recorder.folder / SAMPLES).read_text(encoding="utf-8").splitlines()
    expected = formats.samples_spec(4).row(
        [as_object[k] for k in ("seq", "t_dev_us", "t_host_ns", "dt_us", "gap", "flags")]
        + [*as_object["raw"], *as_object["d"]])
    assert len(lines) == 3 and lines[2] + "\n" == expected


# --- floats ---------------------------------------------------------------------------------------

def random_doubles(n, seed=7):
    rng = random.Random(seed)
    values = [0.0, -0.0, 0.1, 0.1 + 0.2, 1 / 3, -71.4752, 0.24430000000000002, 5e-324,
              2.2250738585072014e-308, 1.7976931348623157e308, -1e-300, 123456789.0, 2.0 ** 53]
    while len(values) < n:
        value = struct.unpack("<d", rng.getrandbits(64).to_bytes(8, "little"))[0]
        if math.isfinite(value):
            values.append(value)
    return values


def same_double(a, b):
    return struct.pack("<d", a) == struct.pack("<d", b)


def shortest(value):
    """The shortest decimal that reads back as the same double: fewer significant digits never
    do (Python's repr finds it; this checks it independently of repr)."""
    for digits in range(1, 18):
        if float(f"{value:.{digits - 1}e}") == value:
            return digits
    raise AssertionError(value)


def significant_digits(text):
    mantissa = text.lower().split("e")[0].lstrip("-").replace(".", "").lstrip("0")
    return len(mantissa.rstrip("0")) or 1


def test_every_float_reads_back_as_the_value_written(rec):
    recorder = rec(n_axes=4)
    values = random_doubles(3000)
    triples = [values[i:i + 3] for i in range(0, len(values) - 2, 3)]
    for seq, d in enumerate(triples):
        recorder.sample(sample(seq, d=d, raw=[d[0], seq, -seq, 0]))
    poses = [{"seq": k, "epoch": 0, "t_dev_us": k, "x": d[0], "feet_y": d[1], "z": d[2],
              "yaw": d[0], "contact": k % 2 == 0, "airborne": False} for k, d in enumerate(triples)]
    recorder.poses({"world": "w", "poses": poses})
    recorder.event("runtime", "warning", data={"values": values})
    recorder.close()
    rows = read_table(recorder.folder / SAMPLES).rows
    assert len(rows) == len(triples)
    for row, d in zip(rows, triples):
        got = [row["d_fwd_cm"], row["d_left_cm"], row["d_yaw_rad"], row["raw_0_counts"]]
        assert all(same_double(a, b) for a, b in zip(got, [*d, d[0]])), (got, d)
    # ... in the shortest round-trip form (plan item DPR-07), not merely a form that reads back
    lines = (recorder.folder / SAMPLES).read_text(encoding="utf-8").splitlines()[1:]
    for line, d in zip(lines, triples):
        for text, value in zip(line.split("\t")[-3:], d):
            assert significant_digits(text) == shortest(value), (text, value)
    assert lines[0].split("\t")[-3:] == ["0.0", "-0.0", "0.1"]
    for row, d in zip(read_table(recorder.folder / POSES).rows, triples):
        assert all(same_double(a, b) for a, b in zip(
            [row["x_cm"], row["feet_y_cm"], row["z_cm"], row["yaw_rad"]], [*d, d[0]]))
    logged = read_log(recorder.folder / EVENTS).records[0]["data"]["values"]
    assert all(same_double(a, b) for a, b in zip(logged, values)) and len(logged) == len(values)


def test_whole_numbers_from_javascript_are_floats_in_float_columns(rec):
    """JSON.stringify writes 0.0 as 0, so a pose's x can arrive as an int."""
    recorder = rec()
    recorder.poses({"world": "w", "poses": [{"seq": 0, "epoch": 0, "t_dev_us": 0, "x": 0,
                                             "feet_y": -2, "z": 2 ** 53, "yaw": 0,
                                             "contact": False, "airborne": True}]})
    with pytest.raises(RecordError, match="does not fit a double"):
        recorder.poses({"world": "w", "poses": [{"seq": 1, "epoch": 0, "t_dev_us": 0, "x": 0,
                                                 "feet_y": 0, "z": 2 ** 53 + 1, "yaw": 0,
                                                 "contact": False, "airborne": False}]})
    recorder.close()
    text = (recorder.folder / POSES).read_text(encoding="utf-8").splitlines()[1]
    assert text.split("\t")[3:9] == ["0.0", "-2.0", "9007199254740992.0", "0.0", "0", "1"]


def test_numpy_floats_are_written_as_plain_numbers(rec):
    """numpy 2, pinned in requirements.txt, prints a numpy.float64 as np.float64(0.1): a caller
    that computes d or a pose with numpy must still get a table that reads back the same doubles."""
    np = pytest.importorskip("numpy")
    recorder = rec(n_axes=3, seq_source="device")
    raw = [3, -2, 1]
    d = [np.float64(0.0349) * raw[1], np.float64(0.0349) * raw[0], np.float64(0.05) * raw[2]]
    assert all(type(value) is np.float64 for value in d)
    recorder.sample(sample(0, raw=raw, d=d))
    recorder.poses({"world": "w", "poses": [
        {"seq": 0, "epoch": 0, "t_dev_us": 0, "x": d[0], "feet_y": np.float64(-0.0), "z": d[1],
         "yaw": d[2], "contact": False, "airborne": False}]})
    recorder.close()
    assert "np." not in (recorder.folder / SAMPLES).read_text(encoding="utf-8")
    row = read_table(recorder.folder / SAMPLES).rows[0]
    assert all(same_double(a, b) for a, b in zip(
        [row["d_fwd_cm"], row["d_left_cm"], row["d_yaw_rad"]], d))
    pose = read_table(recorder.folder / POSES).rows[0]
    assert all(same_double(a, b) for a, b in zip(
        [pose["x_cm"], pose["feet_y_cm"], pose["z_cm"], pose["yaw_rad"]], [d[0], -0.0, *d[1:]]))


# --- poses, events, render reports ----------------------------------------------------------------

def test_poses_events_and_render_reports_from_the_protocol_examples(rec):
    recorder = rec()
    pose_batch = example("pose.batch.json")
    assert recorder.poses(pose_batch, t_host_ns=11) == 3
    events = ["event--zone-enter.json", "event--zone-exit-teleport.json", "event--fall.json",
              "event--land.json", "event--teleport-applied.json", "event--seq-gap.json",
              "event--guard.json"]
    for name in events:
        recorder.motion_event(example(name), t_host_ns=12)
    for name in ("render.report--ready.json", "render.report--frames.json",
                 "render.report--long-tasks.json", "render.report--clock.json"):
        recorder.render_report(example(name), t_host_ns=13)
    recorder.close()

    poses = read_table(recorder.folder / POSES).rows
    assert [(p["seq"], p["epoch"], p["z_cm"], p["world"], p["t_host_ns"]) for p in poses] == [
        (p["seq"], p["epoch"], p["z"], "hallway", 11) for p in pose_batch["poses"]]

    logged = read_log(recorder.folder / EVENTS).records
    for record, name in zip(logged, events):
        data = example(name)
        assert record["src"] == "motion" and record["t_host_ns"] == 12
        assert {k: record[k] for k in ("kind", "seq", "epoch", "t_dev_us", "world")} == {
            k: data[k] for k in ("kind", "seq", "epoch", "t_dev_us", "world")}
        rest = {k: v for k, v in data.items() if k not in ("kind", "seq", "epoch", "t_dev_us",
                                                           "world")}
        assert record.get("data", {}) == rest
    ready, clock = logged[len(events):]
    assert (ready["src"], ready["kind"], ready["data"]["host"]) == ("render", "ready", "main")
    assert (clock["kind"], clock["data"]["pass"]) == ("clock", True)

    frames = read_table(recorder.folder / FRAMES).rows
    sent = example("render.report--frames.json")
    assert [f["frame"] for f in frames] == [486, 487, 488]
    for row, f in zip(frames, sent["frames"]):
        assert (row["raf_us"], row["entry_us"], row["exit_us"], row["seq"], row["seq_next"],
                row["t_dev_us"], row["flags"]) == (f["t_raf_us"], f["t_start_us"], f["t_end_us"],
                                                   f["seq"], f.get("seq_next"), f["t_dev_us"],
                                                   f["flags"])
        assert row["time_origin_us"] == sent["time_origin_us"] and row["world"] == "hallway"
    assert frames[2]["frozen"] and not frames[2]["blank"] and frames[2]["seq_next"] is None

    tasks = read_log(recorder.folder / LONG_TASKS).records
    sent = example("render.report--long-tasks.json")["entries"]
    assert [(t["type"], t["name"], t["start_us"], t["duration_us"]) for t in tasks] == [
        (e["entry"], e["name"], e["t_start_us"], e["duration_us"]) for e in sent]
    assert tasks[1]["blocking_us"] == 24800 and "blocking_us" not in tasks[0]


def test_frame_flags_split_into_columns(rec):
    recorder = rec()
    recorder.render_report({"kind": "frames", "time_origin_us": 5, "world": "w", "frames": [
        {"frame": k, "t_raf_us": k, "t_start_us": k, "t_end_us": k, "epoch": 0, "flags": 1 << k}
        for k in range(5)]})
    recorder.close()
    rows = read_table(recorder.folder / FRAMES).rows
    for k, row in enumerate(rows):
        assert [row[name] for name in formats.FRAME_FLAG_COLUMNS] == [b == k for b in range(5)]
        assert row["seq"] is None and row["t_dev_us"] is None


def test_events_in_the_order_received_with_stamps_and_stale(rec):
    recorder = rec()
    recorder.event("runtime", "state", data={"state": "running"}, t_host_ns=1)
    recorder.motion_event({"kind": "fall", "seq": 9, "epoch": 1, "t_dev_us": 90, "world": "w"},
                          t_host_ns=2, stale=True)
    recorder.event("device", "lick", seq=10, t_dev_us=95, data={"channel": 0, "level": 1})
    recorder.close()
    records = read_log(recorder.folder / EVENTS).records
    assert records == [
        {"t_host_ns": 1, "src": "runtime", "kind": "state", "data": {"state": "running"}},
        {"t_host_ns": 2, "src": "motion", "kind": "fall", "seq": 9, "epoch": 1, "t_dev_us": 90,
         "world": "w", "stale": True},
        {"t_host_ns": records[2]["t_host_ns"], "src": "device", "kind": "lick", "seq": 10,
         "t_dev_us": 95, "data": {"channel": 0, "level": 1}}]


POSE = {"seq": 0, "epoch": 0, "t_dev_us": 0, "x": 0.0, "feet_y": 0.0, "z": 0.0, "yaw": 0.0,
        "contact": False, "airborne": False}
FRAME = {"frame": 0, "t_raf_us": 1, "t_start_us": 1, "t_end_us": 2, "epoch": 0, "flags": 0}


def frames_report(world="w", **frame):
    return {"kind": "frames", "time_origin_us": 5, "world": world, "frames": [{**FRAME, **frame}]}


def trial_end(outcome):
    return {"seq": 1, "epoch": 0, "t_dev_us": 1, "data": {"trial": 0, "outcome": outcome}}


@pytest.mark.parametrize("call, message", [
    (lambda r: r.event("worker", "x"), "event source"),
    (lambda r: r.event("runtime", "Bad Kind"), "event kind"),
    (lambda r: r.event("runtime", "state\n"), "event kind"),
    (lambda r: r.event("runtime", "x", data={"v": math.nan}), "not recordable"),
    (lambda r: r.event("task", "trial_start", data={"trial": 0}), "stamp"),
    (lambda r: r.event("task", "trial_end", **trial_end("two words")), "outcome"),
    (lambda r: r.event("task", "trial_end", **trial_end("rewarded\n")), "outcome"),
    (lambda r: r.poses({"world": "w", "poses": [{"seq": 0}]}), "no epoch"),
    (lambda r: r.poses({"world": "hallway\n", "poses": [POSE]}), "world"),
    (lambda r: r.poses({"world": "w", "poses": None}), "poses is NoneType, not an array"),
    (lambda r: r.render_report({"kind": "frames", "world": "w", "frames": []}), "time_origin_us"),
    (lambda r: r.render_report(frames_report(world="hallway\n")), "world"),
    (lambda r: r.render_report(frames_report(seq=-1)), "seq"),
    (lambda r: r.render_report(frames_report(seq=1, seq_next=2 ** 32)), "seq_next"),
    (lambda r: r.render_report(frames_report(t_dev_us=-4000)), "t_dev_us"),
    (lambda r: r.render_report({"kind": "long_tasks", "time_origin_us": 5, "entries": 3}),
     "entries is int, not an array"),
])
def test_input_that_cannot_be_recorded_raises(rec, call, message):
    recorder = rec()
    with pytest.raises(RecordError, match=message):
        call(recorder)


def test_a_line_end_in_a_name_never_reaches_a_table(rec):
    """Python's $ also matches before a final line end: a world or an outcome ending in one must
    be refused, or its row would be split in two and the whole table would no longer read."""
    recorder = rec()
    task = Task(recorder)
    for call in (lambda: recorder.poses({"world": "hallway\n", "poses": [POSE]}),
                 lambda: recorder.render_report(frames_report(world="hallway\n")),
                 lambda: task.start(0),
                 lambda: task.end(0, "rewarded\n")):
        try:
            call()
        except RecordError:
            pass
    recorder.poses({"world": "hallway", "poses": [POSE]})
    recorder.render_report(frames_report())
    task.end(0, "rewarded")
    recorder.close()
    assert [p["world"] for p in read_table(recorder.folder / POSES).rows] == ["hallway"]
    assert [f["world"] for f in read_table(recorder.folder / FRAMES).rows] == ["w"]
    assert [t["outcome"] for t in read_table(recorder.folder / TRIALS).rows] == ["rewarded"]


# --- commands.jsonl -------------------------------------------------------------------------------

def test_commands_and_acks_logged_with_their_stamps(rec):
    recorder = rec()
    recorder.command({"src": "runtime", "kind": "command", "cmd_id": 3, "action": "teleport",
                      "epoch": 4, "apply_seq": 2028, "data": {"spawn": "start"}}, t_host_ns=5)
    recorder.command({"src": "motion", "kind": "ack", "cmd_id": 3, "epoch": 4,
                      "applied_seq": 2029}, t_host_ns=6)
    recorder.close()
    assert read_log(recorder.folder / COMMANDS).records == [
        {"t_host_ns": 5, "src": "runtime", "kind": "command", "cmd_id": 3, "action": "teleport",
         "epoch": 4, "apply_seq": 2028, "data": {"spawn": "start"}},
        {"t_host_ns": 6, "src": "motion", "kind": "ack", "cmd_id": 3, "epoch": 4,
         "applied_seq": 2029}]


@pytest.mark.parametrize("record, message", [
    ({"src": "motion", "kind": "request", "cmd_id": 1, "action": "reward"}, "width_us"),
    ({"src": "motion", "kind": "outcome", "cmd_id": 1, "outcome": "lost"}, "outcome"),
    ({"src": "motion", "kind": "nack", "cmd_id": 1}, "command kind"),
    ({"src": "renderer", "kind": "ack", "cmd_id": 1}, "command src"),
    ({"src": "motion", "kind": "ack"}, "no cmd_id"),
    ({"src": "motion", "kind": "ack", "cmd_id": -1}, "cmd_id"),
    ({"src": "motion", "kind": "ack", "cmd_id": 1, "spawn": "start"}, "unknown fields spawn"),
    ({"src": "device", "kind": "outcome", "cmd_id": 1, "outcome": "done", "timing": "late"},
     "timing"),
])
def test_a_command_record_that_breaks_the_format_is_refused(rec, record, message):
    recorder = rec()
    with pytest.raises(RecordError, match=message):
        recorder.command(record)


# --- trials.tsv -----------------------------------------------------------------------------------

class Task:
    """Synthetic task events and reward requests; a seq per call."""

    def __init__(self, recorder):
        self.r = recorder
        self.seq = 0
        self.epoch = 0
        self.cmd_id = 0

    def stamp(self):
        self.seq += 1
        return {"seq": self.seq, "epoch": self.epoch, "t_dev_us": 1000 * self.seq}

    def start(self, trial):
        self.r.event("task", "trial_start", data={"trial": trial}, **self.stamp())

    def end(self, trial, outcome="rewarded"):
        self.r.event("task", "trial_end", data={"trial": trial, "outcome": outcome},
                     **self.stamp())
        self.epoch += 1

    def reward(self, width_us=70000, **extra):
        self.cmd_id += 1
        self.r.command({"src": "motion", "kind": "request", "action": "reward",
                        "cmd_id": self.cmd_id, "width_us": width_us, **self.stamp(), **extra})
        return self.cmd_id

    def outcome(self, cmd_id, outcome, width_us=None, **extra):
        record = {"src": "runtime", "kind": "outcome", "cmd_id": cmd_id, "outcome": outcome,
                  **extra}
        if width_us is not None:
            record["width_us"] = width_us
        self.r.command(record)


def trial_rows(recorder):
    return {row["trial"]: row for row in read_table(recorder.folder / TRIALS).rows}


def counts(row):
    return (row["rewards_requested"], row["reward_requested_us"], row["rewards_done"],
            row["rewards_truncated"], row["rewards_refused"], row["rewards_failed"],
            row["rewards_unresolved"], row["reward_delivered_us"])


def test_trials_show_commanded_against_acknowledged_reward(rec):
    recorder = rec()
    task = Task(recorder)
    task.start(0)                                   # trial 0: one reward, acknowledged
    c1 = task.reward()
    task.outcome(c1, "done", 70012, timing="hardware")
    task.end(0)
    task.start(1)                                   # trial 1: the ack is lost
    c2 = task.reward()
    task.end(1)
    task.outcome(c2, "unresolved")
    task.outcome(c2, "done", 70000)                 # a late ack changes nothing (rule H8)
    task.start(2)                                   # trial 2: refused, then one cut short
    task.outcome(task.reward(400000), "refused")
    task.outcome(task.reward(), "truncated", 31000)
    task.end(2, "miss")
    task.start(3)                                   # trial 3: failed; ended by the task
    task.outcome(task.reward(), "failed", 12000)    # a width with a failure: not delivered
    task.end(3)
    task.start(4)                                   # trial 4: open when the session ends
    task.reward()                                   # never answered
    summary = recorder.close()

    rows = trial_rows(recorder)
    assert sorted(rows) == [0, 1, 2, 3, 4]
    assert counts(rows[0]) == (1, 70000, 1, 0, 0, 0, 0, 70012)
    assert counts(rows[1]) == (1, 70000, 0, 0, 0, 0, 1, 0)
    assert counts(rows[2]) == (2, 470000, 0, 1, 1, 0, 0, 31000)
    assert counts(rows[3]) == (1, 70000, 0, 0, 0, 1, 0, 0)
    assert counts(rows[4]) == (1, 70000, 0, 0, 0, 0, 1, 0)
    assert [rows[k]["outcome"] for k in range(5)] == ["rewarded", "rewarded", "miss", "rewarded",
                                                      None]
    assert [rows[k]["ended"] for k in range(5)] == [True, True, True, True, False]
    assert rows[4]["end_seq"] is None and rows[4]["end_t_host_ns"] is None
    assert rows[0]["start_seq"] < rows[0]["end_seq"] < rows[1]["start_seq"]
    assert summary["files"][TRIALS]["rows"] == 5 and summary["rewards_outside_trials"] == 0


def test_a_trial_row_waits_for_the_next_trial_and_for_every_outcome(rec):
    recorder = rec(flush_interval_s=0.05)
    task = Task(recorder)
    task.start(0)
    c1 = task.reward()
    task.end(0)
    task.start(1)
    time.sleep(0.3)                                 # several flush intervals
    assert trial_rows_on_disk(recorder) == []       # trial 0 still waits for its outcome
    task.outcome(c1, "done", 70000)
    task.end(1)
    time.sleep(0.3)
    assert [row["trial"] for row in trial_rows_on_disk(recorder)] == [0]
    recorder.close()
    assert sorted(trial_rows(recorder)) == [0, 1]


def trial_rows_on_disk(recorder):
    return read_table(recorder.folder / TRIALS).rows


def test_reward_attribution(rec):
    recorder = rec()
    task = Task(recorder)
    task.reward()                                   # before the first trial: belongs to none
    task.start(0)
    task.end(0)
    task.reward()                                   # after the end, same dispatch: trial 0
    task.start(1)
    task.reward(trial=0)                            # names trial 0 while trial 1 is open
    task.reward()                                   # trial 1
    task.reward(trial=7)                            # names a trial that never started
    summary = recorder.close()
    rows = trial_rows(recorder)
    assert (rows[0]["rewards_requested"], rows[1]["rewards_requested"]) == (2, 1)
    assert summary["rewards_outside_trials"] == 2 and summary["trial_warnings"] == 1


def test_trial_events_out_of_order_are_ignored_and_counted(rec):
    recorder = rec()
    task = Task(recorder)
    task.end(5)                                     # never started
    task.start(0)
    task.start(0)                                   # twice
    task.end(0)
    task.end(0)                                     # twice
    summary = recorder.close()
    assert list(trial_rows(recorder)) == [0] and summary["trial_warnings"] == 3
    assert len(read_log(recorder.folder / EVENTS).records) == 5  # every event is still logged


# --- the writer -----------------------------------------------------------------------------------

def test_rows_reach_the_disk_within_about_a_second_without_close(rec):
    recorder = rec()
    recorder.sample(sample(0))
    deadline = time.monotonic() + 2  # one flush interval of 1 s, and room for a busy machine
    while time.monotonic() < deadline and not read_table(recorder.folder / SAMPLES).rows:
        time.sleep(0.05)
    assert [r["seq"] for r in read_table(recorder.folder / SAMPLES).rows] == [0]


def test_the_writer_fsyncs_what_it_wrote_about_once_a_second(rec, monkeypatch):
    """Plan item DPR-07: flush and fsync about every second. A killed process loses only what had
    not reached the operating system, so the kill test cannot see a missing fsync; a computer that
    loses power also loses what the operating system had not yet written to the drive."""
    synced = []
    real_fsync = os.fsync

    def fsync(fd):
        synced.append((fd, os.fstat(fd).st_size, time.monotonic()))
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", fsync)
    recorder = rec()
    fd = recorder._writer._files[SAMPLES].fh.fileno()
    header = len(recorder.samples_spec.header())
    assert [size for f, size, _ in synced if f == fd] == [header]  # the header, at creation
    put = time.monotonic()
    recorder.sample(sample(0))
    row = len(recorder.samples_spec.row([0, 1_000_000, 10 ** 9, 4000, 0, 0, 0, 0, 3, 0, 0.0, -0.0,
                                         1e-3]))
    while time.monotonic() < put + 3 and not any(f == fd and size > header
                                                 for f, size, _ in synced):
        time.sleep(0.02)
    after = [(size, t) for f, size, t in synced if f == fd and size > header]
    assert after and after[0][0] == header + row and after[0][1] - put < 2.0


def test_a_line_after_close_is_counted_logged_once_and_not_written(rec, caplog):
    recorder = rec()
    recorder.close()
    recorder.sample(sample(0))
    recorder.poses({"world": "w", "poses": [POSE]})
    assert recorder.close()["late"] == 0  # the summary was made at the first close
    assert recorder._writer.late == 2
    assert caplog.text.count("arrived after the files were closed") == 1
    assert read_table(recorder.folder / SAMPLES).rows == []


def test_a_partial_last_line_is_dropped_and_other_damage_is_an_error(rec):
    recorder = rec()
    recorder.samples(sample(k) for k in range(3))
    recorder.event("runtime", "warning", data={"k": 1})
    recorder.close()
    path = recorder.folder / SAMPLES
    with open(path, "ab") as fh:
        fh.write(b"3\t1012000\t10")                 # cut off by a crash
    table = read_table(path)
    assert table.partial and [r["seq"] for r in table.rows] == [0, 1, 2]
    with open(path, "ab") as fh:
        fh.write(b"\n4\t1016000\n")                  # a damaged line that is not the last
    with pytest.raises(DataFileError, match=r"samples\.tsv:5: 3 cells"):
        read_table(path)
    log_path = recorder.folder / EVENTS
    with open(log_path, "ab") as fh:
        fh.write(b'{"t_host_ns": 5, "src"')
    log = read_log(log_path)
    assert log.partial and len(log.records) == 1
    path.write_bytes(b"")
    with pytest.raises(DataFileError, match="no header"):
        read_table(path)


def test_a_failing_disk_is_reported_and_counted(rec, monkeypatch):
    failures = []
    recorder = rec(on_error=lambda name, exc: failures.append((name, str(exc))))
    handle = recorder._writer._files[SAMPLES].fh

    class Full:
        def __getattr__(self, name):
            return getattr(handle, name)

        def write(self, text):
            raise OSError(28, "No space left on device")

    recorder._writer._files[SAMPLES].fh = Full()
    recorder.samples(sample(k) for k in range(5))
    recorder.event("runtime", "state", data={"state": "running"})
    summary = recorder.close()
    handle.close()
    assert failures == [(SAMPLES, "[Errno 28] No space left on device")]
    assert summary["files"][SAMPLES] == {"rows": 5, "dropped": 5}
    assert summary["errors"] == [f"{SAMPLES}: OSError: [Errno 28] No space left on device"]
    assert len(read_log(recorder.folder / EVENTS).records) == 1  # the other files go on


def test_existing_files_are_never_overwritten(tmp_path):
    (tmp_path / SAMPLES).write_text("keep\n", encoding="utf-8")
    with pytest.raises(FileExistsError):
        SessionRecorder(tmp_path, n_axes=3)
    assert (tmp_path / SAMPLES).read_text(encoding="utf-8") == "keep\n"


# --- the gate analysis reads frames.tsv and longtasks.jsonl ---------------------------------------

def node_that_strips_types():
    """Node 22.6 or newer (tools/timing runs with --experimental-strip-types), or None."""
    node = shutil.which("node")
    if node is None:
        return None
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout
    major, minor = (int(part) for part in version.strip().lstrip("v").split(".")[:2])
    return node if (major, minor) >= (22, 6) else None


def test_the_gate_analysis_reads_the_frame_log_without_conversion(rec, tmp_path):
    """docs/timing/gate-analysis.md, section 2, is the format of frames.tsv and longtasks.jsonl
    (plan item DPR-17: "REN-13 reads the files without conversion"): the recorder's files go
    straight into the gate's command line."""
    node = node_that_strips_types()
    if node is None:
        pytest.skip("needs Node 22.6 or newer on PATH")
    recorder = rec()
    raf, frames = 1_000_000, []
    for k in range(600):
        raf += 50_000 if k == 300 else 16_667      # one late interval: 2 missed frames
        frames.append({"frame": k, "t_raf_us": raf, "t_start_us": raf + 200,
                       "t_end_us": raf + 1200, "epoch": 0, "seq": k, "t_dev_us": 4000 * k,
                       "flags": 4 if k == 400 else 0})  # frame 400: document hidden
    for start in range(0, 600, 60):
        recorder.render_report({"kind": "frames", "time_origin_us": 1792765391123456,
                                "world": "hallway", "frames": frames[start:start + 60]})
    recorder.render_report({"kind": "long_tasks", "time_origin_us": 1792765391123456,
                            "entries": [{"entry": "longtask", "name": "self",
                                         "t_start_us": 4_000_000, "duration_us": 60_000},
                                        {"entry": "handler", "name": "posePort",
                                         "t_start_us": 5_000_000, "duration_us": 40_000}]})
    recorder.close()
    out = tmp_path / "gate.json"
    result = subprocess.run([node, "--experimental-strip-types",
                             "--disable-warning=ExperimentalWarning", "tools/timing/gate.ts",
                             str(recorder.folder), "--out", str(out)],
                            cwd=REPO, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr + result.stdout
    session = json.loads(out.read_text(encoding="utf-8"))["sessions"][0]
    assert session["frames"] == 600
    assert (session["low"]["late"], session["low"]["missed"]) == (1, 2)
    assert session["excludedIntervals"]["hidden"] == 1
    assert session["tasks"]["observed"] and session["tasks"]["byType"] == {"longtask": 1,
                                                                           "handler": 1}
    assert [task["durationMs"] for task in session["tasks"]["g2"]] == [60]


# --- free-disk preflight --------------------------------------------------------------------------

def test_estimate_grows_with_rate_and_axes():
    slow = estimate_bytes_per_hour(period_us=50000, n_axes=3)
    fast = estimate_bytes_per_hour(period_us=1000, n_axes=3)
    wide = estimate_bytes_per_hour(period_us=1000, n_axes=16)
    assert slow < fast < wide
    # At 1 kHz the samples, poses and raw lines alone are some hundreds of MB per hour (the
    # experiment-data design estimated 189 MB per hour for its narrower samples table)
    assert 189e6 < fast < 2e9


def test_preflight_refuses_to_arm_without_room(sim_rig_path, tmp_path, monkeypatch):
    class Usage:
        free = 10 ** 6

    monkeypatch.setattr(recorder_module.shutil, "disk_usage", lambda path: Usage)
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    with pytest.raises(SessionError, match=r"has 0\.00 GB free.*room for 1 h of its data"):
        session.arm()
    assert session.state.value == "aborted"
    with pytest.raises(PreflightError):
        recorder_module.disk_preflight(tmp_path, period_us=1000, n_axes=3)


def test_without_a_sample_period_the_preflight_is_logged_as_skipped(sim_rig_path, tmp_path,
                                                                     monkeypatch, caplog):
    describe = SimulatedDevice.describe
    monkeypatch.setattr(SimulatedDevice, "describe",
                        lambda self: {**describe(self), "period_us": None, "hello": None})
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    session.arm()
    session.abort("test over")
    assert session.preflight is None and session.recording["errors"] == []
    assert "states no sample period, so the free disk space was not checked" in caplog.text


# --- in a session ---------------------------------------------------------------------------------

def test_a_session_opens_its_recorder_and_records_its_states(sim_rig_path, tmp_path):
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    folder = session.arm()
    assert session.recorder is not None and session.preflight["free_bytes"] > 0
    session.start()
    session.stop()
    assert session.recording["errors"] == [] and session.recording["files"][SAMPLES]["rows"] == 0
    for name in ALL_FILES:
        assert (folder / name).is_file(), name
    states = [r["data"]["state"] for r in read_log(folder / EVENTS).records]
    assert states == ["armed", "running", "stopping", "complete"]
    stamps = [r["t_host_ns"] for r in read_log(folder / EVENTS).records]
    assert stamps == [session.anchors[s].perf_ns for s in states]


def test_an_aborted_session_records_why(sim_rig_path, tmp_path):
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    folder = session.arm()
    session.abort("operator pressed stop")
    last = read_log(folder / EVENTS).records[-1]
    assert last["data"] == {"state": "aborted", "reason": "operator pressed stop"}
    assert session.recording is not None and session.recording["errors"] == []
