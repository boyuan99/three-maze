import asyncio
import websockets
import json
import random
import math
import time

# Global variables
latest_data = {
    "x": 0,
    "y": 0,
    "vx": 0,
    "vy": 0,
    "angle": 0,
    "angular_velocity": 0
}
is_generating = False

async def generate_sensor_data():
    global latest_data, is_generating

    # Constants for data generation
    max_acceleration = 2.0  # m/s^2
    max_angular_acceleration = 1.0  # rad/s^2
    dt = 0.05  # 20 times per second

    while is_generating:
        # Update velocities
        ax = random.uniform(-max_acceleration, max_acceleration)
        ay = random.uniform(-max_acceleration, max_acceleration)
        latest_data["vx"] += ax * dt
        latest_data["vy"] += ay * dt

        # Update position
        latest_data["x"] += latest_data["vx"] * dt
        latest_data["y"] += latest_data["vy"] * dt

        # Update angular velocity
        angular_acceleration = random.uniform(-max_angular_acceleration, max_angular_acceleration)
        latest_data["angular_velocity"] += angular_acceleration * dt

        # Update angle
        latest_data["angle"] += latest_data["angular_velocity"] * dt
        latest_data["angle"] %= (2 * math.pi)  # Keep angle between 0 and 2π

        # Limit values to reasonable ranges
        latest_data["vx"] = max(min(latest_data["vx"], 10), -10)
        latest_data["vy"] = max(min(latest_data["vy"], 10), -10)
        latest_data["x"] = max(min(latest_data["x"], 100), -100)
        latest_data["y"] = max(min(latest_data["y"], 100), -100)
        latest_data["angular_velocity"] = max(min(latest_data["angular_velocity"], 2*math.pi), -2*math.pi)

        await asyncio.sleep(dt)

async def handle_client(websocket, path):
    global is_generating
    print("Client connected")
    is_generating = True
    data_generation_task = asyncio.create_task(generate_sensor_data())

    try:
        while True:
            await websocket.send(json.dumps(latest_data))
            await asyncio.sleep(0.05)  # Send data 20 times per second
    finally:
        print("Client disconnected")
        is_generating = False
        data_generation_task.cancel()

async def main():
    server = await websockets.serve(handle_client, "localhost", 8765)
    print("WebSocket server started on ws://localhost:8765")
    await server.wait_closed()

if __name__ == "__main__":
    asyncio.run(main())
