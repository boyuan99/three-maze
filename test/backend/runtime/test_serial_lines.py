"""The serial reader (plan item DPR-03): threemaze/devices/serial_lines.py and the v1 profile
(threemaze/devices/profiles/v1.py), against docs/protocol/device-v1.md.

Test names carry the rule ids of the protocol's section 9 (RDR-...). The reader is tested on its
golden lines (section 11), on pySerial's loop:// port, on the reference simulated device in
virtual time (every fault type at 20, 250 and 1,000 samples per second) and in real time (in the
runtime's process and behind the end-to-end bench's simulated pySerial port, test/e2e/sim), and
for the hand-off of its records to an asyncio event loop. Nothing here opens a real serial port.
"""
import asyncio
import inspect
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest
import serial

from fakeports import FedPort, VirtualSimPort
from threemaze.api import DeviceContext, DeviceError
from threemaze.config.rig import device_defaults, load_schema
from threemaze.core.records import (DT_ESTIMATED, DT_MISMATCH, DeviceEvent, DeviceMessage,
                                    DeviceSample, Hello, PulseOutcome, StopReport, StreamFault)
from threemaze.devices.profiles.v1 import MAX_LINE, V1Profile, V1Settings, command, crc8
from threemaze.devices.serial_lines import (Line, LineFramer, LineReader, RawLineLog,
                                            SerialLineSource)
from threemaze.devices.sim import SimDevice, config_from_entry, frame
from threemaze.devices.simulated import SimulatedDevice
from threemaze.runtime import Session, SessionError, TaskSource
from threemaze_sim import conformance

REPO = Path(__file__).resolve().parents[3]
U32 = 1 << 32
SENSOR = {"cmPerCount": 0.0349, "radPerCount": 0.05}  # v0.3's mapping, as rigs/sim.json
SIM_MATRIX = [[0, 0.0349, 0], [0.0349, 0, 0], [0, 0, 0.05]]
COUNTER_NAMES = {"lines", "samples", "seq_gaps", "samples_lost", "seq_regressions", "crc_errors",
                 "parse_errors", "overflow", "unknown", "dt_mismatch", "late_events"}

# The example calibration of protocol/v1/examples/sample.batch--v1-device.json for the golden
# 4-axis device of device-v1.md section 11.1: forward = axis 1, left = axis 0, yaw = axis 2
GOLDEN_MATRIX = [[0, 0.0349, 0, 0], [0.0349, 0, 0, 0], [0, 0, 0.002, 0]]
GOLDEN_HELLO = "H,threemaze-device,1.0,ball-01,4000,4,fw=demo-1.2,flags=1,lick=1,fclk=1*D6"

B1_LIKE = {"kind": "segments", "segments": [
    {"durationS": 0.3, "forwardCmPerS": 11.168},
    {"durationS": 0.2, "lick": 1},
    {"durationS": 0.25, "yawDegPerS": 45, "leftCmPerS": 3.0},
    {"durationS": 0.25, "forwardCmPerS": -5.0, "yawDegPerS": -90}]}
RATES = {"20Hz": 50000, "250Hz": 4000, "1000Hz": 1000}


class Clock:
    """Session clock for tests: perf_counter_ns, or ticks of 1000 ns."""

    def __init__(self, ticking=False):
        self.ticking = ticking
        self.t = 0

    def now_ns(self):
        if self.ticking:
            self.t += 1000
            return self.t
        return time.perf_counter_ns()


def golden_profile(**settings):
    defaults = dict(device_id="ball-01", period_us=4000, matrix=GOLDEN_MATRIX)
    return V1Profile(V1Settings(**{**defaults, **settings}))


def accept_hello(profile, line=GOLDEN_HELLO):
    """What open() does with the hello, without a port: parse it and check it (rule H5)."""
    [hello] = profile.parse(line.encode(), 0)
    assert profile.check_hello(hello) == []
    profile.hello = hello
    return hello


def streaming(profile=None):
    profile = profile or golden_profile()
    accept_hello(profile)
    profile.begin_stream()
    return profile


def parse_all(profile, lines, t0=1000):
    out = []
    for n, line in enumerate(lines):
        out += profile.parse(line.encode() if isinstance(line, str) else line, t0 + n)
    return out


def samples(records):
    return [r for r in records if isinstance(r, DeviceSample)]


def s_line(seq, t_us, totals, dt_us=None, flags=0):
    return frame(f"S,{seq},{t_us},{dt_us or 1000},{flags},{','.join(map(str, totals))}")


def without_host_time(record):
    fields = {k: getattr(record, k) for k in record.__slots__ if k != "t_host_ns"}
    return type(record).__name__, tuple(sorted(fields.items()))


def dot(matrix, raw):
    """d = C · raw as section 7.2 fixes it: per row, from 0.0, j ascending, in double precision."""
    out = []
    for row in matrix:
        acc = 0.0
        for c, r in zip(row, raw):
            acc += float(c) * r
        out.append(acc)
    return tuple(out)


def wait_for(condition, timeout_s=10.0):
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.005)


def last_totals(raw_log, seq):
    """The running totals of sample seq, from a raw-line log."""
    marker = b"\tS," + str(seq).encode() + b","
    [line] = [line for line in raw_log.read_bytes().splitlines() if marker in line]
    return [int(v) for v in line.split(b"*")[0].split(b",")[5:]]


def raw_sum(got):
    totals = None
    for s in got:
        totals = list(s.raw) if totals is None else [a + b for a, b in zip(totals, s.raw)]
    return totals


# --- golden lines (device-v1.md section 11) ----------------------------------------------------

def test_rdr_f3_crc8_and_commands_match_the_golden_lines():
    assert crc8(b"123456789") == 0xF4
    for record, line in [("hello", "hello*92"), ("start", "start*3F"), ("stop", "stop*A5"),
                         ("beat", "beat*D7"), ("pulse,1,0,70000", "pulse,1,0,70000*63"),
                         ("pulse,2,0,900000", "pulse,2,0,900000*BF")]:
        assert command(record) == line.encode() + b"\n"


def test_rdr_d1_hello_parsed():
    profile = golden_profile()
    [hello] = profile.parse(GOLDEN_HELLO.encode(), 7)
    assert hello == Hello("threemaze-device", "1.0", "ball-01", 4000, 4,
                          {"fw": "demo-1.2", "flags": "1", "lick": "1", "fclk": "1"}, 7,
                          GOLDEN_HELLO[:-3])
    [valve] = profile.parse(b"H,threemaze-device,1.0,valve-01,0,0,out=1,ack=1,hb=300*2C", 8)
    assert (valve.device_id, valve.period_us, valve.n_axes, dict(valve.keys)) == (
        "valve-01", 0, 0, {"out": "1", "ack": "1", "hb": "300"})


GOLDEN_STREAM = ["S,0,1000000,4000,0,12,-1,35,3*37", "L,0,1002500,1*D5",
                 "S,1,1004000,4000,0,22,-1,65,5*A2", "F,1,1006100*71",
                 "S,2,1008000,4000,1,-2026,6,65,5*F2", "S,5,1020000,4000,0,-2010,6,90,7*F3",
                 "Z,6,1022000*9D"]


def test_rdr_golden_stream_of_section_11_1():
    profile = streaming()
    records = parse_all(profile, GOLDEN_STREAM, t0=100)
    got = [(type(r).__name__, getattr(r, "seq", None)) for r in records]
    assert got == [("DeviceSample", 0), ("DeviceEvent", 1), ("DeviceSample", 1),
                   ("DeviceEvent", 2), ("DeviceSample", 2), ("DeviceSample", 5),
                   ("StopReport", None)]
    s0, lick, s1, frame_edge, s2, s5, z = records
    assert (s0.seq, s0.t_dev_us, s0.dt_us, s0.raw, s0.flags, s0.gap) == (
        0, 1000000, 4000, (12, -1, 35, 3), 0, 0)
    assert lick == DeviceEvent("lick", 1002500, 1, 101, channel=0, level=1)
    assert (s1.t_dev_us, s1.dt_us, s1.raw, s1.gap) == (1004000, 4000, (10, 0, 30, 2), 0)
    assert frame_edge == DeviceEvent("frame", 1006100, 2, 103, count=1)
    assert (s2.raw, s2.flags) == ((-2048, 7, 0, 0), 1)   # count_incomplete
    assert (s5.seq, s5.gap, s5.t_dev_us, s5.dt_us, s5.raw) == (5, 2, 1020000, 12000,
                                                               (16, 0, 25, 2))
    assert (z.n_samples, z.t_dev_us, z.lost_at_end, z.record) == (6, 1022000, 0, "Z,6,1022000")
    c = profile.counters
    # Lines: the hello's, then the stream's 7
    assert (c["lines"], c["samples"], c["seq_gaps"], c["samples_lost"]) == (8, 4, 1, 2)
    assert profile.stop_report and profile.record()["guarantees"]["stop_report"]
    # The link protocol's example carries exactly these samples (protocol/v1/examples)
    example = json.loads((REPO / "protocol/v1/examples/sample.batch--v1-device.json").read_text())
    assert [s.link() for s in (s0, s1, s2, s5)] == example["data"]["samples"]


@pytest.mark.parametrize("first, second, t_dev, raw", [
    # Across the clock wrap and the int32 wrap of axis 0
    ("S,41,4294966296,4000,0,2147483647,0,1,0*17", "S,42,3000,4000,0,-2147483647,0,2,0*09",
     4294970296, (2, 0, 1, 0)),
    # seq 0 right after 4294967295, without a start in between: the next sample
    ("S,4294967295,2500000,4000,0,0,0,0,0*51", "S,0,2504000,4000,0,0,0,0,0*D0", 2504000,
     (0, 0, 0, 0)),
])
def test_rdr_d4_h6_wraps_of_the_clock_seq_and_totals(first, second, t_dev, raw):
    profile = streaming()
    _, b = samples(parse_all(profile, [first, second]))
    assert (b.t_dev_us, b.dt_us, b.raw, b.gap) == (t_dev, 4000, raw, 0)
    assert profile.counters["dt_mismatch"] == profile.counters["seq_regressions"] == 0


@pytest.mark.parametrize("before, line, seq, raw, flags", [
    # checksum digits in lower case: the same result as the seq 1 line of the stream
    (["S,0,1000000,4000,0,12,-1,35,3*37"], "S,1,1004000,4000,0,22,-1,65,5*a2", 1, (10, 0, 30, 2), 0),
    ([], "S,0,1000000,4000,2,12,-1,35,3*8D", 0, (12, -1, 35, 3), 2),  # no_tracking, not declared
    ([], "S,0,1000000,4000,4,12,-1,35,3*44", 0, (12, -1, 35, 3), 4),  # a reserved bit: recorded
])
def test_rdr_d7_f3_single_lines_accepted(before, line, seq, raw, flags):
    """Section 11.1, single lines: the host does not compare flags with the hello's flags key."""
    profile = streaming()
    parse_all(profile, before)
    [sample] = samples(parse_all(profile, [line]))
    assert (sample.seq, sample.raw, sample.flags) == (seq, raw, flags)


REJECTED = [  # device-v1.md section 11.2, for the device of section 11.1 (n_axes 4)
    ("S,1,1004000,4000,0,22,-1,95,5*A2", "crc_errors"),       # 65 corrupted into 95 in transit
    ("S,1,1004000,4000,0,22,-1,65,5", "crc_errors"),          # no checksum
    ("S,0,1000000,4000,0,12,-1,35*0C", "parse_errors"),       # 3 totals for 4 axes
    ("S,0,1000000,4000,0,12,-1,35,3,4*4C", "parse_errors"),   # 5 totals
    ("S,7,1028000,4000,0,1.5,2,3,4*60", "parse_errors"),      # not an integer
    ("S,7,1028000,0,0,1,2,3,4*5D", "parse_errors"),           # dt_us 0
    ("S,0,1000000,4000,256,12,-1,35,3*DE", "parse_errors"),   # flags above 255
    ("S, 7,1028000,4000,0,1,2,3,4*1F", "parse_errors"),       # a space in a field
    ("L,1,1002500,1*CA", "parse_errors"),                     # lick channel 1; the hello has lick=1
    ("Q,1,2*F8", "unknown"),                                  # valid checksum, unknown type
]


@pytest.mark.parametrize("line, counter", REJECTED,
                         ids=[f"{c}-{n}" for n, (_, c) in enumerate(REJECTED)])
def test_rdr_h2_golden_rejected_lines_counted_by_cause_and_never_motion(line, counter):
    profile = streaming()
    assert parse_all(profile, [line]) == []
    nonzero = {k: v for k, v in profile.counters.items() if v}
    assert nonzero == {"lines": 2, counter: 1}  # the hello's line, then this one
    # The next good line is read as if the rejected one had never come
    [s0] = samples(parse_all(profile, ["S,0,1000000,4000,0,12,-1,35,3*37"]))
    assert (s0.seq, s0.gap, s0.raw) == (0, 0, (12, -1, 35, 3))


def corrupt(line, rng):
    """One random byte of a framed line changed (never into an LF)."""
    data = bytearray(line)
    i = rng.randrange(len(data))
    data[i] = (data[i] + rng.randrange(1, 256)) % 256
    if data[i] == 0x0A:
        data[i] = 0x0B
    return bytes(data)


def test_rdr_h2_f3_corrupt_lines_never_become_motion():
    """Every other line with one byte corrupted: each is rejected, or, if the corruption left it
    valid (the letter case of a checksum digit), it is read as the device sent it. The motion the
    host integrates is the device's at every accepted sample."""
    rng = random.Random(3)
    totals = {k: (3 * k, -k, k * k % 97) for k in range(400)}
    clean = [s_line(k, 1000 * (k + 1), totals[k]) for k in range(400)]
    profile = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=SIM_MATRIX))
    profile.begin_stream()
    accepted = []
    for k, line in enumerate(clean):
        accepted += samples(profile.parse(corrupt(line, rng) if k % 2 else line, k))
    running = [0, 0, 0]
    for s in accepted:
        running = [a + b for a, b in zip(running, s.raw)]
        assert tuple(running) == totals[s.seq] and s.t_dev_us == 1000 * (s.seq + 1)
    c = profile.counters
    assert c["crc_errors"] + c["parse_errors"] + len(accepted) == 400
    assert len(accepted) < 210 and c["crc_errors"] > 190


# --- framing (rules F1, F2, H1) ------------------------------------------------------------------

def test_rdr_f1_lf_and_crlf_and_resync_after_garbage():
    framer = LineFramer()
    lines = framer.feed(b"S,0*AA\r\nnoise without end S,1*BB\nH*CC\r\r\n\nZ,1,2*DD\n")
    assert [line.body for line in lines] == [b"S,0*AA", b"noise without end S,1*BB", b"H*CC\r",
                                             b"", b"Z,1,2*DD"]
    assert lines[0].data == b"S,0*AA\r\n"
    profile = streaming()
    assert parse_all(profile, ["S,0,1000000,4000,0,12,-1,35,3*37\r"]) == []  # a second CR
    assert profile.counters["crc_errors"] == 1
    record = b"S,0,1000000,4000,0,12,-1,35,3\x01"
    assert parse_all(profile, [record + b"*%02X" % crc8(record)]) == []
    assert profile.counters["parse_errors"] == 1          # a byte outside printable ASCII


@pytest.mark.parametrize("body_len, overflow", [(254, False), (255, True), (600, True)])
def test_rdr_f2_overlong_line_cut_off_once_and_the_reader_resumes(body_len, overflow):
    body = b"E,long," + b"x" * (body_len - 7 - 3)
    line = body + b"*%02X" % crc8(body)
    assert len(line) == body_len
    framer = LineFramer()
    out = []
    for piece in [line[:100], line[100:300], line[300:] + b"\r\n" + b"S,0*00\n"]:
        out += framer.feed(piece)
        assert len(framer.partial) <= MAX_LINE + 1     # the buffer stays bounded
    assert [o.body is None for o in out] == [overflow, False]
    assert out[1].body == b"S,0*00"
    assert line.startswith(out[0].data.rstrip(b"\r\n"))


def test_rdr_f2_cut_off_as_soon_as_the_line_cannot_end_within_254_bytes():
    """254 bytes and a CR may still end with LF; one byte more cannot, and is cut off at once."""
    framer = LineFramer()
    assert framer.feed(b"x" * 254 + b"\r") == [] and len(framer.partial) == MAX_LINE + 1
    [line] = framer.feed(b"\n")
    assert line.body == b"x" * 254
    assert framer.feed(b"y" * 255) == []                    # could still be 254 bytes and a CR
    [cut] = framer.feed(b"y")
    assert cut.body is None and cut.data == b"y" * 256 and framer.partial == b""
    assert framer.feed(b"yyy\nS,1*00\n") == [Line(b"S,1*00\n", b"S,1*00")]


def test_rdr_h1_random_splits_give_identical_records():
    """The same bytes, read in random pieces, give the same records (all but t_host_ns)."""
    sim = SimDevice(config_from_entry({"deviceId": "d", "periodUs": 4000, "sensor": SENSOR,
                                       "lick": 1, "trajectory": B1_LIKE}, Path))
    sim.write(command("start"), 0)
    data = b"".join(d.data for d in sim.advance(2_000_000))
    assert data.count(b"\n") > 500

    def read(pieces):
        profile = V1Profile(V1Settings(device_id="d", period_us=4000, matrix=SIM_MATRIX))
        profile.hello = Hello("threemaze-device", "1.0", "d", 4000, 3, {"lick": "1"}, 0, "")
        profile.begin_stream()
        framer, records = LineFramer(), []
        for n, piece in enumerate(pieces):
            for line in framer.feed(piece):
                records += profile.parse(line.body, n)
        return [without_host_time(r) for r in records], profile.counters

    whole, counters = read([data])
    rng = random.Random(5)
    for _ in range(3):
        cuts = sorted(rng.sample(range(1, len(data)), 3000))
        pieces = [data[a:b] for a, b in zip([0] + cuts, cuts + [len(data)])]
        split, split_counters = read(pieces)
        assert split == whole and split_counters == counters
    bytewise, _ = read([data[i:i + 1] for i in range(len(data))])
    assert bytewise == whole
    assert counters["samples"] == 500 and counters["late_events"] == 0
    assert sum(1 for r in whole if r[0] == "DeviceEvent") > 0


def test_rdr_h1_each_line_stamped_at_the_read_that_completed_it():
    port = FedPort()
    profile = streaming()
    got = []
    reader = LineReader(port, profile, Clock(ticking=True), got.extend)
    port.feed(b"S,0,1000000,4000,0,", b"12,-1,35,3*37\nS,1,1004000,4000,0,22,-1,65,5*A2\nS,2,",
              b"1008000,4000,1,-2026,6,65,5*F2\n")
    reader.start()
    wait_for(lambda: len(got) == 3)
    reader.stop()
    stamps = [s.t_host_ns for s in got]
    # Lines 0 and 1 were completed by the second read, line 2 by the third
    assert stamps[0] == stamps[1] < stamps[2]
    assert reader.stats["reads"] == 3


# --- the stream (rules D2-D9, H3-H6) -------------------------------------------------------------

def test_rdr_h3_d3_seq_gap_counted_with_its_size_and_regressions_discarded():
    profile = streaming()
    records = parse_all(profile, [s_line(seq, 1000 + 4000 * seq, (0, 0, 0, 0), 4000)
                                  for seq in (0, 1, 4, 4, 2, 5, 9)])
    assert [(s.seq, s.gap) for s in samples(records)] == [(0, 0), (1, 0), (4, 2), (5, 0), (9, 3)]
    c = profile.counters
    assert (c["seq_gaps"], c["samples_lost"], c["seq_regressions"]) == (2, 5, 2)


def test_rdr_h4_d8_lines_before_start_are_not_accepted_and_a_late_first_sample_counts_its_losses():
    profile = golden_profile()
    accept_hello(profile)
    before = parse_all(profile, ["S,0,1000000,4000,0,12,-1,35,3*37", "L,0,1002500,1*D5",
                                 "Z,6,1022000*9D"])
    assert before == [] and profile.stats["outside_stream"] == 3
    assert profile.counters["samples"] == 0
    profile.begin_stream()
    [first] = samples(parse_all(profile, [s_line(3, 1016000, (0, 0, 0, 0), 4000)]))
    assert (first.seq, first.gap, first.dt_us, first.flags) == (3, 3, 16000, DT_ESTIMATED)
    assert (profile.counters["seq_gaps"], profile.counters["samples_lost"]) == (1, 3)


def test_rdr_h6_d5_dt_from_the_clock_mismatch_flagged_and_a_backward_clock_faults_the_stream():
    profile = streaming()
    zero = (0, 0, 0, 0)
    records = parse_all(profile, [s_line(0, 4000, zero, 4000), s_line(1, 8000, zero, 3000),
                                  s_line(3, 20000, zero, 1), s_line(4, 20000, zero, 4000),
                                  s_line(5, 30000, zero, 4000)])
    _, s1, s3, fault = records
    assert (s1.dt_us, s1.flags) == (4000, DT_MISMATCH)      # consecutive: dt_us 3000 disagrees
    assert (s3.dt_us, s3.flags, s3.gap) == (12000, 0, 1)      # not consecutive: not compared
    assert isinstance(fault, StreamFault) and "rule H6" in fault.reason
    assert profile.counters["dt_mismatch"] == 1 and profile.counters["samples"] == 3
    assert profile.stats["outside_stream"] == 1               # nothing more until a new start
    profile.begin_stream()
    assert len(samples(parse_all(profile, [s_line(0, 100, zero, 4000)]))) == 1


def test_rdr_d6_raw_counts_are_differences_of_running_totals_and_lost_lines_keep_their_motion():
    """Axis 1 wraps from 2147483647 (int32): the host's difference is still the counts added."""
    profile = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=SIM_MATRIX))
    profile.begin_stream()
    totals = [(0, 0, 0), (5, 2147483647, -7), (9, -2147483646, -7), (9, -2147483640, 1)]
    lines = [s_line(k, 1000 * (k + 1), t) for k, t in enumerate(totals)]
    got = samples(parse_all(profile, [lines[0], lines[1], lines[3]]))  # line 2 lost
    assert [s.raw for s in got] == [(0, 0, 0), (5, 2147483647, -7), (4, 9, 8)]
    assert got[2].gap == 1 and got[2].d == dot(SIM_MATRIX, (4, 9, 8))
    assert got[2].d == (0.0349 * 9, 0.0349 * 4, 0.05 * 8)


def test_rdr_d6_displacement_is_c_times_raw_in_double_precision():
    matrix = [[0.1, -0.2, 0.3], [1e-3, 0, 7], [0, 0, -0.05]]
    profile = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=matrix))
    profile.begin_stream()
    [s] = samples(parse_all(profile, [s_line(0, 1000, (3, -5, 11))]))
    assert all(type(v) is float for v in s.d)
    assert [v.hex() for v in s.d] == [v.hex() for v in dot(matrix, (3, -5, 11))]
    # The order of the sum fixes the bits: (0.1 + 0.2) + 0.3 is 0.6000000000000001, while
    # (0.3 + 0.2) + 0.1 is 0.6; section 7.2 sums j ascending
    ordered = V1Profile(V1Settings(device_id="d", period_us=1000,
                                   matrix=[[0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0, 0, 1]]))
    ordered.begin_stream()
    [s] = samples(parse_all(ordered, [s_line(0, 1000, (1, 1, 1))]))
    assert s.d == (0.6000000000000001, 0.6, 1.0)


def test_rdr_d2_samples_without_motion_are_delivered_too():
    sim = SimDevice(config_from_entry({"deviceId": "d", "periodUs": 1000}, Path))  # stands still
    sim.write(command("start"), 0)
    profile = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=SIM_MATRIX))
    profile.begin_stream()
    got = samples(parse_all(profile, [d.data.rstrip(b"\n") for d in sim.advance(50_000)]))
    assert [s.seq for s in got] == list(range(50))
    assert {s.raw for s in got} == {(0, 0, 0)} and {s.dt_us for s in got} == {1000}


def test_rdr_d9_events_assigned_to_the_next_sample_and_late_ones_counted():
    profile = streaming()
    records = parse_all(profile, ["S,0,1000000,4000,0,12,-1,35,3*37",
                                  frame("L,0,999000,1"),        # its window was sent: late
                                  frame("L,0,1000000,0"),       # at its window's end: late too
                                  frame("L,0,1000001,1"),       # the next window's first µs
                                  frame("L,0,1003000,0"), "S,1,1004000,4000,0,22,-1,65,5*A2",
                                  frame("L,0,1005000,1"), frame("Z,2,1006000")])
    events = [r for r in records if isinstance(r, DeviceEvent)]
    assert [(e.seq, e.t_dev_us, e.level, e.late) for e in events] == [
        (1, 999000, 1, True), (1, 1000000, 0, True), (1, 1000001, 1, False),
        (1, 1003000, 0, False), (None, 1005000, 1, False)]
    assert profile.counters["late_events"] == 2
    assert isinstance(records[-1], StopReport) and records[-1].lost_at_end == 0


@pytest.mark.parametrize("keys, lick, frame_ok", [("", False, False), (",lick=1", True, False),
                                                  (",fclk=1", False, True)])
def test_rdr_l_and_f_lines_only_as_the_hello_declares(keys, lick, frame_ok):
    """Section 4.4: L lines on the declared lick channels, F lines with fclk=1; others rejected."""
    profile = golden_profile()
    accept_hello(profile, frame(f"H,threemaze-device,1.0,ball-01,4000,4{keys}").decode())
    profile.begin_stream()
    records = parse_all(profile, [frame("L,0,999000,1"), frame("F,1,999500"),
                                  "S,0,1000000,4000,0,12,-1,35,3*37"])
    kinds = [e.kind for e in records if isinstance(e, DeviceEvent)]
    assert kinds == (["lick"] if lick else []) + (["frame"] if frame_ok else [])
    assert profile.counters["parse_errors"] == (not lick) + (not frame_ok)


def test_rdr_d10_h8_pulse_outcomes_and_messages():
    profile = golden_profile(device_id="valve-01", period_us=0, matrix=None, n_axes=0, outputs=1)
    accept_hello(profile, "H,threemaze-device,1.0,valve-01,0,0,out=1,ack=1,hb=300*2C")
    records = parse_all(profile, ["A,1,1010200,1080200*CC", "X,2,range*AD",
                                  "E,sensor,left sensor did not answer*98", frame("A,3,10,5")])
    assert records == [PulseOutcome(1, True, 1000, t_on_dev_us=1010200, t_off_dev_us=1080200),
                       PulseOutcome(2, False, 1001, reason="range"),
                       DeviceMessage("sensor", "left sensor did not answer", 1002)]
    assert profile.counters["parse_errors"] == 1                # off before on


def test_rdr_h6_event_and_outcome_times_unwrapped_near_their_reference_sample():
    profile = streaming()
    zero = (0, 0, 0, 0)
    records = parse_all(profile, [s_line(0, 4294960000, zero, 4000), frame("L,0,4294964000,1"),
                                  s_line(1, 2704, zero, 10000), frame("A,1,1000,2000"),
                                  frame("Z,2,3000")])
    s0, lick, s1, outcome, z = records
    assert s1.t_dev_us == s0.t_dev_us + 10000 == U32 + 2704
    assert lick.t_dev_us == U32 - 3296 and lick.seq == 1
    assert (outcome.t_on_dev_us, outcome.t_off_dev_us) == (U32 + 1000, U32 + 2000)
    assert z.t_dev_us == U32 + 3000


def test_rdr_h6_a_stream_without_samples_records_its_times_as_sent():
    """A stream's device time starts at its own first sample (H6), so in a later stream in which
    no sample arrived, the stop report and the events left waiting are recorded as sent, not
    unwrapped against the samples of the stream before."""
    profile = streaming()
    zero = (0, 0, 0, 0)
    parse_all(profile, [s_line(0, 4294960000, zero, 4000), s_line(1, 2704, zero, 10000),
                        frame("Z,2,3000")])
    profile.begin_stream()
    lick, z = parse_all(profile, [frame("L,0,5000,1"), frame("Z,0,6000")])
    assert (lick.seq, lick.t_dev_us) == (None, 5000)
    assert (z.t_dev_us, z.lost_at_end, z.n_samples) == (6000, 0, 0)


def test_rdr_h5_hello_checked_against_the_rig_file():
    profile = golden_profile(n_axes=4)
    [hello] = profile.parse(GOLDEN_HELLO.encode(), 0)
    assert profile.check_hello(hello) == []
    other = golden_profile(device_id="ball-02", period_us=2000, matrix=SIM_MATRIX, outputs=1)
    assert other.check_hello(hello) == [
        "device_id 'ball-01' (rig file: 'ball-02')", "period_us 4000 (rig file: 2000)",
        "n_axes 4 (calibration: 3 columns)", "out 0: the rig file uses 1 output channels"]
    [old] = profile.parse(frame("H,threemaze-device,2.0,ball-01,4000,4,hb=299"), 0)
    assert profile.check_hello(old) == ["version '2.0' (rig file: 1.x)",
                                        "hb '299': a heartbeat timeout below 300 ms (rule H5)"]


@pytest.mark.parametrize("line", [
    "H,threemaze-device,1.0,ball 01,4000,4", "H,threemaze-device,1,b,4000,4",
    "H,threemaze-device,1.0,b,4000,17", "H,threemaze-device,1.0,b,-1,4",
    "H,threemaze-device,1.0,b,4000,4,lick", "H,threemaze-device,1.0,b,4000,4,fclk=2",
    "H,threemaze-device,1.0,b,4000"])
def test_rdr_d1_malformed_hello_is_a_parse_error(line):
    profile = golden_profile()
    assert profile.parse(frame(line), 0) == [] and profile.counters["parse_errors"] == 1


def test_rdr_f4_leading_zeros_accepted():
    profile = streaming()
    [s0] = samples(parse_all(profile, [frame("S,0000,01000000,04000,00,012,-01,035,03")]))
    assert (s0.seq, s0.t_dev_us, s0.dt_us, s0.raw) == (0, 1000000, 4000, (12, -1, 35, 3))


# --- the reader thread ---------------------------------------------------------------------------

def test_rdr_h1_h2_pyserial_loop_port_with_random_splits(tmp_path):
    """pySerial's loop:// port, fed from another thread in random pieces: the reader's records are
    those of the whole stream read at once, rejected lines are counted and logged raw."""
    sim = SimDevice(config_from_entry({"deviceId": "d", "periodUs": 1000, "sensor": SENSOR,
                                       "trajectory": B1_LIKE,
                                       "faults": [{"type": "badCrc", "seq": 30}]}, Path))
    sim.write(command("start"), 0)
    data = b"".join(d.data for d in sim.advance(400_000)) + b"garbage, no checksum\r\n"
    port = serial.serial_for_url("loop://", timeout=0.05)
    profile = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=SIM_MATRIX))
    profile.begin_stream()
    raw = RawLineLog(tmp_path / "raw.tsv", {"device": "test"})
    got = []
    reader = LineReader(port, profile, Clock(), got.extend, raw=raw)
    reader.start()
    rng = random.Random(11)

    def feed():
        i = 0
        while i < len(data):
            n = rng.randint(1, 80)
            port.write(data[i:i + n])
            i += n

    feeder = threading.Thread(target=feed)
    feeder.start()
    feeder.join(30)
    wait_for(lambda: profile.counters["lines"] == data.count(b"\n"))
    reader.stop()
    raw.close(0, reader.framer.partial)
    port.close()
    expected = V1Profile(V1Settings(device_id="d", period_us=1000, matrix=SIM_MATRIX))
    expected.begin_stream()
    whole = [without_host_time(r) for r in parse_all(expected, data.split(b"\n")[:-1])]
    assert [without_host_time(r) for r in got] == whole
    assert profile.counters == expected.counters
    assert (profile.counters["samples"], profile.counters["crc_errors"]) == (399, 2)
    assert profile.counters["seq_gaps"] == 1 and samples(got)[30].seq == 31
    report = conformance.check_file(tmp_path / "raw.tsv")
    assert report.stats["device_lines"] == data.count(b"\n")
    assert report.stats["crc_errors"] == 2


def test_rdr_reader_hands_batches_to_the_event_loop():
    """With an event loop, each read's records reach it through call_soon_threadsafe, in order and
    on the loop's thread; the loop never polls the reader."""
    async def main():
        loop = asyncio.get_running_loop()
        port = FedPort()
        seen = []

        def on_batch(records):
            seen.append((threading.get_ident(), [r.seq for r in samples(records)]))

        reader = LineReader(port, streaming(), Clock(),
                            lambda records: loop.call_soon_threadsafe(on_batch, records))
        reader.start()
        lines = [s_line(k, 1000000 + 4000 * k, (0, 0, 0, 0), 4000) + b"\n" for k in range(200)]
        for k in range(0, 200, 7):
            port.feed(b"".join(lines[k:k + 7]))
            await asyncio.sleep(0.001)
        while sum(len(s) for _, s in seen) < 200:
            await asyncio.sleep(0.005)
        reader.stop()
        return seen

    seen = asyncio.run(asyncio.wait_for(main(), 20))
    assert {thread for thread, _ in seen} == {threading.get_ident()}
    assert [seq for _, batch in seen for seq in batch] == list(range(200))


def test_rdr_no_sleep_in_the_ingestion_path():
    """Acceptance of DPR-03: the reader blocks in read(); nothing on the ingestion path sleeps or
    polls the event loop (v0.3 slept 1 ms on the loop after every line, hallway04_experiment.py:
    327)."""
    v1 = (REPO / "threemaze/devices/profiles/v1.py").read_text(encoding="utf-8")
    sources = [inspect.getsource(LineReader), inspect.getsource(LineFramer),
               v1.split("# --- the session sequence")[0],
               (REPO / "threemaze/devices/profiles/__init__.py").read_text(encoding="utf-8")]
    for source in sources:
        assert "asyncio.sleep" not in source and "time.sleep" not in source
    module = (REPO / "threemaze/devices/serial_lines.py").read_text(encoding="utf-8")
    assert "asyncio.sleep" not in module


# --- the reference simulated device in virtual time: every fault at three rates -----------------

def faults_for(period_us, first=8):
    """One fault of every type (DPR-02), apart from each other, and what each costs the reader."""
    s = [first + 6 * k for k in range(7)]
    gap = max(1, min(400, (period_us - 1) // 4))
    silence_ms = max(1, 3 * period_us // 1000)
    return [
        ({"type": "drop", "seq": s[0], "count": 2}, {"seq_gaps": 1, "samples_lost": 2}),
        ({"type": "badCrc", "seq": s[1]}, {"crc_errors": 1, "seq_gaps": 1, "samples_lost": 1}),
        ({"type": "truncate", "seq": s[2], "keepBytes": 9},       # takes the next line with it
         {"crc_errors": 1, "seq_gaps": 1, "samples_lost": 2}),
        ({"type": "split", "seq": s[3], "pieces": 3, "gapUs": gap}, {}),
        ({"type": "burst", "seq": s[4], "count": 3}, {}),
        ({"type": "silence", "seq": s[5], "durationMs": silence_ms},
         {"seq_gaps": 1, "samples_lost": math.ceil(silence_ms * 1000 / period_us)}),
        ({"type": "wrap", "seq": s[6]}, {}),
    ]


def sim_entry(period_us, faults=(), **more):
    return {"driver": "simulated", "deviceId": "sim-ball", "periodUs": period_us,
            "sensor": SENSOR, "lick": 1, "trajectory": B1_LIKE, "faults": list(faults), **more}


def expected_counters(faults):
    out = {"crc_errors": 0, "seq_gaps": 0, "samples_lost": 0}
    for _, cost in faults:
        for key, value in cost.items():
            out[key] += value
    return out


def make_context(tmp_path, *, matrix=SIM_MATRIX, loop=None, on_batch=None, clock=None):
    return DeviceContext(clock=clock or Clock(), session_dir=tmp_path, rig_dir=tmp_path,
                         calibration={"matrix": matrix} if matrix else None, loop=loop,
                         on_batch=on_batch)


def virtual_device(tmp_path, entry, *, until_us=None, seed=1, on_batch=None):
    """A SimulatedDevice on a VirtualSimPort (the sim in virtual time, read in random pieces)."""
    device = SimulatedDevice("ball", entry, make_context(tmp_path, on_batch=on_batch))

    def open_port():
        cfg = config_from_entry(entry, Path)
        device.log.write("open", device="ball", config=entry, files={})
        return VirtualSimPort(SimDevice(cfg, log=device.log.write), seed=seed, until_us=until_us)

    device.open_port = open_port
    return device


@pytest.mark.parametrize("rate", RATES)
@pytest.mark.parametrize("index", range(7), ids=["drop", "badCrc", "truncate", "split", "burst",
                                                  "silence", "wrap"])
def test_rdr_every_sim_fault_counted_at_20_250_1000_hz(tmp_path, rate, index):
    period = RATES[rate]
    fault, cost = faults_for(period)[index]
    n = 60
    records = []
    device = virtual_device(tmp_path, sim_entry(period, [fault]), until_us=n * period + period // 2,
                            on_batch=lambda name, batch: records.extend(batch))
    device.open()
    device.start()
    c = device.profile.counters
    wait_for(lambda: c["samples"] + c["samples_lost"] >= n)
    device.stop()
    device.close()
    assert {k: c[k] for k in ("crc_errors", "seq_gaps", "samples_lost")} == expected_counters(
        [(fault, cost)])
    assert (c["parse_errors"], c["overflow"], c["seq_regressions"], c["dt_mismatch"]) == (0, 0, 0, 0)
    got = samples(records)
    assert c["samples"] + c["samples_lost"] == n and got[-1].seq == n - 1
    # One device clock: every window counted once, across the wrap and the gaps
    assert all(b.t_dev_us - a.t_dev_us == b.dt_us == period * (b.gap + 1)
               for a, b in zip(got, got[1:]))
    # Running totals: the motion of lost samples is in the next sample's raw counts
    assert raw_sum(got) == last_totals(tmp_path / "raw" / "ball.tsv", n - 1)
    log = [json.loads(line) for line in (tmp_path / "sim" / "ball.jsonl").read_text().splitlines()]
    assert [(f["type"], f["seq"]) for f in log if f["event"] == "fault"] == [
        (fault["type"], fault["seq"])]
    assert device.stop_report.startswith(f"Z,{n},")
    assert device.describe()["guarantees"]["stop_report"]
    report = conformance.check_file(tmp_path / "raw" / "ball.tsv")
    assert report.stats["samples"] == c["samples"] and report.stats["crc_errors"] == c["crc_errors"]


def test_rdr_1khz_for_60_s_loses_nothing(tmp_path):
    """Acceptance of DPR-03 in virtual time: 60,000 samples at 1 kHz with licks, read in random
    pieces: none lost, none rejected, each once and in order. The same in real time, with the
    hand-off latency, is tools/timing/reader_handoff.py, run in an exclusive bench window."""
    n = 60_000
    got = []
    device = virtual_device(tmp_path, sim_entry(1000), until_us=n * 1000 + 500, seed=7,
                            on_batch=lambda name, batch: got.extend(samples(batch)))
    device.open()
    device.start()
    wait_for(lambda: device.profile.counters["samples"] >= n, timeout_s=120)
    device.stop()
    device.close()
    c = device.profile.counters
    assert c["samples"] == n and sum(v for k, v in c.items() if k not in ("lines", "samples")) == 0
    assert [s.seq for s in got] == list(range(n))
    assert c["lines"] == n + 2 + device.profile.stats["lick_edges"]   # with the H and Z lines
    assert raw_sum(got) == last_totals(tmp_path / "raw" / "ball.tsv", n - 1)


# --- the device's host side: hello, start, stop, heartbeat (section 6, rules H4, H5, H7, H9) -----

def test_rdr_h9_guarantees_recorded_and_stop_report_only_with_a_z_line(tmp_path, monkeypatch):
    device = virtual_device(tmp_path, sim_entry(4000), until_us=40_000)
    device.open()
    record = device.describe()
    levels = ("profile", "completeness", "integrity", "seq_source", "time_source")
    assert {k: record[k] for k in levels} == {
        "profile": "v1", "completeness": "counted", "integrity": "crc8", "seq_source": "device",
        "time_source": "device"}
    assert record["guarantees"] == {"hello": True, "device_seq": True, "device_time": True,
                                    "window_dt": True, "checksum": True, "running_totals": True,
                                    "stop_report": False}
    assert record["hello"]["device_id"] == "sim-ball" and record["hello"]["n_axes"] == 3
    assert set(record["counters"]) == COUNTER_NAMES
    assert device.link_device() == {
        "profile": "v1", "completeness": "counted", "integrity": "crc8", "seq_source": "device",
        "time_source": "device", "period_us": 4000, "n_axes": 3, "device_id": "sim-ball"}
    device.start()
    wait_for(lambda: device.profile.counters["samples"] >= 10)
    # A device that never sends its stop report: the stream ends after the wait, without the flag
    monkeypatch.setattr(SimDevice, "_stop", lambda self, now: setattr(self, "_stream", None))
    t0 = time.monotonic()
    device.stop()
    assert 0.4 < time.monotonic() - t0 < 2.0
    assert device.stop_report is None
    assert device.describe()["guarantees"]["stop_report"] is False
    device.close()


HELLO_D = frame("H,threemaze-device,1.0,d,4000,3") + b"\n"


class _FedDevice(SerialLineSource):
    """A v1 device on a FedPort (the test plays the device)."""

    @classmethod
    def profile_for(cls, config, calibration):
        return V1Profile(V1Settings(device_id="d", period_us=4000,
                                    matrix=(calibration or {}).get("matrix"),
                                    hello_interval_ms=config.get("hello_interval_ms", 1000),
                                    hello_timeout_ms=config.get("hello_timeout_ms", 2000),
                                    stop_timeout_ms=100))

    def open_port(self):
        return self.config["port_object"]


def fed_device(tmp_path, port, config=None, **ctx):
    return _FedDevice("d", {"port_object": port, "periodUs": 4000, **(config or {})},
                      make_context(tmp_path, **ctx))


def test_rdr_h4_input_before_start_discarded(tmp_path):
    """Lines waiting when the stream starts never enter it (rule H4): a line read before start is
    not accepted, a partial line held by the reader and the port's buffer are discarded."""
    port = FedPort(answers={b"hello*92\n": HELLO_D})
    device = fed_device(tmp_path, port)
    device.open()
    port.feed(s_line(7, 40000, (1, 1, 1), 4000) + b"\n" + s_line(8, 44000, (2, 2, 2), 4000)[:9])
    wait_for(lambda: device.profile.stats["outside_stream"] == 1
             and len(device.reader.framer.partial) == 9)
    device.start()
    port.feed(s_line(0, 100, (5, 5, 5), 4000) + b"\n")
    wait_for(lambda: device.profile.counters["samples"] == 1)
    assert device.profile.stats["outside_stream"] == 1
    assert port.writes == [b"stop*A5\n", b"hello*92\n", b"start*3F\n"]
    assert device.reader.stats["discarded_bytes"] == 9
    device.close()


def test_rdr_d1_hello_sent_again_until_answered_and_refused_after_the_timeout(tmp_path):
    port = FedPort()
    device = fed_device(tmp_path, port, {"hello_interval_ms": 50, "hello_timeout_ms": 300})
    with pytest.raises(DeviceError, match=r"did not answer hello within 0.3 s \(0 lines read\)$"):
        device.open()
    hellos = [w for w in port.writes if w == b"hello*92\n"]
    assert 3 <= len(hellos) <= 8          # every 50 ms for 300 ms, give or take a timer tick
    device.close()
    # A device that answers the third hello only
    calls = []

    class Third(FedPort):
        def write(self, data):
            calls.append(data)
            if data == b"hello*92\n" and calls.count(data) == 3:
                self.feed(HELLO_D)
            return super().write(data)

    device = fed_device(tmp_path / "third", Third(),
                        {"hello_interval_ms": 50, "hello_timeout_ms": 2000})
    device.open()
    assert calls.count(b"hello*92\n") == 3 and device.hello["device_id"] == "d"
    device.close()


def test_rdr_a_port_that_fails_is_named_as_the_cause_and_logged(tmp_path, caplog):
    """A port whose read fails (a USB device unplugged) ends the reader with a StreamFault and a
    log line, and a session being armed is refused for that reason, not for a silent device."""
    class Unplugged(FedPort):
        def read(self, size=1):
            raise OSError("the device is gone")

    got = []
    device = fed_device(tmp_path, Unplugged(), on_batch=lambda name, records: got.extend(records))
    with pytest.raises(DeviceError, match="^device 'd': reading the port failed: OSError: the"
                                          " device is gone$"):
        device.open()
    assert [type(r) for r in got] == [StreamFault]
    assert device.describe()["reader"]["failure"] == got[0].reason
    assert any("reading the port failed" in r.getMessage() and r.levelname == "ERROR"
               for r in caplog.records)
    device.close()


def test_rdr_a_closed_device_is_safe_to_call(tmp_path):
    """After close(), safe_state() must not raise (the OutputDevice contract), stop() and start()
    do nothing, and pulse() refuses: the port is gone, and nothing is written to it."""
    port = FedPort(answers={b"hello*92\n": HELLO_D})
    device = fed_device(tmp_path, port, {"outputs": 1})
    device.open()
    device.safe_state()                      # open: the device gets stop, which closes outputs
    assert port.writes[-1] == b"stop*A5\n"
    device.close()
    writes = list(port.writes)
    device.safe_state()
    device.stop()
    device.start()
    with pytest.raises(DeviceError, match="is not open"):
        device.pulse(0, 1000)
    assert port.writes == writes and device.port is None
    device.close()                           # idempotent


def test_rdr_h7_heartbeat_to_a_device_that_declares_one(tmp_path):
    entry = {"driver": "simulated", "deviceId": "valve-01", "outputs": 1, "hbMs": 300}
    device = SimulatedDevice("valve", entry, make_context(tmp_path, matrix=None))
    device.open()
    time.sleep(0.5)
    device.close()
    raw = (tmp_path / "raw" / "valve.tsv").read_text()
    assert len([line for line in raw.splitlines() if "beat*D7" in line]) >= 6
    report = conformance.check_file(tmp_path / "raw" / "valve.tsv")
    assert report.ok, report.findings     # the checker reports beats more than 100 ms apart (H7)


def test_rdr_pulse_command_ids_from_1_and_outcomes_reach_the_runtime(tmp_path):
    got = []
    entry = {"driver": "simulated", "deviceId": "valve-01", "outputs": 1, "maxPulseUs": 100_000}
    device = SimulatedDevice("valve", entry, make_context(tmp_path, matrix=None,
                                                          on_batch=lambda n, r: got.extend(r)))
    device.open()
    assert [device.pulse(0, 20_000), device.pulse(0, 900_000)] == [1, 2]
    wait_for(lambda: len([r for r in got if isinstance(r, PulseOutcome)]) == 2)
    device.close()
    outcomes = sorted((r for r in got if isinstance(r, PulseOutcome)), key=lambda r: r.cmd_id)
    assert [(o.cmd_id, o.done, o.reason) for o in outcomes] == [(1, True, None),
                                                                 (2, False, "range")]
    assert outcomes[0].t_off_dev_us - outcomes[0].t_on_dev_us == 20_000


def test_rdr_serial_lines_driver_on_a_loop_port_times_out_without_a_device(tmp_path, sim_rig_data,
                                                                         write_rig):
    """The serial_lines driver opens pySerial URLs; on loop:// it hears only its own commands,
    which are no device lines, and refuses to arm after helloTimeoutMs, saying what it read."""
    sim_rig_data["devices"]["ball"] = {"driver": "serial_lines", "port": "loop://",
                                       "profile": "v1", "periodUs": 4000, "helloTimeoutMs": 200,
                                       "helloIntervalMs": 50}
    del sim_rig_data["bindings"]["reward"]
    del sim_rig_data["devices"]["valve"]
    session = Session()
    session.configure(write_rig(sim_rig_data), data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    with pytest.raises(SessionError, match=r"did not answer hello within 0.2 s \((\d+) lines read;"
                                           r" rejected: parse_errors \1\)"):
        session.arm()
    counters = session.devices["ball"].describe()["counters"]
    assert counters["parse_errors"] >= 3      # its own stop and hello commands, read back
    assert counters["samples"] == 0


def test_serial_lines_defaults_are_the_protocols():
    """Section 6's proposed defaults: the schema's for serial_lines, V1Settings' for the simulated
    device, which has no such fields."""
    d = device_defaults("serialLinesDevice")
    s = V1Settings()
    assert (d["openDelayMs"], d["helloIntervalMs"], d["helloTimeoutMs"], d["stopTimeoutMs"]) == (
        s.open_delay_ms, s.hello_interval_ms, s.hello_timeout_ms, s.stop_timeout_ms)
    assert (s.open_delay_ms, s.hello_interval_ms, s.hello_timeout_ms, s.stop_timeout_ms) == (
        0, 500, 5000, 500)
    assert d["rawLog"] is True
    assert load_schema()["$defs"]["serialLinesDevice"]["properties"]["profile"]["enum"] == ["v1"]


# --- real time: the runtime's simulated rig, with an event loop ----------------------------------

def run_on_loop(rig, data_root, seconds, listener):
    """A session on an asyncio event loop: arm, start, wait, stop; listener gets its records."""
    async def main():
        session = Session(loop=asyncio.get_running_loop())
        session.add_listener(listener)
        session.configure(rig, data_root=data_root)
        session.set_task(TaskSource("declarative", "test-task"))
        await asyncio.to_thread(session.arm)
        await asyncio.to_thread(session.start)
        await asyncio.sleep(seconds)
        await asyncio.to_thread(session.stop)
        return session

    return asyncio.run(asyncio.wait_for(main(), 60))


@pytest.mark.parametrize("rate", RATES)
def test_rdr_sim_rig_in_real_time_with_every_fault(sim_rig_data, write_rig, tmp_path, rate):
    """The simulated rig in real time, its records handed to an asyncio event loop: every fault
    counted, nothing else lost."""
    period = RATES[rate]
    faults = faults_for(period, first=4 if period == 50000 else 20)
    sim_rig_data["devices"]["ball"].update(periodUs=period, lick=1, trajectory=B1_LIKE,
                                            faults=[f for f, _ in faults])
    got = []

    class Listener:
        def on_device_batch(self, session, device, records):
            assert threading.current_thread() is threading.main_thread()
            if device == "ball":
                got.extend(records)

    seconds = (faults[-1][0]["seq"] + 12) * period / 1e6 + 0.1
    session = run_on_loop(write_rig(sim_rig_data), tmp_path / "data", seconds, Listener())
    c = session.devices["ball"].describe()["counters"]
    assert {k: c[k] for k in ("crc_errors", "seq_gaps", "samples_lost")} == expected_counters(faults)
    assert (c["parse_errors"], c["overflow"], c["seq_regressions"], c["dt_mismatch"]) == (0, 0, 0, 0)
    got_samples = samples(got)
    assert len(got_samples) == c["samples"] and isinstance(got[-1], StopReport)
    assert got[-1].lost_at_end == 0 and got[-1].n_samples == got_samples[-1].seq + 1
    assert all(b.t_dev_us - a.t_dev_us == period * (b.gap + 1)
               for a, b in zip(got_samples, got_samples[1:]))
    raw_log = session.dir / "raw" / "ball.tsv"
    assert raw_sum(got_samples) == last_totals(raw_log, got_samples[-1].seq)
    assert conformance.check_file(raw_log).stats["samples"] == c["samples"]


def test_rdr_short_real_time_run_at_1khz_reports_the_hand_off(sim_rig_data, write_rig, tmp_path):
    """1 kHz for 2 s through the reader to an event loop: nothing lost; the hand-off latency (read
    to loop callback) is printed, not judged (timing is judged only in an exclusive bench window:
    tools/timing/reader_handoff.py)."""
    sim_rig_data["devices"]["ball"]["periodUs"] = 1000
    latency, seqs = [], []

    class Listener:
        def on_device_batch(self, session, device, records):
            now = time.perf_counter_ns()
            for r in samples(records):
                latency.append(now - r.t_host_ns)
                seqs.append(r.seq)

    session = run_on_loop(write_rig(sim_rig_data), tmp_path / "data", 2.0, Listener())
    c = session.devices["ball"].describe()["counters"]
    assert seqs == list(range(len(seqs))) and len(seqs) >= 1500
    assert sum(v for k, v in c.items() if k not in ("lines", "samples")) == 0
    latency.sort()
    p50, p99 = latency[len(latency) // 2], latency[int(0.99 * len(latency))]
    print(f"\nhand-off read -> loop callback at 1 kHz, {len(latency)} samples: p50 {p50 / 1e6:.3f}"
          f" ms, p99 {p99 / 1e6:.3f} ms, max {latency[-1] / 1e6:.3f} ms (not judged here)")


# --- the end-to-end bench's simulated serial port (test/e2e/sim, pySerial patched) ---------------

SIM_ROOT = REPO / "test" / "e2e" / "sim"
CHILD = Path(__file__).with_name("e2e_sim_reader.py")


@pytest.fixture
def sim_folder(tmp_path):
    """A folder for the end-to-end sim's files. The sim refuses one on D:, which it redirects
    (test_backend_rig.py does the same), so then a temporary folder in the user profile."""
    if tmp_path.drive.upper() != "D:":
        yield tmp_path
        return
    base = Path(tempfile.mkdtemp(prefix="three-maze-pytest-", dir=Path.home()))
    try:
        yield base
    finally:
        shutil.rmtree(base, ignore_errors=True)


@pytest.mark.skipif(sys.platform != "win32", reason="the end-to-end sim models a Windows rig")
@pytest.mark.parametrize("rate", RATES)
def test_rdr_serial_lines_driver_on_the_e2e_sim_port_with_every_fault(sim_folder, rate):
    """The serial_lines driver in a process where test/e2e/sim stands in for pySerial's ports
    (THREEMAZE_SIM=1, THREEMAZE_SIM_PROTOCOL=v1): the device-v1 sim at 20, 250 and 1,000 Hz with
    every fault type. The child refuses to run unless serial.Serial is the sim's."""
    period = RATES[rate]
    faults = faults_for(period, first=4 if period == 50000 else 20)
    device = {"deviceId": "sim-e2e", "periodUs": period, "sensor": SENSOR, "lick": 1,
              "trajectory": B1_LIKE, "faults": [f for f, _ in faults]}
    sim_dir = sim_folder / "sim"
    sim_dir.mkdir()
    (sim_folder / "device.json").write_text(json.dumps(device), encoding="utf-8")
    rig = {"format": "three-maze-rig", "version": 1, "name": "e2e-sim",
           "devices": {"ball": {"driver": "serial_lines", "port": "SIMV1READER", "profile": "v1",
                                "deviceId": "sim-e2e", "periodUs": period}},
           "bindings": {"motion": "ball"}, "calibration": {"ball": {"matrix": SIM_MATRIX}},
           "dataRoot": str(sim_folder / "data")}
    (sim_folder / "rig.json").write_text(json.dumps(rig), encoding="utf-8")
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("THREEMAZE_") and k != "ELECTRON_RUN_AS_NODE"}
    env.update(PYTHONPATH=str(SIM_ROOT), PYTHONIOENCODING="utf-8", THREEMAZE_SIM="1",
               THREEMAZE_SIM_DIR=str(sim_dir), THREEMAZE_SIM_PROTOCOL="v1",
               THREEMAZE_SIM_DEVICE=str(sim_folder / "device.json"),
               PYTHONDONTWRITEBYTECODE="1")         # no __pycache__ in test/e2e/sim
    seconds = (faults[-1][0]["seq"] + 12) * period / 1e6
    out = sim_folder / "result.json"
    proc = subprocess.run([sys.executable, str(CHILD), str(sim_folder / "rig.json"), str(seconds),
                           str(out)], cwd=sim_folder, env=env, capture_output=True, text=True,
                          timeout=120, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["serial_class"] == "threemaze_sim.teensy.SimSerial"
    c = result["counters"]
    assert {k: c[k] for k in ("crc_errors", "seq_gaps", "samples_lost")} == expected_counters(faults)
    assert (c["parse_errors"], c["overflow"], c["seq_regressions"], c["dt_mismatch"]) == (0, 0, 0, 0)
    seqs = result["seqs"]
    assert seqs == sorted(seqs) and len(seqs) == c["samples"]
    assert result["stop_report"].startswith("Z,")
    serial_log = [json.loads(line) for line in
                  (sim_dir / "serial.jsonl").read_text(encoding="utf-8").splitlines()]
    assert sorted((r["seq"], r["type"]) for r in serial_log if r["event"] == "fault") == sorted(
        (f["seq"], f["type"]) for f, _ in faults)
    # Every sample the sim sent intact (in one line or in pieces) was accepted, each once, in
    # order; the line after the truncated one is lost with it
    sent = {r["seq"] for r in serial_log if r["event"] == "sent" and r["kind"] in ("S", "piece")}
    spoilt = {f["seq"] for f, _ in faults if f["type"] in ("badCrc", "truncate")}
    assert seqs == sorted(sent - spoilt - {faults[2][0]["seq"] + 1})
    # One device clock across the wrap and the gaps: each step is the windows it covers
    assert result["t_dev_steps"] == sorted({period * (b - a) for a, b in zip(seqs, seqs[1:])})
    # Running totals: the sum of the raw counts is the last line's totals
    [last] = [r["line"] for r in serial_log
              if r["event"] == "sent" and r["kind"] == "S" and r["seq"] == seqs[-1]]
    assert result["raw_sum"] == [int(v) for v in last.split("*")[0].split(",")[5:]]
