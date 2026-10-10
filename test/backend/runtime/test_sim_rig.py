"""The 'sim' rig (rigs/sim.json) runs end to end in the test's own process (plan item DPR-06a):
rig file validated, session folder with the rig file copied and hashed, devices opened, started,
stopped and closed."""
import hashlib

from threemaze.runtime import Session, TaskSource
from threemaze.core import SessionState


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
