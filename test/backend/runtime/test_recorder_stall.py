"""samples.tsv through a 10 s render stall (plan item DPR-07): the simulated device streams device
protocol v1 at 1,000 samples per second in real time, its lines are read by the serial reader of
plan item DPR-03, and each sample is recorded when the reader hands it to the session, while the
stimulus side (the motion worker's poses and the render host's frames) stops for 10 s and then
catches up. samples.tsv must hold one row per sample line the device sent, stamped with the time
its line was read, and those rows must reach the disk during the stall. In v0.3 a row was written
only when the renderer reported a pose, so a stalled renderer lost rows (test/e2e/README.md, Known
limits).
"""
import queue
import threading
import time

import pytest

from threemaze.core.records import DeviceSample
from threemaze.devices.sim.frame import int32
from threemaze.record import read_table
from threemaze.record.formats import FRAMES, POSES, SAMPLES
from threemaze.runtime import Session, TaskSource
from threemaze_sim import conformance

STALL_S = 10.0
FRAME_NS = 16_666_667


class Tap:
    """A session listener: the motion device's samples, as the reader hands them to the session,
    go to the recorder and to the fake motion worker (out)."""

    def __init__(self):
        self.out = queue.SimpleQueue()

    def on_device_batch(self, session, device, records):
        if device != "ball":
            return
        samples = [r for r in records if type(r) is DeviceSample]
        session.recorder.samples(samples)
        for sample in samples:
            self.out.put(sample)


@pytest.fixture
def reader():
    return Tap()


def test_samples_are_recorded_on_receipt_through_a_10_s_stall(sim_rig_data, write_rig, tmp_path,
                                                               reader):
    sim_rig_data["devices"]["ball"]["periodUs"] = 1000
    session = Session()
    session.add_listener(reader)
    session.configure(write_rig(sim_rig_data), data_root=tmp_path)
    session.set_task(TaskSource("declarative", "test-task"))
    folder = session.arm()
    stalled = threading.Event()
    done = threading.Event()

    def motion_worker():
        """A pose per sample, every 20 ms; nothing while stalled, then the backlog."""
        x = 0.0
        while not done.is_set():
            time.sleep(0.02)
            if stalled.is_set():
                continue
            poses = []
            while True:
                try:
                    s = reader.out.get_nowait()
                except queue.Empty:
                    break
                x += s.d[0]
                poses.append({"seq": s.seq, "epoch": 0, "t_dev_us": s.t_dev_us, "x": x,
                              "feet_y": 0.0, "z": 0.0, "yaw": 0.0, "contact": False,
                              "airborne": False})
            for start in range(0, len(poses), 1000):
                session.recorder.poses({"world": "hallway", "poses": poses[start:start + 1000]})

    def render_host():
        """Frames at 60 Hz in batches of up to 1 s; no frame at all while stalled."""
        frame, batch, last_batch = 0, [], time.perf_counter_ns()
        next_frame = last_batch
        while not done.is_set():
            now = time.perf_counter_ns()
            if not stalled.is_set() and now >= next_frame:
                batch.append({"frame": frame, "t_raf_us": now // 1000, "t_start_us": now // 1000,
                              "t_end_us": now // 1000 + 500, "epoch": 0, "flags": 0})
                frame += 1
                next_frame = now + FRAME_NS
            if batch and (now - last_batch >= 1e9 or stalled.is_set() or done.is_set()):
                session.recorder.render_report({"kind": "frames", "time_origin_us": 0,
                                                "world": "hallway", "frames": batch})
                batch, last_batch = [], now
            time.sleep(0.002)

    threads = [threading.Thread(target=motion_worker), threading.Thread(target=render_host)]
    session.start()
    for thread in threads:
        thread.start()
    on_disk_during_stall = []
    try:
        time.sleep(0.5)
        stalled.set()
        stall_started = time.perf_counter_ns()
        for _ in range(4):
            time.sleep(STALL_S / 4)
            rows = read_table(folder / SAMPLES).rows
            on_disk_during_stall.append((time.perf_counter_ns(), len(rows),
                                         rows[-1]["t_host_ns"] if rows else None))
        stalled.clear()
        time.sleep(1.0)
    finally:
        done.set()
        for thread in threads:
            thread.join(5)
        session.stop()

    # samples.tsv: exactly the S lines the device sent, each stamped when its line was read
    report = conformance.check_file(folder / "raw" / "ball.tsv")
    assert report.ok, [str(f) for f in report.findings]
    rows = read_table(folder / SAMPLES).rows
    assert len(rows) == report.stats["samples"] >= 10_000
    assert [r["seq"] for r in rows] == list(range(len(rows)))
    assert [r["t_host_ns"] for r in rows] == [t_ns for *_, t_ns in report.samples]
    totals = [0, 0, 0]
    for row, (seq, t_us, dt_us, flags, line_totals, t_ns) in zip(rows, report.samples):
        counts = [row[f"raw_{j}_counts"] for j in range(3)]
        totals = [int32(a + b) for a, b in zip(totals, counts)]
        assert totals == line_totals and row["t_dev_us"] - rows[0]["t_dev_us"] == t_us - \
            report.samples[0][1]
        assert row["gap"] == 0 and row["flags"] == flags == 0
    stall_end = stall_started + STALL_S * 1e9
    stall_rows = [r for r in rows if stall_started <= r["t_host_ns"] <= stall_end]
    assert len(stall_rows) >= 0.9 * STALL_S * 1000

    # ... and they reached the disk during the stall, about a second after they arrived
    print(f"\n{len(rows)} samples, {len(stall_rows)} of them during the stall; rows on disk at"
          f" each quarter of the stall: {[n for _, n, _ in on_disk_during_stall]}, the newest"
          " received {} s before".format(
              [round((c - t) / 1e9, 3) for c, _, t in on_disk_during_stall]))
    counts = [n for _, n, _ in on_disk_during_stall]
    assert counts == sorted(counts) and counts[-1] - counts[0] >= 0.6 * STALL_S * 1000
    for checked_ns, _, newest_ns in on_disk_during_stall:
        assert newest_ns is not None and (checked_ns - newest_ns) / 1e9 < 2.0

    # The stimulus side lost nothing either: a pose per sample, frames without a gap in the index
    poses = read_table(folder / POSES).rows
    assert [p["seq"] for p in poses] == [r["seq"] for r in rows[:len(poses)]]
    assert len(poses) >= len(rows) - 500  # samples of the last moments may have no pose yet
    frames = read_table(folder / FRAMES).rows
    assert [f["frame"] for f in frames] == list(range(len(frames)))
    longest = max(b["raf_us"] - a["raf_us"] for a, b in zip(frames, frames[1:]))
    assert longest >= STALL_S * 1e6 * 0.99
    assert session.recording["errors"] == [] and session.recording["seq_mismatches"] == 0
