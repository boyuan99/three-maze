"""terminate() of the standalone experiment, which owns its serial port and DAQ task.

1. A reward pulse may be in progress when terminate() closes the DAQ task. The analog output keeps
   its last value after the task is closed, so terminate() must write 0 V before closing it.
2. terminate() sends STOP to the Teensy and waits 0.2 s before closing the port; position updates
   arriving meanwhile must be ignored (no new trial, no new pulse), so the experiment is inactive
   from the start of cleanup.

Both tests step the event loop to the moment that matters instead of sleeping.
"""
import asyncio

import pytest

FILENAME = "standalone_hallway_experiment.py"


@pytest.fixture
def standalone(experiment_class, make_ao):
    """A running standalone experiment without hardware (__init__ would open the port and DAQ)."""
    cls = experiment_class(FILENAME)
    exp = cls.__new__(cls)
    exp.experiment_id, exp.daq_task, exp.num_rewards, exp.trial_number = "test", make_ao(), 0, 0
    exp.serial_port, exp.serial_read_task, exp.data_file, exp.start_time = None, None, None, None
    exp.is_active = True
    return exp


def test_terminate_during_pulse_closes_daq_at_zero_volts(standalone, run, wait_until):
    ao = standalone.daq_task

    async def terminate_mid_pulse():
        pulse = asyncio.create_task(standalone._deliver_water())
        await wait_until(lambda: ao.writes)
        assert ao.value == 5.0  # the valve is open when cleanup starts
        await standalone.terminate()
        await pulse  # the interrupted pulse must not raise

    run(terminate_mid_pulse())
    assert ao.closed
    assert ao.value_at_close == 0.0


def test_terminate_is_inactive_from_start_of_cleanup(standalone, fake_serial, run, wait_until):
    standalone.serial_port = fake_serial

    async def observe_cleanup():
        cleanup = asyncio.create_task(standalone.terminate())
        await wait_until(lambda: fake_serial.writes)  # STOP sent; terminate() now waits 0.2 s
        inactive = standalone.is_active is False
        in_progress = not cleanup.done()
        await cleanup
        return inactive, in_progress

    inactive, in_progress = run(observe_cleanup())
    assert in_progress, "cleanup finished before it could be observed"
    assert inactive
    assert fake_serial.writes == [b"STOP\n"]
    assert not fake_serial.is_open
