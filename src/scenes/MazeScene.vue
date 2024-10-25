<template>
  <div class="scene-container">
    <canvas ref="canvasRef"></canvas>
    <div id="blocker" v-show="!isPointerLocked" class="blocker" @click="startGame">
      <div id="instructions" class="instructions">
        <p style="font-size:36px">Click to play</p>
        <p>WASD = Move</p>
        <p>MOUSE = Look around</p>
        <p>TAB = Toggle pointer lock</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import {ref, onMounted, onUnmounted} from 'vue'
import {MazeWorld} from '../worlds/MazeWorld.js'

const canvasRef = ref(null)
const isPointerLocked = ref(false)
let world = null

onMounted(async () => {
  world = new MazeWorld(canvasRef.value)
  await world.init()

  // Handle pointer lock changes
  document.addEventListener('pointerlockchange', onPointerLockChange)

  // Add Tab key handler
  document.addEventListener('keydown', handleTabKey)
})

onUnmounted(() => {
  if (world) {
    world.dispose()
  }
  document.removeEventListener('pointerlockchange', onPointerLockChange)
  document.removeEventListener('keydown', handleTabKey)
})

const startGame = () => {
  if (canvasRef.value) {
    canvasRef.value.requestPointerLock()
  }
}

const handleTabKey = (event) => {
  if (event.code === 'Tab') {
    event.preventDefault()
    if (document.pointerLockElement) {
      document.exitPointerLock()
    } else {
      canvasRef.value?.requestPointerLock()
    }
  }
}

const onPointerLockChange = () => {
  isPointerLocked.value = document.pointerLockElement === canvasRef.value
}
</script>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  position: relative;
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}

.blocker {
  position: absolute;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.7);
  top: 0;
  left: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
}

.instructions {
  color: #ffffff;
  text-align: center;
  font-size: 14px;
  background-color: rgba(0, 0, 0, 0.5);
  padding: 2rem;
  border-radius: 8px;
}

.instructions p {
  margin: 0.5em 0;
}
</style>