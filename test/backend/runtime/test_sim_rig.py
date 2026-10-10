"""The 'sim' rig (rigs/sim.json) runs end to end in the test's own process (plan items DPR-06a and
DPR-02): rig file validated, session folder with the rig file copied and hashed, devices opened,
started, stopped and closed; the simulated device streams device protocol v1 in real time, and
its raw log conforms (the end-to-end sim's conformance checker)."""
import hashlib
import json
import time
from pathlib import Path

import pytest

from threemaze.config import RigFileError, load_rig
from threemaze.core import SessionState
from threemaze.runtime import Session, SessionError, TaskSource
from threemaze_sim import conformance


def test_sim_rig_runs_end_to_end(sim_rig_path, tmp_path):
    with Session() as session:
        session.configure(sim_rig_path, data_root=tmp_path, session_id="ses-test_rig-sim")
        session.set_task(TaskSource("declarative", "test-task"))
        folder = session.arm()
        session.start()
        session.stop()

    assert session.state is SessionState.COMPLETE
    assert folder == tmp_path / "ses-test_rig-sim"
    raw = sim_rig_path.read_bytes()
    assert (folder / "rig.json").read_bytes() == raw
    digest = hashlib.sha256(raw).hexdigest()
    assert (folder / "rig.json.sha256").read_text(encoding="ascii") == f"{digest}  rig.json\n"
    assert session.rig.sha256 == digest
    assert sorted(p.name for p in (folder / "sim").iterdir()) == ["ball.jsonl", "valve.jsonl"]


def test_the_copy_is_of_the_bytes_validated(sim_rig_path, tmp_path):
    """A rig file edited after configure() does not change the session: it keeps its snapshot."""
    rig_file = tmp_path / "rig" / "sim.json"
    rig_file.parent.mkdir()
    rig_file.write_bytes(sim_rig_path.read_bytes())
    session = Session()
    session.configure(rig_file, data_root=tmp_path / "data")
    rig_file.write_text("{}", encoding="utf-8")
    session.set_task(TaskSource("declarative", "test-task"))
    folder = session.arm()
    session.abort("test over")
    assert (folder / "rig.json").read_bytes() == sim_rig_path.read_bytes()


def test_sessions_never_share_a_folder(sim_rig_path, tmp_path):
    folders = []
    for _ in range(2):
        session = Session()
        session.configure(sim_rig_path, data_root=tmp_path, session_id="ses-same")
        session.set_task(TaskSource("declarative", "test-task"))
        folders.append(session.arm())
        session.abort("test over")
    assert [f.name for f in folders] == ["ses-same", "ses-same-2"]


# --- the simulated device in real time, in the runtime's process (plan item DPR-02) -------------

def run_sim_rig(path, data_root, seconds, pulses=()):
    session = Session()
    session.configure(path, data_root=data_root)
    session.set_task(TaskSource("declarative", "test-task"))
    session.arm()
    session.start()
    time.sleep(seconds)
    for width_us in pulses:
        session.outputs["reward"].pulse(0, width_us)
        time.sleep(width_us / 1e6 + 0.05)
    session.stop()
    return session


@pytest.mark.parametrize("period_us", [50000, 4000, 1000], ids=["20Hz", "250Hz", "1000Hz"])
def test_sim_rig_streams_device_protocol_v1(sim_rig_data, write_rig, tmp_path, period_us):
    sim_rig_data["devices"]["ball"]["periodUs"] = period_us
    session = run_sim_rig(write_rig(sim_rig_data), tmp_path / "data", 0.4)
    assert session.state is SessionState.COMPLETE
    report = conformance.check_file(session.dir / "raw" / "ball.tsv")
    assert report.ok, [str(f) for f in report.findings]
    stats = report.stats
    assert stats["hello"]["device_id"] == "sim-ball" and stats["hello"]["period_us"] == period_us
    # Rule H1: each line stamped with the session clock when the read that completed it returned
    stamps = [t_ns for *_, t_ns in report.samples]
    assert stamps == sorted(stamps)
    assert session.anchors["armed"].perf_ns < stamps[0] and stamps[-1] < session.anchors["complete"].perf_ns
    assert stats["samples"] >= 0.2e6 / period_us  # timing is not judged here; the e2e sim self-test reports it
    assert stats["lost_at_end"] == 0 and stats["seq_gaps"] == 0
    assert stats["dt_us_min"] == stats["dt_us_max"] == period_us
    forward = [totals[1] for *_, totals, _ in report.samples]
    assert forward[-1] > 0
    if period_us == 50000:  # 11.168 cm/s at 0.0349 cm per count: 16 counts per 50 ms, as v0.3's sim
        assert forward == [16 * k for k in range(1, len(forward) + 1)]
    ball = session.devices["ball"].describe()
    assert ball["hello"]["n_axes"] == 3 and ball["stop_report"].startswith("Z,")


def test_sim_rig_valve_answers_pulses(sim_rig_path, tmp_path):
    session = run_sim_rig(sim_rig_path, tmp_path, 0.05, pulses=[70000])
    report = conformance.check_file(session.dir / "raw" / "valve.tsv")
    assert report.ok and report.stats["acks"] == 1
    log = [json.loads(line) for line in (session.dir / "sim" / "valve.jsonl").read_text().splitlines()]
    off = [r for r in log if r["event"] == "pulse_off"]
    assert [(r["commanded_width_us"], r["width_us"], r["reason"]) for r in off] == [(70000, 70000, "done")]


def test_sim_rig_faults_from_the_rig_file(sim_rig_data, write_rig, tmp_path):
    ball = sim_rig_data["devices"]["ball"]
    ball["periodUs"] = 4000
    ball["faults"] = [{"type": "drop", "seq": 5, "count": 2}, {"type": "badCrc", "seq": 20}]
    session = run_sim_rig(write_rig(sim_rig_data), tmp_path / "data", 0.3)
    report = conformance.check_file(session.dir / "raw" / "ball.tsv")
    assert [(f.rule, f.details.get("missing")) for f in report.findings] == [
        ("D3", [5, 6]), ("F3", None), ("D3", [20])]
    log = [json.loads(line) for line in (session.dir / "sim" / "ball.jsonl").read_text().splitlines()]
    assert [(r["type"], r["seq"]) for r in log if r["event"] == "fault"] == [("drop", 5), ("badCrc", 20)]


@pytest.mark.parametrize("content", [None, "50000,0,16,50000,0,16,50000,0.5,16,0,0,0,1\n"],
                         ids=["missing", "fractional counts"])
def test_unusable_trajectory_file_fails_before_armed(sim_rig_data, write_rig, tmp_path, content):
    """The file a rig file names is part of it: a missing or unusable one is reported with its
    pointer when the session is configured, and nothing is written."""
    sim_rig_data["devices"]["ball"]["trajectory"] = {"kind": "replay", "file": "capture.tsv"}
    path = write_rig(sim_rig_data)
    if content is not None:
        (path.parent / "capture.tsv").write_text(content, encoding="utf-8")
    session = Session()
    with pytest.raises(RigFileError) as excinfo:
        session.configure(path, data_root=tmp_path / "data")
    assert [issue.pointer for issue in excinfo.value.issues] == ["/devices/ball/trajectory/file"]
    assert "capture.tsv" in str(excinfo.value)
    assert session.state is SessionState.IDLE and not (tmp_path / "data").exists()


def test_trajectory_file_gone_by_arming_aborts(sim_rig_data, write_rig, tmp_path):
    sim_rig_data["devices"]["ball"]["trajectory"] = {"kind": "replay", "file": "capture.tsv"}
    path = write_rig(sim_rig_data)
    capture = path.parent / "capture.tsv"
    capture.write_text("50000,0,16,50000,0,16,50000,0,16,0,0,0,1\n", encoding="utf-8")
    session = Session()
    session.configure(path, data_root=tmp_path / "data")
    session.set_task(TaskSource("declarative", "test-task"))
    capture.unlink()
    with pytest.raises(SessionError, match="capture.tsv"):
        session.arm()
    assert session.state is SessionState.ABORTED


@pytest.mark.parametrize("old, new, message", [
    ("sim-ball", "other-ball", "device_id 'other-ball'"),
    # Rule H5: n_axes against the columns of the calibration matrix
    ("sim-ball,50000,3", "sim-ball,50000,4", "n_axes 4 (calibration: 3 columns)"),
])
def test_hello_that_does_not_match_the_rig_file_aborts_arming(sim_rig_path, tmp_path, monkeypatch,
                                                              old, new, message):
    from threemaze.devices.sim.model import SimDevice
    real = SimDevice._hello
    monkeypatch.setattr(SimDevice, "_hello", lambda self: real(self).replace(old, new))
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    with pytest.raises(SessionError) as excinfo:
        session.arm()
    assert message in str(excinfo.value)
    assert session.state is SessionState.ABORTED


@pytest.mark.parametrize("hb_ms, arms", [(299, False), (300, True)])
def test_heartbeat_timeout_below_300_ms_refused(sim_rig_data, write_rig, tmp_path, hb_ms, arms):
    """Rule H5: a declared heartbeat timeout below three 100 ms heartbeat periods refuses to arm."""
    sim_rig_data["devices"]["valve"]["hbMs"] = hb_ms
    session = Session()
    session.configure(write_rig(sim_rig_data), data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    if arms:
        session.arm()
        assert session.devices["valve"].hello["keys"]["hb"] == "300"
        session.abort("test over")
    else:
        with pytest.raises(SessionError, match="hb '299': a heartbeat timeout below 300 ms"):
            session.arm()
        assert session.state is SessionState.ABORTED


def device_log(session, name):
    path = session.dir / "sim" / f"{name}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_ending_a_session_closes_an_open_pulse(sim_rig_path, tmp_path):
    """Outputs are made safe when the session ends: a 10 s pulse ends at once, with its
    outcome."""
    session = Session()
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    session.arm()
    session.start()
    session.outputs["reward"].pulse(0, 10_000_000)
    time.sleep(0.1)
    session.stop()
    off = [r for r in device_log(session, "valve") if r["event"] == "pulse_off"]
    assert [(r["commanded_width_us"], r["reason"]) for r in off] == [(10_000_000, "stop")]
    assert 0 < off[0]["width_us"] < 1_000_000
    report = conformance.check_file(session.dir / "raw" / "valve.tsv")
    assert report.ok and report.stats["acks"] == 1


def test_one_device_for_motion_and_reward(sim_rig_data, write_rig, tmp_path):
    """Making the outputs safe stops the stream of a device that also streams: the stop report
    still arrives, and no second stop follows."""
    del sim_rig_data["devices"]["valve"]
    sim_rig_data["devices"]["ball"]["outputs"] = 1
    sim_rig_data["bindings"]["reward"] = "ball"
    session = run_sim_rig(write_rig(sim_rig_data), tmp_path / "data", 0.2)
    assert session.state is SessionState.COMPLETE
    assert session.devices["ball"].stop_report.startswith("Z,")
    commands = [r["command"] for r in device_log(session, "ball") if r["event"] == "command"]
    assert commands == ["stop", "hello", "start", "stop"]
    report = conformance.check_file(session.dir / "raw" / "ball.tsv")
    assert report.ok and report.stats["lost_at_end"] == 0


def test_gate_rig_file_is_valid():
    rig = load_rig(Path(__file__).resolve().parents[3] / "rigs" / "sim-gate.json")
    ball = rig.devices["ball"].config
    assert ball["periodUs"] == 50000 and ball["trajectory"]["kind"] == "segments" and ball["lick"] == 1
