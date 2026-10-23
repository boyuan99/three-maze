"""The session record, session.json (plan item DPR-08a): valid against schema/session-v1.schema.json
at every stage of a session; the versions of ADR-0004 Decision 1 recorded from a mock motion hello
and from the runtime's environment; the render host from the ready report; each device's protocol
profile and guarantee level (device protocol v1, section 8.3); clock anchors; updates from the
link server that do not wait for the disk; and a runtime killed during a session leaves the record
running, which the next session detects and marks crashed."""
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import jsonschema
import pytest

from threemaze.devices.guarantees import FLAGS, levels, protocol_record, v1_flags
from threemaze.devices.simulated import SimulatedDevice
from threemaze.record import read_log
from threemaze.record import session as record_module
from threemaze.record.formats import EVENTS, FORMAT_VERSION
from threemaze.record.session import (LOCK_FILE, SESSION_JSON, find_crashed_sessions,
                                      lock_is_free, mark_crashed)
from threemaze.runtime import Session, SessionError, TaskSource
from threemaze.runtime import session as runtime_module

REPO = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((REPO / "schema" / "session-v1.schema.json").read_text(encoding="utf-8"))
EXAMPLES = REPO / "protocol" / "v1" / "examples"
CHILD = Path(__file__).with_name("session_child.py")

# ADR-0004 Decision 1: exact pins for electron, @dimforge/rapier3d-compat, three and ajv, which the
# motion worker reports in its hello (link protocol C5, with Chromium and V8: DPR-08a), and every
# package in requirements.txt, which the runtime finds in its own environment
HELLO_VERSIONS = {"electron": "44.7.0", "chromium": "152.0.7444.59", "v8": "15.2.110",
                  "three": "0.169.0", "rapier3d-compat": "0.14.0", "ajv": "8.20.0"}


def motion_hello(session_id, **versions):
    data = json.loads((EXAMPLES / "hello--motion.json").read_text(encoding="utf-8"))["data"]
    data.update(session=session_id, versions={**HELLO_VERSIONS, **versions},
                token="0123456789abcdef0123456789abcdef")
    return data


def record_of(folder):
    return json.loads((Path(folder) / SESSION_JSON).read_text(encoding="utf-8"))


def valid(record):
    validator = jsonschema.Draft202012Validator(SCHEMA)
    errors = sorted(validator.iter_errors(record), key=lambda e: list(e.absolute_path))
    assert not errors, [f"{list(e.absolute_path)}: {e.message}" for e in errors]
    return record


def new_session(rig, data_root, session_id=None):
    session = Session()
    session.configure(rig, data_root=data_root, session_id=session_id)
    session.set_task(TaskSource("declarative", "test-task"))
    return session


def test_the_schema_is_a_valid_2020_12_schema():
    jsonschema.Draft202012Validator.check_schema(SCHEMA)


def walk(node, where="#"):
    if isinstance(node, dict):
        yield node, where
        for key, value in node.items():
            yield from walk(value, f"{where}/{key}")
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from walk(value, f"{where}/{i}")


def test_every_pattern_ends_at_the_true_end_of_the_string():
    """As in the link protocol's schemas: Python's $ also matches before a final line end and
    Ajv's does not, so a session id ending in one would pass one validator and fail the other."""
    patterns = [(node["pattern"], where) for node, where in walk(SCHEMA) if "pattern" in node]
    assert len(patterns) >= 6
    for pattern, where in patterns:
        assert pattern.startswith("^") and pattern.endswith(r"(?![\s\S])"), where
    session_id = jsonschema.Draft202012Validator(
        {"$defs": SCHEMA["$defs"], "$ref": "#/$defs/session_id"})
    assert session_id.is_valid("ses-20261022T101500_rig-sim")
    assert not session_id.is_valid("ses-20261022T101500_rig-sim\n")


def test_the_record_is_valid_at_every_stage(sim_rig_path, tmp_path):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    armed = valid(record_of(folder))
    assert (armed["status"], armed["state"]) == ("running", "armed")
    assert [s["state"] for s in armed["states"]] == ["configured", "armed"]
    assert armed["format_version"] == FORMAT_VERSION and armed["session"] == session.session_id
    assert not lock_is_free(folder / LOCK_FILE)  # held while the session is open
    session.record.client_hello(motion_hello(session.session_id), t_host_ns=11)
    session.recorder.render_report(
        json.loads((EXAMPLES / "render.report--ready.json").read_text())["data"], t_host_ns=12)
    valid(record_of(folder))
    session.start()
    running = valid(record_of(folder))
    assert running["state"] == "running" and running["clock"]["start"] is not None
    time.sleep(0.15)
    session.stop()
    done = valid(record_of(folder))
    assert (done["status"], done["state"], done["abort_reason"]) == ("complete", "complete", None)
    assert [s["state"] for s in done["states"]] == ["configured", "armed", "running", "stopping",
                                                    "complete"]
    for state in ("running", "complete"):
        assert {"perf_ns": session.anchors[state].perf_ns,
                "wall_utc": session.anchors[state].wall_utc} == done["clock"][
            "start" if state == "running" else "stop"]
    assert done["recording"] == session.recording and done["recording"]["errors"] == []
    assert not (folder / LOCK_FILE).exists() and not (folder / "session.json.tmp").exists()
    assert done["subject"] is None  # D16 open


def test_the_rig_file_and_the_task(sim_rig_path, tmp_path):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    session.abort("test over")
    rig = valid(record_of(folder))["rig"]
    assert rig["sha256"] == session.rig.sha256 and rig["copy"] == "rig.json"
    assert (folder / rig["copy"]).read_bytes() == sim_rig_path.read_bytes()
    assert Path(rig["source"]) == sim_rig_path.resolve()
    assert rig["bindings"] == {"motion": "ball", "reward": "valve"}
    assert rig["in_force"]["motion"] == {"eyeHeight": 3.7, "maxSpeed": 141}  # maxSpeed: default
    assert record_of(folder)["task"] == {"kind": "declarative", "ref": "test-task"}


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def pinned_requirements():
    """name -> version of every exact pin in requirements.txt that applies to this platform."""
    pins = {}
    for line in (REPO / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        spec, _, marker = line.partition(";")
        if marker.strip() and marker.strip() != f'sys_platform == "{sys.platform}"':
            continue
        name, version = spec.strip().split("==")
        pins[normalized(name)] = version
    return pins


def test_every_version_of_adr_0004_decision_1_is_recorded(sim_rig_path, tmp_path):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    session.record.client_hello(motion_hello(session.session_id), t_host_ns=42)
    session.abort("test over")
    record = valid(record_of(folder))
    client = record["client"]
    assert client["versions"] == HELLO_VERSIONS
    assert (client["role"], client["impl"], client["protocol_version"], client["t_host_ns"]) == (
        "motion", "three-maze-motion-worker", "1.0", 42)
    assert "token" not in json.dumps(record)  # the session token is never written down
    packages = {normalized(name): version for name, version in
                record["runtime"]["packages"].items()}
    pins = pinned_requirements()
    assert "jsonschema" in pins and len(pins) > 10
    assert {name: packages.get(name) for name in pins} == pins
    assert record["runtime"]["python"]["version"] == ".".join(map(str, sys.version_info[:3]))


def test_the_checkout_is_named_by_its_commit(sim_rig_path, tmp_path):
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True,
                          text=True)
    if head.returncode != 0:
        pytest.skip("not a git checkout")
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    session.abort("test over")
    three_maze = record_of(folder)["runtime"]["three_maze"]
    package = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["version"]
    assert three_maze["git_commit"] == head.stdout.strip() and three_maze["version"] == package
    assert isinstance(three_maze["git_dirty"], bool)


@pytest.mark.parametrize("ready", [
    {},
    {"host": "main", "fallback_reason": "OffscreenCanvas is not available in this window"},
], ids=["main", "fallback"])
def test_the_render_host_comes_from_the_ready_report(sim_rig_path, tmp_path, ready):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    data = json.loads((EXAMPLES / "render.report--ready.json").read_text())["data"]
    data.update(ready)
    session.recorder.render_report(data, t_host_ns=77)
    session.abort("test over")
    render = valid(record_of(folder))["render"]
    assert (render["host"], render["fallback_reason"], render["t_host_ns"]) == (
        "main", ready.get("fallback_reason"), 77)
    assert render["refresh_hz"] == 60 and render["settings"]["shadows"] is False
    assert [e["kind"] for e in read_log(folder / EVENTS).records if e["src"] == "render"] == [
        "ready"]


def test_rig_information_and_build(sim_rig_path, tmp_path):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    info = {"schema": "three-maze/rig-info@1", "primary_display_id": 1,
            "displays": [{"id": 1, "primary": True, "refresh_hz": 60, "scale_factor": 1}],
            "gpu": {"webgl": {"default": {"renderer": "ANGLE (NVIDIA)"}}}}
    session.record.set_rig_info(info)
    session.record.set_build("rig", "ab" * 32)
    session.abort("test over")
    record = valid(record_of(folder))
    assert record["rig_info"] == info
    assert record["build"] == {"kind": "rig", "dist_sha256": "ab" * 32}


# --- who waits for the disk -----------------------------------------------------------------------

def test_updates_from_the_link_server_do_not_wait_for_the_disk(sim_rig_path, tmp_path,
                                                                monkeypatch):
    """The hello and the ready report arrive on the link server's event loop, which also carries
    the samples and the heartbeats (link protocol, B1 and B2): they must not wait for the disk."""
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    disk = threading.Event()
    write_text = record_module._write_text

    def slow_disk(path, text):
        assert disk.wait(10), "the disk was never released"
        write_text(path, text)

    monkeypatch.setattr(record_module, "_write_text", slow_disk)
    ready = json.loads((EXAMPLES / "render.report--ready.json").read_text())["data"]
    started = time.perf_counter()
    session.record.client_hello(motion_hello(session.session_id), t_host_ns=21)
    session.recorder.render_report(ready, t_host_ns=22)
    session.record.set_build("rig", "cd" * 32)
    assert time.perf_counter() - started < 0.5   # none of them waited for the stuck disk
    assert record_of(folder)["client"] is None    # not on disk yet
    assert not session.record.flush(timeout_s=0.2)
    disk.set()
    assert session.record.flush(timeout_s=5)
    record = valid(record_of(folder))
    assert (record["client"]["t_host_ns"], record["render"]["t_host_ns"],
            record["build"]["kind"]) == (21, 22, "rig")
    session.abort("test over")


def test_every_record_is_written_while_the_lock_is_held(sim_rig_path, tmp_path, monkeypatch):
    """mark_crashed() reads a record again under the session's lock, so a runtime must write its
    last record before it releases the lock: otherwise a session that ends while another runtime
    arms could be read as still running, with its lock free, and be marked crashed."""
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    seen = []
    write_text = record_module._write_text

    def write_and_check(path, text):
        if path.name == SESSION_JSON:
            seen.append((json.loads(text)["status"], lock_is_free(folder / LOCK_FILE)))
        write_text(path, text)

    monkeypatch.setattr(record_module, "_write_text", write_and_check)
    session.start()
    session.stop()
    assert seen == [("running", False), ("running", False), ("complete", False)]
    assert lock_is_free(folder / LOCK_FILE) and record_of(folder)["status"] == "complete"


def test_the_last_record_has_every_update_and_a_later_one_is_dropped(sim_rig_path, tmp_path,
                                                                     caplog):
    session = new_session(sim_rig_path, tmp_path)
    folder = session.arm()
    session.record.client_hello(motion_hello(session.session_id), t_host_ns=31)
    session.abort("test over")                   # right after the hello: no flush in between
    last = valid(record_of(folder))
    assert last["status"] == "aborted" and last["client"]["t_host_ns"] == 31
    session.record.set_build("rig", "ef" * 32)   # after the end: logged, not recorded
    assert record_of(folder) == last and session.record.data["build"]["kind"] is None
    assert "arrived after the session ended; not recorded" in caplog.text


def test_devices_with_their_protocol_and_guarantee_level(sim_rig_data, write_rig, tmp_path):
    sim_rig_data["devices"]["valve"]["ack"] = False
    session = new_session(write_rig(sim_rig_data), tmp_path)
    folder = session.arm()
    ball = record_of(folder)["devices"]["ball"]
    assert ball["guarantees"]["stop_report"] is False  # no stop report before the stream ends
    session.start()
    time.sleep(0.1)
    session.stop()
    devices = valid(record_of(folder))["devices"]
    ball, valve = devices["ball"], devices["valve"]
    assert (ball["roles"], ball["profile"], ball["completeness"], ball["integrity"],
            ball["seq_source"], ball["time_source"]) == (["motion"], "v1", "counted", "crc8",
                                                         "device", "device")
    assert ball["guarantees"] == {flag: True for flag in FLAGS}
    assert ball["hello"]["device_id"] == "sim-ball" and ball["hello"]["n_axes"] == 3
    assert (valve["roles"], valve["output_timing"]) == (["reward"], "unreported")
    # Rule H9 names each device, so the valve, a v1 device that streams nothing, states its
    # profile too; it sends no stop report
    assert (valve["profile"], valve["integrity"], valve["hello"]["device_id"]) == (
        "v1", "crc8", "sim-valve")
    assert valve["guarantees"] == {**{flag: True for flag in FLAGS}, "stop_report": False}


def test_one_device_for_motion_and_reward(sim_rig_data, write_rig, tmp_path):
    del sim_rig_data["devices"]["valve"]
    sim_rig_data["devices"]["ball"]["outputs"] = 1
    sim_rig_data["bindings"]["reward"] = "ball"
    session = new_session(write_rig(sim_rig_data), tmp_path)
    folder = session.arm()
    session.abort("test over")
    ball = valid(record_of(folder))["devices"]["ball"]
    assert ball["roles"] == ["motion", "reward"] and ball["output_timing"] == "hardware"


@pytest.mark.parametrize("flags, expected", [
    (v1_flags(hello=True, stop_report=True), ("counted", "crc8", "device", "device")),
    ({**v1_flags(hello=False, stop_report=False), "device_seq": False},
     ("inferred", "crc8", "host", "device")),
    ({**v1_flags(hello=False, stop_report=False), "device_seq": False, "device_time": False,
      "checksum": False}, ("received", "parse-only", "host", "host")),
])
def test_levels_follow_the_flags(flags, expected):
    """Device protocol v1, section 8.2."""
    got = levels(flags)
    assert expected == (got["completeness"], got["integrity"], got["seq_source"],
                        got["time_source"])
    assert protocol_record("v1", flags)["guarantees"] == flags
    with pytest.raises(ValueError):
        protocol_record("v1", {"hello": True})


def test_an_arming_failure_is_recorded(sim_rig_path, tmp_path, monkeypatch):
    def fail(self):
        raise OSError("valve not found")

    monkeypatch.setattr(SimulatedDevice, "open", fail)
    session = new_session(sim_rig_path, tmp_path)
    with pytest.raises(SessionError):
        session.arm()
    record = valid(record_of(session.dir))
    assert (record["status"], record["state"]) == ("aborted", "aborted")
    assert "valve not found" in record["abort_reason"] and record["recording"] is None
    assert not (session.dir / LOCK_FILE).exists()


# --- a runtime killed during a session ------------------------------------------------------------

def wait_until(condition, timeout_s=10.0):
    deadline = time.monotonic() + timeout_s
    while not condition():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.05)
    return True


def test_a_killed_runtime_leaves_running_and_the_next_session_detects_it(sim_rig_path, tmp_path):
    data_root = tmp_path / "data"
    child = subprocess.Popen([sys.executable, str(CHILD), str(sim_rig_path), str(data_root),
                              "ses-killed"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        line = child.stdout.readline().decode()
        assert line.startswith("running "), child.stderr.read().decode(errors="replace")
        folder = Path(line[len("running "):].strip())
        assert record_of(folder)["status"] == "running"
        assert find_crashed_sessions(data_root) == []  # alive: its lock is held
    finally:
        child.kill()
        child.wait(10)
        child.stdout.close()
        child.stderr.close()

    left = valid(record_of(folder))
    assert (left["status"], left["state"]) == ("running", "running")
    assert (folder / LOCK_FILE).exists()
    assert wait_until(lambda: lock_is_free(folder / LOCK_FILE))  # the OS released it

    session = new_session(sim_rig_path, data_root, session_id="ses-next")
    new_folder = session.arm()
    session.abort("test over")
    crashed = valid(record_of(folder))
    assert crashed["status"] == "crashed"
    assert (crashed["crash"]["detected_by"], crashed["crash"]["last_state"]) == ("ses-next",
                                                                                  "running")
    assert {k: v for k, v in crashed.items() if k not in ("status", "crash")} == {
        k: v for k, v in left.items() if k != "status"}  # nothing else changes
    assert not (folder / LOCK_FILE).exists()
    assert session.crashed_sessions == ["ses-killed"]
    assert valid(record_of(new_folder))["crashed_sessions"] == ["ses-killed"]
    warnings = [e["data"] for e in read_log(new_folder / EVENTS).records
                if e["kind"] == "warning"]
    assert [(w["code"], w["session"]) for w in warnings] == [("crashed_session", "ses-killed")]

    third = new_session(sim_rig_path, data_root, session_id="ses-third")
    third.arm()
    third.abort("test over")
    assert third.crashed_sessions == []  # found once


def test_a_session_open_in_this_process_is_not_taken_for_crashed(sim_rig_path, tmp_path):
    first = new_session(sim_rig_path, tmp_path, session_id="ses-first")
    first_folder = first.arm()
    second = new_session(sim_rig_path, tmp_path, session_id="ses-second")
    second.arm()
    assert second.crashed_sessions == [] and record_of(first_folder)["status"] == "running"
    assert mark_crashed(first_folder, detected_by="ses-second") is False  # its lock is held
    assert record_of(first_folder)["status"] == "running"
    second.abort("test over")
    first.abort("test over")
    assert record_of(first_folder)["status"] == "aborted"


def test_a_session_closed_after_it_was_found_is_not_marked(sim_rig_path, tmp_path, monkeypatch):
    """find_crashed_sessions() read the record while it still said running, and the session's
    runtime wrote its last record and released the lock before mark_crashed() came to it."""
    first = new_session(sim_rig_path, tmp_path, session_id="ses-first")
    first_folder = first.arm()
    first.abort("test over")
    monkeypatch.setattr(runtime_module, "find_crashed_sessions", lambda root: [first_folder])
    second = new_session(sim_rig_path, tmp_path, session_id="ses-second")
    second_folder = second.arm()
    second.abort("test over")
    assert second.crashed_sessions == [] and record_of(first_folder)["status"] == "aborted"
    assert valid(record_of(second_folder))["crashed_sessions"] == []
    assert [e for e in read_log(second_folder / EVENTS).records if e["kind"] == "warning"] == []
    assert not (first_folder / LOCK_FILE).exists()


def test_git_status_takes_no_optional_locks(monkeypatch):
    """The dirty flag must not rewrite the checkout's index, which a git command run on the rig at
    the same time would then find locked."""
    calls = []
    monkeypatch.setattr(record_module, "_command", lambda args, cwd: calls.append(args) or "")
    assert record_module.three_maze_version()["git_dirty"] is False
    status = [args for args in calls if "status" in args]
    assert status and all("--no-optional-locks" in args for args in status)
