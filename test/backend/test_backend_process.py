"""The backend process, started the way Electron starts it, shuts down cleanly by itself.

Electron (electron/main.js) runs `python -m backend.src.main` from the repository root with stdin,
stdout and stderr as pipes, PYTHONUNBUFFERED=1 and THREEMAZE_PARENT_PIPE=1; on Windows it uses the
venv's pythonw.exe. Before quitting it writes 'shutdown' to stdin and closes it; if Electron
crashes, the pipe just closes. Either way the backend must release the experiment and exit with
code 0. Started by hand (no THREEMAZE_PARENT_PIPE), it must not stop when stdin ends.

Timing: the backend checks stdin every 0.2 s and gives each client 2 s (close_timeout) to answer
the closing handshake; a shutdown that hangs is cut off by the watchdog after 10 s with exit code
1. The tests wait up to 30 s for the server to start and allow EXIT_TIMEOUT_S = 8 s for a clean
exit (measured: about 2.5 s with an unresponsive client, under 1 s without one). A backend that
must keep running is watched for 1.5 s, more than 7 poll intervals.

Every process is started through the start_backend fixture (conftest.py), which kills it (with its
children) if it is still running at the end of the test. The backend always serves on port 8765, so
the tests are skipped while three-maze (or an end-to-end bench run) holds that port.
"""
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
import websockets

EXIT_TIMEOUT_S = 8
KEEPS_RUNNING_S = 1.5

PYTHONW = Path(sys.executable).with_name("pythonw.exe")
INTERPRETERS = [
    pytest.param(Path(sys.executable), id="python"),
    pytest.param(PYTHONW, id="pythonw", marks=pytest.mark.skipif(
        sys.platform != "win32" or not PYTHONW.exists(),
        reason="pythonw.exe (what Electron uses on Windows) exists on Windows only")),
]


async def connect_client(port):
    ws = await websockets.connect(f"ws://127.0.0.1:{port}", open_timeout=10)
    await ws.send(json.dumps({"type": "connect", "data": {"clientId": "pytest"}}))
    while True:
        reply = json.loads(await asyncio.wait_for(ws.recv(), 10))
        if reply.get("type") == "connected":
            return ws


def close_client(loop, ws):
    async def close():
        if ws is not None:
            try:
                await asyncio.wait_for(ws.close(), 5)
            except Exception:
                pass  # the server is gone already
        others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        for task in others:
            task.cancel()
        await asyncio.gather(*others, return_exceptions=True)

    try:
        loop.run_until_complete(close())
    finally:
        loop.close()


@pytest.mark.parametrize("interpreter", INTERPRETERS)
def test_shutdown_with_unresponsive_client_exits_cleanly(interpreter, start_backend):
    backend = start_backend(interpreter)
    loop, ws = asyncio.new_event_loop(), None
    try:
        ws = loop.run_until_complete(connect_client(backend.port))
        # This loop no longer runs, so the client never answers the server's closing handshake
        started = time.perf_counter()
        backend.popen.stdin.write(b"shutdown")
        backend.popen.stdin.close()  # what Electron's proc.stdin.end('shutdown') does
        code = backend.wait(EXIT_TIMEOUT_S)
        elapsed = time.perf_counter() - started
    finally:
        close_client(loop, ws)

    assert code == 0, f"exit code {code} after {elapsed:.2f} s:\n{backend.log}"
    assert "Shutdown requested" in backend.log
    assert "Traceback" not in backend.log, backend.log


@pytest.mark.parametrize("interpreter", INTERPRETERS)
def test_parent_pipe_closed_exits_cleanly(interpreter, start_backend):
    backend = start_backend(interpreter)
    backend.popen.stdin.close()  # Electron crashed: the pipe closes without a message

    code = backend.wait(EXIT_TIMEOUT_S)
    assert code == 0, f"exit code {code}:\n{backend.log}"
    assert "Shutdown requested" in backend.log
    assert "Traceback" not in backend.log, backend.log


@pytest.mark.parametrize("parent_pipe, stdin", [
    (False, subprocess.DEVNULL),  # started by hand: stdin is NUL (/dev/null) and ends at once
    (False, subprocess.PIPE),     # started by another program that closes the pipe
    (True, subprocess.DEVNULL),   # the flag is set, but stdin is not a pipe
], ids=["no-flag-NUL", "no-flag-pipe-closed", "flag-but-stdin-not-a-pipe"])
def test_backend_with_unwatched_stdin_keeps_running(parent_pipe, stdin, start_backend):
    backend = start_backend(parent_pipe=parent_pipe, stdin=stdin)
    if stdin == subprocess.PIPE:
        backend.popen.stdin.close()
    time.sleep(KEEPS_RUNNING_S)

    assert backend.popen.poll() is None, f"the backend stopped:\n{backend.log}"
    assert "Shutdown requested" not in backend.log
    if parent_pipe:
        assert "stdin is not a pipe; not watching it" in backend.log
