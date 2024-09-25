from flask import Blueprint, jsonify
import time
import numpy as np

cube_blueprint = Blueprint('cube', __name__)


@cube_blueprint.route('/get_rotation')
def get_rotation():
    current_time = time.time()
    return jsonify({
        'x': (current_time * 0.5) % (2 * np.pi),
        'y': (current_time * 0.3) % (2 * np.pi),
        'z': (current_time * 0.1) % (2 * np.pi)
    })
