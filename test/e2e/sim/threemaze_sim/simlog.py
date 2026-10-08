"""Append-only JSON-lines logs. Every record carries t (time.perf_counter()), wall (time.time())
and pid; each line is flushed at once, so a killed process keeps everything it logged."""
import json
import os
import sys
import threading
import time

_real_open = open  # captured before paths.install() wraps builtins.open


def _default(obj):
    tolist = getattr(obj, "tolist", None)
    if callable(tolist):
        return tolist()
    return str(obj)


class JsonlLog:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._fh = None
        self.error = None  # first exception that stopped this log

    def write(self, event, t=None, wall=None, **fields):
        # Never block shutdown: a daemon thread killed while holding the lock must not hang exit
        if self.error is not None or sys.is_finalizing():
            return
        record = {
            "t": time.perf_counter() if t is None else t,
            "wall": time.time() if wall is None else wall,
            "pid": os.getpid(),
            "event": event,
        }
        record.update(fields)
        line = json.dumps(record, separators=(",", ":"), default=_default) + "\n"
        if not self._lock.acquire(timeout=1.0):
            return
        try:
            if self._fh is None:
                self._fh = _real_open(self.path, "a", encoding="utf-8", newline="\n")
            self._fh.write(line)
            self._fh.flush()
        except Exception as exc:  # a broken log must not change the behaviour of the code under test
            self.error = exc
        finally:
            self._lock.release()
