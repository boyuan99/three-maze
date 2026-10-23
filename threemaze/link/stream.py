"""The sample stream to the motion client (plan item DPR-06b; protocol/v1/SPEC.md rules S1, S2).

The motion device's samples reach the event loop in the order the reader accepted them, already
calibrated (threemaze/devices). The stream keeps them in one queue, and the link server's sender
takes up to 1000 at a time for one sample.batch, as soon as any are there: a batch holds only
samples that were already waiting, so batching carries no meaning (S2). A sample leaves the queue
only to be sent; nothing is merged, reordered or dropped (S1).

The queue has a bound, `limit`. When more samples wait than that, the motion client (or its
connection) is falling behind the device, and the stream raises a session alarm, once, through
on_alarm; it keeps every sample, and the alarm clears when the backlog is back under half the
bound. A sample the server took but could not send, because the connection closed, is counted as
undelivered and reported the same way: never silently.

The stream also sums the displacements it sent, sample by sample in seq order, so that a receiver
can check that the sum it received is the same, bit for bit (plan item DPR-06b, acceptance).
"""
import asyncio
import logging
from collections import deque
from collections.abc import Callable
from typing import Any

from ..core.records import DeviceSample

log = logging.getLogger("threemaze.link")

MAX_BATCH = 1000  # samples per sample.batch (protocol/v1/sample.batch.schema.json)


def backlog_limit(period_us: int | None, seconds: float = 2.0, minimum: int = 100) -> int:
    """The default bound: `seconds` of samples at the device's period, at least `minimum`."""
    if not period_us:
        return max(minimum, 1000)
    return max(minimum, round(seconds * 1e6 / period_us))


class SampleStream:
    def __init__(self, *, limit: int,
                 on_alarm: Callable[[str, dict[str, Any]], None] | None = None):
        self.limit = limit
        self._on_alarm = on_alarm
        self._queue: deque[DeviceSample] = deque()
        self._ready: asyncio.Event | None = None
        self._drained: asyncio.Event | None = None
        self.pushed = 0
        self.sent = 0
        self.in_flight = 0   # taken for a batch whose sending has not ended yet
        self.batches = 0
        self.undelivered = 0
        self.max_backlog = 0
        self.alarms = 0
        self.alarmed = False
        self.last_sent_seq: int | None = None
        self.sum_d_sent = [0.0, 0.0, 0.0]

    @property
    def backlog(self) -> int:
        return len(self._queue)

    @property
    def pending(self) -> int:
        """Samples not yet sent or reported undelivered: waiting, or in a batch being sent."""
        return len(self._queue) + self.in_flight

    def _events(self) -> tuple[asyncio.Event, asyncio.Event]:
        if self._ready is None:  # made on the event loop, at first use
            self._ready, self._drained = asyncio.Event(), asyncio.Event()
            self._drained.set()
        return self._ready, self._drained

    def push(self, samples: list[DeviceSample]) -> None:
        """Samples in the order the reader accepted them; on the event loop."""
        if not samples:
            return
        ready, drained = self._events()
        self._queue.extend(samples)
        self.pushed += len(samples)
        ready.set()
        drained.clear()
        backlog = len(self._queue)
        if backlog > self.max_backlog:
            self.max_backlog = backlog
        if backlog > self.limit and not self.alarmed:
            self.alarmed = True
            self.alarms += 1
            self._alarm(f"{backlog} samples wait for the motion client, more than the bound"
                        f" of {self.limit}: it, or its connection, falls behind the device; no"
                        " sample is dropped", backlog=backlog, limit=self.limit)

    async def take(self, max_samples: int = MAX_BATCH) -> list[DeviceSample]:
        """The samples waiting now, up to max_samples, oldest first; waits for at least one."""
        ready, _ = self._events()
        while not self._queue:
            ready.clear()
            await ready.wait()
        n = min(max_samples, len(self._queue))
        self.in_flight += n
        return [self._queue.popleft() for _ in range(n)]

    def sent_ok(self, batch: list[DeviceSample]) -> None:
        """A batch from take() was sent."""
        self.in_flight -= len(batch)
        self.sent += len(batch)
        self.batches += 1
        self.last_sent_seq = batch[-1].seq
        acc = self.sum_d_sent
        for sample in batch:
            d = sample.d
            acc[0] += d[0]
            acc[1] += d[1]
            acc[2] += d[2]
        self._settle()

    def not_sent(self, batch: list[DeviceSample], why: str) -> None:
        """A batch from take() could not be sent: counted and reported, never silently lost."""
        self.in_flight -= len(batch)
        self.undelivered += len(batch)
        self._alarm(f"{len(batch)} samples not delivered ({why})", first_seq=batch[0].seq,
                    last_seq=batch[-1].seq, undelivered=self.undelivered)
        self._settle()

    def _settle(self) -> None:
        if self.alarmed and len(self._queue) <= self.limit // 2:
            self.alarmed = False
            log.warning("sample backlog back to %d (bound %d)", len(self._queue), self.limit)
        if not self.pending:
            _, drained = self._events()
            drained.set()

    async def drained(self, timeout_s: float) -> bool:
        """Wait until every sample pushed so far was sent (or reported undelivered), the batch
        being sent included."""
        _, drained = self._events()
        if not self.pending:
            return True
        try:
            await asyncio.wait_for(drained.wait(), timeout_s)
        except asyncio.TimeoutError:
            return False
        return True

    def abandon(self, why: str) -> int:
        """Give up the samples still waiting (the session is over and no client takes them);
        returns how many, which are reported as undelivered."""
        n = len(self._queue)
        if n:
            first, last = self._queue[0].seq, self._queue[-1].seq
            self._queue.clear()
            self.undelivered += n
            self._alarm(f"{n} samples never sent ({why})", first_seq=first, last_seq=last,
                        undelivered=self.undelivered)
        self._settle()
        return n

    def _alarm(self, reason: str, **fields: Any) -> None:
        log.error("link: %s", reason)
        if self._on_alarm is not None:
            self._on_alarm(reason, fields)

    def stats(self) -> dict[str, Any]:
        return {"samples_received": self.pushed, "samples_sent": self.sent, "batches": self.batches,
                "backlog": len(self._queue), "in_flight": self.in_flight,
                "max_backlog": self.max_backlog, "limit": self.limit,
                "alarms": self.alarms, "undelivered": self.undelivered,
                "last_sent_seq": self.last_sent_seq, "sum_d_sent": list(self.sum_d_sent)}
