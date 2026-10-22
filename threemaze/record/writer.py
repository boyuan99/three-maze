"""The writer thread: the only code that writes a session's tables and logs to disk.

Callers hand it whole lines (put), from any thread; put never blocks on the disk. The thread wakes
about once per flush interval (1 s, the experiment-data design's choice), writes every line that
waited, then flushes each file that got lines and fsyncs it. A crash of the process therefore loses
at most the lines of the last interval, and every file stays readable: a last line cut off by the
crash has no line end, and readers drop it (threemaze/record/read.py). Each file's header is
written, flushed and fsynced when the file is created, so even a file without rows has its header.

Lines of one file reach the disk in the order put was called; the files are created with mode "x",
so an existing file is never overwritten.

A write that fails (a full disk, a lost drive) is recorded in `errors` and reported once per file
through on_error, on the writer thread; that file's later lines are counted as dropped. on_error
must not call close().
"""
import logging
import os
import queue
import threading
from collections.abc import Callable
from pathlib import Path

FLUSH_INTERVAL_S = 1.0  # flush and fsync about every second (plan item DPR-07)

log = logging.getLogger("threemaze.record")


class _File:
    def __init__(self, name: str, fh):
        self.name = name
        self.fh = fh
        self.dirty = False
        self.lines = 0        # lines accepted by put
        self.dropped = 0      # lines not written because the file failed
        self.failed = False


class FileWriter:
    def __init__(self, folder: Path, *, flush_interval_s: float = FLUSH_INTERVAL_S,
                 on_error: Callable[[str, OSError], None] | None = None, name: str = "recorder"):
        self.folder = Path(folder)
        self.flush_interval_s = flush_interval_s
        self.errors: list[str] = []
        self.late = 0  # put after close: lines dropped (the first one is logged)
        self._on_error = on_error
        self._files: dict[str, _File] = {}
        self._queue: queue.SimpleQueue = queue.SimpleQueue()
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._closed = False
        self._thread = threading.Thread(target=self._run, name=f"{name}-writer", daemon=True)
        self._thread.start()

    # --- callers ---------------------------------------------------------------------------------

    def create(self, name: str, header: str = "") -> Path:
        """Create a new file in the folder; its header (if any) is on disk when this returns."""
        path = self.folder / name
        fh = open(path, "x", encoding="utf-8", newline="\n")
        try:
            if header:
                fh.write(header)
                fh.flush()
                os.fsync(fh.fileno())
        except BaseException:
            fh.close()
            raise
        with self._lock:
            self._files[name] = _File(name, fh)
        return path

    def put(self, name: str, line: str) -> bool:
        """Queue one line (ended by LF) for a file; False if the writer is closed (the line is
        dropped, counted in `late` and, the first time, logged)."""
        with self._lock:
            if self._closed:
                self.late += 1
                first = self.late == 1
            else:
                self._files[name].lines += 1
                self._queue.put((name, line))
                return True
        if first:
            log.warning("%s: a line for %s arrived after the files were closed; it is not"
                        " recorded, and neither is any later one", self.folder, name)
        return False

    def lines(self, name: str) -> int:
        return self._files[name].lines

    def dropped(self, name: str) -> int:
        return self._files[name].dropped

    @property
    def names(self) -> list[str]:
        return list(self._files)

    def close(self, timeout_s: float | None = None) -> bool:
        """Write what waits, flush, fsync and close every file. Idempotent. False if the thread
        did not finish within timeout_s."""
        with self._lock:
            self._closed = True
        self._wake.set()
        if threading.current_thread() is not self._thread:
            self._thread.join(timeout_s)
        return not self._thread.is_alive()

    # --- the thread ------------------------------------------------------------------------------

    def _run(self) -> None:
        while True:
            self._wake.wait(self.flush_interval_s)
            closing = self._closed
            try:
                self._drain()
                self._sync()
            except Exception as exc:  # noqa: BLE001 - the writer must outlive any one failure
                self._error("writer", exc)
            if closing:
                break
        self._drain()  # whatever was put before close() set the flag
        self._sync()
        for file in self._files.values():
            try:
                file.fh.close()
            except OSError as exc:
                self._fail(file, exc)

    def _drain(self) -> None:
        while True:
            try:
                name, line = self._queue.get_nowait()
            except queue.Empty:
                return
            file = self._files[name]
            if file.failed:
                file.dropped += 1
                continue
            try:
                file.fh.write(line)
                file.dirty = True
            except OSError as exc:
                file.dropped += 1
                self._fail(file, exc)

    def _sync(self) -> None:
        for file in list(self._files.values()):
            if not file.dirty or file.failed:
                continue
            try:
                file.fh.flush()
                os.fsync(file.fh.fileno())
                file.dirty = False
            except OSError as exc:
                self._fail(file, exc)

    def _fail(self, file: _File, exc: OSError) -> None:
        if not file.failed:
            file.failed = True
            self._error(file.name, exc)

    def _error(self, where: str, exc: Exception) -> None:
        message = f"{where}: {type(exc).__name__}: {exc}"
        self.errors.append(message)
        log.error("recording failed: %s", message)
        if self._on_error is not None and isinstance(exc, OSError):
            try:
                self._on_error(where, exc)
            except Exception:  # noqa: BLE001 - a failing callback must not stop the writer
                log.exception("on_error callback failed")
