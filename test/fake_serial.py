import os
import pty
import json
import random
import time
import math
import threading
import fcntl
import termios

def generate_sensor_data():
    data = {
        "x": 0,
        "y": 0,
        "vx": 0,
        "vy": 0,
        "angle": 0,
        "angular_velocity": 0
    }

    # Constants for data generation
    max_acceleration = 2.0  # m/s^2
    max_angular_acceleration = 1.0  # rad/s^2
    dt = 0.05  # 20 times per second

    while True:
        # Update velocities
        ax = random.uniform(-max_acceleration, max_acceleration)
        ay = random.uniform(-max_acceleration, max_acceleration)
        data["vx"] += ax * dt
        data["vy"] += ay * dt

        # Update position
        data["x"] += data["vx"] * dt
        data["y"] += data["vy"] * dt

        # Update angular velocity
        angular_acceleration = random.uniform(-max_angular_acceleration, max_angular_acceleration)
        data["angular_velocity"] += angular_acceleration * dt

        # Update angle
        data["angle"] += data["angular_velocity"] * dt
        data["angle"] %= (2 * math.pi)  # Keep angle between 0 and 2π

        # Limit values to reasonable ranges
        data["vx"] = max(min(data["vx"], 10), -10)
        data["vy"] = max(min(data["vy"], 10), -10)
        data["x"] = max(min(data["x"], 100), -100)
        data["y"] = max(min(data["y"], 100), -100)
        data["angular_velocity"] = max(min(data["angular_velocity"], 2*math.pi), -2*math.pi)

        yield data

def writer(master):
    for sensor_data in generate_sensor_data():
        json_data = json.dumps(sensor_data).encode('utf-8') + b'\n'
        os.write(master, json_data)
        print(f"Wrote data: {json_data.decode().strip()}")
        time.sleep(0.05)

def reader(slave):
    while True:
        data = os.read(slave, 1024).decode('utf-8')
        if data:
            print(f"Received: {data.strip()}")

if __name__ == "__main__":
    master, slave = pty.openpty()
    print(f"Virtual serial port created.")

    # Get the device names without using os.ttyname
    for fd in range(255):
        try:
            if os.isatty(fd):
                attr = termios.tcgetattr(fd)
                if fd == master:
                    print(f"Master FD: {fd}")
                elif fd == slave:
                    print(f"Slave FD: {fd}")
        except:
            pass

    print("To use this virtual port in another script, use the Slave FD number.")
    print("For example, if Slave FD is 5, you would open '/dev/ttys005' in your other script.")

    # Start the writer in a separate thread
    writer_thread = threading.Thread(target=writer, args=(master,))
    writer_thread.daemon = True
    writer_thread.start()

    # Use the reader in the main thread
    reader(slave)
