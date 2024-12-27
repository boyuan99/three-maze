<template>
  <div class="scene-container">
    <div class="monitor-wrapper">
      <div class="monitor-container">
        <div class="controls">
          <button @click="startMonitoring" :disabled="isMonitoring">
            Start Monitoring
          </button>
          <button @click="stopMonitoring" :disabled="!isMonitoring">
            Stop Monitoring
          </button>
        </div>

        <div class="data-display">
          <div class="data-grid">
            <div class="data-item">
              <span class="label">Position X:</span>
              <span class="value">{{ formatNumber(latestData.x) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Position Y:</span>
              <span class="value">{{ formatNumber(latestData.y) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Theta:</span>
              <span class="value">{{ formatNumber(latestData.theta) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Water:</span>
              <span class="value">{{ latestData.water }}</span>
            </div>
            <div class="data-item">
              <span class="label">World:</span>
              <span class="value">{{ latestData.currentWorld }}</span>
            </div>
            <div class="data-item">
              <span class="label">Timestamp:</span>
              <span class="value">{{ latestData.timestamp }}</span>
            </div>
          </div>

          <div v-if="error" class="error-message">
            {{ error }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const isMonitoring = ref(false)
const error = ref(null)
const latestData = ref({
  x: 0,
  y: 0,
  theta: 0,
  water: 0,
  timestamp: '',
  isWhite: true,
  currentWorld: 1
})

const formatNumber = (num) => {
  return typeof num === 'number' ? num.toFixed(2) : '0.00'
}

const startMonitoring = async () => {
  try {
    if (window.electron) {
      console.log('Starting Python serial monitoring...')
      await window.electron.startPythonSerial()
      isMonitoring.value = true
      error.value = null
    }
  } catch (err) {
    console.error('Start monitoring error:', err)
    error.value = `Failed to start monitoring: ${err.message}`
  }
}

const stopMonitoring = async () => {
  try {
    if (window.electron) {
      window.electron.sendToPython({ command: 'stop_logging' })
      await new Promise(resolve => setTimeout(resolve, 100))
      await window.electron.stopPythonSerial()
      isMonitoring.value = false
    }
  } catch (err) {
    error.value = `Failed to stop monitoring: ${err.message}`
  }
}

onMounted(() => {
  if (window.electron) {
    // Listen for initialization data
    window.electron.onPythonSerialData((data) => {
      // Handle initialization data
      console.log('Initialization data:', data)
    })

    // Listen for position updates
    window.electron.onPythonPositionData((data) => {
      // Handle position updates
      console.log('Position update:', data)
      // Update your UI here
    })
  }
})

onUnmounted(() => {
  if (isMonitoring.value) {
    stopMonitoring()
  }
})
</script>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  background-color: #1a1a1a;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem;
}

.monitor-wrapper {
  width: 100%;
  max-width: 800px;
  background-color: #2a2a2a;
  border-radius: 12px;
  padding: 2rem;
}

.monitor-container {
  width: 100%;
  height: 100%;
}

.controls {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
}

button {
  background-color: #4a4a4a;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.3s;
}

button:hover:not(:disabled) {
  background-color: #5a5a5a;
}

button:disabled {
  background-color: #3a3a3a;
  cursor: not-allowed;
  opacity: 0.7;
}

.data-display {
  background-color: #1a1a1a;
  border-radius: 8px;
  padding: 1rem;
}

.data-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.5rem;
}

.data-item {
  padding: 0.5rem;
  background-color: #2a2a2a;
  border-radius: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.label {
  color: #888;
  font-size: 0.9rem;
}

.value {
  color: white;
  font-family: monospace;
  font-size: 1.1rem;
}

.error-message {
  margin-top: 1rem;
  padding: 1rem;
  background-color: #ff444433;
  color: #ff4444;
  border-radius: 6px;
  text-align: center;
}
</style> 