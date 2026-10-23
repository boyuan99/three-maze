"""The recorder fed by the serial reader (plan items DPR-03 and DPR-07): every sample the reader
accepts gets exactly one samples.tsv row when it reaches the session, with the values the reader
handed over, whatever the motion worker does.

The reference simulated device of device protocol v1 streams with one fault of every type (plan
item DPR-02) at 20, 250 and 1,000 samples per second, two ways: the simulated rig (rigs/sim.json,
driver simulated) in the runtime's own process, its session on an asyncio event loop as the link
server runs one, so the batches reach the session on the loop; and the serial_lines driver on the
end-to-end bench's simulated serial port (test/e2e/sim) in a child process whose session has no
event loop, so the batches reach the session on the reader's thread. Both ways, every sample the
device produced is a row or is counted as lost where it was lost, every fault is counted, and
session.json is complete and valid. Two more runs end a session while its event loop is busy, and
stream to a motion worker that takes no sample at all; and a sample that the recorder refuses
costs no other sample its row. Nothing here opens a real serial port.
"""
import asyncio
import dataclasses
import json
import math
import sys
import threading
import time
from pathlib import Path

import jsonschema
import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from simfaults import (B1_LIKE, RATES, expected_counters, faults_for, intact_seqs,
                       run_e2e_reader, sim_log)
from threemaze.core.records import DeviceSample, StopReport
from threemaze.link import LinkServer
from threemaze.record import read_log, read_table
from threemaze.record.formats import EVENTS, SAMPLES
from threemaze.runtime import Session, TaskSource
from threemaze_sim import conformance

REPO = Path(__file__).resolve().parents[3]
SCHEMA = json.loads((REPO / "schema" / "session-v1.schema.json").read_text(encoding="utf-8"))
# How long each rate streams in real time: past the last fault, and for some thousand samples at
# the higher rates
RUN_S = {"20Hz": 3.0, "250Hz": 2.0, "1000Hz": 3.0}
REJECTED = ("parse_errors", "overflow", "seq_regressions", "dt_mismatch")
STATES = ["armed", "running", "stopping", "complete"]


def as_row(sample):
    """The samples.tsv row of a sample (the link protocol's sample with its t_host_ns, or a
    DeviceSample), as read_table() reads it back: the integers written, the same doubles."""
    if isinstance(sample, DeviceSample):
        sample = {**sample.link(), "t_host_ns": sample.t_host_ns}
    d = sample["d"]
    return {"seq": sample["seq"], "t_dev_us": sample["t_dev_us"], "t_host_ns": sample["t_host_ns"],
            "dt_us": sample["dt_us"], "gap": sample["gap"], "flags": sample["flags"],
            **{f"raw_{j}_counts": count for j, count in enumerate(sample["raw"])},
            "d_fwd_cm": d[0], "d_left_cm": d[1], "d_yaw_rad": d[2]}


def valid(record):
    errors = list(jsonschema.Draft202012Validator(SCHEMA).iter_errors(record))
    assert not errors, [f"{list(e.absolute_path)}: {e.message}" for e in errors]
    return record


def check_recording(folder, received, faults, period):
    """What the session folder holds after a run of the faulty device: one samples.tsv row per
    sample the reader handed to the session (received, as rows), and a complete session.json."""
    record = valid(json.loads((folder / "session.json").read_text(encoding="utf-8")))
    ball = record["devices"]["ball"]
    c = ball["counters"]
    rows = read_table(folder / SAMPLES).rows
    # One row per sample the reader handed over, in that order, with the values it handed over
    assert len(rows) == len(received) == c["samples"] > 0
    assert rows == received
    # Every fault counted, and nothing else rejected
    counted = {k: c[k] for k in ("crc_errors", "seq_gaps", "samples_lost")}
    assert counted == expected_counters(faults)
    assert {k: c[k] for k in REJECTED} == dict.fromkeys(REJECTED, 0)
    # Every sample the device produced (its stop report says how many) is a row, or is counted as
    # lost in the gap of the row after it: none went missing between the reader and the file
    n_samples = int(ball["stop_report"].split(",")[1])
    gaps = sum(row["gap"] for row in rows)
    assert len(rows) + gaps == n_samples and gaps == c["samples_lost"]
    assert rows[0]["seq"] == 0 and rows[-1]["seq"] == n_samples - 1
    assert all(b["seq"] == a["seq"] + 1 + b["gap"] for a, b in zip(rows, rows[1:]))
    # One device clock across the wrap and the gaps
    assert all(b["t_dev_us"] - a["t_dev_us"] == b["dt_us"] == period * (b["gap"] + 1)
               for a, b in zip(rows, rows[1:]))
    # The raw-line log holds the same samples, each stamped at the same read, and its last line's
    # running totals are the sum of the counts recorded: the lost samples' motion is in the rows
    report = conformance.check_file(folder / "raw" / "ball.tsv")
    assert [(seq, t_ns) for seq, *_, t_ns in report.samples] == [
        (row["seq"], row["t_host_ns"]) for row in rows]
    assert [sum(row[f"raw_{j}_counts"] for row in rows) for j in range(3)] == report.samples[-1][4]
    # session.json: the session complete, the recorder's summary, the device's level and counters
    assert (record["status"], record["state"], record["abort_reason"]) == ("complete", "complete",
                                                                            None)
    assert [s["state"] for s in record["states"]] == ["configured", *STATES]
    recording = record["recording"]
    assert recording["files"][SAMPLES] == {"rows": len(rows), "dropped": 0}
    assert (recording["late"], recording["seq_mismatches"], recording["errors"]) == (0, 0, [])
    assert (ball["profile"], ball["completeness"], ball["integrity"], ball["seq_source"]) == (
        "v1", "counted", "crc8", "device")
    assert ball["guarantees"]["stop_report"] and record["preflight"]["free_bytes"] > 0
    events = read_log(folder / EVENTS).records
    assert [e["data"]["state"] for e in events if e["kind"] == "state"] == STATES
    assert [e for e in events if e["kind"] == "warning"] == []
    return rows, record


class Samples:
    """A session listener that keeps the motion device's samples as the session hands them on."""

    def __init__(self):
        self.got = []

    def on_device_batch(self, session, device, records):
        if device == "ball":
            self.got.extend(r for r in records if type(r) is DeviceSample)


def new_session(loop, rig, data_root, listener, session_id=None):
    session = Session(loop=loop)
    session.add_listener(listener)
    session.configure(rig, data_root=data_root, session_id=session_id)
    session.set_task(TaskSource("declarative", "linear_track"))
    return session


def faulty_rig(sim_rig_data, write_rig, period, faults):
    sim_rig_data["devices"]["ball"].update(periodUs=period, lick=1, trajectory=B1_LIKE,
                                            faults=[f for f, _ in faults])
    return write_rig(sim_rig_data)


# --- the simulated rig, on an event loop ----------------------------------------------------------

@pytest.mark.parametrize("rate", RATES)
def test_every_sample_the_reader_hands_over_gets_one_row(sim_rig_data, write_rig, tmp_path, rate):
    """The simulated rig in the runtime's process, in real time, its session on an asyncio event
    loop: the reader's batches reach the session, and its recorder, on the loop."""
    period = RATES[rate]
    faults = faults_for(period, first=4 if period == 50000 else 20)
    rig = faulty_rig(sim_rig_data, write_rig, period, faults)
    listener = Samples()

    async def main():
        session = new_session(asyncio.get_running_loop(), rig, tmp_path / "data", listener)
        await asyncio.to_thread(session.arm)
        await asyncio.to_thread(session.start)
        await asyncio.sleep(RUN_S[rate])
        await asyncio.to_thread(session.stop)
        return session

    session = asyncio.run(asyncio.wait_for(main(), 60))
    rows, record = check_recording(session.dir, [as_row(s) for s in listener.got], faults, period)
    assert record["devices"]["ball"]["driver"] == "simulated"
    # It streamed the whole time
    produced = len(rows) + record["devices"]["ball"]["counters"]["samples_lost"]
    assert produced >= 0.8 * RUN_S[rate] * 1e6 / period


def test_samples_waiting_on_a_busy_loop_when_the_session_ends_are_recorded(sim_rig_data,
                                                                           write_rig, tmp_path):
    """The session ends on another thread while its event loop is busy (here for 0.5 s), so the
    reader's last batches, the stop report's among them, still wait on the loop when the devices
    have closed. The session waits for the loop before it closes its recorder, and every one of
    those samples gets its row."""
    sim_rig_data["devices"]["ball"]["periodUs"] = 1000
    rig = write_rig(sim_rig_data)
    calls = []

    class Batches:
        def on_device_batch(self, session, device, records):
            if device == "ball":
                calls.append((session.clock.now_ns(), records))

    async def main():
        session = new_session(asyncio.get_running_loop(), rig, tmp_path / "data", Batches())
        await asyncio.to_thread(session.arm)
        await asyncio.to_thread(session.start)
        await asyncio.sleep(1.0)
        ended = []

        def stop():
            session.stop()
            ended.append(session.clock.now_ns())

        stopping = threading.Thread(target=stop)
        stopping.start()
        time.sleep(0.5)                   # the loop is busy while the session ends
        free = session.clock.now_ns()
        await asyncio.to_thread(stopping.join, 30)
        return session, free, ended

    session, free, ended = asyncio.run(asyncio.wait_for(main(), 60))
    late = [r for t_ns, records in calls if t_ns >= free for r in records]
    held = [r for r in late if type(r) is DeviceSample and r.t_host_ns < free]
    # The samples read while the loop was busy reached the session after it, with the stop report
    assert held and any(type(r) is StopReport for r in late)
    # ... and the end of the session waited for them
    assert ended and ended[0] >= free
    received = [r for _, records in calls for r in records if type(r) is DeviceSample]
    rows = read_table(session.dir / SAMPLES).rows
    assert rows == [as_row(s) for s in received] and rows[-1]["seq"] == held[-1].seq
    assert session.recording["late"] == 0
    assert session.recording["files"][SAMPLES] == {"rows": len(rows), "dropped": 0}


def test_a_sample_the_recorder_refuses_costs_no_other_row(sim_rig_path, tmp_path):
    """A sample the recorder cannot record (here one whose displacement is not a finite number)
    gets no row: the session logs it and names it in a warning event, the samples after it in the
    same batch get their rows, the listeners get the whole batch, and the gap is counted."""
    listener = Samples()
    session = Session()
    session.add_listener(listener)
    session.configure(sim_rig_path, data_root=tmp_path)
    session.set_task(TaskSource("declarative", "linear_track"))
    folder = session.arm()
    batch = [DeviceSample(k, 50_000 * (k + 1), 50_000, (0, 16, 0), (0.5584, 0.0, 0.0), 0, 0, k)
             for k in range(3)]
    batch[1] = dataclasses.replace(batch[1], d=(math.inf, 0.0, 0.0))
    session.devices["ball"].ctx.on_batch("ball", batch)   # as the ball's reader hands one over
    session.abort("test over")
    assert [row["seq"] for row in read_table(folder / SAMPLES).rows] == [0, 2]
    assert listener.got == batch
    warnings = [e["data"] for e in read_log(folder / EVENTS).records if e["kind"] == "warning"]
    assert [(w["code"], w["seq"]) for w in warnings] == [("sample_not_recorded", 1),
                                                         ("sample_seq", 2)]
    assert "not a finite number" in warnings[0]["message"]
    assert session.unrecorded_samples == 1 and session.recording["seq_mismatches"] == 1


def hello(session_id):
    return {"type": "hello", "t": 1000, "id": "h1", "data": {
        "protocol": "three-maze/link", "version": "1.0", "role": "motion",
        "client": {"impl": "mock-worker", "version": "0.0.1"}, "session": session_id,
        "versions": {"electron": "44.7.0", "three": "0.169.0", "rapier3d-compat": "0.14.0"}}}


def test_a_motion_worker_that_takes_no_sample_holds_up_no_row(sim_rig_data, write_rig, tmp_path):
    """The link server streams the samples to a motion worker whose connection takes none (each
    sample batch's send waits for good), at 1,000 samples per second: the rows reach samples.tsv,
    and the disk within about a second, as if the worker were not there. When the session ends the
    worker's samples are reported undelivered, and samples.tsv lacks none of them."""
    sim_rig_data["devices"]["ball"]["periodUs"] = 1000
    rig = write_rig(sim_rig_data)
    listener = Samples()

    async def main():
        server = LinkServer(drain_timeout_s=0.3, send_timeout_s=0.3)
        await server.start()
        session = new_session(asyncio.get_running_loop(), rig, tmp_path / "data", listener,
                              session_id="ses-stalled")
        server.attach(session, world="hallway")
        folder = await asyncio.to_thread(session.arm)
        async with connect(server.url, proxy=None, compression=None, ping_interval=None) as ws:
            await ws.send(json.dumps(hello(session.session_id)))
            while json.loads(await asyncio.wait_for(ws.recv(), 5))["type"] != "welcome":
                pass
            while server.motion is None:
                await asyncio.sleep(0.01)
            connection, never = server.motion.ws, asyncio.Event()
            real_send = connection.send

            async def stalled_send(frame):
                if frame.startswith('{"type":"sample.batch"'):
                    await never.wait()
                await real_send(frame)

            async def read_the_rest():      # heartbeats and states, until the 4004 close
                try:
                    async for _ in ws:
                        pass
                except ConnectionClosed:
                    return ws.close_code

            connection.send = stalled_send
            reading = asyncio.create_task(read_the_rest())
            await asyncio.to_thread(session.start)
            await asyncio.sleep(2.5)
            on_disk = read_table(folder / SAMPLES).rows   # the worker has taken nothing so far
            taken = server.stream.sent
            await asyncio.to_thread(session.stop)
            await asyncio.wait_for(server.finished.wait(), 10)
            code = await asyncio.wait_for(reading, 10)
        await server.close()
        return session, server, on_disk, taken, code

    session, server, on_disk, taken, code = asyncio.run(asyncio.wait_for(main(), 60))
    assert taken == 0 and len(on_disk) >= 1000 and code == 4004
    rows = read_table(session.dir / SAMPLES).rows
    assert rows[:len(on_disk)] == on_disk
    assert rows == [as_row(s) for s in listener.got] and len(rows) >= 2400
    stats = server.stream.stats()
    assert (stats["samples_received"], stats["samples_sent"]) == (len(rows), 0)
    assert stats["undelivered"] == len(rows) and session.alarms
    record = valid(json.loads((session.dir / "session.json").read_text(encoding="utf-8")))
    assert record["status"] == "complete" and record["recording"]["late"] == 0
    assert record["recording"]["files"][SAMPLES] == {"rows": len(rows), "dropped": 0}


# --- the end-to-end bench's simulated serial port, without an event loop --------------------------

@pytest.mark.skipif(sys.platform != "win32", reason="the end-to-end sim models a Windows rig")
@pytest.mark.parametrize("rate", RATES)
def test_every_sample_from_the_e2e_sim_port_gets_one_row(sim_folder, rate):
    """The serial_lines driver on the end-to-end bench's simulated port (test/e2e/sim) in a child
    process, whose session has no event loop: the batches reach the session, and its recorder, on
    the reader's thread. The rows are exactly the samples the sim sent intact."""
    period = RATES[rate]
    faults = faults_for(period, first=4 if period == 50000 else 20)
    result, sim_dir = run_e2e_reader(sim_folder, period, faults)
    assert result["serial_class"] == "threemaze_sim.teensy.SimSerial"
    rows, record = check_recording(Path(result["folder"]), [as_row(s) for s in result["samples"]],
                                   faults, period)
    assert record["devices"]["ball"]["driver"] == "serial_lines"
    assert [row["seq"] for row in rows] == intact_seqs(sim_log(sim_dir), faults)
