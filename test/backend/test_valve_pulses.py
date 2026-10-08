"""Every water-valve pulse ends at 0 V, also when it is cancelled half-way.

The NI-DAQ analog output keeps its last value, so a pulse that never writes 0 V leaves the valve
open. A cancelled pulse must still write 0 V on its way out (try/finally around the wait).

The cancellation tests cancel while the output is high: they step the event loop until the fake
output has been driven high (no wall-clock sleep), and the pulse lasts 10 s (25 ms in the
standalone experiment, which is hard-coded), so the timing cannot flake.
"""
import asyncio
from types import SimpleNamespace

import pytest

PULSE_EXPERIMENTS = [
    "hallway01_experiment.py",
    "hallway02_experiment.py",
    "hallway04_experiment.py",
    "standalone_hallway_experiment.py",
]


def new_experiment(cls, ao, duration_ms):
    """An experiment with only what _deliver_water reads (__init__ would open the hardware)."""
    exp = cls.__new__(cls)
    exp.daq_task, exp.num_rewards, exp.experiment_id = ao, 0, "test"
    # Read by the hallway experiments; the standalone one pulses 5 V for a fixed 25 ms
    exp.WATER_DURATION_MS, exp.WATER_VOLTAGE = duration_ms, 5.0
    return exp


@pytest.mark.parametrize("filename", PULSE_EXPERIMENTS)
def test_pulse_ends_at_zero_volts(filename, experiment_class, make_ao, run):
    ao = make_ao()
    exp = new_experiment(experiment_class(filename), ao, duration_ms=20)

    assert run(exp._deliver_water()) is True
    assert ao.writes == [5.0, 0.0]
    assert exp.num_rewards == 1


@pytest.mark.parametrize("filename", PULSE_EXPERIMENTS)
def test_cancelled_pulse_ends_at_zero_volts(filename, experiment_class, make_ao, run, wait_until):
    ao = make_ao()
    exp = new_experiment(experiment_class(filename), ao, duration_ms=10_000)

    async def cancel_mid_pulse():
        pulse = asyncio.create_task(exp._deliver_water())
        await wait_until(lambda: ao.writes)
        assert ao.writes == [5.0]  # the valve is open
        pulse.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pulse

    run(cancel_mid_pulse())
    assert ao.writes == [5.0, 0.0]
    assert exp.num_rewards == 0


@pytest.fixture
def water_delivery(monkeypatch, make_ao):
    """backend/src/hardware/water_delivery.py with a fake nidaqmx whose tasks are recorded."""
    import backend.src.hardware.water_delivery as wd
    tasks = []

    def new_task():
        tasks.append(make_ao())
        return tasks[-1]

    monkeypatch.setattr(wd, "NIDAQMX_AVAILABLE", True)
    monkeypatch.setattr(wd, "nidaqmx", SimpleNamespace(Task=new_task), raising=False)
    delivery = wd.WaterDelivery()
    delivery.is_initialized = delivery.is_active = True
    return delivery, tasks


def test_water_delivery_pulse_ends_at_zero_volts(water_delivery, run):
    delivery, tasks = water_delivery
    delivery.duration_ms = 20

    result = run(delivery.deliver())
    assert result["success"] is True
    (ao,) = tasks
    assert ao.writes == [5.0, 0.0]
    assert ao.closed and ao.value_at_close == 0.0


def test_water_delivery_cancelled_pulse_ends_at_zero_volts(water_delivery, run, wait_until):
    delivery, tasks = water_delivery
    delivery.duration_ms = 10_000

    async def cancel_mid_pulse():
        pulse = asyncio.create_task(delivery.deliver())
        await wait_until(lambda: tasks and tasks[0].writes)
        assert tasks[0].writes == [5.0]  # the valve is open
        pulse.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pulse

    run(cancel_mid_pulse())
    (ao,) = tasks
    assert ao.writes == [5.0, 0.0]
    assert ao.closed and ao.value_at_close == 0.0
