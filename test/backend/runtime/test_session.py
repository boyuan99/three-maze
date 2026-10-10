"""Session states and lifecycle (plan item DPR-06a): IDLE -> CONFIGURED -> ARMED -> RUNNING ->
STOPPING -> COMPLETE | ABORTED; an invalid rig file fails before ARMED; one task source per
session (ADR-0002); outputs are made safe first whenever a session ends."""
import itertools
import json

import pytest

from threemaze.config import RigFileError
from threemaze.core import InvalidTransition, SessionState, StateMachine, TRANSITIONS
from threemaze.devices.simulated import SimulatedDevice
from threemaze.runtime import Session, SessionError, TaskSource, TaskSourceError

S = SessionState
TASK = TaskSource("declarative", "test-task")

ALLOWED = {
    (S.IDLE, S.CONFIGURED), (S.IDLE, S.ABORTED),
    (S.CONFIGURED, S.ARMED), (S.CONFIGURED, S.ABORTED),
    (S.ARMED, S.RUNNING), (S.ARMED, S.ABORTED),
    (S.RUNNING, S.STOPPING), (S.RUNNING, S.ABORTED),
    (S.STOPPING, S.COMPLETE), (S.STOPPING, S.ABORTED),
}


def test_transition_table_is_the_documented_one():
    table = {(a, b) for a, targets in TRANSITIONS.items() for b in targets}
    assert table == ALLOWED
    assert {state for state in S if state.final} == {S.COMPLETE, S.ABORTED}


@pytest.mark.parametrize("source, target", list(itertools.product(S, S)))
def test_every_transition_allowed_or_refused(source, target):
    machine = StateMachine(0)
    machine._state = source
    if (source, target) in ALLOWED:
        step = machine.go(target, 5, "why")
        assert machine.state is target and step.t_ns == 5 and machine.history == [step]
    else:
        with pytest.raises(InvalidTransition):
            machine.go(target, 5)
        assert machine.state is source and machine.history == []


def events(session, device):
    path = session.dir / "sim" / f"{device}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


LIFECYCLE = ("open", "start", "safe_state", "stop", "close")


def names(session, device):
    """The runtime's calls on a simulated device, from its log (which has the device's own events
    too)."""
    return [record["event"] for record in events(session, device) if record["event"] in LIFECYCLE]


@pytest.fixture
def session(sim_rig_path, tmp_path):
    s = Session()
    s.configure(sim_rig_path, data_root=tmp_path / "data")
    s.set_task(TASK)
    return s


def test_full_lifecycle(session):
    assert session.state is S.CONFIGURED
    folder = session.arm()
    assert session.state is S.ARMED and folder.is_dir()
    assert set(session.devices) == {"ball", "valve"}
    assert session.inputs == {"motion": session.devices["ball"]}
    assert session.outputs == {"reward": session.devices["valve"]}
    session.start()
    assert session.state is S.RUNNING
    session.stop()
    assert session.state is S.COMPLETE and session.abort_reason is None
    assert [t.target for t in session.history] == [S.CONFIGURED, S.ARMED, S.RUNNING, S.STOPPING,
                                                   S.COMPLETE]
    stamps = [t.t_ns for t in session.history]
    assert stamps == sorted(stamps)
    assert set(session.anchors) == {"configured", "armed", "running", "stopping", "complete"}
    assert names(session, "ball") == ["open", "start", "safe_state", "stop", "close"]
    assert names(session, "valve") == ["open", "safe_state", "close"]


def test_invalid_rig_fails_before_armed(sim_rig_data, write_rig, tmp_path):
    sim_rig_data["devices"]["ball"]["periodUs"] = 0
    s = Session()
    with pytest.raises(RigFileError) as excinfo:
        s.configure(write_rig(sim_rig_data), data_root=tmp_path / "data")
    assert [issue.pointer for issue in excinfo.value.issues] == ["/devices/ball/periodUs"]
    assert s.state is S.IDLE and s.history == []
    assert not (tmp_path / "data").exists()  # nothing written for an invalid rig
    with pytest.raises(InvalidTransition):
        s.arm()


def test_second_task_source_refused(sim_rig_path, tmp_path):
    s = Session()
    s.set_task(TaskSource("declarative", "first"))
    with pytest.raises(TaskSourceError, match="exactly one"):
        s.set_task(TaskSource("declarative", "second"))
    s.configure(sim_rig_path, data_root=tmp_path)
    with pytest.raises(TaskSourceError, match="exactly one"):
        s.set_task(TaskSource("declarative", "third"))
    assert s.task.ref == "first"


def test_code_task_refused_in_phase_1():
    with pytest.raises(TaskSourceError, match="phase 2"):
        Session().set_task(TaskSource("code", "Hallway02"))


def test_task_source_needed_before_arming(sim_rig_path, tmp_path):
    s = Session()
    s.configure(sim_rig_path, data_root=tmp_path)
    with pytest.raises(SessionError, match="no task source"):
        s.arm()
    assert s.state is S.CONFIGURED


def test_task_source_fixed_once_armed(session):
    session.arm()
    with pytest.raises(TaskSourceError):
        session.set_task(TASK)
    session.abort("test over")


@pytest.mark.parametrize("call", ["start", "stop"])
def test_out_of_order_calls_refused(session, call):
    with pytest.raises(InvalidTransition):
        getattr(session, call)()
    assert session.state is S.CONFIGURED


def test_configure_twice_refused(session, sim_rig_path):
    with pytest.raises(InvalidTransition):
        session.configure(sim_rig_path)


def test_invalid_session_id_refused_before_armed(sim_rig_path, tmp_path):
    with pytest.raises(ValueError, match="invalid session id"):
        Session().configure(sim_rig_path, data_root=tmp_path, session_id="../escape")


def test_device_that_fails_to_open_aborts(session, monkeypatch):
    real_open = SimulatedDevice.open

    def open_or_fail(self):
        real_open(self)
        if self.name == "valve":
            raise OSError("valve not found")

    monkeypatch.setattr(SimulatedDevice, "open", open_or_fail)
    with pytest.raises(SessionError, match="valve not found"):
        session.arm()
    assert session.state is S.ABORTED
    assert "valve not found" in session.abort_reason
    assert names(session, "ball")[-1] == "close" and names(session, "valve")[-1] == "close"
    assert (session.dir / "rig.json").is_file()  # the folder records the attempt


def test_abort_makes_outputs_safe_before_anything_else(session):
    session.arm()
    session.start()
    session.abort("operator pressed stop")
    assert session.state is S.ABORTED and session.abort_reason == "operator pressed stop"
    log = sorted(events(session, "ball") + events(session, "valve"), key=lambda r: r["t_ns"])
    order = [record["event"] for record in log if record["event"] in ("safe_state", "stop", "close")]
    assert order == ["safe_state", "safe_state", "stop", "close", "close"]


def test_failure_while_stopping_aborts_but_still_closes_everything(session, monkeypatch):
    def broken_stop(self):
        raise RuntimeError("stream did not end")

    session.arm()
    session.start()
    monkeypatch.setattr(SimulatedDevice, "stop", broken_stop)
    session.stop()
    assert session.state is S.ABORTED
    assert "ball.stop: RuntimeError: stream did not end" in session.abort_reason
    assert names(session, "ball")[-1] == "close" and names(session, "valve")[-1] == "close"
    assert [(f.device, f.action) for f in session.failures] == [("ball", "stop")]


def test_context_manager_aborts_on_exception(session):
    with pytest.raises(KeyError):
        with session:
            session.arm()
            session.start()
            raise KeyError("task crashed")
    assert session.state is S.ABORTED and "KeyError" in session.abort_reason
    assert names(session, "valve")[-1] == "close"


def test_context_manager_stops_a_running_session(session):
    with session:
        session.arm()
        session.start()
    assert session.state is S.COMPLETE


def test_abort_of_a_final_session_refused(session):
    session.abort("never ran")
    assert session.state is S.ABORTED
    with pytest.raises(InvalidTransition):
        session.abort("again")
