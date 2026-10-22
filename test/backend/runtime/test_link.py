"""The link server (plan item DPR-06b): threemaze/link against protocol/v1/SPEC.md, with a mock
motion worker and mock monitors (websockets clients in the test's own process).

Test names carry the rule ids of SPEC.md. Every message the runtime sends is validated strictly
(rule E4), except, for speed, the sample batches of the 100,000-sample run, which are compared
sample by sample with what the reader produced. The server listens on a free loopback port, so
these tests never touch the end-to-end bench's fixed ports.
"""
import asyncio
import copy
import json
import re
import time
from pathlib import Path

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

import threemaze.link.server as link_server
from fakeports import VirtualSimPort
from threemaze.core.records import DeviceSample, StreamFault
from threemaze.devices.sim import SimDevice, config_from_entry
from threemaze.devices.simulated import SimulatedDevice
from threemaze.link import LinkServer
from threemaze.link.receive import heartbeat_ok, pose_batch_ok, read_frame
from threemaze.link.server import text
from threemaze.link.validate import link_errors
from threemaze.runtime import Session, TaskSource

REPO = Path(__file__).resolve().parents[3]
EXAMPLES = REPO / "protocol" / "v1" / "examples"
SESSION = "ses-link"
WORLD = "hallway"
# Forward runs, sideways steps and turns both ways, looped: every component of d moves
ALL_AXES = {"kind": "segments", "segments": [
    {"durationS": 0.3, "forwardCmPerS": 11.168},
    {"durationS": 0.25, "yawDegPerS": 45, "leftCmPerS": 3.0},
    {"durationS": 0.25, "forwardCmPerS": -5.0, "yawDegPerS": -90, "leftCmPerS": -1.5}]}


# --- the mock clients ---------------------------------------------------------------------------

def hello(role="motion", session=SESSION, version="1.0", rid="h1"):
    data = {"protocol": "three-maze/link", "version": version, "role": role,
            "client": {"impl": "mock-worker", "version": "0.0.1"}}
    if role == "motion":
        data.update(session=session, versions={"electron": "44.7.0", "three": "0.169.0",
                                               "rapier3d-compat": "0.14.0"})
    return {"type": "hello", "t": 1000, "id": rid, "data": data}


def client(url, **options):
    return connect(url, proxy=None, compression=None, ping_interval=None, **options)


async def receive(ws, *, skip=("heartbeat",), timeout=5.0, validate=True):
    """The next message the runtime sent, not of a type in skip; strictly valid (rule E4)."""
    while True:
        message = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if validate:
            assert link_errors(message) == [], (message, link_errors(message))
        if message["type"] not in skip:
            return message


async def closed(ws, timeout=5.0):
    """Read until the runtime closes the connection; its close code."""
    try:
        while True:
            await asyncio.wait_for(ws.recv(), timeout)
    except ConnectionClosed:
        return ws.close_code


async def join(url, message=None, **options):
    """Connect, send hello, return (connection, welcome, first session.state)."""
    ws = await client(url, **options)
    await ws.send(json.dumps(message or hello()))
    welcome = await receive(ws)
    state = await receive(ws)
    return ws, welcome, state


def send(ws, message):
    return ws.send(json.dumps(message))


# --- the runtime side ----------------------------------------------------------------------------

def make_session(rig, tmp_path, loop):
    session = Session(loop=loop)
    session.configure(rig, data_root=tmp_path / "data", session_id=SESSION)
    session.set_task(TaskSource("declarative", "linear_track"))
    return session


async def serve(sim_rig_path, tmp_path, *, attach=True, rig=None, check_outgoing=True, **options):
    """A link server for a session of the rig (configured, not armed); by default it validates
    every message it sends (rule E4)."""
    server = LinkServer(check_outgoing=check_outgoing, **options)
    await server.start()
    session = make_session(rig or sim_rig_path, tmp_path, asyncio.get_running_loop())
    if attach:
        server.attach(session, world=WORLD)
    return server, session


def synthetic(first, n):
    """n device samples from seq first, with displacements whose sum tests every bit."""
    return [DeviceSample(k, 1000 * (k + 1), 1000, (k % 7, -3, 1),
                         (k * 0.0349, -1e-3 * k, 0.05 / (k + 1)), 0, 0, k)
            for k in range(first, first + n)]


def push(server, session, samples):
    server.on_device_batch(session, "ball", samples)


def link_log(session):
    path = session.dir / "link.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


# --- handshake (rules C1-C5) --------------------------------------------------------------------

def test_link_c1_no_hello_within_the_limit_closes_with_4000(run, sim_rig_path, tmp_path):
    async def main():
        server, _ = await serve(sim_rig_path, tmp_path, hello_timeout_s=0.2)
        async with client(server.url) as ws:
            code = await closed(ws)
        await server.close()
        return code, server.counts["refused"]

    assert run(main()) == (4000, 1)


@pytest.mark.parametrize("first", [
    json.dumps({"type": "heartbeat", "t": 1, "data": {"n": 0}}),   # a valid message, not hello
    "not json at all",
    json.dumps({"type": "telemetry.v2", "t": 1, "data": {}}),     # a later version's type
    json.dumps({**hello(), "data": {**hello()["data"], "role": "renderer"}}),
    b"\x00\x01",                                                   # a binary frame
], ids=["heartbeat", "not-json", "unknown-type", "bad-role", "binary"])
def test_link_c1_anything_before_hello_gets_bad_message_then_4000(run, sim_rig_path, tmp_path,
                                                                  first):
    async def main():
        server, _ = await serve(sim_rig_path, tmp_path)
        async with client(server.url) as ws:
            await ws.send(first)
            error = await receive(ws)
            code = await closed(ws)
        await server.close()
        return error, code

    error, code = run(main())
    assert error["type"] == "error" and error["data"]["code"] == "bad_message" and "re" not in error
    assert code == 4000


def test_link_c2_major_version_1_and_the_lower_minor(run, sim_rig_path, tmp_path):
    async def main():
        server, _ = await serve(sim_rig_path, tmp_path)
        async with client(server.url) as ws:
            await send(ws, hello(version="2.0"))
            error = await receive(ws)
            code = await closed(ws)
        ws2, welcome, _ = await join(server.url, hello(version="1.7"))
        await ws2.close()
        await server.close()
        return error, code, welcome

    error, code, welcome = run(main())
    assert (error["re"], error["data"]["code"], code) == ("h1", "version_mismatch", 4002)
    assert "2.0" in error["data"]["message"] and welcome["data"]["version"] == "1.0"


def test_link_c3_one_motion_client_per_session_and_of_that_session(run, sim_rig_path, tmp_path):
    async def refused(url, message):
        async with client(url) as ws:
            await send(ws, message)
            error = await receive(ws)
            return error["re"], error["data"]["code"], await closed(ws)

    async def main():
        bare = LinkServer(check_outgoing=True)          # no session attached
        await bare.start()
        no_session = await refused(bare.url, hello())
        await bare.close()
        server, _ = await serve(sim_rig_path, tmp_path)
        other = await refused(server.url, hello(session="ses-other"))
        first, welcome, _ = await join(server.url)
        second = await refused(server.url, hello(rid="h2"))
        monitor, monitor_welcome, _ = await join(server.url, hello(role="monitor", rid="m1"))
        await first.close()
        await asyncio.sleep(0.05)
        after = await refused(server.url, hello(rid="h3"))
        await monitor.close()
        await server.close()
        return no_session, other, welcome, second, monitor_welcome, after, server

    no_session, other, welcome, second, monitor_welcome, after, server = run(main())
    assert no_session == ("h1", "session_mismatch", 4005)
    assert other == ("h1", "session_mismatch", 4005)
    assert welcome["data"]["client_id"] == "motion-2"   # the second connection to this server
    assert second == ("h2", "role_conflict", 4003)
    assert monitor_welcome["data"]["role"] == "monitor"
    # Resuming with a new motion worker is phase 2 (DPR-13): the session's worker is the first one
    assert after == ("h3", "role_conflict", 4003)
    assert [a["reason"] for a in server.alarms] == [
        "the motion client closed its connection (1000) while the session is configured"]


def test_link_c4_c5_welcome_session_state_and_heartbeats(run, sim_rig_path, tmp_path):
    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        monitor, monitor_welcome, monitor_state = await join(server.url,
                                                             hello(role="monitor", rid="m1"))
        ws, welcome, state = await join(server.url)
        loop = asyncio.get_running_loop()
        beats = []
        while len(beats) < 15:
            message = await receive(ws, skip=())
            if message["type"] == "heartbeat":
                beats.append((loop.time(), message["data"]["n"]))
        await asyncio.to_thread(session.abort, "test over")
        final = await receive(monitor)
        await ws.close()
        await monitor.close()
        await server.close()
        return session, welcome, state, monitor_welcome, monitor_state, beats, final, server

    session, welcome, state, monitor_welcome, monitor_state, beats, final, server = run(main())
    data = welcome["data"]
    assert (welcome["re"], data["role"], data["session"], data["epoch"], data["world"]) == (
        "h1", "motion", SESSION, 0, WORLD)
    assert (data["heartbeat_ms"], data["watchdog_ms"]) == (20, 100)
    assert data["device"] == {"profile": "v1", "completeness": "counted", "integrity": "crc8",
                              "seq_source": "device", "time_source": "device", "period_us": 50000,
                              "n_axes": 3, "device_id": "sim-ball"}
    assert state["data"] == {"state": "configured", "session": SESSION,
                             "experiment": "linear_track"}
    assert "world" not in monitor_welcome["data"] and "device" not in monitor_welcome["data"]
    assert monitor_state["data"]["state"] == "configured"
    assert [n for _, n in beats] == list(range(15))     # B1: counted from 0, none missing
    gaps_ms = [(b - a) * 1000 for (a, _), (b, _) in zip(beats, beats[1:])]
    print(f"\nruntime heartbeat gaps: median {sorted(gaps_ms)[len(gaps_ms) // 2]:.1f} ms,"
          f" max {max(gaps_ms):.1f} ms (not judged here: timing needs an exclusive bench window)")
    assert final["data"]["state"] == "aborted" and final["data"]["reason"] == "test over"
    hello_logged = [r for r in server.link_log._pending if '"event":"hello"' in r]
    assert any('"rapier3d-compat":"0.14.0"' in r for r in hello_logged)  # C5: versions kept


# --- the sample stream (rules S1, S2) ------------------------------------------------------------

def test_link_s1_s2_100000_samples_in_order_complete_and_sum_d_conserved(run, sim_rig_data,
                                                                         write_rig, tmp_path,
                                                                         monkeypatch):
    """Acceptance of DPR-06b: the simulated device at 1 kHz in virtual time, read by the reader,
    through the session and the link to a mock worker: 100,000 samples arrive, each once, in seq
    order, every field as the reader produced it, and the sum of d received equals the sum sent,
    bit for bit; the last samples go out before the final state and the 4004 close."""
    n = 100_000
    sim_rig_data["devices"]["ball"].update(periodUs=1000, trajectory=ALL_AXES)
    rig = write_rig(sim_rig_data)

    def fast_port(self):
        cfg = config_from_entry(self.config, self.ctx.resolve)
        # Read in stretches of 50 ms of samples, as USB delivers several lines at a time
        return VirtualSimPort(SimDevice(cfg, log=self.log.write), seed=None, step_us=50_000,
                              until_us=n * 1000 + 500)

    monkeypatch.setattr(SimulatedDevice, "open_port", fast_port)
    produced = []

    class Reader:
        def on_device_batch(self, session, device, records):
            if device == "ball":
                produced.extend(r for r in records if type(r) is DeviceSample)

    async def main():
        # The batches are compared sample by sample below; validating 100 batches of 1,000 with
        # jsonschema as they are sent would take most of the test's time
        server, session = await serve(None, tmp_path, rig=rig, backlog=n, check_outgoing=False)
        session.add_listener(Reader())
        await asyncio.to_thread(session.arm)
        ws, welcome, _ = await join(server.url, max_size=None)
        await asyncio.to_thread(session.start)
        received, batches, states = [], 0, []
        while len(received) < n:
            message = await receive(ws, validate=batches < 3, timeout=60)
            if message["type"] == "sample.batch":
                assert message["data"]["seq_source"] == "device"
                received += message["data"]["samples"]
                batches += 1
        await asyncio.to_thread(session.stop)
        try:
            while True:
                message = await receive(ws)
                if message["type"] == "session.state":
                    states.append(message["data"]["state"])
                elif message["type"] == "sample.batch":
                    received += message["data"]["samples"]
        except ConnectionClosed:
            code = ws.close_code
        await server.close()
        return server, received, batches, states, code

    server, received, batches, states, code = run(main(), timeout=120)
    assert len(produced) == n and [s["seq"] for s in received] == list(range(n))
    assert received == [s.link() for s in produced]
    sent_sum, received_sum = [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    for s, r in zip(produced, received):
        for i in range(3):
            sent_sum[i] += s.d[i]
            received_sum[i] += r["d"][i]
    assert all(v != 0.0 for v in sent_sum)       # forward, left and yaw all summed
    assert [v.hex() for v in received_sum] == [v.hex() for v in sent_sum]
    assert server.stream.sum_d_sent == sent_sum
    assert states[-1] == "complete" and code == 4004
    stats = server.stream.stats()
    assert (stats["samples_sent"], stats["undelivered"], stats["alarms"]) == (n, 0, 0)
    assert batches >= n // 1000


def test_link_s1_slow_consumer_raises_an_alarm_and_nothing_is_dropped(run, sim_rig_path, tmp_path):
    """A motion client that stops taking messages: its connection's send stalls (as when the
    socket's buffers are full), samples keep coming 100 at a time, the backlog passes the bound and
    the session alarm goes off, once; when the client takes messages again, every sample arrives,
    in order, and the alarm clears."""
    async def main():
        server, session = await serve(sim_rig_path, tmp_path, backlog=500)
        ws, _, _ = await join(server.url)
        connection = server.motion.ws
        flowing = asyncio.Event()
        real_send = connection.send

        async def stalled_send(frame):
            await flowing.wait()
            await real_send(frame)

        connection.send = stalled_send
        pushed = 0
        while pushed < 3000:
            push(server, session, synthetic(pushed, 100))
            pushed += 100
            await asyncio.sleep(0.001)
        alarmed, backlog = server.stream.alarmed, server.stream.backlog
        flowing.set()
        received = []
        while len(received) < pushed:
            message = await receive(ws, validate=False, timeout=30)
            if message["type"] == "sample.batch":
                received += message["data"]["samples"]
        await ws.close()
        await server.close()
        return server, session, pushed, alarmed, backlog, received

    server, session, pushed, alarmed, backlog, received = run(main(), timeout=60)
    assert alarmed and backlog > 500 and server.stream.alarms == 1
    assert [s["seq"] for s in received] == list(range(pushed))
    assert received == [s.link() for s in synthetic(0, pushed)]
    assert server.stream.undelivered == 0 and not server.stream.alarmed
    assert server.stream.max_backlog >= backlog
    alarm = server.alarms[0]
    assert "falls behind" in alarm["reason"] and alarm["limit"] == 500 and alarm["backlog"] > 500
    # A session alarm: the session keeps it for its record
    assert [(a["source"], a["reason"]) for a in session.alarms][0] == ("link", alarm["reason"])


def test_link_s1_samples_wait_for_the_motion_client_and_a_closed_session_reports_the_rest(
        run, sim_rig_path, tmp_path):
    async def main():
        server, session = await serve(sim_rig_path, tmp_path, backlog=10_000)
        push(server, session, synthetic(0, 2500))       # before the worker connects
        ws, _, _ = await join(server.url)
        received = []
        while len(received) < 2500:
            message = await receive(ws, validate=False)
            if message["type"] == "sample.batch":
                received += message["data"]["samples"]
                assert len(message["data"]["samples"]) <= 1000
        await ws.close()
        await asyncio.sleep(0.05)
        push(server, session, synthetic(2500, 10))       # nobody takes these any more
        await asyncio.to_thread(session.abort, "test over")
        await asyncio.wait_for(server.finished.wait(), 5)
        push(server, session, synthetic(2510, 5))        # after the end: reported too
        await server.close()
        return server, received

    server, received = run(main())
    assert [s["seq"] for s in received] == list(range(2500))
    assert (server.stream.undelivered, server.stream.backlog) == (15, 0)
    reasons = [a["reason"] for a in server.alarms]
    assert any(r.startswith("10 samples never sent (the session ended without") for r in reasons)
    assert reasons[-1] == ("5 samples never sent (they arrived after the end of the session was"
                           " sent)")


def test_link_s1_the_session_end_waits_for_the_batch_being_sent(run, sim_rig_path, tmp_path):
    """A batch the server took from the queue and is still sending when the session ends goes out
    before the final state and the 4004 close, and the stream's record at the end counts it sent."""
    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        await asyncio.to_thread(session.arm)
        ws, _, _ = await join(server.url)
        connection = server.motion.ws
        flowing = asyncio.Event()
        real_send = connection.send

        async def slow_send(frame):
            if frame.startswith('{"type":"sample.batch"'):
                await flowing.wait()
            await real_send(frame)

        connection.send = slow_send
        push(server, session, synthetic(0, 50))
        await asyncio.sleep(0.05)                 # the batch is taken; its send has not ended
        taken = (server.stream.backlog, server.stream.in_flight)
        await asyncio.to_thread(session.abort, "test over")
        await asyncio.sleep(0.2)
        waited = not server.finished.is_set()     # the end waits for the batch
        flowing.set()
        await asyncio.wait_for(server.finished.wait(), 5)
        order = []
        try:
            while True:
                message = await receive(ws)
                order.append(message["type"] if message["type"] != "session.state"
                             else message["data"]["state"])
        except ConnectionClosed:
            code = ws.close_code
        await server.close()
        return server, session, taken, waited, order, code

    server, session, taken, waited, order, code = run(main())
    assert taken == (0, 50) and waited
    assert order == ["sample.batch", "aborted"] and code == 4004
    [end] = [r for r in link_log(session) if r["event"] == "stream_end"]
    assert (end["samples_sent"], end["in_flight"], end["undelivered"]) == (50, 0, 0)
    assert server.alarms == []


async def stall(server, session, ws):
    """Push batches of 1,000 samples until the motion client, which no longer reads (ws), holds
    them up: its socket's buffers are full and the server's send waits. Returns how many."""
    pushed = 0
    while server.stream.backlog < 2000:
        assert pushed < 200_000, "the motion client's connection never filled up"
        push(server, session, synthetic(pushed, 1000))
        pushed += 1000
        await asyncio.sleep(0.01)
    return pushed


def test_link_s1_the_end_is_bounded_when_the_motion_client_stops_reading(run, sim_rig_path,
                                                                         tmp_path):
    """A motion worker that stops reading (its socket's buffers full, as when its thread hangs)
    and a monitor whose final state cannot be sent: the end of the session still goes through
    within its time limits. The samples the worker did not take are reported, the worker is cut
    off with an alarm, the monitor stays connected, and the server closes; nothing waits forever
    (websockets waits for a socket's buffer to drain without a time limit)."""
    async def main():
        server, session = await serve(sim_rig_path, tmp_path, backlog=10**6,
                                      drain_timeout_s=0.3, send_timeout_s=0.3)
        await asyncio.to_thread(session.arm)
        ws, _, _ = await join(server.url, max_queue=1, max_size=None)   # reads nothing more
        monitor, _, _ = await join(server.url, hello(role="monitor", rid="m1"))
        reading = asyncio.create_task(closed(monitor, timeout=30))
        [watcher] = [c for c in server.clients.values() if c.role == "monitor"]
        never, real_send = asyncio.Event(), watcher.ws.send

        async def final_state_stuck(frame):
            if '"state":"aborted"' in frame:
                await never.wait()
            await real_send(frame)

        watcher.ws.send = final_state_stuck
        pushed = await stall(server, session, ws)
        t0 = time.monotonic()
        await asyncio.to_thread(session.abort, "test over")
        await asyncio.wait_for(server.finished.wait(), 5)
        took = time.monotonic() - t0
        still_there = watcher.id in server.clients
        await asyncio.wait_for(server.close(), 10)
        await asyncio.wait_for(reading, 10)
        return server, session, pushed, took, still_there

    server, session, pushed, took, still_there = run(main(), timeout=60)
    assert took < 3.0 and still_there
    stats = server.stream.stats()
    assert (stats["backlog"], stats["in_flight"]) == (0, 0)
    assert stats["samples_sent"] + stats["undelivered"] == pushed and stats["undelivered"] > 0
    reasons = [a["reason"] for a in server.alarms]
    assert any("never sent (the motion client did not take the last samples within 0.3 s" in r
               for r in reasons)
    assert any(re.fullmatch(r"motion-\d+ took no message within 0.3 s \(the final state\): cut off",
                            r) for r in reasons)
    records = link_log(session)
    assert [r["waiting_for"] for r in records if r["event"] == "cut"] == ["the final state"]
    [end] = [r for r in records if r["event"] == "stream_end"]
    assert (end["samples_sent"], end["undelivered"]) == (stats["samples_sent"],
                                                         stats["undelivered"])


def test_link_close_cuts_off_a_client_that_stops_reading(run, sim_rig_path, tmp_path,
                                                        monkeypatch):
    """The server's close() during a session: a motion client that no longer reads cannot take
    the close either, and is cut off after the time limit instead of holding the close up."""
    monkeypatch.setattr(link_server, "CLOSE_TIMEOUT_S", 0.2)

    async def main():
        server, session = await serve(sim_rig_path, tmp_path, backlog=10**6, send_timeout_s=0.3)
        ws, _, _ = await join(server.url, max_queue=1, max_size=None)
        await stall(server, session, ws)
        t0 = time.monotonic()
        await asyncio.wait_for(server.close(), 10)
        return server, time.monotonic() - t0

    server, took = run(main(), timeout=60)
    assert took < 3.0 and server.clients == {}
    assert server.stream.in_flight == 0 and server.stream.undelivered > 0


def test_link_successive_sessions_on_one_server(run, sim_rig_path, tmp_path):
    """One server, two sessions one after the other, with the control window (a monitor)
    connected throughout: the second session is attached once the first one's end is through,
    gets its own motion worker, samples, epoch and link log, and the first session's late calls
    change nothing."""
    async def session_run(server, session, first_seq, monitor_states):
        await asyncio.to_thread(session.arm)
        ws, welcome, _ = await join(server.url, hello(session=session.session_id))
        push(server, session, synthetic(first_seq, 20))
        received = []
        while len(received) < 20:
            message = await receive(ws)
            if message["type"] == "sample.batch":
                received += [s["seq"] for s in message["data"]["samples"]]
        await send(ws, event("teleport_applied", first_seq, 1, x=0.0, feet_y=0.0, z=0.0, yaw=0.0))
        await ws.send("flush")
        await receive(ws)
        await asyncio.to_thread(session.abort, "test over")
        await asyncio.wait_for(server.finished.wait(), 5)
        code = await closed(ws)
        return welcome, received, code

    async def main():
        server = LinkServer(check_outgoing=True)
        await server.start()
        loop = asyncio.get_running_loop()
        first = Session(loop=loop)
        first.configure(sim_rig_path, data_root=tmp_path / "data", session_id="ses-one")
        first.set_task(TaskSource("declarative", "linear_track"))
        server.attach(first, world=WORLD)
        monitor, _, _ = await join(server.url, hello(role="monitor", rid="m1"))
        states = []

        async def watch():
            try:
                while True:
                    message = await receive(monitor, timeout=30)
                    if message["type"] == "session.state":
                        states.append((message["data"].get("session"), message["data"]["state"]))
            except ConnectionClosed:
                return

        watching = asyncio.create_task(watch())
        second = Session(loop=loop)
        second.configure(sim_rig_path, data_root=tmp_path / "data", session_id="ses-two")
        second.set_task(TaskSource("declarative", "linear_track"))
        with pytest.raises(ValueError, match="serves session ses-one until its end"):
            server.attach(second, world=WORLD)
        one = await session_run(server, first, 0, states)
        server.attach(second, world=WORLD)
        server.on_device_batch(first, "ball", synthetic(100, 5))   # late: the first session's
        epoch_at_start = server.epoch
        two = await session_run(server, second, 500, states)
        await monitor.close()
        await watching
        await server.close()
        return server, first, second, one, two, states, epoch_at_start

    server, first, second, one, two, states, epoch_at_start = run(main(), timeout=60)
    for (welcome, received, code), session, seqs in ((one, first, range(20)),
                                                     (two, second, range(500, 520))):
        assert welcome["data"]["session"] == session.session_id and welcome["data"]["epoch"] == 0
        assert received == list(seqs) and code == 4004
        records = link_log(session)
        [hello_record] = [r for r in records if r["event"] == "hello" and r["client"].startswith(
            "motion")]
        assert hello_record["message"]["data"]["session"] == session.session_id
        assert [r["message"]["data"]["seq"] for r in records if r["event"] == "event"] == [seqs[0]]
    assert epoch_at_start == 0 and server.stream.pushed == 20
    assert [s for s in states if s[1] in ("configured", "armed", "aborted")] == [
        ("ses-one", "armed"), ("ses-one", "aborted"), ("ses-two", "configured"),
        ("ses-two", "armed"), ("ses-two", "aborted")]


def test_link_s1_a_batch_that_cannot_be_sent_is_reported_and_the_stream_goes_on(
        run, sim_rig_path, tmp_path):
    """A batch the server cannot send (here a displacement JSON cannot hold) is reported as
    undelivered with an alarm, never lost silently, and the samples after it still go out."""
    async def main():
        server, session = await serve(sim_rig_path, tmp_path, check_outgoing=False)
        ws, _, _ = await join(server.url)
        bad = DeviceSample(0, 1000, 1000, (1, 0, 0), (float("inf"), 0.0, 0.0), 0, 0, 0)
        push(server, session, [bad])
        while not server.alarms:
            await asyncio.sleep(0.01)
        push(server, session, synthetic(1, 5))
        received = []
        while len(received) < 5:
            message = await receive(ws)
            if message["type"] == "sample.batch":
                received += [s["seq"] for s in message["data"]["samples"]]
        await ws.close()
        await server.close()
        return server, received

    server, received = run(main())
    assert received == [1, 2, 3, 4, 5]
    assert server.stream.stats()["undelivered"] == 1
    [alarm] = [a for a in server.alarms if "not delivered" in a["reason"]]
    assert alarm["reason"].startswith("1 samples not delivered (the batch could not be sent:"
                                      " ValueError")
    assert (alarm["first_seq"], alarm["last_seq"]) == (0, 0)


def test_link_device_fault_raises_an_alarm(run, sim_rig_path, tmp_path):
    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        server.on_device_batch(session, "ball", [StreamFault("the device clock went back", 1)])
        server.on_device_batch(session, "valve", [StreamFault("not the motion device", 2)])
        await server.close()
        return server

    server = run(main())
    assert [a["reason"] for a in server.alarms] == [
        "the motion device's stream failed: the device clock went back"]


def test_link_attach_needs_a_configured_session_on_the_servers_loop(run, sim_rig_path, tmp_path):
    """The session hands its records to its own event loop, and the sample stream lives on the
    server's: a session without a loop (its records would come on the reader threads) is refused,
    as is a session that is not configured (no session to name in welcome, rule C4)."""
    async def main():
        server = LinkServer()
        without_loop = Session()
        without_loop.configure(sim_rig_path, data_root=tmp_path / "data", session_id=SESSION)
        not_configured = Session(loop=asyncio.get_running_loop())
        problems = []
        for session in (without_loop, not_configured):
            with pytest.raises(ValueError) as caught:
                server.attach(session, world=WORLD)
            problems.append(str(caught.value))
        return server, problems

    server, problems = run(main())
    assert "event loop" in problems[0] and "not configured" in problems[1]
    assert server.session is None and server.stream is None


# --- what the motion worker sends: poses, events, render reports, errors (rules V1, Q2, E5) -------

def pose(seq, epoch=0):
    return {"seq": seq, "epoch": epoch, "t_dev_us": 50000 * (seq + 1), "x": 0.0, "feet_y": 0.0,
            "z": -0.5584 * (seq + 1), "yaw": 0.0, "contact": False, "airborne": False}


def event(kind, seq, epoch, **more):
    return {"type": "event", "t": 5000 + seq, "data": {"kind": kind, "seq": seq, "epoch": epoch,
                                                       "t_dev_us": 50000 * (seq + 1), "world": WORLD,
                                                       **more}}


def test_link_poses_events_and_reports_logged_and_old_epoch_events_stale(run, sim_rig_path,
                                                                         tmp_path):
    passed_on = []

    class TaskSide:
        def on_link_event(self, server, message, t_ns):
            passed_on.append((message["data"]["kind"], message["data"]["epoch"]))

    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        server.add_listener(TaskSide())
        await asyncio.to_thread(session.arm)
        ws, _, _ = await join(server.url)
        await send(ws, {"type": "pose.batch", "t": 4000, "data": {"world": WORLD,
                                                                  "poses": [pose(0), pose(1)]}})
        await send(ws, event("zone", 1, 0, zone="reward", edge="enter", cause="move"))
        await send(ws, event("teleport_applied", 1, 1, x=0.0, feet_y=0.0, z=0.0, yaw=0.0,
                             spawn="start"))
        await send(ws, event("zone", 1, 1, zone="reward", edge="exit", cause="teleport"))
        await send(ws, event("zone", 1, 0, zone="reward", edge="exit", cause="move"))  # stale
        await send(ws, {"type": "pose.batch", "t": 4001, "data": {"world": WORLD,
                                                                  "poses": [pose(2, 1)]}})
        await send(ws, json.loads((EXAMPLES / "render.report--ready.json").read_text()))
        await send(ws, {"type": "heartbeat", "t": 4002,
                        "data": {"n": 0, "last_seq": 2, "epoch": 1}})
        await ws.send("flush")                           # bad_json: everything before is handled
        await receive(ws)
        server.advance_epoch(5)                          # a teleport the runtime issued
        await send(ws, event("land", 2, 1))               # stale from now on
        await ws.send("flush")
        await receive(ws)
        await asyncio.to_thread(session.abort, "test over")
        await asyncio.wait_for(server.finished.wait(), 5)
        await ws.close()
        await server.close()
        return server, session

    server, session = run(main())
    assert passed_on == [("zone", 0), ("teleport_applied", 1), ("zone", 1)]
    records = link_log(session)
    events = [(r["message"]["data"]["kind"], r["message"]["data"]["epoch"], r["stale"])
              for r in records if r["event"] == "event"]
    assert events == [("zone", 0, False), ("teleport_applied", 1, False), ("zone", 1, False),
                      ("zone", 0, True), ("land", 1, True)]
    batches = [r["message"]["data"]["poses"] for r in records if r["event"] == "pose.batch"]
    poses = [p["seq"] for batch in batches for p in batch]
    assert poses == [0, 1, 2] and server.counts["pose_order_errors"] == 0
    reports = [r["message"]["data"]["kind"] for r in records if r["event"] == "render.report"]
    assert reports == ["ready"]
    assert server.last_pose == {"seq": 2, "x": 0.0, "z": -0.5584 * 3, "yaw": 0.0}
    assert (server.counts["events"], server.counts["stale_events"], server.epoch) == (5, 2, 5)
    assert all(r["t_ns"] > 0 for r in records)
    # The pose records read back exactly as sent (floats in shortest round-trip form)
    assert batches[0][1] == pose(1)


def test_link_p1_b1_pose_order_and_the_motion_clients_heartbeats_counted(run, sim_rig_path,
                                                                        tmp_path):
    """P1: a pose of a sample at or before the last one received is counted as out of order (a
    gap in seq is not: samples can be lost). B1: the motion client's heartbeats are counted, with
    the numbers missing between them and the largest gap, for the watchdog (DPR-11)."""
    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        ws, _, _ = await join(server.url)
        for seqs in ([0, 1], [1], [4], [2, 5]):     # 1 again, 4 after a gap, 2 after 4
            await send(ws, {"type": "pose.batch", "t": 1, "data": {
                "world": WORLD, "poses": [pose(seq) for seq in seqs]}})
        for n in (0, 1, 4, 5):                       # 2 and 3 missing
            await send(ws, {"type": "heartbeat", "t": 2, "data": {"n": n, "last_seq": 5}})
            await asyncio.sleep(0.03)
        await ws.send("flush")
        await receive(ws)
        stats = server.stats()
        await ws.close()
        await server.close()
        return server, stats

    server, stats = run(main())
    assert (server.counts["poses"], server.counts["pose_order_errors"]) == (6, 2)
    [motion] = [c for c in stats["clients"].values() if c["role"] == "motion"]
    assert (motion["heartbeats_received"], motion["missing_heartbeats"]) == (4, 2)
    assert motion["max_heartbeat_gap_us"] >= 20_000


def test_link_q2_e5_errors_after_welcome_and_unknown_types(run, sim_rig_path, tmp_path):
    async def main():
        server, session = await serve(sim_rig_path, tmp_path)
        ws, _, _ = await join(server.url)
        monitor, _, _ = await join(server.url, hello(role="monitor", rid="m1"))
        replies = {}
        await ws.send("{not json")
        replies["bad_json"] = await receive(ws)
        bad = {"type": "pose.batch", "t": 1, "data": {"world": WORLD, "poses": [pose(0)]}}
        bad["data"]["poses"][0]["contact"] = 1
        await send(ws, bad)
        replies["bad_message"] = await receive(ws)
        await send(ws, {"type": "command.v2", "t": 1, "id": "c-7", "data": {}})
        replies["unknown_type"] = await receive(ws)
        await send(ws, {"type": "command.v2", "t": 1, "data": {}})       # no id: ignored
        await ws.send('{"type": "command.v2", "t": 1, "data": {"x": 1e400}}')  # logged as text
        await send(ws, event("contact", 3, 0))                             # unknown kind: ignored
        await send(ws, {"type": "session.state", "t": 1, "data": {"state": "idle"}})
        replies["not_permitted"] = await receive(ws)
        await send(ws, hello(rid="again"))
        replies["second_hello"] = await receive(ws)
        await send(monitor, {"type": "pose.batch", "t": 1,
                             "data": {"world": WORLD, "poses": [pose(0)]}})
        replies["monitor"] = await receive(monitor)
        await send(ws, {"type": "error", "t": 1,
                        "data": {"code": "internal", "message": "worker hiccup"}})
        await ws.send("still open")
        replies["still_open"] = await receive(ws)
        await ws.close()
        await monitor.close()
        await server.close()
        return server, replies

    server, replies = run(main())
    codes = {k: (m["data"]["code"], m.get("re"), m["data"].get("path")) for k, m in replies.items()}
    assert codes == {"bad_json": ("bad_json", None, None),
                     "bad_message": ("bad_message", None, "/data/poses/0/contact"),
                     "unknown_type": ("unknown_type", "c-7", None),
                     "not_permitted": ("not_permitted", None, None),
                     "second_hello": ("not_permitted", "again", None),
                     "monitor": ("not_permitted", None, None),
                     "still_open": ("bad_json", None, None)}
    assert (server.counts["unknown_ignored"], server.counts["client_errors"]) == (4, 1)


def test_link_texts_sent_never_hold_paths_or_py_names():
    assert text("failed at C:\\data/x.py, line 3\n") == "failed at C: data x py, line 3"
    assert text("") == "-" and len(text("a" * 900)) == 500


# --- the session end to end, in real time ---------------------------------------------------------

def test_link_sim_rig_in_real_time_to_a_mock_worker(run, sim_rig_data, write_rig, tmp_path):
    """The simulated rig at 250 Hz: every sample the reader accepted reaches the worker once, in
    order; the worker answers each with its pose; the session ends with complete and 4004."""
    sim_rig_data["devices"]["ball"].update(periodUs=4000,
                                            faults=[{"type": "drop", "seq": 30, "count": 3}])
    rig = write_rig(sim_rig_data)
    produced = []

    class Reader:
        def on_device_batch(self, session, device, records):
            if device == "ball":
                produced.extend(r.seq for r in records if type(r) is DeviceSample)

    async def main():
        server, session = await serve(None, tmp_path, rig=rig)
        session.add_listener(Reader())
        await asyncio.to_thread(session.arm)
        ws, welcome, _ = await join(server.url)
        await asyncio.to_thread(session.start)
        received = []

        async def worker():
            try:
                while True:
                    message = await receive(ws)
                    if message["type"] == "sample.batch":
                        seqs = [s["seq"] for s in message["data"]["samples"]]
                        received.extend(seqs)
                        await send(ws, {"type": "pose.batch", "t": 1, "data": {
                            "world": WORLD, "poses": [pose(seq) for seq in seqs]}})
                        for s in message["data"]["samples"]:
                            if s["gap"]:
                                await send(ws, event("seq_gap", s["seq"], 0, lost=s["gap"]))
            except ConnectionClosed:
                return ws.close_code

        task = asyncio.create_task(worker())
        await asyncio.sleep(0.5)
        await asyncio.to_thread(session.stop)
        code = await asyncio.wait_for(task, 10)
        await server.close()
        return server, session, received, code

    server, session, received, code = run(main(), timeout=60)
    assert received == produced and len(received) > 100 and code == 4004
    assert 30 not in received and 33 in received
    assert server.counts["poses"] == len(received) and server.counts["pose_order_errors"] == 0
    assert [r["message"]["data"]["lost"] for r in link_log(session)
            if r["event"] == "event"] == [3]
    assert server.stream.stats()["undelivered"] == 0 and server.alarms == []


# --- the fast path for heartbeats and poses ------------------------------------------------------

def mutations(message):
    """The message with one value changed or removed, or one property added, at every place."""
    out = []

    def walk(node, path):
        if isinstance(node, dict):
            for key in list(node):
                yield path + [key]
                yield from walk(node[key], path + [key])
        elif isinstance(node, list):
            for i in range(len(node)):
                yield path + [i]
                yield from walk(node[i], path + [i])

    for path in list(walk(message, [])):
        for value in (None, True, False, -1, 0, 1.5, 4294967296, 2 ** 53, "x", "a/b", [], {}, "1",
                      "__delete__"):
            m = copy.deepcopy(message)
            parent = m
            for key in path[:-1]:
                parent = parent[key]
            if value == "__delete__":
                if isinstance(parent, dict):
                    del parent[path[-1]]
                else:
                    parent.pop(path[-1])
            else:
                parent[path[-1]] = value
            out.append(m)
    for where in (None, "data"):
        m = copy.deepcopy(message)
        target = m if where is None else m.get(where)
        if isinstance(target, dict):
            target["extra"] = 1
            out.append(m)
    return out


def test_link_fast_path_never_accepts_what_the_schema_rejects():
    examples = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(EXAMPLES.glob("*.json"))
                if p.name != "expected-errors.json"]
    examples += [json.loads(p.read_text(encoding="utf-8"))
                 for p in sorted((EXAMPLES / "invalid").glob("*.json"))]
    hot = [m for m in examples if m.get("type") in ("heartbeat", "pose.batch")]
    assert len(hot) >= 4
    candidates = examples + [m for base in hot for m in mutations(base)]
    accepted = 0
    for message in candidates:
        if (message.get("type") == "heartbeat" and heartbeat_ok(message)) or (
                message.get("type") == "pose.batch" and pose_batch_ok(message)):
            accepted += 1
            assert link_errors(message, tolerant=True) == [], message
    # Every valid example of the two types takes the fast path
    for name in ("heartbeat--motion.json", "heartbeat--runtime.json", "pose.batch.json"):
        message = json.loads((EXAMPLES / name).read_text(encoding="utf-8"))
        assert read_frame(json.dumps(message)) == (message, [])
        assert heartbeat_ok(message) or pose_batch_ok(message)
    assert accepted >= 3


# --- acceptance: no v0.3 motion code in the runtime ----------------------------------------------

def test_link_no_v03_motion_code_in_the_runtime():
    """Acceptance of DPR-06b: grep finds no velocity, DT, realtime_theta or the stale-pose filter
    (_awaiting_reset_confirm, backend/src/main.py:617-662) in threemaze/; nor v0.3's position
    messages: the runtime sends displacements, the motion worker integrates them (ADR-0001 R1)."""
    patterns = [re.compile(p) for p in (r"(?i)velocit", r"\bDT\b", r"realtime_theta",
                                       r"_awaiting_reset_confirm", r"position_update",
                                       r"position_confirm")]
    found = []
    for path in sorted((REPO / "threemaze").rglob("*.py")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if any(p.search(line) for p in patterns):
                found.append(f"{path.relative_to(REPO)}:{number}: {line.strip()}")
    assert found == []
