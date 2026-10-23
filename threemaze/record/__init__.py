"""Session recording: the session folder and the rig file copy (session_dir), the data tables and
logs (recorder, plan item DPR-07), the session record session.json with crash detection (session,
DPR-08a), their format (formats, tables; docs/data-format-v1.md) and how to read them back
(read)."""
from .formats import FORMAT_VERSION
from .read import DataFileError, read_log, read_table
from .recorder import PreflightError, SessionRecorder, disk_preflight, estimate_bytes_per_hour
from .session import SessionRecord, find_crashed_sessions, lock_is_free, mark_crashed
from .session_dir import (RIG_COPY, RIG_HASH, check_session_id, create_session_dir,
                          default_session_id, write_rig_copy)
from .tables import RecordError

__all__ = ["DataFileError", "FORMAT_VERSION", "PreflightError", "RIG_COPY", "RIG_HASH",
           "RecordError", "SessionRecord", "SessionRecorder", "check_session_id",
           "create_session_dir", "default_session_id", "disk_preflight", "estimate_bytes_per_hour",
           "find_crashed_sessions", "lock_is_free", "mark_crashed", "read_log", "read_table",
           "write_rig_copy"]
