from flask import Flask, jsonify, request
from flask_cors import CORS
import json
import random
from time import perf_counter

# Load shared configuration
with open('../config.json') as config_file:
    config = json.load(config_file)

app = Flask(__name__)
CORS(app)

# Global variables to track timing
start_time = None
data_points_count = 0


@app.route('/api/generate_sensor_data')
def get_sensor_data():
    data = {
        'x': random.uniform(-1, 1),  # Position x
        'y': random.uniform(-1, 1),  # Position y
        'vx': random.uniform(-1, 0),  # Velocity x
        'vy': random.uniform(-1, 0),  # Velocity y
        'angle': random.uniform(0, 0.2 * 3.1415926),  # Angle in radians
        'angular_velocity': random.uniform(-0.01, 0.01),  # Angular velocity
    }
    return jsonify(data)


@app.route('/api/player_position', methods=['POST'])
def receive_player_position():
    global start_time, data_points_count

    data = request.json
    current_time = perf_counter()

    if start_time is None:
        start_time = current_time

    elapsed_time = current_time - start_time
    data['server_timestamp'] = round(elapsed_time, 4)

    data_points_count += 1
    data['data_point_index'] = data_points_count

    # Save to file
    with open('player_positions.json', 'a') as f:
        json.dump(data, f)
        f.write('\n')

    return jsonify({"status": "success", "message": "Position data saved"}), 200


if __name__ == '__main__':
    app.run(debug=True)
