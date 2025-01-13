<template>
  <div class="scene-container">
    <div class="monitor-wrapper">
      <div class="monitor-container">
        <div class="data-display">
          <div class="data-grid">
            <div class="data-item">
              <span class="label">Position X:</span>
              <span class="value">{{ formatNumber(position.x) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Position Y:</span>
              <span class="value">{{ formatNumber(position.y) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Theta:</span>
              <span class="value">{{ formatNumber(position.theta) }}</span>
            </div>
            <div class="data-item">
              <span class="label">Water:</span>
              <span class="value">{{ water ? 'Yes' : 'No' }}</span>
            </div>
            <div class="data-item">
              <span class="label">World:</span>
              <span class="value">{{ currentWorld }}</span>
            </div>
            <div class="data-item">
              <span class="label">Timestamp:</span>
              <span class="value">{{ timestamp }}</span>
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

const position = ref({ x: 0, y: 0, theta: 0 })
const water = ref(false)
const currentWorld = ref(1)
const timestamp = ref('')
const error = ref(null)

const formatNumber = (num) => {
  return typeof num === 'number' ? num.toFixed(2) : '0.00'
}

const initializeSerial = async () => {
  try {
    // Reset position to 0 when starting
    position.value = { x: 0, y: 0, theta: 0 }

    if (!window.electron) {
      error.value = 'Electron API not available'
      return
    }

    // Start serial communication
    const result = await window.electron.initializeJsSerial()
    if (result.error) {
      error.value = result.error
      return
    }

    // Start receiving data
    window.electron.onSerialData((data) => {
      // Add incremental changes (displacements)
      position.value.x += parseFloat(data.x) || 0
      position.value.y += parseFloat(data.y) || 0
      position.value.theta += parseFloat(data.theta) || 0
      
      // Keep theta within -π to π
      if (position.value.theta > Math.PI) {
        position.value.theta -= 2 * Math.PI
      } else if (position.value.theta < -Math.PI) {
        position.value.theta += 2 * Math.PI
      }

      water.value = Boolean(data.water)
      timestamp.value = data.timestamp
      currentWorld.value = data.currentWorld || 1

      // Check if we should reset the trial first
      if (Math.abs(position.value.y) >= 50) {
        // Reset position
        position.value.x = 0
        position.value.y = 0
        position.value.theta = 0
        console.log('Trial reset due to Y position limit')

        // Deliver water reward
        window.electron.deliverWater()
          .then(result => {
            if (result.error) {
              console.error('Water delivery failed:', result.error)
            } else {
              console.log('Water delivered successfully')
            }
          })
          .catch(error => {
            console.error('Error in water delivery:', error)
          })
      }

      // Log data to file after potential reset, with 3 decimal places
      const logData = `${position.value.x.toFixed(3)}\t${position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${currentWorld.value}\t${water.value ? 1 : 0}\t${timestamp.value}\n`
      window.electron.appendToLog(logData)
    })

  } catch (err) {
    error.value = err.message
  }
}

onMounted(async () => {
  await initializeSerial()
})

onUnmounted(async () => {
  if (window.electron) {
    try {
      await window.electron.closeJsSerial()
      console.log('Serial port closed successfully')
    } catch (err) {
      console.error('Error closing serial port:', err)
    }
  }
})
</script>

<style scoped>
/* Use the same styles as SerialMonitorScene.vue */
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