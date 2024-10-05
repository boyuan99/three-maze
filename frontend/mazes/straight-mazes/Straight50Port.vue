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
import axios from 'axios';

const canvasRef = ref(null);

let scene, camera, renderer, world, playerBody, rapierDebugRenderer;
let latestSensorData = null;

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

  // Load and add hallway
  const hallway = createTexturedHallway();
  scene.add(hallway);
  // Add physics to hallway
  addPhysicsToHallway(hallway, world);

  // Initialize player
  playerBody = createPlayer(world);

  // Start fetching sensor data
  fetchSensorData();

  window.addEventListener("resize", onWindowResize, false);
}

function animate() {
  requestAnimationFrame(animate);

  updatePlayerMovement();
  rapierDebugRenderer.update();
  world.step();

  // Send position data after updating player movement
  sendPositionData();

  renderer.render(scene, camera);
}

function fetchSensorData() {
  axios
      .get('/api/generate_sensor_data')
      .then((response) => {
        latestSensorData = response.data;
        // Fetch new data at regular intervals
        setTimeout(fetchSensorData, 50);
      })
      .catch((error) => {
        console.error('Error fetching sensor data:', error);
        // Retry after 1 second if an error occurs
        setTimeout(fetchSensorData, 1000);
      });
}

function updatePlayerMovement() {
  if (latestSensorData) {
    const {vx, vy, angle, angular_velocity} = latestSensorData;

    // Convert the 2D motion to 3D (assuming sensor data is in m/s)
    const linearVelocity = new RAPIER.Vector3(vx, 0, -vy); // Note: we use -vy for z-axis

    // Directly set the linear velocity of the player body
    playerBody.setLinvel(linearVelocity, true);

    // Directly set the angular velocity
    playerBody.setAngvel({x: 0, y: angular_velocity, z: 0}, true);

    updateCameraPositionAndOrientation(angle);
  }
}

function updateCameraPositionAndOrientation(angle) {
  const playerPosition = playerBody.translation();
  // Position the camera at the player's position, slightly raised
  camera.position.set(
      playerPosition.x,
      playerPosition.y + 0.8, // Adjust as needed
      playerPosition.z
  );

  // Set the camera's rotation based on the player's angle
  camera.rotation.y = -angle;
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// New function to send position data
function sendPositionData() {
  const position = playerBody.translation();
  const rotation = playerBody.rotation();

  axios.post('/api/player_position', {
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
    }
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