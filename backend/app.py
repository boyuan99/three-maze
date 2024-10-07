from flask import Flask
from flask_socketio import SocketIO, emit
import json
import random
import time

# Load shared configuration
with open('../config.json') as config_file:
    config = json.load(config_file)

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", path='/socket.io')

# Global variables to track timing
start_time = None
data_points_count = 0


def generate_sensor_data():
    data = {
        'x': random.uniform(-1, 1),
        'y': random.uniform(-1, 1),
        'vx': random.uniform(-1, 0),
        'vy': random.uniform(-1, 0),
        'angle': random.uniform(0, 0.2 * 3.1415926),
        'angular_velocity': random.uniform(-0.01, 0.01),
    }
    return data


@socketio.on_error_default  # Handles the default namespace
def default_error_handler(e):
    print('An error has occurred:', e)


@socketio.on('/api/generate_sensor_data')
def handle_request_sensor_data():
    data = generate_sensor_data()
    emit('/api/sensor_data', data)


@socketio.on('/api/player_position')
def handle_player_position(data):
    global start_time, data_points_count

    current_time = time.perf_counter()

    if start_time is None:
        start_time = current_time

    elapsed_time = current_time - start_time
    data['server_timestamp'] = round(elapsed_time, 6)

    data_points_count += 1
    data['data_point_index'] = data_points_count

    # Save to file
    with open('player_positions.json', 'a') as f:
        json.dump(data, f)
        f.write('\n')

    # Optionally, send back an acknowledgment
    emit('/api/acknowledge', {'status': 'success', 'message': 'Position data saved'})


if __name__ == '__main__':
    socketio.run(app, port=config['flask']['FLASK_RUN_PORT'])
