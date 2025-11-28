<template>
  <div class="monitor-container">
    <!-- Connection Status -->
    <div v-if="!connected" class="status-overlay">
      <div class="status-content">
        <h3>{{ reconnecting ? 'Reconnecting to Backend...' : 'Connecting to Backend...' }}</h3>
        <p>WebSocket: ws://localhost:8765</p>
        <p v-if="error" class="error-message">{{ error }}</p>
      </div>
    </div>

    <!-- Main Monitor Interface -->
    <div v-else class="monitor-interface">
      <!-- Header -->
      <div class="monitor-header">
        <h2>Serial Monitor (WebSocket)</h2>
        <div class="status-indicators">
          <div class="indicator" :class="{ active: connected }">
            <span class="dot"></span>
            <span>Backend</span>
          </div>
          <div class="indicator" :class="{ active: hardwareState.serialHandle }">
            <span class="dot"></span>
            <span>Serial Port</span>
          </div>
          <div class="indicator" :class="{ active: hardwareState.logHandle }">
            <span class="dot"></span>
            <span>Logging</span>
          </div>
        </div>
      </div>

      <!-- Controls -->
      <div class="controls-panel">
        <div class="control-group">
          <label>Port:</label>
          <input v-model="serialConfig.port" type="text" :disabled="hardwareState.serialHandle" />
        </div>
        <div class="control-group">
          <label>Baud Rate:</label>
          <select v-model.number="serialConfig.baudRate" :disabled="hardwareState.serialHandle">
            <option :value="9600">9600</option>
            <option :value="115200">115200</option>
            <option :value="230400">230400</option>
          </select>
        </div>
        <div class="control-group">
          <button
            v-if="!hardwareState.serialHandle"
            @click="openSerial"
            class="btn btn-primary"
          >
            Open Serial Port
          </button>
          <button
            v-else
            @click="closeSerial"
            class="btn btn-danger"
          >
            Close Serial Port
          </button>
        </div>
        <div class="control-group">
          <button
            v-if="!hardwareState.logHandle"
            @click="startLog"
            class="btn btn-secondary"
            :disabled="!hardwareState.serialHandle"
          >
            Start Logging
          </button>
          <button
            v-else
            @click="stopLog"
            class="btn btn-secondary"
          >
            Stop Logging
          </button>
        </div>
        <div class="control-group">
          <button
            v-if="!isPaused"
            @click="pauseData"
            class="btn btn-secondary"
          >
            Pause
          </button>
          <button
            v-else
            @click="resumeData"
            class="btn btn-warning"
          >
            Resume
          </button>
        </div>
        <div class="control-group">
          <button @click="clearData" class="btn btn-secondary">
            Clear Display
          </button>
        </div>
      </div>

      <!-- Data Display -->
      <div class="data-display">
        <div class="data-header">
          <h3>Serial Data Stream (Raw)</h3>
          <div class="header-info">
            <span class="data-count">{{ dataHistory.length }} lines</span>
            <span v-if="isPaused" class="pause-indicator">
              ⏸ PAUSED ({{ pausedCount }} skipped)
            </span>
          </div>
        </div>
        <div class="data-content raw-content" ref="dataContent">
          <div v-if="dataHistory.length === 0" class="no-data">
            Waiting for serial data...
          </div>
          <div v-else class="raw-data-list">
            <div
              v-for="(data, index) in displayData"
              :key="index"
              class="raw-data-line"
            >
              <span class="line-number">{{ dataHistory.length - index }}</span>
              <span class="line-timestamp">{{ formatTimestamp(data.timestamp) }}</span>
              <span class="line-content">{{ data.raw || data }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Statistics -->
      <div class="statistics-panel">
        <h3>Statistics</h3>
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-label">Sample Rate:</span>
            <span class="stat-value">{{ sampleRate.toFixed(1) }} Hz</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total Samples:</span>
            <span class="stat-value">{{ dataHistory.length }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Water Deliveries:</span>
            <span class="stat-value">{{ hardwareState.waterDeliveryCount }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Session Time:</span>
            <span class="stat-value">{{ sessionTime }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useBackend } from '../../composables/useBackend.js'

defineOptions({
  name: 'WebSocketSerialMonitor'
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
  closeSerial: backendCloseSerial,
  startLogging,
  stopLogging,
  clearError
} = useBackend()

// Serial configuration
const serialConfig = ref({
  port: 'COM3',
  baudRate: 115200
})

// Data management
const dataHistory = ref([])
const maxDisplayRows = 100
const dataContent = ref(null)
const autoScroll = ref(true)
const isPaused = ref(false)
const pausedCount = ref(0)  // Track how many samples received while paused

// Session tracking
const sessionStartTime = ref(null)
const sessionTime = ref('00:00:00')
const sampleRate = ref(0)
const lastSampleTime = ref(null)
const sampleCount = ref(0)

// Computed
const displayData = computed(() => {
  return dataHistory.value.slice(-maxDisplayRows).reverse()
})

// Methods
async function openSerial() {
  try {
    await initSerial({
      port: serialConfig.value.port,
      baudRate: serialConfig.value.baudRate,
      autoStart: true
    })
    sessionStartTime.value = Date.now()
    startSessionTimer()
  } catch (err) {
    console.error('Failed to open serial port:', err)
  }
}

async function closeSerial() {
  try {
    await backendCloseSerial()
    stopSessionTimer()
  } catch (err) {
    console.error('Failed to close serial port:', err)
  }
}

async function startLog() {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)
    const filename = `serial_monitor_${timestamp}.tsv`

    await startLogging({
      filename,
      format: 'tsv',
      includeHeaders: true
    })
  } catch (err) {
    console.error('Failed to start logging:', err)
  }
}

async function stopLog() {
  try {
    await stopLogging()
  } catch (err) {
    console.error('Failed to stop logging:', err)
  }
}

function clearData() {
  dataHistory.value = []
  sampleCount.value = 0
  sampleRate.value = 0
  pausedCount.value = 0
}

function pauseData() {
  isPaused.value = true
  pausedCount.value = 0
  console.log('[SerialMonitor] Data display paused')
}

function resumeData() {
  isPaused.value = false
  if (pausedCount.value > 0) {
    console.log(`[SerialMonitor] Resumed - ${pausedCount.value} samples skipped while paused`)
  }
  pausedCount.value = 0
}

function formatTimestamp(ts) {
  const date = new Date(ts)
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
}

// Session timer
let sessionInterval = null

function startSessionTimer() {
  sessionInterval = setInterval(() => {
    if (sessionStartTime.value) {
      const elapsed = Date.now() - sessionStartTime.value
      const hours = Math.floor(elapsed / 3600000)
      const minutes = Math.floor((elapsed % 3600000) / 60000)
      const seconds = Math.floor((elapsed % 60000) / 1000)
      sessionTime.value = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    }
  }, 1000)
}

function stopSessionTimer() {
  if (sessionInterval) {
    clearInterval(sessionInterval)
    sessionInterval = null
  }
}

// Calculate sample rate
function updateSampleRate() {
  const now = Date.now()
  if (lastSampleTime.value) {
    const deltaTime = (now - lastSampleTime.value) / 1000
    if (deltaTime > 0) {
      const instantRate = 1 / deltaTime
      // Exponential moving average
      sampleRate.value = sampleRate.value * 0.9 + instantRate * 0.1
    }
  }
  lastSampleTime.value = now
  sampleCount.value++
}

// Watch for serial data
watch(serialData, (newData) => {
  if (newData) {
    // If paused, increment counter but don't display
    if (isPaused.value) {
      pausedCount.value++
      return
    }

    dataHistory.value.push({
      ...newData,
      timestamp: newData.timestamp || Date.now()
    })

    // Limit history size
    if (dataHistory.value.length > 1000) {
      dataHistory.value = dataHistory.value.slice(-1000)
    }

    updateSampleRate()

    // Auto-scroll to bottom
    if (autoScroll.value) {
      nextTick(() => {
        if (dataContent.value) {
          dataContent.value.scrollTop = dataContent.value.scrollHeight
        }
      })
    }
  }
})

// Initialize
onMounted(async () => {
  await connect()
})

// Cleanup
onUnmounted(() => {
  stopSessionTimer()
})
</script>

<style scoped>
.monitor-container {
  width: 100vw;
  height: 100vh;
  background: #1e1e1e;
  color: #d4d4d4;
  font-family: 'Consolas', 'Monaco', monospace;
  overflow: hidden;
}

/* Status Overlay */
.status-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.status-content {
  background: rgba(30, 30, 30, 0.95);
  padding: 40px;
  border-radius: 12px;
  text-align: center;
  border: 2px solid #4ec9b0;
}

.status-content h3 {
  margin: 0 0 15px 0;
  color: #4ec9b0;
}

.status-content p {
  margin: 5px 0;
  color: #858585;
}

.error-message {
  color: #f48771 !important;
  margin-top: 15px;
  font-weight: bold;
}

/* Monitor Interface */
.monitor-interface {
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 20px;
  gap: 15px;
}

/* Header */
.monitor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 15px;
  border-bottom: 2px solid #3c3c3c;
}

.monitor-header h2 {
  margin: 0;
  color: #4ec9b0;
  font-size: 24px;
}

.status-indicators {
  display: flex;
  gap: 20px;
}

.indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #858585;
}

.indicator.active {
  color: #4ec9b0;
}

.indicator .dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #858585;
}

.indicator.active .dot {
  background: #4ec9b0;
  box-shadow: 0 0 8px #4ec9b0;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Controls Panel */
.controls-panel {
  display: flex;
  gap: 15px;
  padding: 15px;
  background: #2a2a2a;
  border-radius: 8px;
  flex-wrap: wrap;
}

.control-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.control-group label {
  color: #858585;
  font-size: 14px;
}

.control-group input,
.control-group select {
  background: #1e1e1e;
  border: 1px solid #3c3c3c;
  color: #d4d4d4;
  padding: 6px 12px;
  border-radius: 4px;
  font-family: 'Consolas', monospace;
}

.control-group input:disabled,
.control-group select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-weight: bold;
  transition: all 0.2s;
  font-family: 'Consolas', monospace;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #4ec9b0;
  color: #1e1e1e;
}

.btn-primary:hover:not(:disabled) {
  background: #5fd9c0;
}

.btn-danger {
  background: #f48771;
  color: #1e1e1e;
}

.btn-danger:hover:not(:disabled) {
  background: #ff9781;
}

.btn-warning {
  background: #dcdcaa;
  color: #1e1e1e;
}

.btn-warning:hover:not(:disabled) {
  background: #ececba;
}

.btn-secondary {
  background: #3c3c3c;
  color: #d4d4d4;
}

.btn-secondary:hover:not(:disabled) {
  background: #4c4c4c;
}

/* Data Display */
.data-display {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #2a2a2a;
  border-radius: 8px;
  overflow: hidden;
}

.data-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 15px;
  background: #1e1e1e;
  border-bottom: 2px solid #3c3c3c;
}

.data-header h3 {
  margin: 0;
  color: #4ec9b0;
  font-size: 18px;
}

.header-info {
  display: flex;
  align-items: center;
  gap: 15px;
}

.data-count {
  color: #858585;
  font-size: 14px;
}

.pause-indicator {
  color: #dcdcaa;
  font-size: 14px;
  font-weight: bold;
  padding: 4px 12px;
  background: rgba(220, 220, 170, 0.1);
  border-radius: 4px;
  border: 1px solid #dcdcaa;
}

.data-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
}

.raw-content {
  padding: 10px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.no-data {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #858585;
  font-size: 16px;
}

.raw-data-list {
  display: flex;
  flex-direction: column;
}

.raw-data-line {
  display: flex;
  gap: 15px;
  padding: 4px 5px;
  border-bottom: 1px solid #3c3c3c;
  font-size: 13px;
  line-height: 1.6;
}

.raw-data-line:hover {
  background: #1e1e1e;
}

.line-number {
  color: #858585;
  min-width: 50px;
  text-align: right;
  flex-shrink: 0;
}

.line-timestamp {
  color: #569cd6;
  min-width: 120px;
  flex-shrink: 0;
}

.line-content {
  color: #d4d4d4;
  flex: 1;
  word-break: break-all;
}

/* Statistics Panel */
.statistics-panel {
  padding: 15px;
  background: #2a2a2a;
  border-radius: 8px;
}

.statistics-panel h3 {
  margin: 0 0 15px 0;
  color: #4ec9b0;
  font-size: 18px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 15px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.stat-label {
  color: #858585;
  font-size: 12px;
}

.stat-value {
  color: #d4d4d4;
  font-size: 18px;
  font-weight: bold;
}

/* Scrollbar */
.data-content::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.data-content::-webkit-scrollbar-track {
  background: #1e1e1e;
}

.data-content::-webkit-scrollbar-thumb {
  background: #4c4c4c;
  border-radius: 5px;
}

.data-content::-webkit-scrollbar-thumb:hover {
  background: #5c5c5c;
}
</style>
