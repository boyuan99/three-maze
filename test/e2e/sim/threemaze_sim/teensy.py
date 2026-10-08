"""Simulated Teensy behind serial.Serial (pyserial 3.5 API with its Windows semantics).

Device model (the hallway01/02/04 firmware, as far as the repo shows it; the firmware source is
not in the repo):
- Opening the port succeeds at once; the firmware stays silent until it receives an init line.
- Init line "a,b,c,d" of four numbers (hallway04 sends "10000,50,10,1\\n" 2 s after opening):
  b is taken as the sample period in ms (50 -> 20 Hz, matching DT = 1/20 s in the experiments
  and the 50 ms replay rate); d != 0 starts streaming, d == 0 stops it. Sending the line again
  restarts the stream (sample counter and device clock restart at 0).
- "STOP" stops the stream (a sim convenience: no experiment sends it). Anything else is logged
  and ignored, including the "START,50,0" of the other (standalone) firmware.
- While streaming, one CRLF-terminated line per period, on absolute perf_counter deadlines
  (first line one period after the init line):
      t_us,left_dx,left_dy,left_dt,right_dx,right_dy,right_dt,x,y,theta,water,direction,frameCount
  sample k = 1, 2, ...:   k*P,0,c_k,P,0,c_k,P,0,c_k,0,0,0,k        (P = period in us)
  c_k = forward ball counts per sample: 16 * THREEMAZE_SIM_SPEED, emitted as integers whose
  running sum stays exact. No lateral motion, no rotation, no licks.
- Lines are buffered like a driver buffer (1 MiB, then new lines are dropped) until read.
- Closing the port stops the stream. A port can be held by one handle at a time, also across
  processes sharing THREEMAZE_SIM_DIR (a lock file in $THREEMAZE_SIM_DIR/ports), so a second
  open fails like a busy COM port.

THREEMAZE_SIM_SERIAL: ok (default) | missing (open fails like a missing COM3 on this machine) |
busy (open fails like a port held by another program) | silent (opens, never sends data).
THREEMAZE_SIM_OPEN_DELAY_S (default 0): opening the port blocks the calling thread this long first,
like a hung USB-serial driver; e.g. 35 makes hallway04 registration outlast the renderer's 30 s timeout.

serial.jsonl events: open_delay, open, open_failed, close, received (host -> device write), command,
command_ignored, stream_start, stream_stop, sent (device -> host line, with its due time),
read (when the host has consumed the line's last byte, with latency_ms), dropped, discarded.
"""
import atexit
import collections
import ctypes
import math
import os
import threading
import time

from serial.serialutil import PortNotOpenError, SerialBase, SerialException, to_bytes

from . import config, runtime

# --- errors exactly as pyserial's Windows backend reports them ------------------------------


def _win_error(code):
    if hasattr(ctypes, "WinError"):
        return ctypes.WinError(code)
    errno = {2: 2, 5: 13, 6: 9}.get(code, code)
    return OSError(errno, os.strerror(errno))


def _open_error(portstr, winerror):
    # serialwin32.Serial.open(): SerialException("could not open port {!r}: {!r}".format(...))
    return SerialException("could not open port {!r}: {!r}".format(portstr, _win_error(winerror)))


def _bad_handle_error():
    # in_waiting on a closed pyserial port: ClearCommError fails on the invalid handle
    return SerialException("ClearCommError failed ({!r})".format(_win_error(6)))


# --- exclusive access to a port -----------------------------------------------------------------

_claims_lock = threading.Lock()
_claims = {}  # port key -> fd of its lock file


def _port_key(name):
    key = name.strip().upper()
    return key[4:] if key.startswith("\\\\.\\") else key


def _lock_fd(fd):
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _claim(portstr):
    key = _port_key(portstr)
    with _claims_lock:
        if key in _claims:
            raise _open_error(portstr, 5)
        fd = None
        try:
            os.makedirs(runtime.settings.port_lock_dir, exist_ok=True)
            safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in key)
            fd = os.open(os.path.join(runtime.settings.port_lock_dir, safe + ".lock"), os.O_RDWR | os.O_CREAT)
            _lock_fd(fd)
        except OSError as exc:
            if fd is not None:
                os.close(fd)
            runtime.sim_log.write("port_lock_failed", port=portstr, error=repr(exc))
            raise _open_error(portstr, 5) from None
        _claims[key] = fd
    return key


def _release(key):
    with _claims_lock:
        fd = _claims.pop(key, None)
    if fd is None:
        return
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    finally:
        os.close(fd)


# --- the firmware -------------------------------------------------------------------------------

_streams_lock = threading.Lock()
_streams = set()


def _round_half_up(x):
    return math.floor(x + 0.5)


def _is_number(text):
    try:
        float(text)
        return True
    except ValueError:
        return False


class _Stream:
    """The sampling loop of one start command, on its own daemon thread."""

    def __init__(self, device, period_s, t0):
        self.device = device
        self.period_s = period_s
        self.t0 = t0
        self.stopped = False
        self.thread = threading.Thread(target=self._run, name=f"sim-teensy-{device.port}", daemon=True)

    def start(self):
        with _streams_lock:
            _streams.add(self)
        self.thread.start()

    def stop(self):
        self.stopped = True

    def _run(self):
        try:
            period_us = int(round(self.period_s * 1e6))
            counts = config.FORWARD_COUNTS_PER_SAMPLE * runtime.settings.speed
            k = 0
            due = self.t0 + self.period_s
            while not self.stopped:
                delay = due - time.perf_counter()
                if delay > 0:
                    # time.sleep is high resolution on Windows (Python >= 3.11); lock and Event
                    # timeouts are not (15.6 ms), so they are not used for timing
                    time.sleep(min(delay, 0.02))
                    continue
                k += 1
                c = _round_half_up(counts * k) - _round_half_up(counts * (k - 1))
                line = f"{k * period_us},0,{c},{period_us},0,{c},{period_us},0,{c},0,0,0,{k}"
                if not self.device._emit(self, line, k, due):
                    break
                due += self.period_s
        except Exception as exc:  # never let the device thread die silently
            runtime.serial_log.write("stream_error", port=self.device.port, error=repr(exc))
        finally:
            with _streams_lock:
                _streams.discard(self)


def _stop_all_streams():
    with _streams_lock:
        streams = list(_streams)
    for stream in streams:
        stream.stop()
    for stream in streams:
        stream.thread.join(0.2)


atexit.register(_stop_all_streams)


class SimTeensy:
    """Device side of one open port: input buffer for the host, command parser, sample stream."""

    def __init__(self, port, silent):
        self.port = port
        self.silent = silent
        self._cv = threading.Condition(threading.Lock())
        self._buf = bytearray()
        self._produced = 0
        self._consumed = 0
        self._pending = collections.deque()  # (end offset, seq, t_sent) of lines not fully read
        self._rx = bytearray()
        self._open = True
        self._cancel = False
        self._stream = None

    # host -> device
    def receive(self, data):
        t, wall = time.perf_counter(), time.time()
        runtime.serial_log.write("received", t=t, wall=wall, port=self.port,
                                 data=data.decode("utf-8", "backslashreplace"), nbytes=len(data))
        commands = []
        with self._cv:
            self._rx += data
            while True:
                end = self._rx.find(b"\n")
                if end < 0:
                    break
                commands.append(bytes(self._rx[:end]))
                del self._rx[:end + 1]
        for raw in commands:
            self._command(raw.decode("ascii", "replace").strip(), t)

    def _command(self, text, t):
        if not text:
            return
        fields = [field.strip() for field in text.split(",")]
        if fields[0].upper() == "STOP":
            runtime.serial_log.write("command", port=self.port, command=text, action="stop")
            self._stop_stream("stop command")
            return
        if len(fields) == 4 and all(_is_number(field) for field in fields):
            period_ms = float(fields[1])
            if not 1 <= period_ms <= 1000:
                period_ms = config.DEFAULT_PERIOD_MS
            run = float(fields[3]) != 0
            runtime.serial_log.write("command", port=self.port, command=text,
                                     action="start" if run else "stop", period_ms=period_ms)
            if run:
                self._start_stream(period_ms / 1000.0, t, text)
            else:
                self._stop_stream("init line with run flag 0")
            return
        runtime.serial_log.write("command_ignored", port=self.port, command=text)

    def _start_stream(self, period_s, t0, text):
        self._stop_stream("restarted by a new init line")
        if self.silent:
            runtime.serial_log.write("stream_suppressed", port=self.port, reason="THREEMAZE_SIM_SERIAL=silent")
            return
        stream = _Stream(self, period_s, t0)
        with self._cv:
            if not self._open:
                return
            self._stream = stream
        runtime.serial_log.write(
            "stream_start", port=self.port, init=text, period_ms=period_s * 1e3,
            counts_per_sample=config.FORWARD_COUNTS_PER_SAMPLE * runtime.settings.speed,
            speed=runtime.settings.speed, first_due=t0 + period_s)
        stream.start()

    def _stop_stream(self, reason):
        with self._cv:
            stream, self._stream = self._stream, None
        if stream is not None:
            stream.stop()
            runtime.serial_log.write("stream_stop", port=self.port, reason=reason)

    def _emit(self, stream, line, seq, due):
        data = line.encode("ascii") + config.LINE_ENDING
        with self._cv:
            if stream is not self._stream or not self._open:
                return False
            t = time.perf_counter()
            dropped = len(self._buf) + len(data) > config.INPUT_BUFFER_LIMIT
            if not dropped:
                self._buf += data
                self._produced += len(data)
                self._pending.append((self._produced, seq, t))
                self._cv.notify_all()
        runtime.serial_log.write("dropped" if dropped else "sent", t=t, port=self.port, seq=seq,
                                 line=line, due=due, late_ms=round((t - due) * 1e3, 3))
        return True

    # device -> host
    def in_waiting(self):
        with self._cv:
            return len(self._buf)

    def _take(self, n):
        """Remove n bytes from the buffer; call with self._cv held."""
        out = bytes(self._buf[:n])
        del self._buf[:n]
        self._consumed += n
        done = []
        while self._pending and self._pending[0][0] <= self._consumed:
            done.append(self._pending.popleft())
        return out, done, time.perf_counter()

    def _log_reads(self, done, t):
        for _, seq, t_sent in done:
            runtime.serial_log.write("read", t=t, port=self.port, seq=seq,
                                     latency_ms=round((t - t_sent) * 1e3, 3))

    def read(self, size, timeout):
        """pyserial read(): up to size bytes, waiting at most timeout s (None = forever, 0 = no wait)."""
        if size <= 0:
            return b""
        deadline = None if timeout is None else time.perf_counter() + timeout
        with self._cv:
            while len(self._buf) < size and self._open and not self._cancel and timeout != 0:
                if deadline is None:
                    self._cv.wait()
                else:
                    remaining = deadline - time.perf_counter()
                    if remaining <= 0:
                        break
                    self._cv.wait(remaining)
            self._cancel = False
            out, done, t = self._take(min(size, len(self._buf)))
        self._log_reads(done, t)
        return out

    def readline(self, size, timeout):
        """Same result as io.IOBase.readline() over pyserial's read(1): whatever is buffered up to
        the newline is returned at once; each further byte is waited for for up to timeout s."""
        limit = None if size is None or size < 0 else size
        line = bytearray()
        while limit is None or len(line) < limit:
            with self._cv:
                available = len(self._buf)
                if limit is not None:
                    available = min(available, limit - len(line))
                if available:
                    newline = self._buf.find(b"\n", 0, available)
                    chunk, done, t = self._take(available if newline < 0 else newline + 1)
                else:
                    chunk, done, t = b"", (), None
            if chunk:
                self._log_reads(done, t)
                line += chunk
                if line.endswith(b"\n"):
                    break
                continue
            byte = self.read(1, timeout)
            if not byte:
                break
            line += byte
            if byte == b"\n":
                break
        return bytes(line)

    def clear_input(self):
        with self._cv:
            _, done, t = self._take(len(self._buf))
        for _, seq, _ in done:
            runtime.serial_log.write("discarded", t=t, port=self.port, seq=seq)

    def cancel_read(self):
        with self._cv:
            self._cancel = True
            self._cv.notify_all()

    def close(self):
        with self._cv:
            self._open = False
            stream, self._stream = self._stream, None
            self._cv.notify_all()
        if stream is not None:
            stream.stop()
            runtime.serial_log.write("stream_stop", port=self.port, reason="port closed")


# --- serial.Serial replacement ------------------------------------------------------------------


class SimSerial(SerialBase):
    """Drop-in for serial.Serial that talks to a SimTeensy instead of a COM port."""

    def __init__(self, *args, **kwargs):
        self._device = None
        self._port_key = None
        super().__init__(*args, **kwargs)

    def open(self):
        if self._port is None:
            raise SerialException("Port must be configured before it can be used.")
        if self.is_open:
            raise SerialException("Port is already open.")
        delay = runtime.settings.open_delay_s
        if delay:
            # a hung USB-serial driver: CreateFile blocks the calling thread (here the backend's event loop)
            runtime.serial_log.write("open_delay", port=self.portstr, seconds=delay)
            time.sleep(delay)
        mode = runtime.settings.serial_mode
        if mode in ("missing", "busy"):
            exc = _open_error(self.portstr, 2 if mode == "missing" else 5)
            runtime.serial_log.write("open_failed", port=self.portstr, mode=mode, error=str(exc))
            raise exc
        try:
            self._port_key = _claim(self.portstr)
        except SerialException as exc:
            runtime.serial_log.write("open_failed", port=self.portstr, mode="in_use", error=str(exc))
            raise
        self._device = SimTeensy(self.portstr, silent=(mode == "silent"))
        self.is_open = True
        runtime.serial_log.write("open", port=self.portstr, baudrate=self._baudrate, timeout=self._timeout,
                                 write_timeout=self._write_timeout, mode=mode)

    def close(self):
        if not self.is_open:
            return
        self.is_open = False
        device, self._device = self._device, None
        if device is not None:
            device.close()
        if self._port_key is not None:
            _release(self._port_key)
            self._port_key = None
        runtime.serial_log.write("close", port=self.portstr)

    def _reconfigure_port(self):
        pass  # baud rate, framing and timeouts do not matter to a USB serial device

    @property
    def in_waiting(self):
        device = self._device
        if not self.is_open or device is None:
            raise _bad_handle_error()
        return device.in_waiting()

    def read(self, size=1):
        if not self.is_open:
            raise PortNotOpenError()
        return self._device.read(size, self._timeout)

    def readline(self, size=-1):
        if not self.is_open:
            raise PortNotOpenError()
        return self._device.readline(size, self._timeout)

    def write(self, data):
        if not self.is_open:
            raise PortNotOpenError()
        data = to_bytes(data)
        if data:
            self._device.receive(data)
        return len(data)

    def flush(self):
        if not self.is_open:
            raise PortNotOpenError()

    def reset_input_buffer(self):
        if not self.is_open:
            raise PortNotOpenError()
        self._device.clear_input()

    def reset_output_buffer(self):
        if not self.is_open:
            raise PortNotOpenError()

    @property
    def out_waiting(self):
        if not self.is_open:
            raise _bad_handle_error()
        return 0

    def _update_break_state(self):
        if not self.is_open:
            raise PortNotOpenError()

    def _update_rts_state(self):
        pass

    def _update_dtr_state(self):
        pass

    def _modem_status(self):
        if not self.is_open:
            raise PortNotOpenError()

    @property
    def cts(self):
        self._modem_status()
        return True

    @property
    def dsr(self):
        self._modem_status()
        return True

    @property
    def ri(self):
        self._modem_status()
        return False

    @property
    def cd(self):
        self._modem_status()
        return True

    def set_buffer_size(self, rx_size=4096, tx_size=None):
        pass

    def set_output_flow_control(self, enable=True):
        if not self.is_open:
            raise PortNotOpenError()

    def cancel_read(self):
        device = self._device
        if device is not None:
            device.cancel_read()

    def cancel_write(self):
        pass

    @SerialBase.exclusive.setter
    def exclusive(self, exclusive):
        if exclusive is not None and not exclusive:
            raise ValueError("win32 only supports exclusive access (not: {})".format(exclusive))
        SerialBase.exclusive.fset(self, exclusive)


def install(serial_module):
    real = serial_module.Serial
    serial_module.Serial = SimSerial
    serial_module._threemaze_sim_real_Serial = real
    runtime.sim_log.write("patched", module=serial_module.__name__, attr="Serial",
                          replaced=f"{real.__module__}.{real.__qualname__}", mode=runtime.settings.serial_mode)
