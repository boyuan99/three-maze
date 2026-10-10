"""The reference simulated device of device protocol v1 (plan item DPR-02), in virtual time.

Every test drives threemaze/devices/sim with a host that sends commands at given microseconds
and reassembles the device's output into lines, and judges the result with the conformance
checker of the end-to-end sim (test/e2e/sim/threemaze_sim/conformance.py), which is written
apart from the device. Test names carry the rule ids of docs/protocol/device-v1.md section 9
(SIM-...). The checker is itself tested against the specification's golden lines.
"""
import math
from pathlib import Path

import pytest

from threemaze.devices.sim import SimDevice, config_from_entry, config_problems, crc8, frame, int32
from threemaze.devices.sim.motion import MotionError
from threemaze_sim import conformance

U32 = 1 << 32
SENSOR = {"cmPerCount": 0.0349, "radPerCount": 0.05}  # v0.3's mapping, as rigs/sim.json


class Host:
    """A host on a SimDevice in virtual time; what passes between them, as checker entries."""

    def __init__(self, entry, base=Path(".")):
        self.log = []
        self.device = SimDevice(config_from_entry(entry, lambda p: base / p),
                                log=lambda event, **f: self.log.append({"event": event, **f}))
        self.entries = []
        self.chunks = []           # (t_us, bytes) as the device sent them
        self._buf = b""

    def run(self, t_us):
        for delivery in self.device.advance(t_us):
            self.chunks.append((delivery.t_us, delivery.data))
            self._buf += delivery.data
            while b"\n" in self._buf:
                end = self._buf.index(b"\n") + 1
                line, self._buf = self._buf[:end], self._buf[end:]
                n = len(self.entries) + 1
                self.entries.append(conformance.Entry(n, "device", delivery.t_us * 1000, line))

    def send(self, t_us, record=None, raw=None):
        self.run(t_us)
        data = raw if raw is not None else frame(record) + b"\n"
        self.entries.append(conformance.Entry(len(self.entries) + 1, "host", t_us * 1000, data))
        self.device.write(data, t_us)
        self.run(t_us)

    def lines(self, kind=None):
        out = [e.data.rstrip(b"\r\n").decode() for e in self.entries if e.who == "device"]
        return [line for line in out if kind is None or line.startswith(kind + ",")]

    def records(self, kind):
        return [line.rsplit("*", 1)[0].split(",") for line in self.lines(kind)]

    def events(self, name):
        return [record for record in self.log if record["event"] == name]

    def check(self, **kwargs):
        return conformance.check(self.entries, **kwargs)


def stream(entry, seconds, start_at=1000, extra=()):
    """hello at 0, start at start_at, stop `seconds` later; extra: (t_us, record) host commands."""
    host = Host(entry)
    host.send(0, "hello")
    host.send(start_at, "start")
    for t, record in sorted(extra):
        host.send(t, record)
    stop = start_at + int(seconds * 1e6)
    host.send(stop, "stop")
    host.run(stop + 10_000)
    return host


def motion_device(period_us, **more):
    return {"deviceId": "sim-test", "periodUs": period_us, "sensor": SENSOR, **more}


B1_LIKE = {"kind": "segments", "segments": [
    {"durationS": 0.3, "forwardCmPerS": 11.168},
    {"durationS": 0.2, "lick": 1},
    {"durationS": 0.25, "yawDegPerS": 45, "leftCmPerS": 3.0},
    {"durationS": 0.25, "forwardCmPerS": -5.0, "yawDegPerS": -90}]}


# --- framing and the checker against the specification's golden lines ---------------------------

GOLDEN_VALID = [  # device-v1.md section 11.1
    "hello*92", "H,threemaze-device,1.0,ball-01,4000,4,fw=demo-1.2,flags=1*9D", "start*3F",
    "S,0,1000000,4000,0,12,-1,35,3*37", "L,0,1002500,1*D5", "S,1,1004000,4000,0,22,-1,65,5*A2",
    "F,1,1006100*71", "S,2,1008000,4000,1,-2026,6,65,5*F2", "S,5,1020000,4000,0,-2010,6,90,7*F3",
    "stop*A5", "Z,6,1022000*9D", "S,41,4294966296,4000,0,2147483647,0,1,0*17",
    "S,42,3000,4000,0,-2147483647,0,2,0*09", "S,4294967295,2500000,4000,0,0,0,0,0*51",
    "S,0,2504000,4000,0,0,0,0,0*D0", "H,threemaze-device,1.0,valve-01,0,0,out=1,ack=1,hb=300*2C",
    "beat*D7", "pulse,1,0,70000*63", "A,1,1010200,1080200*CC", "pulse,2,0,900000*BF", "X,2,range*AD",
    "E,sensor,left sensor did not answer*98", "S,0,1000000,4000,2,12,-1,35,3*8D",
    "S,0,1000000,4000,4,12,-1,35,3*44", "Q,1,2*F8",
]


def test_sim_f3_crc8_smbus():
    assert crc8(b"123456789") == 0xF4 == conformance.crc8(b"123456789")


@pytest.mark.parametrize("line", GOLDEN_VALID)
def test_sim_f3_framing_matches_the_golden_lines(line):
    record = line.rsplit("*", 1)[0]
    assert frame(record).decode() == line


def entries(lines):
    out = []
    for n, line in enumerate(lines, 1):
        who = "host" if line[0].islower() else "device"
        out.append(conformance.Entry(n, who, None, line.encode() + b"\n"))
    return out


def test_checker_on_the_overview_exchange():
    """Section 2: samples 3 and 4 lost in transit, everything else conforms. (Its hello does not
    declare lick=1, yet the device sends an L line: a note, not a finding.)"""
    report = conformance.check(entries(GOLDEN_VALID[:11]))
    assert [(f.rule, f.details.get("missing")) for f in report.findings] == [("D3", [3, 4])]
    assert [n.rule for n in report.notes] == ["4.4"]
    stats = report.stats
    assert (stats["samples"], stats["lick_edges"], stats["frame_edges"]) == (4, 1, 1)
    assert stats["lost_at_end"] == 0


@pytest.mark.parametrize("line, rule", [  # device-v1.md section 11.2
    ("S,1,1004000,4000,0,22,-1,95,5*A2", "F3"),
    ("S,1,1004000,4000,0,22,-1,65,5", "F3"),
    ("S,0,1000000,4000,0,12,-1,35*0C", "F4"),
    ("S,0,1000000,4000,0,12,-1,35,3,4*4C", "F4"),
    ("S,7,1028000,4000,0,1.5,2,3,4*60", "F4"),
    ("S,7,1028000,0,0,1,2,3,4*5D", "F4"),
    ("S,0,1000000,4000,256,12,-1,35,3*DE", "F4"),
    ("S, 7,1028000,4000,0,1,2,3,4*1F", "F4"),
    ("S,0,1000000,4000," + "1" * 250 + "*00", "F2"),
])
def test_checker_rejects_the_golden_bad_lines(line, rule):
    hello = "H,threemaze-device,1.0,ball-01,4000,4,fw=demo-1.2,flags=1*9D"
    report = conformance.check(entries([hello, line]))
    assert [f.rule for f in report.findings] == [rule], report.findings
    assert report.stats["samples"] == 0


def test_checker_ignores_unknown_types_and_reserved_flags_are_d7():
    hello = frame("H,threemaze-device,1.0,ball-01,4000,4").decode()
    report = conformance.check(entries([hello, "Q,1,2*F8", "S,0,1000000,4000,4,12,-1,35,3*44"]))
    assert report.stats["unknown"] == 1
    assert [f.rule for f in report.findings] == ["D7"]


def test_checker_finds_rule_breaks():
    records = ["hello", "H,threemaze-device,1.0,b,4000,1,lick=1", "start", "S,0,4000,4000,0,0",
               "S,1,4000,4000,0,0",            # D4: the clock did not advance
               "S,1,8000,3000,0,0",            # D5: dt is not the window; D2: not the period
               "L,0,4000,1", "S,2,12000,4000,0,0",  # D9: an event of a window already sent
               "L,0,24000,0",                  # D9: sent before the S line of an earlier window
               "S,4,20000,4000,0,0",           # D3: sample 3 missing
               "stop", "Z,5,21000",
               "S,5,24000,4000,0,0",           # D8: after the stop report
               "pulse,1,0,1000"]               # D10 needs an outcome only with ack=1: none here
    report = conformance.check(entries([frame(r).decode() for r in records]))
    assert [f.rule for f in report.findings] == ["D4", "D5", "D2", "D9", "D3", "D9", "D8"], report.findings


# --- streams ----------------------------------------------------------------------------------

@pytest.mark.parametrize("period_us", [50000, 4000, 1000], ids=["20Hz", "250Hz", "1000Hz"])
def test_sim_stream_conforms_at_20_250_1000_hz(period_us):
    host = stream(motion_device(period_us, lick=1, trajectory=B1_LIKE), seconds=2.0)
    report = host.check()
    assert report.ok, [str(f) for f in report.findings]
    samples = 2_000_000 // period_us
    assert report.stats["samples"] == samples
    assert report.stats["dt_us_min"] == report.stats["dt_us_max"] == period_us     # SIM-D2, SIM-D5
    assert [s[0] for s in report.samples] == list(range(samples))                    # SIM-D3
    assert report.stats["lost_at_end"] == 0
    assert report.stats["lick_edges"] == len(host.events("lick")) > 0                 # SIM-D9


def test_sim_d1_one_h_line_per_hello():
    host = Host({"deviceId": "valve-01", "outputs": 1, "hbMs": 300})
    for t in (0, 10, 20):
        host.send(t, "hello")
    assert host.lines("H") == ["H,threemaze-device,1.0,valve-01,0,0,out=1,ack=1,hb=300*2C"] * 3
    assert host.check().ok


def test_sim_d2_samples_keep_coming_when_nothing_moves():
    host = stream({"deviceId": "still", "periodUs": 4000}, seconds=0.1)
    totals = [s[4] for s in host.check().samples]
    assert len(totals) == 25 and set(map(tuple, totals)) == {(0, 0, 0)}


def test_sim_d4_t_us_is_the_window_end_on_the_device_clock():
    host = stream(motion_device(4000, clockStartUs=123), seconds=0.02, start_at=1000)
    assert [s[1] for s in host.check().samples] == [123 + 1000 + 4000 * k for k in range(1, 6)]


def test_sim_d6_running_totals_of_integer_counts():
    """Counts are the rounded running sum of the exact displacement / resolution, never drifting."""
    host = stream(motion_device(50000, trajectory=B1_LIKE), seconds=3.0)
    samples = host.check().samples
    exact = [0.0, 0.0, 0.0]
    rows = []
    for seg in B1_LIKE["segments"]:
        n = math.floor(seg["durationS"] / 0.05 + 0.5)
        rows += [(seg.get("leftCmPerS", 0) * 0.05, seg.get("forwardCmPerS", 0) * 0.05,
                  math.radians(seg.get("yawDegPerS", 0)) * 0.05)] * n
    for k, (_, _, _, _, totals, _) in enumerate(samples):
        move = rows[k % len(rows)]
        exact = [e + m / r for e, m, r in zip(exact, move, (0.0349, 0.0349, 0.05))]
        assert totals == [math.floor(e + 0.5) for e in exact], k
    assert samples[5][4][1] == 6 * 16  # v0.3's simulated running: 16 forward counts per 50 ms


def test_sim_d6_totals_wrap_like_int32(tmp_path):
    big = tmp_path / "big.tsv"
    big.write_text("forward_cm\tleft_cm\tdyaw_rad\n" + "1000\t0\t0\n" * 5, encoding="utf-8")
    entry = motion_device(1000, sensor={"cmPerCount": 1e-6, "radPerCount": 1.0},
                          trajectory={"kind": "samples", "file": str(big)})
    report = stream(entry, seconds=0.005).check()
    assert report.ok
    forward = [s[4][1] for s in report.samples]
    assert forward == [int32(10**9 * k) for k in range(1, 6)] and forward[2] < 0
    assert [int32(b - a) for a, b in zip([0] + forward, forward)] == [10**9] * 5


def test_sim_d8_lines_only_between_start_and_stop_and_each_stream_restarts():
    host = Host(motion_device(4000, trajectory=B1_LIKE))
    host.send(0, "hello")
    host.run(50_000)
    assert host.lines("S") == []
    host.send(50_000, "start")
    host.send(70_000, "stop")
    host.run(200_000)
    host.send(300_000, "start")
    host.send(312_000, "stop")
    host.run(400_000)
    seqs = [int(r[1]) for r in host.records("S")]
    assert seqs == [0, 1, 2, 3, 4, 0, 1, 2]
    assert host.records("S")[5][5:] == host.records("S")[0][5:]  # totals start at 0 again
    assert [r[1] for r in host.records("Z")] == ["5", "3"]
    assert host.check().ok


def test_sim_d9_lick_edges_before_their_window():
    host = stream(motion_device(50000, lick=1, trajectory=B1_LIKE), seconds=1.0)
    lines = host.lines()
    for index, line in enumerate(lines):
        if line.startswith("L,"):
            t_edge = int(line.split(",")[2])
            following = next(item for item in lines[index + 1:] if item.startswith("S,"))
            assert int(following.split(",")[2]) - 50000 < t_edge <= int(following.split(",")[2])
    assert [r[3] for r in host.records("L")] == ["1", "0"] * (len(host.records("L")) // 2)


# --- outputs ----------------------------------------------------------------------------------

def valve(**more):
    return {"deviceId": "valve-01", "outputs": 1, "maxPulseUs": 500_000, **more}


def test_sim_d10_pulse_done_with_device_times():
    host = Host(valve(onLatencyUs=150))
    host.send(0, "hello")
    host.send(1000, "pulse,1,0,70000")
    host.run(200_000)
    assert host.lines("A") == [frame("A,1,1150,71150").decode()]
    off = host.events("pulse_off")[0]
    assert (off["commanded_width_us"], off["width_us"], off["t_on_dev_us"], off["reason"]) == (
        70000, 70000, 1150, "done")
    assert host.check().ok


@pytest.mark.parametrize("command, reason", [
    ("pulse,2,0,900000", "range"), ("pulse,2,0,0", "range"), ("pulse,2,3,1000", "channel"),
    ("pulse,2,0,1000", "busy")])
def test_sim_d10_pulse_refused(command, reason):
    host = Host(valve())
    host.send(0, "hello")
    host.send(10, "pulse,1,0,100000")
    host.send(20, command)
    host.run(300_000)
    assert [r[1:] for r in host.records("X")] == [["2", reason]]
    assert [r[1] for r in host.records("A")] == ["1"]  # exactly one outcome per pulse
    assert host.check().ok


def test_sim_h7_missing_heartbeats_close_the_output():
    host = Host(valve(hbMs=300))
    host.send(0, "hello")
    host.send(1000, "beat")
    host.send(2000, "pulse,1,0,450000")   # beats stop: closed at 1000 + 300 ms
    host.run(1_000_000)
    host.send(1_000_000, "pulse,2,0,1000")  # heartbeat lapsed: refused
    host.run(1_100_000)
    a = host.records("A")[0]
    assert (int(a[2]), int(a[3])) == (2000, 301_000)
    assert host.events("pulse_off")[0]["reason"] == "heartbeat"
    assert [r[1:] for r in host.records("X")] == [["2", "fault"]]
    report = host.check()
    assert report.ok, report.findings


def test_sim_stop_closes_an_open_output():
    host = Host(valve())
    host.send(0, "hello")
    host.send(10, "pulse,1,0,400000")
    host.send(100_010, "stop")
    a = host.records("A")[0]
    assert int(a[3]) - int(a[2]) == 100_000
    assert host.events("pulse_off")[0]["reason"] == "stop"


def test_sim_without_ack_sends_no_outcome():
    host = Host(valve(ack=False))
    host.send(0, "hello")
    host.send(10, "pulse,1,0,1000")
    host.run(10_000)
    assert host.lines("H")[0].startswith("H,threemaze-device,1.0,valve-01,0,0,out=1*")
    assert host.lines("A") == [] and host.events("pulse_off")


@pytest.mark.parametrize("raw", [b"pulse,1,0,70000\n", b"pulse,1,0,70000*64\n", b"pulse,1,0,80000*63\n"])
def test_sim_d11_commands_with_a_bad_checksum_are_ignored(raw):
    host = Host(valve())
    host.send(0, raw=raw)
    host.run(200_000)
    assert host.lines() == [] and host.events("pulse_on") == []
    assert host.events("command_rejected")[0]["reason"] == "missing or wrong checksum"


def test_sim_unknown_command_answered_with_an_e_line():
    host = Host(valve())
    host.send(0, "reset")
    host.send(10, "start")  # no samples on an output-only device
    assert [r[:2] for r in host.records("E")] == [["E", "unknown_command"]] * 2
    assert host.check().ok


# --- faults -----------------------------------------------------------------------------------

FAULTS = [
    ({"type": "drop", "seq": 10, "count": 3}, [("D3", [10, 11, 12])]),
    ({"type": "badCrc", "seq": 10}, [("F3", None), ("D3", [10])]),
    ({"type": "truncate", "seq": 10, "keepBytes": 9}, [("F3", None), ("D3", [10, 11])]),
    ({"type": "split", "seq": 10, "pieces": 4, "gapUs": 900}, []),
    ({"type": "burst", "seq": 10, "count": 5}, []),
    ({"type": "silence", "seq": 10, "durationMs": 30}, [("D3", list(range(10, 18)))]),
    ({"type": "wrap", "seq": 10}, []),
]


@pytest.mark.parametrize("fault, found", FAULTS, ids=[f["type"] for f, _ in FAULTS])
def test_sim_fault_produced_logged_and_seen(fault, found):
    host = stream(motion_device(4000, trajectory=B1_LIKE, faults=[fault]), seconds=0.2)
    logged = host.events("fault")
    assert [(f["type"], f["seq"]) for f in logged] == [(fault["type"], fault["seq"])]
    report = host.check()
    assert [(f.rule, f.details.get("missing")) for f in report.findings] == found, report.findings
    arrived = {s[0]: s[5] for s in report.samples}
    if fault["type"] == "split":  # sample 10's window ends at 1000 + 11 x 4000 us
        assert [t for t, _ in host.chunks if 45_000 <= t < 49_000] == [45_000, 45_900, 46_800, 47_700]
        assert 10 in arrived and len(logged[0]["piece_bytes"]) == 4
    if fault["type"] == "burst":
        times = [arrived[s] for s in range(10, 15)]
        assert len(set(times)) == 1 and times[0] == arrived[15] - 4000 * 1000
    if fault["type"] == "wrap":
        assert report.stats["clock_wraps"] == 1
        assert report.samples[9][1] > report.samples[10][1]
    if fault["type"] == "truncate":  # the partial line runs into the next one
        bad = host.entries[[f for f in report.findings if f.rule == "F3"][0].n - 1].data
        assert bad.startswith(b"S,10,") and b"S,11," in bad and len(bad.split(b"S,11,")[0]) == 9


def test_sim_burst_lines_go_out_before_the_stop_report():
    host = stream(motion_device(4000, faults=[{"type": "burst", "seq": 3, "count": 50}]), seconds=0.03)
    report = host.check()
    assert report.ok and host.lines()[-1].startswith("Z,")
    # Every sample produced arrived: the held ones were not left behind the stop report
    produced = int(host.records("Z")[0][1])
    assert report.stats["samples"] == produced == 7 and report.stats["lost_at_end"] == 0


def test_sim_d8_held_lines_go_out_before_a_new_stream():
    """A start while streaming starts a new stream (device-v1.md section 5): the lines a burst
    still holds go out first, never among the new stream's lines."""
    host = Host(motion_device(4000, faults=[{"type": "burst", "seq": 3, "count": 50}]))
    host.send(0, "start")
    host.send(30_000, "start")
    host.send(50_000, "stop")
    host.run(400_000)
    sent = [(t, int(r.split(",")[1])) for t, r in
            ((t, data.decode()) for t, data in host.chunks) if r.startswith("S,")]
    assert [seq for _, seq in sent] == [0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4]
    assert all(t <= 30_000 for t, _ in sent[:7])


# --- trajectories -----------------------------------------------------------------------------

def test_segments_hold_still_after_the_end_unless_looped():
    once = dict(B1_LIKE, loop=False)
    totals = [s[4] for s in stream(motion_device(50000, trajectory=once), seconds=2.0).check().samples]
    assert totals[19] == totals[-1] and totals[19] != [0, 0, 0]


def test_samples_file(tmp_path):
    path = tmp_path / "moves.csv"
    path.write_text("# a comment\nforward_cm,left_cm,dyaw_rad,lick\n0.5584,0,0,0\n0,0.0349,-0.1,1\n",
                    encoding="utf-8")
    host = stream(motion_device(50000, lick=1, trajectory={"kind": "samples", "file": str(path)}), 0.2)
    assert [s[4] for s in host.check().samples] == [[0, 16, 0], [1, 16, -2], [1, 16, -2], [1, 16, -2]]
    assert len(host.records("L")) == 2


def raw_capture(lines):
    head = '# {"format": "three-maze raw capture 1"}\n'
    return head + "".join(f"{1000 + n}\t{line}\r\n" for n, line in enumerate(lines))


def test_replay_of_a_legacy_capture(tmp_path):
    path = tmp_path / "legacy.tsv"
    path.write_text(raw_capture([
        "[INFO] streaming",
        "50000,0,16,50000,0,16,50000,0,16,0,0,0,1",
        "60000,0,16,x,0,16,50000,9,16,0,0,0,1",  # field 3 is no number: v0.3 skips the line
        "100000,3,11,50000,4,13,50000,5,12,-3,1,0,2",
        "150000,0,16,50000,0,16,50000,0,16,0,1,0,3",
        "200000,0,16,50000,0,16,50000,0,16,0,0,0,4"]), encoding="utf-8")
    entry = motion_device(4000, lick=1, trajectory={"kind": "replay", "file": str(path)})
    host = stream(entry, seconds=0.024)
    totals = [s[4] for s in host.check().samples]
    assert totals == [[0, 16, 0], [5, 28, -3], [5, 44, -3], [5, 60, -3], [5, 60, -3], [5, 60, -3]]
    assert [r[3] for r in host.records("L")] == ["1", "0"]


def test_replay_of_a_v1_capture_keeps_the_motion_of_lost_samples(tmp_path):
    path = tmp_path / "v1.txt"
    lines = [frame(r).decode() for r in ("S,0,4000,4000,0,0,5,0", "S,1,8000,4000,0,1,10,0",
                                          "S,4,20000,4000,0,4,25,-2")]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    host = stream(motion_device(50000, trajectory={"kind": "replay", "file": str(path)}), 0.15)
    assert [s[4] for s in host.check().samples] == [[0, 5, 0], [1, 10, 0], [4, 25, -2]]


def test_replay_rejects_mixed_or_fractional_recordings(tmp_path):
    mixed = tmp_path / "mixed.txt"
    mixed.write_text(frame("S,0,4000,4000,0,0,5,0").decode() + "\n50000,0,16,50000,0,16,50000,0,16,0,0,0,1\n",
                     encoding="utf-8")
    fractional = tmp_path / "frac.txt"
    fractional.write_text("50000,0,16,50000,0,16,50000,0.5,16,0,0,0,1\n", encoding="utf-8")
    for path, text in ((mixed, "v0.3 line in a recording of v1 lines"), (fractional, "not whole counts")):
        with pytest.raises(MotionError, match=text):
            config_from_entry(motion_device(4000, trajectory={"kind": "replay", "file": str(path)}), Path)


# --- configuration ----------------------------------------------------------------------------

@pytest.mark.parametrize("entry, pointer", [
    ({"deviceId": "v", "outputs": 1, "faults": [{"type": "drop", "seq": 1}]}, "/faults"),
    (motion_device(4000, sensor=None, trajectory=B1_LIKE), "/sensor"),
    (motion_device(4000, faults=[{"type": "split", "seq": 1, "pieces": 5, "gapUs": 1000}]), "/faults/0/gapUs"),
    (motion_device(4000, faults=[{"type": "drop", "seq": 1, "count": 3}, {"type": "badCrc", "seq": 3}]),
     "/faults/1"),
    (motion_device(4000, faults=[{"type": "wrap", "seq": 1}, {"type": "wrap", "seq": 9}]), "/faults/1"),
])
def test_config_problems(entry, pointer):
    entry = {k: v for k, v in entry.items() if v is not None}
    assert pointer in [p for p, _ in config_problems(entry)]


def test_defaults_match_the_schema():
    """The model reads entries without the schema's defaults applied, so its own defaults must be
    the schema's (the rig file documents those)."""
    from threemaze.config.rig import load_schema
    from threemaze.devices.sim.model import SimConfig, _fault, kind_loops
    defs = load_schema()["$defs"]
    props = defs["simulatedDevice"]["properties"]
    schema = (props["ack"]["default"], props["lick"]["default"], props["onLatencyUs"]["default"],
              props["clockStartUs"]["default"], props["lineEnding"]["default"])
    for cfg in (SimConfig(device_id="x"), config_from_entry({"deviceId": "x"}, Path)):
        assert schema == (cfg.ack, cfg.lick, cfg.on_latency_us, cfg.clock_start_us, cfg.line_ending)
    assert kind_loops("segments") is defs["segmentsTrajectory"]["properties"]["loop"]["default"]
    assert kind_loops("replay") is defs["fileTrajectory"]["properties"]["loop"]["default"]
    assert _fault({"type": "drop", "seq": 1}).count == defs["faultDrop"]["properties"]["count"]["default"]
    segment = defs["segmentsTrajectory"]["properties"]["segments"]["items"]["properties"]
    assert {key: segment[key]["default"] for key in segment if "default" in segment[key]} == {
        "forwardCmPerS": 0, "leftCmPerS": 0, "yawDegPerS": 0, "lick": 0}


def test_crlf_line_ending():
    host = stream(motion_device(4000, lineEnding="crlf"), seconds=0.01)
    assert all(e.data.endswith(b"\r\n") for e in host.entries if e.who == "device")
    assert host.check().ok


def test_wrap_places_the_clock_wrap_between_two_samples():
    host = stream(motion_device(4000, faults=[{"type": "wrap", "seq": 3}]), seconds=0.03)
    t = [s[1] for s in host.check().samples]
    assert t[2] == U32 - 2000 and t[3] == 2000
