const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
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

// Replace '/dev/ttyACM0' with your Teensy's port (e.g., 'COM3' on Windows)
const serialPort = new SerialPort({ path: '/dev/ttyACM0', baudRate: 115200 });
const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }));

io.on('connection', (socket) => {
    console.log('A client connected');

    parser.on('data', (data) => {
        try {
            const jsonData = JSON.parse(data);
            socket.emit('sensor_data', jsonData);
        } catch (error) {
            console.error('Error parsing JSON:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

const PORT = 8765;
http.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
