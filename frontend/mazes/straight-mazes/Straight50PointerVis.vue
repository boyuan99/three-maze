<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import * as THREE from 'three';
import './style.css';
import { createTexturedHallway } from './HallwayModule.js';
import { UI } from '@/utils/UI.js';
import { FixedCam } from '@/utils/FixedCam.js';
import { KeyboardController } from '@/utils/KeyboardController.js';
import { RapierDebugRenderer } from "@/utils/RapierDebugRenderer.js";
import RAPIER from '@dimforge/rapier3d-compat';

defineOptions({
  name: 'Straight50PointerVis'
})

const canvasRef = ref(null);

let scene, camera, renderer, world, ballBody, fixedCam, keyboard, rapierDebugRenderer;

onMounted(async () => {
  await init();
  animate();
});

onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
});

async function init() {
  // Scene setup
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value });
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(0, 20, 0);
  scene.add(directionalLight);

  // Initialize UI and controllers
  const ui = new UI(renderer);
  fixedCam = new FixedCam(scene, camera, renderer);
  keyboard = new KeyboardController(renderer);

  // Initialize Rapier Physics World
  await RAPIER.init();
  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  world = new RAPIER.World(gravity);

  rapierDebugRenderer = new RapierDebugRenderer(scene, world);

  // Load the textured hallway
  const hallway = createTexturedHallway();
  scene.add(hallway);

  // Adding physics to the hallway
  hallway.children.forEach(child => {
    child.geometry.computeBoundingBox();
    const bbox = child.geometry.boundingBox;
    const width = bbox.max.x - bbox.min.x;
    const height = bbox.max.y - bbox.min.y;
    const depth = bbox.max.z - bbox.min.z;
    const { x: px, y: py, z: pz } = child.position;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(px, py, pz));
    world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2).setRestitution(0).setFriction(1), body);
  });

  // Physics for the ball (player)
  const ballRadius = 1;
  const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, 1, 0)
    .setLinearDamping(0.9)
    .setAngularDamping(0.9)
    .setAdditionalMass(0.0001);

  ballBody = world.createRigidBody(ballBodyDesc);
  world.createCollider(RAPIER.ColliderDesc.ball(ballRadius).setRestitution(0).setFriction(1), ballBody);

  window.addEventListener("resize", onWindowResize);
}

function animate() {
  requestAnimationFrame(animate);

  rapierDebugRenderer.update();

  const moveForce = new THREE.Vector3(0, 0, 0);
  const maxSpeed = 50;
  const rawSpeed = 20;
  const isMoving = keyboard.keyMap['KeyW'] || keyboard.keyMap['KeyA'] || keyboard.keyMap['KeyS'] || keyboard.keyMap['KeyD'];

  if (isMoving) {
    if (keyboard.keyMap['KeyW']) moveForce.z -= rawSpeed;
    if (keyboard.keyMap['KeyS']) moveForce.z += rawSpeed;
    if (keyboard.keyMap['KeyA']) moveForce.x -= rawSpeed;
    if (keyboard.keyMap['KeyD']) moveForce.x += rawSpeed;

    moveForce.applyEuler(new THREE.Euler(0, fixedCam.yaw.rotation.y, 0));

    ballBody.applyImpulse(moveForce, true);
  } else {
    ballBody.setLinvel({x: 0, y: 0, z: 0}, true);
    ballBody.setAngvel({x: 0, y: 0, z: 0}, true);
  }

  const velocity = ballBody.linvel();
  const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
  if (speed > maxSpeed) {
    const scaleFactor = maxSpeed / speed;
    ballBody.setLinvel({
      x: velocity.x * scaleFactor,
      y: velocity.y * scaleFactor,
      z: velocity.z * scaleFactor
    }, true);
  }

  world.step();

  const ballPosition = ballBody.translation();
  fixedCam.update({ position: new THREE.Vector3(ballPosition.x, ballPosition.y + 1, ballPosition.z) });

  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
</script>

<template>
  <canvas ref="canvasRef"></canvas>
</template>

<style scoped>
canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>