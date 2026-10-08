"""Backend for the lifecycle harness (harness.cjs): the real BackendServer of backend/src/main.py
(parent-pipe watcher, release lock, shutdown watchdog) with a fake experiment that records its
cleanup in a marker file. No hardware, no simulated rig.

argv: marker_path [hang]. With 'hang', terminate() blocks the event loop for 30 s, so only the
shutdown watchdog (BackendServer.SHUTDOWN_DEADLINE_S) or a kill can end the process.

Marker lines: "<time.time()> pid=<pid> <event>" with the events started, terminate begin,
terminate end, main returned. The marker is a file because stdout is gone once Electron has died.
"""
import asyncio
import os
import sys
import time

REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))
sys.path.insert(0, REPO)
os.chdir(REPO)
marker = sys.argv[1]
hang = len(sys.argv) > 2 and sys.argv[2] == "hang"
PORT = 8795  # not the app's 8765; BackendServer takes the first free port from here


def mark(s):
    with open(marker, "a") as f:
        f.write(f"{time.time():.3f} pid={os.getpid()} {s}\n")


from backend.src.main import BackendServer  # noqa: E402


class FakeExperiment:
    experiment_id = "fake"
    data_file_path = None

    async def terminate(self):
        mark("terminate begin")
        if hang:
            time.sleep(30)  # blocks the event loop: only the watchdog can end the process
        await asyncio.sleep(0.5)
        mark("terminate end")
        return {}


mark(f"started exe={os.path.basename(sys.executable)}")
server = BackendServer(host="localhost", port=PORT)
server.active_experiment = FakeExperiment()
asyncio.run(server.start())
mark("main returned")
