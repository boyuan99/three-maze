"""A rig runtime that runs a session on the simulated rig until it is killed
(test_session_record.py).

    python session_child.py <rig file> <data root> <session id>

It configures, arms and starts the session, prints "running <session folder>" and waits.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from threemaze.runtime import Session, TaskSource  # noqa: E402


def main(rig: str, data_root: str, session_id: str) -> None:
    session = Session()
    session.configure(rig, data_root=data_root, session_id=session_id)
    session.set_task(TaskSource("declarative", "test-task"))
    folder = session.arm()
    session.start()
    print(f"running {folder}", flush=True)
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
