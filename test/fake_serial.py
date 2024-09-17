import json
import random
import time
import math

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

def writer():
    with open('sensor_data.json', 'w') as f:
        for sensor_data in generate_sensor_data():
            json_data = json.dumps(sensor_data)
            f.seek(0)
            f.write(json_data)
            f.truncate()
            print(f"Wrote data: {json_data}")
            time.sleep(0.05)

if __name__ == "__main__":
    print("Starting to write sensor data to sensor_data.json")
    writer()
