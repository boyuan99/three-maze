from flask import Flask, jsonify
from flask import render_template
from flask_cors import CORS
import random

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})  # Allow all origins to access /api/* paths

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/rotation')
def get_rotation():
    rotation = {
        'x': random.uniform(0, 2 * 3.1415926),
        'y': random.uniform(0, 2 * 3.1415926),
        'z': random.uniform(0, 2 * 3.1415926),
    }
    return jsonify(rotation)

@app.route('/api/generate_sensor_data')
def get_sensor_data():
    data = {
        'x': random.uniform(-1, 1),                   # Position x
        'y': random.uniform(-1, 1),                   # Position y
        'vx': random.uniform(-1, 0),                    # Velocity x
        'vy': random.uniform(-1, 0),                    # Velocity y
        'angle': random.uniform(0, 0.2 * 3.1415926),      # Angle in radians
        'angular_velocity': random.uniform(-0.01, 0.01),  # Angular velocity
    }
    return jsonify(data)


if __name__ == '__main__':
    app.run(debug=True, port=5050)
