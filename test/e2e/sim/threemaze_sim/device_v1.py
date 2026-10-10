"""The simulated serial device in device protocol v1 mode (THREEMAZE_SIM_PROTOCOL=v1).

The device is the rig runtime's reference simulated device (threemaze/devices/sim: model.py for
what it sends, Pacer for when), described by THREEMAZE_SIM_DEVICE. This class only puts it
behind SimSerial: it shares the legacy device's input buffer, read and close semantics
(teensy.SimTeensy) and logs to serial.jsonl:
- the device's own events: command, command_rejected, command_ignored, hello, stream_start,
  stream_stop, fault {type, seq, ...}, lick, pulse_commanded, pulse_refused, pulse_on, pulse_off;
- received (host -> device write), sent {seq, kind, line, due, late_ms} per piece of output,
  read {seq} when the host has consumed a complete line, dropped, discarded (as in legacy mode).
"""
import time

from . import config, devicecfg, runtime
from .teensy import SimTeensy


class SimV1Teensy(SimTeensy):
    def __init__(self, port, silent):
        super().__init__(port, silent)
        sim, _ = devicecfg._threemaze()
        settings = runtime.settings
        cfg = sim.config_from_entry(devicecfg.v1_entry(settings), devicecfg.resolver(settings.device_file))
        self._pacer = sim.Pacer(sim.SimDevice(cfg, log=self._device_log), self._deliver,
                                name=f"sim-v1-{port}")
        self._pacer.start()

    def _device_log(self, event, **fields):
        runtime.serial_log.write(event, port=self.port, **fields)

    # host -> device
    def receive(self, data):
        t, wall = time.perf_counter(), time.time()
        runtime.serial_log.write("received", t=t, wall=wall, port=self.port,
                                 data=data.decode("utf-8", "backslashreplace"), nbytes=len(data))
        self._pacer.write(data)

    # device -> host
    def _deliver(self, deliveries):
        if self.silent:
            return
        for delivery in deliveries:
            due = self._pacer.to_perf_ns(delivery.t_us) / 1e9
            data = delivery.data
            with self._cv:
                if not self._open:
                    return
                t = time.perf_counter()
                dropped = len(self._buf) + len(data) > config.INPUT_BUFFER_LIMIT
                if not dropped:
                    self._buf += data
                    self._produced += len(data)
                    if data.endswith(b"\n"):  # a complete line: log when the host has read it
                        self._pending.append((self._produced, delivery.seq, t))
                    self._cv.notify_all()
            runtime.serial_log.write("dropped" if dropped else "sent", t=t, port=self.port,
                                     seq=delivery.seq, kind=delivery.kind,
                                     line=data.decode("ascii", "backslashreplace").rstrip("\r\n"),
                                     due=due, late_ms=round((t - due) * 1e3, 3))

    def close(self):
        super().close()
        self._pacer.stop()
