<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    <div class="overlay-info" v-if="showInfo">
      <div class="info-panel">
        <h3>Serial Control Hallway</h3>
        <p>Status: {{ connectionStatus }}</p>
        <button @click="connectSerial" v-if="!isConnected">Connect Serial Port</button>
        <button @click="disconnectSerial" v-if="isConnected">Disconnect</button>
      </div>
      <button class="toggle-info" @click="showInfo = false">Hide Info</button>
    </div>
    <button
      v-else
      class="toggle-info-mini"
      @click="showInfo = true"
    >
      Show Info
    </button>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef, computed } from 'vue'
import * as THREE from 'three'
import { HallwayWorld } from '../worlds/HallwayWorld.js'
import { useRouter } from 'vue-router'
import { serialControlScenes, generatePreviews } from '@/scenes'
import NavigationBar from '@/components/NavigationBar.vue'

const canvas = ref(null)
const world = shallowRef(null)
const showInfo = ref(true)
const port = ref(null)
const reader = ref(null)
const isConnected = ref(false)
const connectionStatus = ref('Not connected')
const router = useRouter()
const previews = ref({})
const previewsLoaded = ref(false)

const availableSerialScenes = computed(() => {
  return serialControlScenes
})

const connectSerial = async () => {
  try {
    port.value = await navigator.serial.requestPort()
    await port.value.open({ baudRate: 9600 })
    isConnected.value = true
    connectionStatus.value = 'Connected'
    startReading()
  } catch (err) {
    console.error('Error connecting to serial port:', err)
    connectionStatus.value = 'Connection failed'
  }
}

const disconnectSerial = async () => {
  if (reader.value) {
    await reader.value.cancel()
  }
  if (port.value) {
    await port.value.close()
  }
  isConnected.value = false
  connectionStatus.value = 'Disconnected'
}

const startReading = async () => {
  while (port.value && port.value.readable) {
    reader.value = port.value.readable.getReader()
    try {
      while (true) {
        const { value, done } = await reader.value.read()
        if (done) break
        
        // Parse the incoming data and update camera
        const data = new TextDecoder().decode(value)
        updateCameraFromSerial(data)
      }
    } catch (err) {
      console.error('Error reading serial data:', err)
    } finally {
      reader.value.releaseLock()
    }
  }
}

const updateCameraFromSerial = (data) => {
  if (!world.value) return
  
  try {
    // Assuming data format is "x,y,z"
    const [x, y, z] = data.trim().split(',').map(Number)
    
    // Update camera position based on serial data
    if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
      world.value.camera.position.set(x, y, z)
    }
  } catch (err) {
    console.error('Error parsing serial data:', err)
  }
}

onMounted(async () => {
  if (canvas.value) {
    world.value = new HallwayWorld(canvas.value)
    await world.value.init()
    
    // Disable orbit controls since we're using serial input
    if (world.value.controls) {
      world.value.controls.enabled = false
    }
  }
})

onUnmounted(async () => {
  await disconnectSerial()
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

.overlay-info {
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.info-panel {
  background: rgba(0, 0, 0, 0.7);
  padding: 20px;
  border-radius: 8px;
  color: white;
  min-width: 200px;
}

button {
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  margin-top: 10px;
  width: 100%;
}

button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.toggle-info-mini {
  position: absolute;
  top: 20px;
  right: 20px;
}

.entrance-wrapper {
  background-color: rgba(255, 0, 0, 0.1); /* Light red */
}

.entrance-container {
  background-color: rgba(0, 255, 0, 0.1); /* Light green */
}

.entrance-content {
  background-color: rgba(0, 0, 255, 0.1); /* Light blue */
}

.scene-grid {
  background-color: rgba(255, 255, 0, 0.1); /* Light yellow */
}
</style> 