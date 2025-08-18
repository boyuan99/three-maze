<template>
  <div class="hardware-test-panel">
    <div class="test-header">
      <h3>🔧 Hardware Test Panel</h3>
      <div class="status-indicator" :class="statusClass">
        <div class="status-dot"></div>
        <span>{{ statusText }}</span>
      </div>
    </div>

    <div class="test-controls">
      <div class="config-section">
        <h4>Test Configuration</h4>
        <div class="config-grid">
          <div class="config-item">
            <label>Serial Port:</label>
            <select v-model="testConfig.port" :disabled="testActive">
              <option value="COM3">COM3</option>
              <option value="COM4">COM4</option>
              <option value="COM5">COM5</option>
              <option value="/dev/ttyUSB0">/dev/ttyUSB0</option>
              <option value="/dev/ttyACM0">/dev/ttyACM0</option>
            </select>
          </div>
          
          <div class="config-item">
            <label>Baud Rate:</label>
            <select v-model="testConfig.baudRate" :disabled="testActive">
              <option value="9600">9600</option>
              <option value="115200">115200</option>
              <option value="230400">230400</option>
            </select>
          </div>
          
          <div class="config-item">
            <label>Test Duration:</label>
            <select v-model="testConfig.duration" :disabled="testActive">
              <option value="30000">30 seconds</option>
              <option value="60000">1 minute</option>
              <option value="120000">2 minutes</option>
              <option value="300000">5 minutes</option>
            </select>
          </div>
        </div>
      </div>

      <div class="action-buttons">
        <button 
          @click="loadTestExperiment" 
          :disabled="experimentLoaded || loading"
          class="btn load-btn"
        >
          {{ loading ? 'Loading...' : 'Load Test Experiment' }}
        </button>
        
        <button 
          @click="startTest" 
          :disabled="!experimentLoaded || testActive || loading"
          class="btn start-btn"
        >
          ▶️ Start Hardware Test
        </button>
        
        <button 
          @click="stopTest" 
          :disabled="!testActive || loading"
          class="btn stop-btn"
        >
          ⏹️ Stop Test
        </button>
        
        <button 
          @click="resetTest" 
          :disabled="!experimentLoaded || loading"
          class="btn reset-btn"
        >
          🔄 Reset
        </button>
      </div>
    </div>

    <div v-if="experimentLoaded" class="test-metrics">
      <h4>📊 Performance Metrics</h4>
      <div class="metrics-grid">
        <div class="metric-card">
          <div class="metric-value">{{ testStatus.dataPoints }}</div>
          <div class="metric-label">Data Points</div>
        </div>
        
        <div class="metric-card">
          <div class="metric-value">{{ testStatus.dataRate?.toFixed(1) || '0.0' }}</div>
          <div class="metric-label">Data Rate (pts/sec)</div>
        </div>
        
        <div class="metric-card">
          <div class="metric-value">{{ testStatus.dataGaps }}</div>
          <div class="metric-label">Data Gaps</div>
        </div>
        
        <div class="metric-card">
          <div class="metric-value">{{ testStatus.memoryUsage }}MB</div>
          <div class="metric-label">Memory Usage</div>
        </div>
        
        <div class="metric-card">
          <div class="metric-value">{{ formatDuration(testStatus.duration) }}</div>
          <div class="metric-label">Test Duration</div>
        </div>
        
        <div class="metric-card">
          <div class="metric-value">{{ testStatus.errors }}</div>
          <div class="metric-label">Errors</div>
        </div>
      </div>
    </div>

    <div v-if="testReport" class="test-report">
      <h4>📋 Test Report</h4>
      <div class="report-content">
        <div class="report-result" :class="getResultClass(testReport.testResult)">
          {{ testReport.testResult }}
        </div>
        
        <div class="report-details">
          <div><strong>Data Receival Rate:</strong> {{ testReport.dataPoints.receivalRate }}</div>
          <div><strong>Expected Points:</strong> {{ testReport.dataPoints.expected }}</div>
          <div><strong>Actual Points:</strong> {{ testReport.dataPoints.received }}</div>
          <div><strong>Stop Reason:</strong> {{ testReport.stopReason }}</div>
        </div>
        
        <div v-if="testReport.recommendations?.length" class="recommendations">
          <strong>Recommendations:</strong>
          <ul>
            <li v-for="rec in testReport.recommendations" :key="rec">{{ rec }}</li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="error" class="error-display">
      <h4>❌ Error</h4>
      <p>{{ error }}</p>
      <button @click="error = null" class="btn">Clear Error</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'

// Reactive state
const experimentLoaded = ref(false)
const testActive = ref(false)
const loading = ref(false)
const error = ref(null)
const testStatus = ref({
  dataPoints: 0,
  dataRate: 0,
  dataGaps: 0,
  memoryUsage: 0,
  duration: 0,
  errors: 0
})
const testReport = ref(null)
const statusTimer = ref(null)

// Test configuration
const testConfig = ref({
  port: 'COM3',
  baudRate: 115200,
  duration: 60000
})

// Computed properties
const statusClass = computed(() => {
  if (testActive.value) return 'status-running'
  if (experimentLoaded.value) return 'status-ready'
  return 'status-idle'
})

const statusText = computed(() => {
  if (testActive.value) return 'Test Running'
  if (experimentLoaded.value) return 'Ready to Test'
  return 'Not Loaded'
})

// Methods
async function loadTestExperiment() {
  loading.value = true
  error.value = null
  
  try {
    console.log('Loading hardware test experiment...')
    
    const result = await window.electron.loadExperiment(
      './experiments/realHardwareTestExperiment.js'
    )
    
    if (result.success) {
      experimentLoaded.value = true
      console.log('Hardware test experiment loaded successfully')
      
      // Start status monitoring
      startStatusMonitoring()
    } else {
      throw new Error(result.error || 'Failed to load experiment')
    }
    
  } catch (err) {
    console.error('Error loading hardware test experiment:', err)
    error.value = err.message || 'Failed to load experiment'
  } finally {
    loading.value = false
  }
}

async function startTest() {
  if (!experimentLoaded.value) return
  
  loading.value = true
  error.value = null
  testReport.value = null
  
  try {
    console.log('Starting hardware test with config:', testConfig.value)
    
    const result = await window.electron.invoke('real-hardware-start-test', testConfig.value)
    
    if (result.success) {
      testActive.value = true
      console.log('Hardware test started successfully')
    } else {
      throw new Error(result.error || 'Failed to start test')
    }
    
  } catch (err) {
    console.error('Error starting hardware test:', err)
    error.value = err.message || 'Failed to start test'
  } finally {
    loading.value = false
  }
}

async function stopTest() {
  if (!testActive.value) return
  
  loading.value = true
  
  try {
    console.log('Stopping hardware test...')
    
    const result = await window.electron.invoke('real-hardware-stop-test')
    
    if (result.success) {
      testActive.value = false
      testReport.value = result.report
      console.log('Hardware test stopped successfully')
      console.log('Test report:', result.report)
    } else {
      throw new Error(result.error || 'Failed to stop test')
    }
    
  } catch (err) {
    console.error('Error stopping hardware test:', err)
    error.value = err.message || 'Failed to stop test'
  } finally {
    loading.value = false
  }
}

async function resetTest() {
  if (!experimentLoaded.value) return
  
  loading.value = true
  error.value = null
  testReport.value = null
  
  try {
    console.log('Resetting hardware test...')
    
    const result = await window.electron.invoke('real-hardware-reset-test')
    
    if (result.success) {
      testActive.value = false
      testStatus.value = {
        dataPoints: 0,
        dataRate: 0,
        dataGaps: 0,
        memoryUsage: 0,
        duration: 0,
        errors: 0
      }
      console.log('Hardware test reset successfully')
    } else {
      throw new Error(result.error || 'Failed to reset test')
    }
    
  } catch (err) {
    console.error('Error resetting hardware test:', err)
    error.value = err.message || 'Failed to reset test'
  } finally {
    loading.value = false
  }
}

function startStatusMonitoring() {
  if (statusTimer.value) return
  
  statusTimer.value = setInterval(async () => {
    if (!experimentLoaded.value) return
    
    try {
      const status = await window.electron.invoke('real-hardware-get-status')
      testStatus.value = status
      testActive.value = status.active
      
    } catch (err) {
      console.warn('Failed to get test status:', err)
    }
  }, 1000) // Update every second
}

function stopStatusMonitoring() {
  if (statusTimer.value) {
    clearInterval(statusTimer.value)
    statusTimer.value = null
  }
}

function formatDuration(ms) {
  if (!ms) return '0s'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`
  }
  return `${remainingSeconds}s`
}

function getResultClass(result) {
  if (result.includes('EXCELLENT')) return 'result-excellent'
  if (result.includes('GOOD')) return 'result-good'
  if (result.includes('FAIR')) return 'result-fair'
  return 'result-poor'
}

// Lifecycle
onMounted(() => {
  console.log('Hardware Test Panel mounted')
})

onUnmounted(() => {
  stopStatusMonitoring()
})
</script>

<style scoped>
.hardware-test-panel {
  background: #2a2a2a;
  border-radius: 12px;
  padding: 1.5rem;
  margin: 1rem;
  color: white;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.test-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #444;
}

.test-header h3 {
  margin: 0;
  color: #4CAF50;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 20px;
  font-size: 0.9rem;
  font-weight: bold;
}

.status-idle {
  background: rgba(108, 117, 125, 0.2);
  color: #6c757d;
}

.status-ready {
  background: rgba(76, 175, 80, 0.2);
  color: #4CAF50;
}

.status-running {
  background: rgba(33, 150, 243, 0.2);
  color: #2196F3;
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.config-section {
  background: #333;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.config-section h4 {
  margin: 0 0 1rem 0;
  color: #ccc;
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1rem;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.config-item label {
  font-size: 0.9rem;
  color: #ccc;
  font-weight: bold;
}

.config-item select {
  background: #444;
  color: white;
  border: 1px solid #555;
  border-radius: 4px;
  padding: 0.5rem;
  font-size: 0.9rem;
}

.config-item select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.action-buttons {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  justify-content: center;
  margin: 1rem 0;
}

.btn {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s ease;
  min-width: 140px;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.load-btn {
  background: linear-gradient(135deg, #4CAF50, #45a049);
  color: white;
}

.load-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #45a049, #3d8b40);
}

.start-btn {
  background: linear-gradient(135deg, #2196F3, #1976D2);
  color: white;
}

.start-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #1976D2, #1565C0);
}

.stop-btn {
  background: linear-gradient(135deg, #ff6b6b, #ff5252);
  color: white;
}

.stop-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #ff5252, #f44336);
}

.reset-btn {
  background: linear-gradient(135deg, #FF9800, #F57C00);
  color: white;
}

.reset-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #F57C00, #E65100);
}

.test-metrics {
  background: #333;
  border-radius: 8px;
  padding: 1rem;
  margin: 1rem 0;
}

.test-metrics h4 {
  margin: 0 0 1rem 0;
  color: #ccc;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1rem;
}

.metric-card {
  background: #444;
  border-radius: 6px;
  padding: 1rem;
  text-align: center;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: bold;
  color: #4CAF50;
  margin-bottom: 0.5rem;
}

.metric-label {
  font-size: 0.8rem;
  color: #ccc;
}

.test-report {
  background: #333;
  border-radius: 8px;
  padding: 1rem;
  margin: 1rem 0;
}

.test-report h4 {
  margin: 0 0 1rem 0;
  color: #ccc;
}

.report-result {
  font-size: 1.1rem;
  font-weight: bold;
  padding: 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  text-align: center;
}

.result-excellent {
  background: rgba(76, 175, 80, 0.2);
  color: #4CAF50;
  border: 1px solid #4CAF50;
}

.result-good {
  background: rgba(33, 150, 243, 0.2);
  color: #2196F3;
  border: 1px solid #2196F3;
}

.result-fair {
  background: rgba(255, 152, 0, 0.2);
  color: #FF9800;
  border: 1px solid #FF9800;
}

.result-poor {
  background: rgba(244, 67, 54, 0.2);
  color: #f44336;
  border: 1px solid #f44336;
}

.report-details {
  background: #444;
  border-radius: 6px;
  padding: 1rem;
  margin-bottom: 1rem;
}

.report-details > div {
  margin-bottom: 0.5rem;
  color: #ccc;
}

.recommendations {
  background: #444;
  border-radius: 6px;
  padding: 1rem;
}

.recommendations ul {
  margin: 0.5rem 0 0 0;
  padding-left: 1.5rem;
  color: #ccc;
}

.recommendations li {
  margin-bottom: 0.5rem;
}

.error-display {
  background: rgba(244, 67, 54, 0.1);
  border: 1px solid #f44336;
  border-radius: 8px;
  padding: 1rem;
  margin: 1rem 0;
}

.error-display h4 {
  margin: 0 0 0.5rem 0;
  color: #f44336;
}

.error-display p {
  margin: 0 0 1rem 0;
  color: #ffcdd2;
}
</style>