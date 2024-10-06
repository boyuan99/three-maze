<template>
  <canvas ref="canvasRef"></canvas>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createTexturedHallway } from './HallwayModule.js';
import { RapierDebugRenderer } from '@/utils/RapierDebugRenderer.js';
import { initScene } from '@/utils/initScene.js';
import { initPhysics, createPlayer, addPhysicsToHallway } from '@/utils/initPhysics.js';
import axios from 'axios';
import config from '@tmroot/config.json';

const canvasRef = ref(null);

let scene, camera, renderer, world, playerBody, rapierDebugRenderer;
let latestSensorData = null;

// Frame rates from config
const SCENE_FRAME_RATE = config.scene.frameRate;
const SCENE_FRAME_INTERVAL = 1000 / SCENE_FRAME_RATE;
const DATA_SAMPLE_RATE = config.data.sampleRate;
const DATA_SAMPLE_INTERVAL = 1000 / DATA_SAMPLE_RATE;

let lastFrameTime = 0;
let lastDataSampleTime = 0;

// API URL uses the proxy set up in vite.config.js
const API_URL = '/api';

onMounted(async () => {
  await init();
  animate();
});

onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
  if (renderer) {
    renderer.dispose();
  }
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

  fetchSensorData();

  window.addEventListener("resize", onWindowResize, false);
}

function animate(currentTime) {
  requestAnimationFrame(animate);

  if (currentTime - lastFrameTime >= SCENE_FRAME_INTERVAL) {
    updatePlayerMovement();
    rapierDebugRenderer.update();
    world.step();
    renderer.render(scene, camera);
    lastFrameTime = currentTime;
  }

  if (currentTime - lastDataSampleTime >= DATA_SAMPLE_INTERVAL) {
    sendPositionData();
    lastDataSampleTime = currentTime;
  }
}

function fetchSensorData() {
  axios
      .get(`${API_URL}/generate_sensor_data`)
      .then((response) => {
        latestSensorData = response.data;
        setTimeout(fetchSensorData, DATA_SAMPLE_INTERVAL);
      })
      .catch((error) => {
        console.error('Error fetching sensor data:', error);
        setTimeout(fetchSensorData, 1000);
      });
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
  const position = playerBody.translation();
  const rotation = playerBody.rotation();

  axios.post(`${API_URL}/player_position`, {
    position: {
      x: position.x,
      y: position.y,
      z: position.z
    },
    rotation: {
      x: rotation.x,
      y: rotation.y,
      z: rotation.z,
      w: rotation.w
    },
  }).catch(error => {
    console.error('Error sending position data:', error);
  });
}
</script>

<style scoped>
canvas {
  width: 100vw;
  height: 100vh;
  display: block;
}
</style>