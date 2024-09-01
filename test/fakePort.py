from flask import Flask, render_template, jsonify, request
from flask_socketio import SocketIO
import random
import time
import threading
import os

current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)

app = Flask(__name__,
            static_folder=current_dir,  # Serve static files from the current directory
            static_url_path='')
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app)

# Global variables
latest_data = {"x": 0, "z": 0}
is_generating = False
generation_thread = None

def generate_sensor_data():
    global latest_data, is_generating
    while is_generating:
        x = random.uniform(-1, 1)
        z = random.uniform(-1, 1)
        latest_data = {"x": x, "z": z}
        socketio.emit('sensor_data', latest_data)
        time.sleep(0.05)  # 20 times per second

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
    socketio.run(app, debug=True, port=8765)
