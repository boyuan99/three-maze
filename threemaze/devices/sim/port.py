"""Running a SimDevice in real time.

Pacer maps the device's microsecond time line onto time.perf_counter_ns() (time 0 = when the
Pacer was created) and hands each delivery to a sink at its time, from its own thread. SimPort is
a serial port in the runtime's own process: the subset of pyserial's Serial API that a reader
uses (read, readline, in_waiting, write, reset_input_buffer, close, timeout), with a bounded input
buffer like a driver's.

Timing: the thread sleeps with time.sleep, which is high resolution on Windows from Python 3.11
(lock and Event timeouts are not, so they only wait when nothing is due), at most 2 ms at a time
while something is due, so an earlier event that a write creates is late by at most that.
"""
import threading
import time
from collections.abc import Callable

from .model import Delivery, SimDevice

SinkFn = Callable[[list[Delivery]], None]
STEP_S = 0.002


class Pacer:
    def __init__(self, device: SimDevice, sink: SinkFn, name: str = "sim-device"):
        self.device = device
        self._sink = sink
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = False
        self.t0_ns = time.perf_counter_ns()
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def now_us(self) -> int:
        return (time.perf_counter_ns() - self.t0_ns) // 1000

    def to_perf_ns(self, t_us: int) -> int:
        return self.t0_ns + t_us * 1000

    def write(self, data: bytes) -> None:
        """Host bytes now; what the device answers at once reaches the sink before this returns."""
        with self._lock:
            now = self.now_us()
            self.device.write(data, now)
            self._deliver(now)
        self._wake.set()

    def stop(self) -> None:
        self._stopped = True
        self._wake.set()
        if self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(1.0)

    def _deliver(self, now: int) -> None:
        out = self.device.advance(now)
        if out:
            self._sink(out)  # under the lock, so deliveries reach the sink in order

    def _run(self) -> None:
        while not self._stopped:
            with self._lock:
                now = self.now_us()
                self._deliver(now)
                due = self.device.next_due()
            if due is None:
                self._wake.wait(0.05)
                self._wake.clear()
            else:
                remaining = (due - self.now_us()) / 1e6
                if remaining > 0:
                    time.sleep(min(remaining, STEP_S))


class SimPort:
    """A serial port to a SimDevice. timeout as pyserial's: None waits for ever, 0 never waits,
    otherwise read() waits up to that many seconds for the bytes asked for."""

    def __init__(self, device: SimDevice, timeout: float | None = None, buffer_limit: int = 1 << 20,
                 name: str = "sim-port", on_drop: Callable[[Delivery], None] | None = None):
        self.timeout = timeout
        self.is_open = True
        self._buf = bytearray()
        self._limit = buffer_limit
        self._cv = threading.Condition()
        self._on_drop = on_drop
        self.pacer = Pacer(device, self._receive, name=name)
        self.pacer.start()

    def _receive(self, deliveries: list[Delivery]) -> None:
        with self._cv:
            for delivery in deliveries:
                if len(self._buf) + len(delivery.data) > self._limit:
                    if self._on_drop is not None:
                        self._on_drop(delivery)
                    continue
                self._buf += delivery.data
            self._cv.notify_all()

    @property
    def in_waiting(self) -> int:
        with self._cv:
            return len(self._buf)

    def read(self, size: int = 1) -> bytes:
        if not self.is_open:
            raise OSError("port closed")
        deadline = None if self.timeout is None else time.monotonic() + self.timeout
        with self._cv:
            while len(self._buf) < size and self.is_open and self.timeout != 0:
                if deadline is None:
                    self._cv.wait()
                else:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self._cv.wait(remaining)
            out = bytes(self._buf[:size])
            del self._buf[:size]
            return out

    def readline(self) -> bytes:
        line = bytearray()
        while not line.endswith(b"\n"):
            byte = self.read(1)
            if not byte:
                break
            line += byte
        return bytes(line)

    def write(self, data: bytes) -> int:
        if not self.is_open:
            raise OSError("port closed")
        self.pacer.write(bytes(data))
        return len(data)

    def reset_input_buffer(self) -> None:
        with self._cv:
            self._buf.clear()

    def close(self) -> None:
        if not self.is_open:
            return
        self.is_open = False
        self.pacer.stop()
        with self._cv:
            self._cv.notify_all()
