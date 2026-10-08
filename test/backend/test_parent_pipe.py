"""The parent-pipe watcher: how the backend notices that Electron wants it to stop, or is gone.

With THREEMAZE_PARENT_PIPE=1, BackendServer._watch_parent_pipe runs in a thread. It waits on stdin
(polling with PeekNamedPipe on Windows, reading elsewhere) until Electron writes 'shutdown' or the
pipe closes, then asks the event loop to shut down and, as a watchdog, exits the process if the
shutdown takes longer than SHUTDOWN_DEADLINE_S. A stdin that cannot be watched, or is not a pipe,
must never shut the backend down.

The exit_calls fixture replaces os._exit with a recorder and shortens the deadline to 0.05 s, so
no test here can end the test run. Pollers run in a thread joined with a 5 s timeout (the Windows
poller checks every 0.2 s); the reader subprocesses get 30 s, mostly for the interpreter to start.
"""
import os
import subprocess
import sys
import threading

import pytest

from backend.src.main import BackendServer

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="PeekNamedPipe poller is Windows-only")


class FakeLoop:
    def __init__(self):
        self.callbacks = []

    def call_soon_threadsafe(self, callback):
        self.callbacks.append(callback)


class FakeEvent:
    def set(self):
        pass


def test_setup_error_keeps_backend_running(monkeypatch, exit_calls, caplog):
    monkeypatch.setattr(sys, "stdin", None)  # no stdin at all: the watcher cannot even start
    loop = FakeLoop()

    BackendServer._watch_parent_pipe(loop, FakeEvent())

    assert loop.callbacks == []  # no shutdown requested
    assert exit_calls == []
    assert "Cannot watch the parent pipe" in caplog.text


def test_watchdog_exits_after_deadline(monkeypatch, exit_calls, capfd):
    # The parent asked for a shutdown, and the shutdown never finishes
    monkeypatch.setattr(BackendServer, "_poll_parent_pipe_windows", staticmethod(lambda: True))
    monkeypatch.setattr(BackendServer, "_read_parent_pipe_posix", staticmethod(lambda: True))
    loop, event = FakeLoop(), FakeEvent()

    BackendServer._watch_parent_pipe(loop, event)

    assert loop.callbacks == [event.set]  # shutdown requested first...
    assert exit_calls == [1]  # ...then exit with 1 once the deadline has passed
    assert "Shutdown did not finish in time" in capfd.readouterr().err


# The POSIX reader also runs on Windows: a pipe is S_ISFIFO there and NUL is a character device.
# It runs in a subprocess, because it reads the real stdin.
READER = ("import sys; sys.path.insert(0, sys.argv[1]); "
          "from backend.src.main import BackendServer; "
          "print('watched=%s' % BackendServer._read_parent_pipe_posix())")


def run_reader(repo_root, stdin, send=None, close=True):
    """Run the reader on `stdin`, optionally sending `send` and then closing the pipe; returns the
    reader's last output line. Not communicate(): that would close stdin."""
    proc = subprocess.Popen([sys.executable, "-c", READER, str(repo_root)], cwd=repo_root,
                            stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        if send is not None:
            proc.stdin.write(send)
            proc.stdin.flush()
            if close:
                proc.stdin.close()
        proc.wait(timeout=30)  # the output is a few lines, so the stdout pipe cannot fill up
        out = proc.stdout.read()
        return out.decode(errors="replace").strip().splitlines()[-1]
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        for stream in (proc.stdin, proc.stdout):
            if stream and not stream.closed:
                stream.close()


def test_posix_reader_returns_on_shutdown_message(repo_root):
    # The pipe stays open: the reader returns because of the message, not because of EOF
    assert run_reader(repo_root, subprocess.PIPE, b"hello\nshutdown\n", close=False) == "watched=True"


def test_posix_reader_returns_when_pipe_closes(repo_root):
    assert run_reader(repo_root, subprocess.PIPE, b"hello\n") == "watched=True"


def test_posix_reader_ignores_non_pipe_stdin(repo_root):
    assert run_reader(repo_root, subprocess.DEVNULL) == "watched=False"


def poll_in_thread(timeout=5):
    """Run the Windows poller in a watcher thread; return its result."""
    result = []
    thread = threading.Thread(target=lambda: result.append(BackendServer._poll_parent_pipe_windows()),
                              name="parent-pipe", daemon=True)
    thread.start()
    thread.join(timeout)
    assert not thread.is_alive(), "the poller did not return"
    return result[0]


@windows_only
def test_windows_poller_returns_on_shutdown_message(parent_pipe):
    parent_pipe.send(b"shutdown\n")  # the pipe stays open
    assert poll_in_thread() is True


@windows_only
def test_windows_poller_returns_when_pipe_closes(parent_pipe):
    parent_pipe.close_writer()
    assert poll_in_thread() is True


@windows_only
def test_windows_poller_ignores_non_pipe_stdin(monkeypatch, exit_calls):
    with open(os.devnull, "r") as nul:
        monkeypatch.setattr(sys, "stdin", nul)
        assert poll_in_thread() is False
