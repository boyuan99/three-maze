"""The session folder: <data root>/<session id>/, with the rig file copied into it.

The copy is the exact bytes the session validated (RigConfig.raw), next to its SHA-256 in the
format of sha256sum, so `sha256sum -c rig.json.sha256` checks it.
"""
import re
from datetime import datetime
from pathlib import Path

RIG_COPY = "rig.json"
RIG_HASH = "rig.json.sha256"

# Matched whole (fullmatch): Python's $ also matches before a final line end
_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


def default_session_id(rig_name: str, when: datetime | None = None) -> str:
    """ses-<local date and time>_rig-<rig name>, for example ses-20261009T101500_rig-sim."""
    when = when or datetime.now()
    return f"ses-{when:%Y%m%dT%H%M%S}_rig-{rig_name}"


def check_session_id(session_id: str) -> None:
    """A session id is one folder name: letters, digits, '.', '_' and '-'."""
    if not _SESSION_ID.fullmatch(session_id):
        raise ValueError(f"invalid session id {session_id!r}: use letters, digits, '.', '_' and '-'")


def create_session_dir(data_root: Path, session_id: str) -> Path:
    """Create a new, empty session folder. If the name is taken (two sessions started in the
    same second), a suffix -2, -3, ... is added; an existing folder is never reused."""
    check_session_id(session_id)
    data_root.mkdir(parents=True, exist_ok=True)
    for n in range(1, 1000):
        path = data_root / (session_id if n == 1 else f"{session_id}-{n}")
        try:
            path.mkdir()
        except FileExistsError:
            continue
        return path
    raise FileExistsError(f"no free session folder name for {session_id!r} in {data_root}")


def write_rig_copy(session_dir: Path, raw: bytes, sha256: str) -> Path:
    """Write rig.json (the exact bytes) and rig.json.sha256; return the copy's path."""
    copy = session_dir / RIG_COPY
    with open(copy, "xb") as fh:
        fh.write(raw)
    with open(session_dir / RIG_HASH, "x", encoding="ascii", newline="\n") as fh:
        fh.write(f"{sha256}  {RIG_COPY}\n")
    return copy
