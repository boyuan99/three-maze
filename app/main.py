from flask import Flask, render_template
from cube_controller import cube_blueprint
import logging
from werkzeug.serving import WSGIRequestHandler, is_running_from_reloader


class CustomRequestHandler(WSGIRequestHandler):
    def log(self, type, message, *args):
        if "GET /get_rotation" not in message:
            return WSGIRequestHandler.log(self, type, message, *args)


def create_app():
    app = Flask(__name__,
                template_folder='../templates',
                static_folder='../static',
                static_url_path='/static')

    app.register_blueprint(cube_blueprint)

    # Custom logging configuration
    logging.basicConfig(level=logging.INFO)
    werkzeug_logger = logging.getLogger('werkzeug')
    werkzeug_logger.setLevel(logging.ERROR)

    @app.after_request
    def add_header(response):
        response.headers['X-UA-Compatible'] = 'IE=Edge,chrome=1'
        response.headers['Cache-Control'] = 'public, max-age=0'
        return response

    @app.route('/')
    def index():
        return render_template('index.html')

    return app


def log_startup_info(host, port):
    if not is_running_from_reloader():
        print(f" * Running on http://{host}:{port}")
        print(" * (Press CTRL+C to quit)")


if __name__ == '__main__':
    app = create_app()

    host = '127.0.0.1'
    port = 5000

    log_startup_info(host, port)
    app.run(debug=True, host=host, port=port, request_handler=CustomRequestHandler)
