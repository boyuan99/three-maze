"""Ports for the reader's tests (plan items DPR-03, DPR-06b): pySerial's reading interface without
hardware.

- FedPort: bytes that the test feeds, read back in the pieces they were fed in.
- VirtualSimPort: the reference simulated device (threemaze/devices/sim) in virtual time: whenever
  the reader finds nothing to read, the device's clock jumps to its next event, so a stream runs as
  fast as the reader reads, with the same lines as in real time; reads return random pieces of
  what the device sent (rule H1), and the stream can be told to end at a given device time.
"""
import random
import threading
import time


class FedPort:
    """A port whose input is fed by the test; read() returns at most one fed piece at a time, so
    each piece is one read of the reader. Writes are recorded; answers maps a write to the bytes
    the port then feeds itself, as a device would answer."""

    def __init__(self, timeout=0.05, answers=None):
        self.timeout = timeout
        self.is_open = True
        self.writes = []
        self.answers = dict(answers or {})
        self._pieces = []
        self._cv = threading.Condition()
        self._cancel = False

    def feed(self, *pieces):
        with self._cv:
            self._pieces += [bytes(p) for p in pieces if p]
            self._cv.notify_all()

    @property
    def in_waiting(self):
        with self._cv:
            return len(self._pieces[0]) if self._pieces else 0

    def read(self, size=1):
        if not self.is_open:
            raise OSError("port closed")
        deadline = time.monotonic() + self.timeout
        with self._cv:
            while not self._pieces and self.is_open and not self._cancel:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cv.wait(remaining)
            self._cancel = False
            if not self._pieces:
                return b""
            piece = self._pieces[0]
            out, rest = piece[:size], piece[size:]
            if rest:
                self._pieces[0] = rest
            else:
                self._pieces.pop(0)
            return out

    def drained(self):
        with self._cv:
            return not self._pieces

    def write(self, data):
        if not self.is_open:
            raise OSError("port closed")
        self.writes.append(bytes(data))
        if bytes(data) in self.answers:
            self.feed(self.answers[bytes(data)])
        return len(data)

    def reset_input_buffer(self):
        with self._cv:
            self._pieces.clear()

    def cancel_read(self):
        with self._cv:
            self._cancel = True
            self._cv.notify_all()

    def close(self):
        with self._cv:
            self.is_open = False
            self._cv.notify_all()


class VirtualSimPort:
    """A SimDevice in virtual time behind pySerial's reading interface (see the module docstring).

    seed: random pieces of 1 to max_piece bytes (None: everything at once). until_us: the device's
    clock does not advance past this time, so a stream started at time 0 sends exactly the samples
    whose windows end by then."""

    def __init__(self, device, *, seed=1, max_piece=48, until_us=None, timeout=0.05):
        self.device = device
        self.timeout = timeout
        self.is_open = True
        self.now = 0
        self.until_us = until_us
        self._rng = random.Random(seed) if seed is not None else None
        self._max_piece = max_piece
        self._buf = bytearray()
        self._cv = threading.Condition()
        self._cancel = False

    def _fill(self):
        for delivery in self.device.advance(self.now):
            self._buf += delivery.data
        if self._buf:
            return
        due = self.device.next_due()
        if due is not None and (self.until_us is None or due <= self.until_us):
            self.now = max(self.now, due)
            for delivery in self.device.advance(self.now):
                self._buf += delivery.data

    @property
    def in_waiting(self):
        with self._cv:
            self._fill()
            return len(self._buf)

    def read(self, size=1):
        if not self.is_open:
            raise OSError("port closed")
        deadline = time.monotonic() + self.timeout
        with self._cv:
            self._fill()
            while not self._buf and self.is_open and not self._cancel:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._cv.wait(remaining)
                self._fill()
            self._cancel = False
            n = min(size, len(self._buf))
            if n and self._rng is not None:
                n = self._rng.randint(1, min(n, self._max_piece))
            out = bytes(self._buf[:n])
            del self._buf[:n]
            return out

    def write(self, data):
        if not self.is_open:
            raise OSError("port closed")
        with self._cv:
            self.device.write(bytes(data), self.now)
            self._cv.notify_all()
        return len(data)

    def reset_input_buffer(self):
        with self._cv:
            self._buf.clear()

    def cancel_read(self):
        with self._cv:
            self._cancel = True
            self._cv.notify_all()

    def close(self):
        with self._cv:
            self.is_open = False
            self._cv.notify_all()
