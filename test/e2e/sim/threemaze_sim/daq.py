"""Simulated NI-DAQmx: nidaqmx.Task (and nidaqmx.task.Task) is replaced by SimTask.

The real nidaqmx package is still imported, so nidaqmx.constants, nidaqmx.errors etc. are the
real ones. SimTask supports what the experiments and backend/src/hardware/water_delivery.py use:
creating a task, ao_channels.add_ao_voltage_chan(...), do_channels.add_do_chan(...),
timing.samp_timing_type = ..., timing.cfg_samp_clk_timing(...), write(), start/stop, close(),
and the context manager. Like DAQmx:
- writes and other calls after close() raise DaqError -200088 (task invalid or does not exist);
- an AO value outside the channel's [min_val, max_val] raises DaqWriteError -200561;
- a write to a task without channels raises DaqError -200478;
- a second close() only warns (DaqResourceWarning); a task garbage-collected while open warns.

THREEMAZE_SIM_DAQ: ok (default) | missing (Task() raises the DaqNotFoundError that this machine,
which has no NI-DAQmx driver, raises).

daq.jsonl events (each with t = perf_counter, wall = time.time, pid, task = DAQmx task name):
create, create_failed, add_channel, timing, start, stop,
write {value (one-element lists flattened), channel, auto_start, n},
write_error {value, error}, close {value_at_close = output level left by the last write},
close_again, destroyed_open.
"""
import itertools
import sys
import threading
import time
import warnings

from nidaqmx.constants import AcquisitionType, Edge, LineGrouping, SampleTimingType, VoltageUnits
from nidaqmx.error_codes import DAQmxErrors
from nidaqmx.errors import DaqError, DaqNotFoundError, DaqResourceWarning, DaqWriteError

from . import runtime

try:
    from nidaqmx.task._task import AUTO_START_UNSET
except ImportError:  # other nidaqmx versions
    AUTO_START_UNSET = object()

_counter = itertools.count()
_names_lock = threading.Lock()
_live_names = set()


def _plain(value):
    tolist = getattr(value, "tolist", None)  # numpy arrays and scalars
    return tolist() if callable(tolist) else value


def _flatten(data):
    data = _plain(data)
    if isinstance(data, (list, tuple)):
        data = [_plain(item) for item in data]
        return data[0] if len(data) == 1 else data
    return data


def _samples(data):
    data = _plain(data)
    if isinstance(data, (list, tuple)):
        return [_plain(item) for item in data]
    return [data]


def _describe(value):
    return getattr(value, "name", None) or _plain(value)


def _invalid_task_error():
    return DaqError("Task specified is invalid or does not exist.\nStatus Code: -200088", DAQmxErrors.INVALID_TASK)


class _Channel:
    def __init__(self, kind, physical_channel, name, min_val=None, max_val=None, units=None):
        self.kind = kind
        self.physical_channel = physical_channel
        self._name = name
        self.min_val = min_val
        self.max_val = max_val
        self.units = units

    @property
    def name(self):
        return self._name or self.physical_channel

    def __repr__(self):
        return f"Channel(name={self.name})"


class _ChannelCollection:
    def __init__(self, task):
        self._task = task

    def add_ao_voltage_chan(self, physical_channel, name_to_assign_to_channel="", min_val=-10.0,
                            max_val=10.0, units=VoltageUnits.VOLTS, custom_scale_name=""):
        return self._task._add_channel(_Channel("ao", physical_channel, name_to_assign_to_channel,
                                                float(min_val), float(max_val), units))

    def add_do_chan(self, lines, name_to_assign_to_lines="", line_grouping=LineGrouping.CHAN_FOR_ALL_LINES):
        return self._task._add_channel(_Channel("do", lines, name_to_assign_to_lines))

    def __len__(self):
        return len(self._task._channels)

    def __iter__(self):
        return iter(list(self._task._channels))

    @property
    def channel_names(self):
        return [channel.name for channel in self._task._channels]


class _Timing:
    def __init__(self, task):
        object.__setattr__(self, "_task", task)
        object.__setattr__(self, "_values", {"samp_timing_type": SampleTimingType.ON_DEMAND})

    def __getattr__(self, name):
        values = object.__getattribute__(self, "_values")
        if name in values:
            return values[name]
        raise AttributeError(f"the simulated DAQ task does not simulate timing.{name}")

    def __setattr__(self, name, value):
        self._task._check()
        self._values[name] = value
        self._task._event("timing", setting=name, to=_describe(value))

    def cfg_samp_clk_timing(self, rate, source="", active_edge=Edge.RISING,
                            sample_mode=AcquisitionType.FINITE, samps_per_chan=1000):
        self._task._check()
        self._values.update(samp_timing_type=SampleTimingType.SAMPLE_CLOCK, samp_clk_rate=rate,
                            samp_quant_samp_mode=sample_mode, samp_quant_samp_per_chan=samps_per_chan)
        self._task._event("timing", setting="cfg_samp_clk_timing",
                          to={"rate": rate, "sample_mode": _describe(sample_mode), "samps_per_chan": samps_per_chan})

    def cfg_implicit_timing(self, sample_mode=AcquisitionType.FINITE, samps_per_chan=1000):
        self._task._check()
        self._values.update(samp_timing_type=SampleTimingType.IMPLICIT, samp_quant_samp_mode=sample_mode,
                            samp_quant_samp_per_chan=samps_per_chan)
        self._task._event("timing", setting="cfg_implicit_timing",
                          to={"sample_mode": _describe(sample_mode), "samps_per_chan": samps_per_chan})


class SimTask:
    """Stands in for nidaqmx.Task; every call is logged to $THREEMAZE_SIM_DIR/daq.jsonl."""

    def __init__(self, new_task_name="", *, grpc_options=None):
        self._handle = None  # set first, like the real Task, so __del__ works if __init__ raises
        self._close_on_exit = False
        self._name = new_task_name
        if runtime.settings.daq_mode == "missing":
            exc = DaqNotFoundError(
                "Could not find an installation of NI-DAQmx. Please ensure that NI-DAQmx is installed "
                "on this machine or contact National Instruments for support.")
            runtime.daq_log.write("create_failed", task=new_task_name, mode="missing", error=str(exc))
            raise exc
        index = next(_counter)
        name = new_task_name or f"_unnamedTask<{index}>"
        with _names_lock:
            if name in _live_names:
                raise DaqError("Task name specified conflicts with an existing task name.",
                               DAQmxErrors.DUPLICATE_TASK, task_name=name)
            _live_names.add(name)
        self._name = name
        self._channels = []
        self._level = None  # output level after the last write (what the line holds now)
        self.ao_channels = _ChannelCollection(self)
        self.do_channels = _ChannelCollection(self)
        self.timing = _Timing(self)
        self._handle = index + 1
        self._close_on_exit = True
        self._event("create", requested_name=new_task_name)

    # --- helpers
    def _event(self, event, **fields):
        runtime.daq_log.write(event, task=self._name, **fields)

    def _check(self):
        if self._handle is None:
            raise _invalid_task_error()

    def _add_channel(self, channel):
        self._check()
        self._channels.append(channel)
        self._event("add_channel", kind=channel.kind, channel=channel.physical_channel, name=channel.name,
                    min_val=channel.min_val, max_val=channel.max_val, units=_describe(channel.units))
        return channel

    def _channel_label(self):
        names = [channel.physical_channel for channel in self._channels]
        return names[0] if len(names) == 1 else names

    # --- nidaqmx.Task API
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._close_on_exit:
            self.close()

    def __del__(self):
        if self._handle is not None and self._close_on_exit and not sys.is_finalizing():
            warnings.warn(
                'Task of name "{}" was not explicitly closed before it was destructed. Resources on the '
                "task device may still be reserved.".format(self._name), DaqResourceWarning)
            self._event("destroyed_open", level=self._level)

    def __repr__(self):
        return f"Task(name={self._name})"

    @property
    def name(self):
        self._check()
        return self._name

    @property
    def channel_names(self):
        self._check()
        return [channel.name for channel in self._channels]

    @property
    def number_of_channels(self):
        self._check()
        return len(self._channels)

    def start(self):
        self._check()
        self._event("start")

    def stop(self):
        self._check()
        self._event("stop")

    def wait_until_done(self, timeout=10.0):
        self._check()

    def is_task_done(self):
        self._check()
        return True

    def write(self, data, auto_start=AUTO_START_UNSET, timeout=10.0):
        t, wall = time.perf_counter(), time.time()
        value = _flatten(data)
        try:
            self._check()
            if not self._channels:
                raise DaqError("Specified operation cannot be performed when there are no channels in the task.",
                               DAQmxErrors.CAN_NOT_PERFORM_OP_WHEN_NO_CHANS_IN_TASK, task_name=self._name)
            samples = _samples(data)
            channel = self._channels[0]
            if len(self._channels) == 1 and channel.kind == "ao":
                for sample in samples:
                    if not channel.min_val <= float(sample) <= channel.max_val:
                        raise DaqWriteError(
                            "Attempted writing analog data that is too large or too small.\n"
                            f"Channel Name: {channel.name}\nRequested Value: {sample}\n"
                            f"Min Value: {channel.min_val}\nMax Value: {channel.max_val}",
                            DAQmxErrors.INVALID_AO_DATA_WRITE, 0, task_name=self._name)
        except DaqError as exc:
            self._event("write_error", t=t, wall=wall, value=value, error=str(exc))
            raise
        if auto_start is AUTO_START_UNSET:
            auto_start = len(samples) <= 1
        self._level = samples[-1] if len(self._channels) == 1 else value
        self._event("write", t=t, wall=wall, value=value, channel=self._channel_label(),
                    auto_start=bool(auto_start), n=len(samples))
        return len(samples)

    def close(self):
        if self._handle is None:
            warnings.warn('Attempted to close NI-DAQmx task of name "{}" but task was already closed.'.format(self._name),
                          DaqResourceWarning)
            self._event("close_again")
            return
        self._handle = None
        with _names_lock:
            _live_names.discard(self._name)
        self._event("close", value_at_close=self._level, channel=self._channel_label())


def install(nidaqmx_module):
    real = nidaqmx_module.Task
    nidaqmx_module.Task = SimTask
    nidaqmx_module._threemaze_sim_real_Task = real
    task_package = sys.modules.get("nidaqmx.task")
    if task_package is not None:
        task_package.Task = SimTask
    runtime.sim_log.write("patched", module=nidaqmx_module.__name__, attr="Task",
                          replaced=f"{real.__module__}.{real.__qualname__}", mode=runtime.settings.daq_mode)
