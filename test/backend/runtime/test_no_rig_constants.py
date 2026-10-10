"""Acceptance of plan item DPR-06a: no device, port, channel, data path or calibration constant in
the rig runtime's code. They belong in the rig file; v0.3 hard-codes them (COM3 and 115200 baud
at experiments/hallway04_experiment.py:156-157, the init line at :172, Dev1/ao0 at :190-191,
D:\\VirmenData at :214, ENCODER_TO_CM 0.0349 at :84 and 0.0364 in other experiment files)."""
import re
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[3] / "threemaze"

FORBIDDEN = {
    "serial port name": r"\bCOM\d+\b|/dev/tty",
    "baud rate": r"\b115200\b",
    "v0.3 init line": r"10000,50,10,1",
    "NI-DAQ channel": r"\bDev\d+/|\bao\d\b",
    "data path": r"VirmenData|\b[A-Za-z]:[\\/]",
    "cm per count": r"0\.0349|0\.0364",
}


def sources():
    files = sorted(PACKAGE.rglob("*.py"))
    assert files, PACKAGE
    return files


@pytest.mark.parametrize("what, pattern", FORBIDDEN.items(), ids=list(FORBIDDEN))
def test_no_rig_constant_in_runtime_code(what, pattern):
    found = []
    for path in sources():
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if re.search(pattern, line):
                found.append(f"{path.relative_to(PACKAGE.parent)}:{number}: {line.strip()}")
    assert not found, f"{what} in runtime code (it belongs in the rig file):\n" + "\n".join(found)
