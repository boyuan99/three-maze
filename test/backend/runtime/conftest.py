"""Shared setup for the rig runtime's tests (threemaze/, plan items DPR-06a and DPR-02).

Every session these tests run writes into pytest's tmp_path (data_root=...), never into the
rig file's own data root.
"""
import copy
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SIM_RIG = REPO / "rigs" / "sim.json"

# The end-to-end bench's simulated rig (threemaze_sim: the conformance checker, the legacy stream).
# Importing it changes nothing: it patches a process only when its sitecustomize runs at start-up
# with THREEMAZE_SIM=1, which a test process never has.
SIM_DIR = REPO / "test" / "e2e" / "sim"
if str(SIM_DIR) not in sys.path:
    sys.path.append(str(SIM_DIR))


@pytest.fixture(scope="session")
def sim_rig_path():
    return SIM_RIG


@pytest.fixture
def sim_rig_data():
    """rigs/sim.json as a dict, to modify."""
    return copy.deepcopy(json.loads(SIM_RIG.read_text(encoding="utf-8")))


@pytest.fixture
def write_rig(tmp_path):
    """write_rig(data, name="rig.json") -> path of a rig file in a fresh folder under tmp_path."""
    counter = iter(range(1, 10_000))

    def write(data, name="rig.json"):
        folder = tmp_path / f"rig{next(counter)}"
        folder.mkdir()
        path = folder / name
        path.write_text(json.dumps(data, indent=2), encoding="utf-8")
        return path
    return write


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
