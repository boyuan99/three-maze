<template>
  <div class="demo-container">
    <div class="demo-content">
      <h1>WebSocket Backend Demo</h1>

      <!-- Connection Status -->
      <div class="status-card" :class="{ connected: connected, reconnecting: reconnecting }">
        <h2>Connection Status</h2>
        <div class="status-indicator">
          <span class="status-dot" :class="{ active: connected }"></span>
          <span class="status-text">
            {{ connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected' }}
          </span>
        </div>
        <div class="status-details">
          <p><strong>WebSocket:</strong> ws://localhost:8766</p>
        </div>
        <div v-if="!connected" class="button-group">
          <button @click="connect" :disabled="reconnecting">
            {{ reconnecting ? 'Reconnecting...' : 'Connect' }}
          </button>
        </div>
      </div>

      <!-- Error Display -->
      <div v-if="error" class="error-card">
        <h3>Error</h3>
        <p>{{ error }}</p>
        <button @click="clearError">Clear</button>
      </div>

      <!-- Serial Port Controls -->
      <div class="card" v-if="connected">
        <h2>Serial Port</h2>
        <div class="status-indicator">
          <span class="status-dot" :class="{ active: hardwareState.serialHandle }"></span>
          <span class="status-text">
            {{ hardwareState.serialHandle ? 'Open' : 'Closed' }}
          </span>
        </div>

        <div class="button-group">
          <button
            @click="handleInitSerial"
            :disabled="hardwareState.serialHandle !== null"
          >
            Initialize Serial
          </button>
          <button
            @click="handleCloseSerial"
            :disabled="!hardwareState.serialHandle"
          >
            Close Serial
          </button>
        </div>
      </div>

      <!-- Serial Data Display -->
      <div class="card" v-if="connected && serialData">
        <h2>Serial Data Stream</h2>
        <div class="data-grid">
          <div class="data-item">
            <span class="data-label">X Position</span>
            <span class="data-value">{{ serialData.x?.toFixed(3) || '-' }}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Y Position</span>
            <span class="data-value">{{ serialData.y?.toFixed(3) || '-' }}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Theta</span>
            <span class="data-value">{{ serialData.theta?.toFixed(3) || '-' }}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Direction</span>
            <span class="data-value">{{ serialData.direction?.toFixed(1) || '-' }}°</span>
          </div>
          <div class="data-item">
            <span class="data-label">Frame Count</span>
            <span class="data-value">{{ serialData.frameCount || '-' }}</span>
          </div>
          <div class="data-item">
            <span class="data-label">Water</span>
            <span class="data-value">{{ serialData.water || 0 }}</span>
          </div>
        </div>
      </div>

      <!-- Water Delivery -->
      <div class="card" v-if="connected">
        <h2>Water Delivery</h2>
        <div class="status-indicator">
          <span class="data-label">Total Deliveries:</span>
          <span class="data-value">{{ hardwareState.waterDeliveryCount }}</span>
        </div>
        <div class="button-group">
          <button @click="handleDeliverWater">
            Deliver Water (25ms)
          </button>
        </div>
      </div>

      <!-- Data Logging -->
      <div class="card" v-if="connected">
        <h2>Data Logging</h2>
        <div class="status-indicator">
          <span class="status-dot" :class="{ active: hardwareState.logHandle }"></span>
          <span class="status-text">
            {{ hardwareState.logHandle ? 'Logging Active' : 'Not Logging' }}
          </span>
        </div>
        <div class="button-group">
          <button
            @click="handleStartLogging"
            :disabled="hardwareState.logHandle !== null"
          >
            Start Logging
          </button>
          <button
            @click="handleStopLogging"
            :disabled="!hardwareState.logHandle"
          >
            Stop Logging
          </button>
        </div>
      </div>

      <!-- System Status -->
      <div class="card" v-if="connected">
        <h2>System Status</h2>
        <div class="button-group">
          <button @click="handleGetStatus">
            Refresh Status
          </button>
        </div>
        <pre v-if="systemStatus" class="status-pre">{{ systemStatus }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useBackend } from '../../composables/useBackend.js'

defineOptions({
  name: 'WebSocketDemo'
})

// Backend integration
const {
  backend,
  connected,
  reconnecting,
  error,
  serialData,
  hardwareState,
  connect,
  initSerial,
  closeSerial,
  deliverWater,
  startLogging,
  stopLogging,
  getStatus,
  clearError
} = useBackend()

// System status
const systemStatus = ref(null)

/**
 * Initialize serial port
 */
async function handleInitSerial() {
  try {
    await initSerial({
      port: 'COM5',
      baudRate: 115200,
      autoStart: true
    })
  } catch (err) {
    console.error('Failed to initialize serial:', err)
  }
}

/**
 * Close serial port
 */
async function handleCloseSerial() {
  try {
    await closeSerial()
  } catch (err) {
    console.error('Failed to close serial:', err)
  }
}

/**
 * Deliver water reward
 */
async function handleDeliverWater() {
  try {
    await deliverWater({
      amount: 1,
      duration: 25,
      channel: 'Dev1/ao0'
    })
  } catch (err) {
    console.error('Failed to deliver water:', err)
  }
}

/**
 * Start data logging
 */
async function handleStartLogging() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const filename = `websocket_demo_${timestamp}.tsv`

    await startLogging({
      filename,
      format: 'tsv',
      includeHeaders: true
    })
  } catch (err) {
    console.error('Failed to start logging:', err)
  }
}

/**
 * Stop data logging
 */
async function handleStopLogging() {
  try {
    await stopLogging()
  } catch (err) {
    console.error('Failed to stop logging:', err)
  }
}

/**
 * Get system status
 */
async function handleGetStatus() {
  try {
    const status = await getStatus(true, true)
    systemStatus.value = JSON.stringify(status, null, 2)
  } catch (err) {
    console.error('Failed to get status:', err)
  }
}
</script>

<style scoped>
.demo-container {
  width: 100vw;
  min-height: 100vh;
  background: linear-gradient(135deg, #1e1e1e 0%, #2d2d30 100%);
  padding: 40px 20px;
  overflow-y: auto;
}

.demo-content {
  max-width: 1200px;
  margin: 0 auto;
}

h1 {
  color: #4ec9b0;
  text-align: center;
  margin-bottom: 40px;
  font-size: 2.5em;
  text-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.card,
.status-card,
.error-card {
  background: rgba(30, 30, 30, 0.8);
  border-radius: 12px;
  padding: 25px;
  margin-bottom: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(78, 201, 176, 0.2);
}

.status-card {
  border-color: rgba(78, 201, 176, 0.4);
}

.status-card.connected {
  border-color: #4ec9b0;
  background: rgba(30, 30, 30, 0.95);
}

.status-card.reconnecting {
  border-color: #dcdcaa;
}

.error-card {
  background: rgba(244, 135, 113, 0.2);
  border-color: #f48771;
}

h2,
h3 {
  color: #569cd6;
  margin: 0 0 20px 0;
  font-size: 1.5em;
}

.error-card h3 {
  color: #f48771;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 15px;
}

.status-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #666;
  transition: all 0.3s;
}

.status-dot.active {
  background: #4ec9b0;
  box-shadow: 0 0 12px #4ec9b0;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.status-text {
  color: #d4d4d4;
  font-size: 1.1em;
  font-weight: 500;
}

.status-details {
  color: #858585;
  font-size: 0.9em;
  margin-bottom: 15px;
}

.status-details p {
  margin: 5px 0;
}

.button-group {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

button {
  background: #0e639c;
  color: white;
  border: none;
  padding: 12px 24px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

button:hover:not(:disabled) {
  background: #1177bb;
  transform: translateY(-2px);
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
}

button:active:not(:disabled) {
  transform: translateY(0);
}

button:disabled {
  background: #3c3c3c;
  color: #858585;
  cursor: not-allowed;
  transform: none;
}

.data-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 15px;
}

.data-item {
  background: rgba(0, 0, 0, 0.3);
  padding: 15px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.data-label {
  color: #858585;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.data-value {
  color: #4ec9b0;
  font-size: 24px;
  font-weight: bold;
  font-family: 'Courier New', monospace;
}

.status-pre {
  background: rgba(0, 0, 0, 0.4);
  padding: 15px;
  border-radius: 8px;
  color: #d4d4d4;
  font-size: 12px;
  overflow-x: auto;
  margin-top: 15px;
}

.error-card p {
  color: #f48771;
  margin: 10px 0;
}

.error-card button {
  background: #f48771;
  margin-top: 10px;
}

.error-card button:hover {
  background: #ff6b6b;
}
</style>
