"""Releasing the active experiment: exactly once, and never left running.

The last client disconnecting, an experiment_stop message and a backend shutdown can all release
the experiment, also at the same time. terminate() (which zeroes the outputs and closes the data
file) must run once per experiment, a shutdown must wait for a release that is still running,
requests arriving during a shutdown are refused, and an
experiment released while it is still initializing is terminated again once initialize()
returns, because initialize() may have opened the DAQ task or the data file after the first
terminate().
"""
import asyncio

import pytest


def test_disconnect_and_shutdown_terminate_once(new_server, counting_experiment, run):
    server = new_server()
    experiment = server.active_experiment = counting_experiment()

    async def release_twice():
        await asyncio.gather(server._release_session("client disconnect"),
                             server._release_session("backend shutdown"))

    run(release_twice())
    assert experiment.terminated == 1
    assert server.active_experiment is None


def test_experiment_stop_and_shutdown_terminate_once(new_server, counting_experiment, run):
    server = new_server()
    experiment = server.active_experiment = counting_experiment()

    async def stop_and_release():
        await asyncio.gather(server._handle_experiment_stop({}),
                             server._release_session("backend shutdown"))

    run(stop_and_release())
    assert experiment.terminated == 1
    assert server.active_experiment is None


def test_shutdown_release_waits_for_release_in_progress(new_server, run, wait_until):
    # The two tests above only show that terminate() runs once; taking the experiment out before
    # awaiting terminate() already ensures that. This one checks the lock: a shutdown that arrives
    # while the disconnect is still terminating the experiment must wait for it. Otherwise start()
    # returns and the process exits before terminate() has set 0 V and closed the files.
    server = new_server()
    events = []

    class GatedTerminate:
        """terminate() starts, then waits until the test opens its gate."""
        experiment_id = "gated-terminate"

        def __init__(self):
            self.terminated = 0
            self.gate = asyncio.Event()

        async def terminate(self):
            self.terminated += 1
            events.append("terminate started")
            await self.gate.wait()
            events.append("terminate finished")
            return {}

    experiment = server.active_experiment = GatedTerminate()

    async def open_gate_later():
        # Long enough for an unserialized shutdown release to return first
        for _ in range(50):
            await asyncio.sleep(0)
        events.append("gate opened")
        experiment.gate.set()

    async def disconnect_then_shutdown():
        disconnect = asyncio.create_task(server._release_session("client disconnect"))
        await wait_until(lambda: "terminate started" in events)
        opener = asyncio.create_task(open_gate_later())
        await server._release_session("backend shutdown")
        events.append("shutdown release returned")
        await asyncio.gather(disconnect, opener)

    run(disconnect_then_shutdown())
    assert events == ["terminate started", "gate opened", "terminate finished",
                      "shutdown release returned"], \
        "the shutdown release returned before the disconnect had finished terminating the experiment"
    assert experiment.terminated == 1
    assert server.active_experiment is None


def test_shutting_down_rejects_experiment_register(new_server, run):
    server = new_server()
    server._shutting_down = True

    def must_not_load(filename, mode):
        raise AssertionError("the experiment was loaded during a shutdown")
    server.experiment_loader.load_experiment = must_not_load

    reply = run(server._handle_experiment_register({"filename": "hallway02_experiment.py"}))
    assert reply["type"] == "experiment_error"
    assert "shutting down" in reply["data"]["error"]
    assert server.active_experiment is None


def test_shutting_down_rejects_water_deliver(new_server, run):
    server = new_server()
    server._shutting_down = True

    reply = run(server._handle_water_deliver({"amount": 1}))
    assert reply["type"] == "water_error"
    assert "shutting down" in reply["data"]["error"]


@pytest.fixture
def gated_experiment():
    """A standalone experiment class whose initialize() waits until the test opens its gate,
    like an experiment opening the serial port, the DAQ task and the data file."""

    class GatedExperiment:
        HARDWARE_MODE = "standalone"
        instances = []

        def __init__(self, experiment_id, config, hardware_manager=None, event_callback=None):
            self.experiment_id = experiment_id
            self.terminated = 0
            self.initializing = asyncio.Event()
            self.gate = asyncio.Event()
            GatedExperiment.instances.append(self)

        async def initialize(self, config):
            self.initializing.set()
            await self.gate.wait()
            return {"state": "ready"}

        async def terminate(self):
            self.terminated += 1
            return {}

    return GatedExperiment


def register_gated(server, experiment_cls, wait_until, during_initialize):
    """Register experiment_cls; run during_initialize(experiment) while its initialize() waits,
    then let initialize() finish. Returns (experiment, reply)."""
    server.experiment_loader.load_experiment = lambda filename, mode: experiment_cls

    async def scenario():
        register = asyncio.create_task(
            server._handle_experiment_register({"filename": "gated_experiment.py"}))
        await wait_until(lambda: experiment_cls.instances and experiment_cls.instances[0].initializing.is_set())
        experiment = experiment_cls.instances[0]
        await during_initialize(experiment)
        experiment.gate.set()
        return experiment, await register
    return scenario()


def test_registration_without_shutdown_succeeds(new_server, gated_experiment, run, wait_until):
    server = new_server()

    async def nothing(experiment):
        pass

    experiment, reply = run(register_gated(server, gated_experiment, wait_until, nothing))
    assert reply["type"] == "experiment_registered"
    assert server.active_experiment is experiment
    assert experiment.terminated == 0


def test_shutdown_during_initialize_terminates_again(new_server, gated_experiment, run, wait_until):
    server = new_server()

    async def shut_down(experiment):
        server._shutting_down = True  # what start() does once Electron asks the backend to stop
        await server._release_session("backend shutdown")
        assert experiment.terminated == 1  # released while initialize() is still running

    experiment, reply = run(register_gated(server, gated_experiment, wait_until, shut_down))
    assert reply["type"] == "experiment_error"
    assert experiment.terminated == 2
    assert server.active_experiment is None


def test_experiment_stop_during_initialize_terminates_again(new_server, gated_experiment, run, wait_until):
    # The renderer sends experiment_stop when registration times out on its side
    server = new_server()

    async def stop(experiment):
        await server._handle_experiment_stop({})
        assert experiment.terminated == 1

    experiment, reply = run(register_gated(server, gated_experiment, wait_until, stop))
    assert reply["type"] == "experiment_error"
    assert experiment.terminated == 2
    assert server.active_experiment is None
