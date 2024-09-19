import os
import pty
import json
import random
import time
import math
import fcntl
import termios


def generate_sensor_data():
    data = {
        "x": 0, "y": 0, "vx": 0, "vy": 0,
        "angle": 0, "angular_velocity": 0
    }
    max_acceleration = 2.0
    max_angular_acceleration = 1.0
    dt = 0.05
    while True:
        ax = random.uniform(-max_acceleration, max_acceleration)
        ay = random.uniform(-max_acceleration, max_acceleration)
        data["vx"] += ax * dt
        data["vy"] += ay * dt
        data["x"] += data["vx"] * dt
        data["y"] += data["vy"] * dt
        angular_acceleration = random.uniform(-max_angular_acceleration, max_angular_acceleration)
        data["angular_velocity"] += angular_acceleration * dt
        data["angle"] += data["angular_velocity"] * dt
        data["angle"] %= (2 * math.pi)
        data["vx"] = max(min(data["vx"], 10), -10)
        data["vy"] = max(min(data["vy"], 10), -10)
        data["x"] = max(min(data["x"], 100), -100)
        data["y"] = max(min(data["y"], 100), -100)
        data["angular_velocity"] = max(min(data["angular_velocity"], 2 * math.pi), -2 * math.pi)
        yield data


def writer(master, slave):
    # Set non-blocking mode for both master and slave
    for fd in [master, slave]:
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    buffer_clear_interval = 5  # Clear buffer every 5 writes
    write_count = 0
    total_writes = 0
    start_time = time.perf_counter()
    target_interval = 1 / 20  # 50ms for 20Hz
    next_time = start_time + target_interval

    for sensor_data in generate_sensor_data():
        current_time = time.perf_counter()

        json_data = json.dumps(sensor_data).encode('utf-8') + b'\n'

        write_count += 1
        if write_count >= buffer_clear_interval:
            # Clear the buffer
            try:
                while True:
                    os.read(slave, 1024)
            except BlockingIOError:
                pass
            print(f"Buffer cleared after {buffer_clear_interval} writes", flush=True)
            write_count = 0

        try:
            bytes_written = os.write(master, json_data)
            total_writes += 1
            rate = total_writes / (current_time - start_time)
            print(f"Wrote data {total_writes}: {json_data.decode().strip()} (Rate: {rate:.2f} Hz)", flush=True)
        except BlockingIOError:
            print(f"Buffer full, skipping write {total_writes + 1}", flush=True)

        # Calculate sleep time to maintain 20Hz
        sleep_time = next_time - time.perf_counter()
        if sleep_time > 0:
            time.sleep(sleep_time)
        next_time += target_interval

        # Adjust next_time if we've fallen behind
        current_time = time.perf_counter()
        if current_time > next_time:
            missed_intervals = math.floor((current_time - next_time) / target_interval)
            next_time += target_interval * (missed_intervals + 1)


if __name__ == "__main__":
    master, slave = pty.openpty()
    print(f"Virtual serial port created.", flush=True)

    # Get the device names
    for fd in range(255):
        try:
            if os.isatty(fd):
                attr = termios.tcgetattr(fd)
                if fd == master:
                    print(f"Master FD: {fd}", flush=True)
                elif fd == slave:
                    slave_name = os.ttyname(fd)
                    print(f"Slave FD: {fd}", flush=True)
                    print(f"Slave device: {slave_name}", flush=True)
        except:
            pass

    print("To use this virtual port in another script, use the Slave device name.", flush=True)
    print("Starting writer at 20Hz...", flush=True)

    writer(master, slave)