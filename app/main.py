from flask import Flask, render_template
from cube_controller import cube_blueprint
import logging

app = Flask(__name__,
            template_folder='../templates',
            static_folder='../static',
            static_url_path='/static')

app.register_blueprint(cube_blueprint)


@app.after_request
def add_header(response):
    """
    Add headers to both force latest IE rendering engine or Chrome Frame,
    and also to cache the rendered page for 10 minutes.
    """
    response.headers['X-UA-Compatible'] = 'IE=Edge,chrome=1'
    response.headers['Cache-Control'] = 'public, max-age=0'
    return response


@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    app.run(debug=True)
