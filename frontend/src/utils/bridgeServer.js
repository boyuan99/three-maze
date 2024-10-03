const fs = require('fs');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const { Server } = require('socket.io');
const io = new Server(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const FILE_PATH = '../test/sensor_data.json';
const EMIT_INTERVAL = 50; // Emit data every 100ms

let lastData = null;
let fileWatcher = null;

function readSensorData() {
    try {
        const data = fs.readFileSync(FILE_PATH, 'utf8');

        if (data.trim() === '') {
            console.log('File is empty');
            return null;
        }

        const parsedData = JSON.parse(data);

        // Check if the data has changed
        if (JSON.stringify(parsedData) !== JSON.stringify(lastData)) {
            console.log('New data read:', parsedData);
            lastData = parsedData;
        }

        return parsedData;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error('File not found. Make sure the Python script is running and creating the file.');
        } else if (error instanceof SyntaxError) {
            console.error('Error parsing JSON:', error);
            console.log('Invalid JSON content:', fs.readFileSync(FILE_PATH, 'utf8'));
        } else {
            console.error('Error reading file:', error);
        }
        return null;
    }
}

io.on('connection', (socket) => {
    console.log('A client connected');

    const interval = setInterval(() => {
        if (lastData) {
            socket.emit('sensor_data', lastData);
        }
    }, EMIT_INTERVAL);

    socket.on('disconnect', () => {
        console.log('Client disconnected');
        clearInterval(interval);
    });
});

const PORT = 8765;
http.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Watching for changes in ${FILE_PATH}`);
    console.log(`Emitting data every ${EMIT_INTERVAL}ms to WebSocket clients`);
    console.log('Make sure the Python script is running to generate data.');
});

// Set up file watcher
function setupFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
    }

    fileWatcher = fs.watch(FILE_PATH, (eventType, filename) => {
        if (eventType === 'change') {
            console.log(`File ${filename} changed`);
            readSensorData();
        }
    });

    console.log(`File watcher set up for ${FILE_PATH}`);
}

// Check if the file exists on startup
fs.access(FILE_PATH, fs.constants.F_OK, (err) => {
    if (err) {
        console.error(`${FILE_PATH} does not exist. Make sure the Python script is running.`);
        // Set up a watcher for the directory to detect when the file is created
        const dir = require('path').dirname(FILE_PATH);
        fs.watch(dir, (eventType, filename) => {
            if (eventType === 'rename' && filename === require('path').basename(FILE_PATH)) {
                console.log('Sensor data file created. Setting up file watcher.');
                setupFileWatcher();
            }
        });
    } else {
        console.log(`${FILE_PATH} found. Ready to read data.`);
        // Attempt to read data immediately
        readSensorData();
        // Set up file watcher
        setupFileWatcher();
    }
});
