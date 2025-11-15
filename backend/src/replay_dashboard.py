"""
Web Dashboard for Data Replay Control
Simple HTTP server for controlling data playback
"""

import asyncio
import json
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import threading


class ReplayDashboardHandler(BaseHTTPRequestHandler):
    """HTTP request handler for replay dashboard"""

    replayer = None  # Set by ReplayDashboard

    def log_message(self, format, *args):
        """Suppress default logging"""
        pass

    def do_GET(self):
        """Handle GET requests"""
        parsed_path = urlparse(self.path)
        path = parsed_path.path

        if path == '/':
            self.serve_html()
        elif path == '/api/status':
            self.serve_status()
        elif path == '/api/control':
            self.handle_control(parsed_path.query)
        else:
            self.send_error(404)

    def serve_html(self):
        """Serve the dashboard HTML"""
        html = """
<!DOCTYPE html>
<html>
<head>
    <title>Data Replay Controller</title>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #1a1a1a;
            color: #e0e0e0;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: #2a2a2a;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
        }
        h1 {
            text-align: center;
            margin-bottom: 30px;
            color: #4CAF50;
            font-size: 24px;
        }
        .section {
            margin-bottom: 25px;
            padding-bottom: 25px;
            border-bottom: 1px solid #3a3a3a;
        }
        .section:last-child { border-bottom: none; }
        .info-row {
            display: flex;
            justify-content: space-between;
            margin: 8px 0;
            font-size: 14px;
        }
        .label { color: #888; }
        .value { color: #fff; font-weight: 500; }
        .progress-bar {
            width: 100%;
            height: 30px;
            background: #1a1a1a;
            border-radius: 6px;
            overflow: hidden;
            margin: 15px 0;
            position: relative;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #45a049);
            transition: width 0.3s ease;
        }
        .progress-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-weight: bold;
            font-size: 14px;
            color: #fff;
            text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        }
        .controls {
            display: flex;
            gap: 10px;
            justify-content: center;
            margin: 20px 0;
        }
        button {
            padding: 12px 24px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 600;
            transition: all 0.2s;
        }
        button:hover { transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.3); }
        button:active { transform: translateY(0); }
        .btn-play { background: #4CAF50; color: white; }
        .btn-pause { background: #FF9800; color: white; }
        .btn-stop { background: #f44336; color: white; }
        .btn-restart { background: #2196F3; color: white; }
        .slider-container {
            margin: 15px 0;
        }
        .slider-label {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 14px;
        }
        input[type="range"] {
            width: 100%;
            height: 6px;
            border-radius: 3px;
            background: #1a1a1a;
            outline: none;
            -webkit-appearance: none;
        }
        input[type="range"]::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #4CAF50;
            cursor: pointer;
        }
        input[type="range"]::-moz-range-thumb {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #4CAF50;
            cursor: pointer;
            border: none;
        }
        .checkbox-container {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 15px 0;
        }
        input[type="checkbox"] {
            width: 20px;
            height: 20px;
            cursor: pointer;
        }
        .data-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            margin-top: 10px;
        }
        .status-playing { color: #4CAF50; }
        .status-paused { color: #FF9800; }
        .footer {
            text-align: center;
            margin-top: 20px;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Data Replay Controller</h1>

        <div class="section">
            <div class="info-row">
                <span class="label">File:</span>
                <span class="value" id="filename">-</span>
            </div>
            <div class="info-row">
                <span class="label">Status:</span>
                <span class="value" id="status">-</span>
            </div>
        </div>

        <div class="section">
            <div class="progress-bar">
                <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
                <div class="progress-text" id="progress-text">0%</div>
            </div>
            <div class="info-row">
                <span class="label">Frame:</span>
                <span class="value" id="frame">0 / 0</span>
            </div>
            <div class="info-row">
                <span class="label">Time:</span>
                <span class="value" id="time">0.0s / 0.0s</span>
            </div>
        </div>

        <div class="section">
            <div class="controls">
                <button class="btn-play" onclick="control('play')">▶ Play</button>
                <button class="btn-pause" onclick="control('pause')">⏸ Pause</button>
                <button class="btn-stop" onclick="control('stop')">⏹ Stop</button>
                <button class="btn-restart" onclick="control('restart')">↻ Restart</button>
            </div>

            <div class="slider-container">
                <div class="slider-label">
                    <span class="label">Speed</span>
                    <span class="value" id="speed-value">1.0x</span>
                </div>
                <input type="range" id="speed-slider" min="0.1" max="10" step="0.1" value="1.0"
                       oninput="updateSpeed(this.value)">
            </div>

            <div class="checkbox-container">
                <input type="checkbox" id="loop-checkbox" onchange="toggleLoop()">
                <label for="loop-checkbox">Loop playback</label>
            </div>
        </div>

        <div class="section">
            <h3 style="margin-bottom: 15px; font-size: 16px;">Last Frame Data</h3>
            <div class="data-grid">
                <div class="info-row">
                    <span class="label">X:</span>
                    <span class="value" id="data-x">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Y:</span>
                    <span class="value" id="data-y">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Face Angle:</span>
                    <span class="value" id="data-angle">-</span>
                </div>
                <div class="info-row">
                    <span class="label">Lick:</span>
                    <span class="value" id="data-lick">-</span>
                </div>
            </div>
        </div>

        <div class="footer">
            WebSocket: ws://localhost:8765 | Dashboard: http://localhost:8766
        </div>
    </div>

    <script>
        let speedDebounce = null;

        function control(action) {
            fetch('/api/control?action=' + action)
                .then(r => r.json())
                .then(data => updateUI(data))
                .catch(err => console.error('Control error:', err));
        }

        function updateSpeed(value) {
            document.getElementById('speed-value').textContent = parseFloat(value).toFixed(1) + 'x';
            clearTimeout(speedDebounce);
            speedDebounce = setTimeout(() => {
                fetch('/api/control?action=speed&value=' + value)
                    .catch(err => console.error('Speed error:', err));
            }, 300);
        }

        function toggleLoop() {
            const checked = document.getElementById('loop-checkbox').checked;
            fetch('/api/control?action=loop')
                .catch(err => console.error('Loop error:', err));
        }

        function updateUI(status) {
            if (!status.loaded) {
                document.getElementById('filename').textContent = 'No file loaded';
                document.getElementById('status').textContent = 'Waiting';
                return;
            }

            document.getElementById('filename').textContent = status.filename;

            const statusText = status.is_playing ? 'PLAYING' : 'PAUSED';
            const statusEl = document.getElementById('status');
            statusEl.textContent = statusText;
            statusEl.className = 'value ' + (status.is_playing ? 'status-playing' : 'status-paused');

            const progress = Math.round(status.progress);
            document.getElementById('progress-fill').style.width = progress + '%';
            document.getElementById('progress-text').textContent = progress + '%';

            document.getElementById('frame').textContent =
                `${status.current_frame} / ${status.total_frames}`;
            document.getElementById('time').textContent =
                `${status.current_time.toFixed(1)}s / ${status.total_time.toFixed(1)}s`;

            document.getElementById('speed-value').textContent = status.speed.toFixed(1) + 'x';
            document.getElementById('speed-slider').value = status.speed;
            document.getElementById('loop-checkbox').checked = status.is_looping;

            if (status.last_data) {
                const data = status.last_data;
                document.getElementById('data-x').textContent = data.x.toFixed(3);
                document.getElementById('data-y').textContent = data.y.toFixed(3);
                document.getElementById('data-angle').textContent = data.face_angle.toFixed(1) + '°';
                document.getElementById('data-lick').textContent = data.lick ? 'Yes' : 'No';
            }
        }

        function fetchStatus() {
            fetch('/api/status')
                .then(r => r.json())
                .then(data => updateUI(data))
                .catch(err => console.error('Status error:', err));
        }

        // Update every 500ms
        setInterval(fetchStatus, 500);
        fetchStatus();
    </script>
</body>
</html>
        """

        self.send_response(200)
        self.send_header('Content-type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(html.encode('utf-8'))

    def serve_status(self):
        """Serve replay status as JSON"""
        if self.replayer:
            status = self.replayer.get_status()
        else:
            status = {"loaded": False}

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(status).encode('utf-8'))

    def handle_control(self, query_string):
        """Handle control actions"""
        params = parse_qs(query_string)
        action = params.get('action', [''])[0]

        if not self.replayer:
            self.send_error(400, "No replayer available")
            return

        if action == 'play':
            self.replayer.play()
        elif action == 'pause':
            self.replayer.pause()
        elif action == 'stop':
            self.replayer.stop()
        elif action == 'restart':
            self.replayer.restart()
        elif action == 'speed':
            value = float(params.get('value', ['1.0'])[0])
            self.replayer.set_speed(value)
        elif action == 'loop':
            self.replayer.toggle_loop()

        # Return current status
        self.serve_status()


class ReplayDashboard:
    """Web dashboard server for replay control"""

    def __init__(self, replayer, host='localhost', port=8766):
        self.replayer = replayer
        self.host = host
        self.port = port
        self.server = None
        self.thread = None

    def start(self):
        """Start the dashboard server in a background thread"""
        ReplayDashboardHandler.replayer = self.replayer

        self.server = HTTPServer((self.host, self.port), ReplayDashboardHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

        print(f"Dashboard: http://{self.host}:{self.port}")

    def stop(self):
        """Stop the dashboard server"""
        if self.server:
            self.server.shutdown()
