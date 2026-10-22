"""The link log: <session>/link.jsonl (plan item DPR-06b).

One JSON object per line, in the order things happened on the link: every message a client sent
except heartbeats (pose.batch, event, render.report, error, hello), each with the session clock at
its receipt (t_ns), the client's name and, for events, whether it was stale; what the runtime
decided (welcome, refusals with their close codes, errors it sent, alarms); and a summary of the
samples sent when the stream ends. Floats are written in their shortest round-trip form, so every
value reads back as received. Until the session has a folder (it gets one when armed), records are
kept in memory and written first. Plan item DPR-07 builds pose.tsv and events.jsonl from what this
log holds; v0.3 kept no record of a pose that did not come with a frame.
"""
import json
import threading
import time
from pathlib import Path
from typing import Any

FLUSH_EVERY_S = 1.0


class LinkLog:
    def __init__(self) -> None:
        self.path: Path | None = None
        self._fh = None
        self._pending: list[str] = []
        self._lock = threading.Lock()
        self._flushed = time.monotonic()
        self.records = 0

    def open(self, path: Path) -> None:
        """Write to path from now on (appending), with the records kept so far first."""
        with self._lock:
            if self._fh is not None:
                return
            path.parent.mkdir(parents=True, exist_ok=True)
            self.path = path
            self._fh = open(path, "a", encoding="utf-8", newline="\n")
            for line in self._pending:
                self._fh.write(line)
            self._pending.clear()
            self._fh.flush()

    def write(self, t_ns: int, event: str, **fields: Any) -> None:
        record = {"t_ns": t_ns, "event": event, **fields}
        try:
            line = json.dumps(record, allow_nan=False, separators=(",", ":"), ensure_ascii=False)
        except (TypeError, ValueError):  # a value JSON cannot hold, from a malformed message
            line = json.dumps({"t_ns": t_ns, "event": event, "unloggable": repr(fields)[:4000]},
                              separators=(",", ":"), ensure_ascii=False)
        line += "\n"
        with self._lock:
            self.records += 1
            if self._fh is None:
                self._pending.append(line)
                return
            self._fh.write(line)
            if time.monotonic() - self._flushed >= FLUSH_EVERY_S:
                self._fh.flush()
                self._flushed = time.monotonic()

    def flush(self) -> None:
        with self._lock:
            if self._fh is not None:
                self._fh.flush()

    def close(self) -> None:
        with self._lock:
            if self._fh is not None:
                self._fh.close()
                self._fh = None
