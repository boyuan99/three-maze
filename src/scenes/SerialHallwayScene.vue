<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import { HallwayWorld } from '../worlds/HallwayWorld.js'

const canvas = ref(null)
const world = shallowRef(null)
const state = ref({})

// Handle incoming data from Python backend
const updateFromPython = (data) => {
  if (!world.value) return
  
  try {
    const { x, y, theta, water, timestamp, isWhite } = data
    const { playerBody, camera } = state.value

    // Update position and rotation (similar to grittonmove.m)
    const rotMatrix = new THREE.Matrix4().makeRotationY(theta)
    const position = new THREE.Vector3(x, 2, y)
    position.applyMatrix4(rotMatrix)

    // Update player position
    playerBody.setTranslation({
      x: position.x,
      y: 2,  // Fixed height
      z: position.z
    })

    // Update camera
    camera.position.copy(position)
    camera.rotation.y = theta
  } catch (err) {
    console.error('Error updating scene:', err)
  }
}

onMounted(async () => {
  if (canvas.value) {
    // Create world with orbit controls disabled
    world.value = new HallwayWorld(canvas.value, {
      useOrbitControls: false  // Explicitly disable orbit controls
    })
    await world.value.init()
    
    if (window.electron) {
      window.electron.onPythonSerialData(updateFromPython)
    }
  }
})

onUnmounted(() => {
  if (world.value) {
    world.value.dispose()
  }
})
</script>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
}

canvas {
  width: 100%;
  height: 100%;
}
</style> 