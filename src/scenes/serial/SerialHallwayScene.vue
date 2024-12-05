<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import { HallwayWorld } from '../../worlds/HallwayWorld.js'

const canvas = ref(null)
const world = shallowRef(null)
const currentState = ref({})

// Handle incoming data from Python backend
const updateFromPython = (data) => {
  if (!world.value) return
  
  try {
    const { dx, dy, dtheta, x, y, theta, water } = data
    const { playerBody, camera } = world.value
    
    // Use the current accumulated position from Python backend
    const newPosition = new THREE.Vector3(x, 2, y)
    
    // Update player position and rotation
    playerBody.setTranslation({
      x: newPosition.x,
      y: 2,
      z: newPosition.z
    })
    
    playerBody.setRotation({
      x: 0,
      y: theta,
      z: 0
    })

    // Update camera
    camera.position.copy(newPosition)
    camera.rotation.y = theta
    
    // Store current state
    currentState.value = {
      position: newPosition,
      rotation: theta
    }
  } catch (err) {
    console.error('Error updating scene:', err)
  }
}

onMounted(async () => {
  if (canvas.value) {
    world.value = new HallwayWorld(canvas.value, {
      useOrbitControls: false
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