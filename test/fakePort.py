from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO
import random
import time
import threading
import os
import math

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)

app = Flask(__name__,
            static_folder=current_dir,  # Serve static files from the current directory
            static_url_path='')
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app)

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
generation_thread = None

def generate_sensor_data():
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

        socketio.emit('sensor_data', latest_data)
        time.sleep(dt)

@app.route('/')
def index():
    return render_template('test_pyport.html')

@app.route('/favicon.ico')
def favicon():
    return '', 204

@app.route('/data')
def get_data():
    return jsonify(latest_data)

@app.route('/toggle_generation', methods=['POST'])
def toggle_generation():
    global is_generating, generation_thread
    is_generating = not is_generating

    if is_generating and (generation_thread is None or not generation_thread.is_alive()):
        generation_thread = threading.Thread(target=generate_sensor_data)
        generation_thread.start()

    return jsonify({"is_generating": is_generating})

@socketio.on('connect')
def test_connect():
    print('Client connected')
    socketio.emit('generation_status', {"is_generating": is_generating})

@socketio.on('disconnect')
def test_disconnect():
    print('Client disconnected')

if __name__ == '__main__':
    port = 8765
    print(f"Running on \033[94mhttp://127.0.0.1:{port}\033[0m")
    socketio.run(app, debug=True, port=port)
