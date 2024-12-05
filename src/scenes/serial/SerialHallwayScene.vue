<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    
    <div v-if="error" class="error-overlay">
      <div class="error-content">
        <h3>Python Backend Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import { HallwayWorld } from '../../worlds/HallwayWorld.js'

const canvas = ref(null)
const world = shallowRef(null)
const error = ref(null)

// Track accumulated position
const currentPosition = {
  x: 0,
  y: -50, 
  theta: 0
}

// Handle incoming data from Python backend
const updateFromPython = (data) => {
  if (!world.value) return
  
  try {
    const { x, y, theta, water, timestamp, isWhite, currentWorld } = data
    const { playerBody, camera } = world.value
    
    // Update current position based on data
    currentPosition.x = x
    currentPosition.y = y
    currentPosition.theta = theta

    // Update player position and rotation
    playerBody.setTranslation({
      x: currentPosition.x,
      y: 2,
      z: currentPosition.y // Note: y in data maps to z in THREE.js
    })
    
    playerBody.setRotation({
      x: 0,
      y: currentPosition.theta,
      z: 0
    })

    // Update camera to follow player
    camera.position.set(
      currentPosition.x,
      2,
      currentPosition.y
    )
    camera.rotation.y = currentPosition.theta

    // Send position back to Python backend for trial end detection
    if (window.electron) {
      window.electron.sendToPython(`POS,${x},${y},${theta},${water}`)
    }
  } catch (err) {
    console.error('Error updating scene:', err)
  }
}

onMounted(async () => {
  if (canvas.value) {
    // Initialize world with higher frame rate
    world.value = new HallwayWorld(canvas.value, {
      useOrbitControls: false,
      frameRate: 60
    })
    await world.value.init()
    
    if (window.electron) {
      window.electron.onPythonSerialData(updateFromPython)
      window.electron.onPythonError((errorMsg) => {
        error.value = errorMsg
      })
    }
  }
})

onUnmounted(() => {
  if (world.value) {
    world.value.dispose()
  }
  // Signal Python backend to stop logging
  if (window.electron) {
    window.electron.sendToPython({ command: 'stop_logging' })
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

.error-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.error-content {
  background: #ff4444;
  padding: 20px;
  border-radius: 8px;
  color: white;
  text-align: center;
}
</style> 