<template>
  <canvas ref="canvasRef"></canvas>
</template>

<script setup>
import {ref, onMounted, onUnmounted} from 'vue';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {createTexturedHallway} from './HallwayModule.js';
import {RapierDebugRenderer} from '@/utils/RapierDebugRenderer.js';
import {initScene} from '@/utils/initScene.js';
import {initPhysics, createPlayer, addPhysicsToHallway} from '@/utils/initPhysics.js';
import config from '@tmroot/config.json';
import {io} from 'socket.io-client';

const canvasRef = ref(null);

let scene, camera, renderer, world, playerBody, rapierDebugRenderer;
let latestSensorData = null;

// Frame rates from config
const SCENE_FRAME_RATE = config.scene.frameRate;
const SCENE_FRAME_INTERVAL = 1000 / SCENE_FRAME_RATE;
const DATA_SAMPLE_RATE = config.data.sampleRate;
const DATA_SAMPLE_INTERVAL = 1000 / DATA_SAMPLE_RATE;

// High-resolution timing variables
let expectedDataTime;

// Use the proxied URL for WebSocket connection
const API_URL = '/api';

// Initialize WebSocket connection without hardcoding the port
const socket = io('/', {
  path: '/socket.io',
});

// Event names with '/api/' prefix
const GENERATE_SENSOR_DATA_EVENT = `${API_URL}/generate_sensor_data`;
const SENSOR_DATA_EVENT = `${API_URL}/sensor_data`;
const PLAYER_POSITION_EVENT = `${API_URL}/player_position`;

onMounted(async () => {
  await init();
  animate();

  // Start data transmission loop after socket connection is established
  socket.on('connect', () => {
    console.log('Connected to WebSocket server');
    expectedDataTime = performance.now() + DATA_SAMPLE_INTERVAL;
    sendPositionData();
    // Request initial sensor data
    socket.emit(GENERATE_SENSOR_DATA_EVENT);
  });

  // Listen for sensor data from server
  socket.on(SENSOR_DATA_EVENT, (data) => {
    latestSensorData = data;
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.warn('Disconnected from WebSocket server');
  });

  //Handle errors
  socket.on('connect_error', (error) => {
    console.error('Socket.IO connection error:', error);
  });

  socket.on('error', (error) => {
    console.error('Socket.IO error:', error);
  });

});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize);
  if (renderer) {
    renderer.dispose();
  }
  socket.disconnect();
});

async function init() {
  const container = canvasRef.value;
  ({scene, camera, renderer} = initScene(container));
  world = await initPhysics();

  rapierDebugRenderer = new RapierDebugRenderer(scene, world);

  const hallway = createTexturedHallway();
  scene.add(hallway);
  addPhysicsToHallway(hallway, world);

  playerBody = createPlayer(world);

  window.addEventListener('resize', onWindowResize, false);
}

function animate() {
  requestAnimationFrame(animate);
  updatePlayerMovement();
  rapierDebugRenderer.update();
  world.step();
  renderer.render(scene, camera);
}

function updatePlayerMovement() {
  if (latestSensorData) {
    const {vx, vy, angle, angular_velocity} = latestSensorData;
    const linearVelocity = new RAPIER.Vector3(vx, 0, -vy);
    playerBody.setLinvel(linearVelocity, true);
    playerBody.setAngvel({x: 0, y: angular_velocity, z: 0}, true);
    updateCameraPositionAndOrientation(angle);
  }
}

function updateCameraPositionAndOrientation(angle) {
  const playerPosition = playerBody.translation();
  camera.position.set(
      playerPosition.x,
      playerPosition.y + config.camera.offset,
      playerPosition.z
  );
  camera.rotation.y = -angle;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function sendPositionData() {
  // Collect data
  const position = playerBody.translation();
  const rotation = playerBody.rotation();

  // Send data via WebSocket
  socket.emit(PLAYER_POSITION_EVENT, {
    position: {
      x: position.x,
      y: position.y,
      z: position.z,
    },
    rotation: {
      x: rotation.x,
      y: rotation.y,
      z: rotation.z,
      w: rotation.w,
    },
  });

  // Adjust for drift
  expectedDataTime += DATA_SAMPLE_INTERVAL;
  const drift = performance.now() - expectedDataTime;
  const nextInterval = DATA_SAMPLE_INTERVAL - drift;

  // Ensure the next interval is not negative
  setTimeout(sendPositionData, Math.max(0, nextInterval));
}

</script>

<style scoped>
canvas {
  width: 100vw;
  height: 100vh;
  display: block;
}
</style>
