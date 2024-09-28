from flask import Flask, jsonify
from flask_cors import CORS
import random

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})  # 允许所有来源访问 /api/* 路径


@app.route('/api/rotation')
def get_rotation():
    rotation = {
        'x': random.uniform(0, 2 * 3.1415926),
        'y': random.uniform(0, 2 * 3.1415926),
        'z': random.uniform(0, 2 * 3.1415926),
    }
    return jsonify(rotation)


if __name__ == '__main__':
    app.run(debug=True, port=5050)
