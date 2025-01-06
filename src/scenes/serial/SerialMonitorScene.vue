<template>
  <div class="scene-container">
    <div class="monitor-wrapper">
      <div class="monitor-container">

        <div class="data-display">
          <div class="data-grid">
            <div class="data-item">
              <span class="label">Position X:</span>
              <span class="value">{{ formatNumber(latestData.position?.x) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Position Y:</span>
              <span class="value">{{ formatNumber(latestData.position?.y) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Theta:</span>
              <span class="value">{{ formatNumber(latestData.position?.theta) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Water:</span>
              <span class="value">{{ latestData.water ? 'Yes' : 'No' }}</span>
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

// Initialize position state
const posX = ref(0)
const posY = ref(0)
const theta = ref(0)

const latestData = ref({
  position: {
    x: posX.value,
    y: posY.value,
    theta: theta.value
  },
  water: false,
  timestamp: '',
  currentWorld: 1
})

const formatNumber = (num) => {
  return typeof num === 'number' ? num.toFixed(2) : '0.00'
}

const stopMonitoring = async () => {
  try {
    if (window.electron) {
      await window.electron.stopPythonSerial()
      isMonitoring.value = false
    }
  } catch (err) {
    error.value = `Failed to stop monitoring: ${err.message}`
  }
}

const serialData = ref(null)

onMounted(() => {
  console.log('SerialMonitorScene: Component mounted')
  
  if (window.electron) {
    console.log('SerialMonitorScene: electron object exists')
    
    window.electron.onPythonSerialData((data) => {
      console.log('SerialMonitorScene: Received serial data:', data)
      // Store the serial data
      serialData.value = data
      
      // Extract displacement data
      const dx = parseFloat(data.x) || 0  // Displacement in x (dxTriangle from Teensy)
      const dy = parseFloat(data.y) || 0  // Displacement in y (dyTriangle from Teensy)
      const dtheta = parseFloat(data.theta) || 0  // Change in theta (dTheta from Teensy)
      
      // Update the position
      posX.value += dx
      posY.value += dy
      theta.value += dtheta
      
      // Keep theta within -π to π
      if (theta.value > Math.PI) {
        theta.value -= 2 * Math.PI
      } else if (theta.value < -Math.PI) {
        theta.value += 2 * Math.PI
      }
      
      // Update latestData for UI
      latestData.value.position.x = posX.value
      latestData.value.position.y = posY.value
      latestData.value.position.theta = theta.value
      latestData.value.water = data.water
      latestData.value.timestamp = data.timestamp
      latestData.value.currentWorld = data.currentWorld || 1
      
      // Send computed position back to Python
      const positionUpdate = {
        command: 'position_update',
        data: {
          x: posX.value,
          y: posY.value,
          theta: theta.value
        }
      }
      window.electron.sendToPython(JSON.stringify(positionUpdate))
    })
  } else {
    console.log('SerialMonitorScene: electron object not found')
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