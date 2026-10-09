"""BackendServer.start() returns once Electron asks it to stop, after terminating the experiment.

The server runs in this process with THREEMAZE_PARENT_PIPE=1 and a real pipe as stdin, as Electron
connects it, so the real watcher thread (PeekNamedPipe polling on Windows, a blocking read
elsewhere) sees either the 'shutdown' message, with the pipe left open, or the pipe closing
without a message, as when Electron crashes. Expected run time: about 0.2 s (one poll interval);
the test fails after 10 s. The parent_pipe fixture makes the watchdog's os._exit harmless.
"""
import pytest


@pytest.mark.parametrize("parent_closes_pipe", [False, True], ids=["shutdown-message", "pipe-closed"])
def test_server_terminates_experiment_and_returns(parent_closes_pipe, monkeypatch, parent_pipe,
                                                  new_server, counting_experiment, run):
    monkeypatch.setenv("THREEMAZE_PARENT_PIPE", "1")
    if parent_closes_pipe:
        parent_pipe.close_writer()
    else:
        parent_pipe.send(b"shutdown\n")
    server = new_server()
    experiment = server.active_experiment = counting_experiment()

    run(server.start(), timeout=10)

    assert experiment.terminated == 1
    assert server.active_experiment is None
    assert server._shutting_down
