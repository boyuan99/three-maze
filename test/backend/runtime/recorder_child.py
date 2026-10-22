"""A process that records a synthetic session until it is killed (test_recorder_crash.py).

    python recorder_child.py <session folder> <seed>

It opens a SessionRecorder in the folder, prints "ready" and then feeds every table and log in
real time, as a session at 1,000 samples per second would: one sample (and its pose) per
millisecond, a pose batch every 20 ms, a frame about every 16.7 ms in batches of 100 ms, an event
every 50 ms, a trial with a reward request and its outcome every 200 ms, a long task every second.
Each row's t_host_ns is time.perf_counter_ns() when it was made, the clock the parent reads when
it kills the process. It never closes the recorder: the parent kills it.
"""
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from threemaze.record import SessionRecorder  # noqa: E402

PERIOD_NS = 1_000_000


def main(folder: str, seed: int) -> None:
    rng = random.Random(seed)
    recorder = SessionRecorder(Path(folder), n_axes=3, seq_source="device")
    print("ready", flush=True)
    clock = time.perf_counter_ns
    start = clock()
    seq = frame = trial = cmd_id = 0
    totals = [0, 0, 0]
    poses, frames = [], []
    next_sample = start
    next_poses = next_frames = start
    next_frame = start
    next_event = next_trial = next_task = start
    while True:
        now = clock()
        while next_sample <= now:
            raw = [rng.randint(-40, 40) for _ in range(3)]
            totals = [a + b for a, b in zip(totals, raw)]
            d = [raw[1] * 0.0349, raw[0] * 0.0349, raw[2] * 0.05]
            recorder.sample({"seq": seq, "t_dev_us": 1000 * seq, "t_host_ns": clock(),
                             "dt_us": 1000, "gap": 0, "flags": 0, "raw": raw, "d": d})
            poses.append({"seq": seq, "epoch": trial, "t_dev_us": 1000 * seq, "x": d[1],
                          "feet_y": 0.0, "z": -d[0] * seq, "yaw": d[2], "contact": False,
                          "airborne": False})
            seq += 1
            next_sample += PERIOD_NS
        if now >= next_frame:
            frames.append({"frame": frame, "t_raf_us": now // 1000, "t_start_us": now // 1000,
                           "t_end_us": now // 1000 + 900, "epoch": trial, "seq": max(seq - 1, 0),
                           "t_dev_us": 1000 * max(seq - 1, 0), "flags": 0})
            frame += 1
            next_frame += 16_666_667
        if now >= next_poses and poses:
            recorder.poses({"world": "hallway", "poses": poses}, t_host_ns=clock())
            poses = []
            next_poses += 20_000_000
        if now >= next_frames and frames:
            recorder.render_report({"kind": "frames", "time_origin_us": start // 1000,
                                    "world": "hallway", "frames": frames}, t_host_ns=clock())
            frames = []
            next_frames += 100_000_000
        if now >= next_event:
            recorder.event("motion", "zone", seq=seq - 1, epoch=trial, t_dev_us=1000 * (seq - 1),
                           world="hallway", data={"zone": "reward", "edge": "enter",
                                                  "cause": "move"}, t_host_ns=clock())
            next_event += 50_000_000
        if now >= next_trial:
            stamp = {"seq": seq - 1, "epoch": trial, "t_dev_us": 1000 * (seq - 1)}
            if trial:
                recorder.event("task", "trial_end", data={"trial": trial - 1,
                                                         "outcome": "rewarded"}, **stamp)
            recorder.event("task", "trial_start", data={"trial": trial}, **stamp)
            cmd_id += 1
            recorder.command({"src": "motion", "kind": "request", "action": "reward",
                              "cmd_id": cmd_id, "width_us": 70000, "trial": trial, **stamp})
            recorder.command({"src": "device", "kind": "outcome", "cmd_id": cmd_id,
                              "outcome": "done", "width_us": 70000 + rng.randint(-20, 20),
                              "timing": "hardware"})
            trial += 1
            next_trial += 200_000_000
        if now >= next_task:
            recorder.render_report({"kind": "long_tasks", "time_origin_us": start // 1000,
                                    "entries": [{"entry": "longtask", "name": "self",
                                                 "t_start_us": now // 1000,
                                                 "duration_us": 61000}]}, t_host_ns=clock())
            next_task += 1_000_000_000
        time.sleep(0.0005)


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]))
