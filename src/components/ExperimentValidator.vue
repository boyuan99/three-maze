<template>
  <div class="experiment-validator">
    <div class="validator-header">
      <h4>🔍 Experiment Validation</h4>
      <div class="validation-status" :class="validationStatusClass">
        <div class="status-dot"></div>
        <span>{{ validationStatusText }}</span>
      </div>
    </div>
    
    <div v-if="validationResults" class="validation-results">
      <div class="validation-section">
        <h5>📁 File Structure</h5>
        <div class="validation-items">
          <div class="validation-item" :class="validationResults.fileExists ? 'success' : 'error'">
            <span class="icon">{{ validationResults.fileExists ? '✅' : '❌' }}</span>
            <span>File exists and readable</span>
          </div>
          <div class="validation-item" :class="validationResults.moduleLoads ? 'success' : 'error'">
            <span class="icon">{{ validationResults.moduleLoads ? '✅' : '❌' }}</span>
            <span>ES module loads successfully</span>
          </div>
          <div class="validation-item" :class="validationResults.hasDefaultExport ? 'success' : 'error'">
            <span class="icon">{{ validationResults.hasDefaultExport ? '✅' : '❌' }}</span>
            <span>Default class export found</span>
          </div>
          <div class="validation-item" :class="validationResults.hasExperimentConfig ? 'success' : 'error'">
            <span class="icon">{{ validationResults.hasExperimentConfig ? '✅' : '❌' }}</span>
            <span>Experiment configuration export found</span>
          </div>
        </div>
      </div>
      
      <div class="validation-section">
        <h5>🏗️ Class Structure</h5>
        <div class="validation-items">
          <div class="validation-item" :class="validationResults.instantiates ? 'success' : 'error'">
            <span class="icon">{{ validationResults.instantiates ? '✅' : '❌' }}</span>
            <span>Class instantiation successful</span>
          </div>
          <div class="validation-item" :class="validationResults.hasRequiredMethods ? 'success' : 'error'">
            <span class="icon">{{ validationResults.hasRequiredMethods ? '✅' : '❌' }}</span>
            <span>Required methods present</span>
            <div v-if="validationResults.missingMethods?.length" class="validation-details">
              Missing: {{ validationResults.missingMethods.join(', ') }}
            </div>
          </div>
          <div class="validation-item" :class="validationResults.hasIpcHandlers ? 'success' : 'error'">
            <span class="icon">{{ validationResults.hasIpcHandlers ? '✅' : '❌' }}</span>
            <span>IPC handlers configured</span>
            <div v-if="validationResults.ipcHandlerCount > 0" class="validation-details">
              {{ validationResults.ipcHandlerCount }} handlers found
            </div>
          </div>
        </div>
      </div>
      
      <div v-if="validationResults.experimentInfo" class="validation-section">
        <h5>📊 Experiment Details</h5>
        <div class="experiment-info">
          <div class="info-item">
            <strong>Name:</strong> {{ validationResults.experimentInfo.name }}
          </div>
          <div class="info-item">
            <strong>Version:</strong> {{ validationResults.experimentInfo.version }}
          </div>
          <div v-if="validationResults.experimentInfo.description" class="info-item">
            <strong>Description:</strong> {{ validationResults.experimentInfo.description }}
          </div>
          <div v-if="validationResults.experimentInfo.hardware?.required?.length" class="info-item">
            <strong>Required Hardware:</strong> {{ validationResults.experimentInfo.hardware.required.join(', ') }}
          </div>
          <div v-if="validationResults.experimentInfo.hardware?.optional?.length" class="info-item">
            <strong>Optional Hardware:</strong> {{ validationResults.experimentInfo.hardware.optional.join(', ') }}
          </div>
        </div>
      </div>
      
      <div v-if="validationResults.warnings?.length" class="validation-section">
        <h5>⚠️ Warnings</h5>
        <div class="validation-warnings">
          <div v-for="warning in validationResults.warnings" :key="warning" class="warning-item">
            <span class="icon">⚠️</span>
            <span>{{ warning }}</span>
          </div>
        </div>
      </div>
      
      <div v-if="validationResults.errors?.length" class="validation-section">
        <h5>❌ Errors</h5>
        <div class="validation-errors">
          <div v-for="error in validationResults.errors" :key="error" class="error-item">
            <span class="icon">❌</span>
            <span>{{ error }}</span>
          </div>
        </div>
      </div>
    </div>
    
    <div v-if="validationError" class="validation-error">
      <h5>❌ Validation Failed</h5>
      <p>{{ validationError }}</p>
    </div>
    
    <div class="validation-actions">
      <button 
        @click="validateExperiment" 
        :disabled="validating || !experimentPath"
        class="btn validate-btn"
      >
        {{ validating ? 'Validating...' : '🔍 Validate Experiment' }}
      </button>
      
      <button 
        v-if="isValid"
        @click="loadExperiment" 
        :disabled="loading"
        class="btn load-btn"
      >
        {{ loading ? 'Loading...' : '📁 Load Experiment' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

// Props
const props = defineProps({
  experimentPath: {
    type: String,
    default: ''
  }
})

// Emits
const emit = defineEmits(['experiment-validated', 'experiment-loaded'])

// Reactive state
const validating = ref(false)
const loading = ref(false)
const validationResults = ref(null)
const validationError = ref(null)

// Computed properties
const validationStatusClass = computed(() => {
  if (validating.value) return 'status-validating'
  if (validationError.value) return 'status-error'
  if (isValid.value) return 'status-valid'
  if (validationResults.value) return 'status-invalid'
  return 'status-idle'
})

const validationStatusText = computed(() => {
  if (validating.value) return 'Validating...'
  if (validationError.value) return 'Validation Error'
  if (isValid.value) return 'Valid Experiment'
  if (validationResults.value) return 'Invalid Experiment'
  return 'Not Validated'
})

const isValid = computed(() => {
  if (!validationResults.value) return false
  
  return validationResults.value.fileExists &&
         validationResults.value.moduleLoads &&
         validationResults.value.hasDefaultExport &&
         validationResults.value.instantiates &&
         validationResults.value.hasRequiredMethods &&
         validationResults.value.hasIpcHandlers
})

// Watch for path changes
watch(() => props.experimentPath, () => {
  validationResults.value = null
  validationError.value = null
})

// Methods
async function validateExperiment() {
  if (!props.experimentPath) return
  
  validating.value = true
  validationError.value = null
  
  try {
    console.log('Validating experiment:', props.experimentPath)
    
    const result = await window.electron.invoke('validate-experiment', props.experimentPath)
    
    if (result.success) {
      validationResults.value = result.validation
      emit('experiment-validated', result.validation)
    } else {
      validationError.value = result.error
    }
    
  } catch (error) {
    console.error('Error validating experiment:', error)
    validationError.value = error.message || 'Validation failed'
  } finally {
    validating.value = false
  }
}

async function loadExperiment() {
  if (!props.experimentPath || !isValid.value) return
  
  loading.value = true
  
  try {
    console.log('Loading experiment:', props.experimentPath)
    
    const result = await window.electron.invoke('load-experiment', props.experimentPath)
    
    if (result.success) {
      emit('experiment-loaded', result)
    } else {
      validationError.value = result.error
    }
    
  } catch (error) {
    console.error('Error loading experiment:', error)
    validationError.value = error.message || 'Loading failed'
  } finally {
    loading.value = false
  }
}

// Auto-validate when path is provided
watch(() => props.experimentPath, (newPath) => {
  if (newPath) {
    validateExperiment()
  }
}, { immediate: true })
</script>

<style scoped>
.experiment-validator {
  background: #2a2a2a;
  border-radius: 12px;
  padding: 1.5rem;
  margin: 1rem 0;
  color: white;
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
}

.validator-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #444;
}

.validator-header h4 {
  margin: 0;
  color: #4CAF50;
}

.validation-status {
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

.status-validating {
  background: rgba(255, 193, 7, 0.2);
  color: #ffc107;
}

.status-valid {
  background: rgba(76, 175, 80, 0.2);
  color: #4CAF50;
}

.status-invalid {
  background: rgba(255, 152, 0, 0.2);
  color: #FF9800;
}

.status-error {
  background: rgba(244, 67, 54, 0.2);
  color: #f44336;
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

.validation-results {
  margin-bottom: 1.5rem;
}

.validation-section {
  margin-bottom: 1.5rem;
}

.validation-section h5 {
  margin: 0 0 0.75rem 0;
  color: #ccc;
  font-size: 1rem;
}

.validation-items {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.validation-item {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.5rem;
  border-radius: 6px;
}

.validation-item.success {
  background: rgba(76, 175, 80, 0.1);
}

.validation-item.error {
  background: rgba(244, 67, 54, 0.1);
}

.validation-item .icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.validation-details {
  font-size: 0.85rem;
  color: #999;
  margin-top: 0.25rem;
}

.experiment-info {
  background: #333;
  border-radius: 6px;
  padding: 1rem;
}

.info-item {
  margin-bottom: 0.5rem;
  color: #ccc;
}

.info-item:last-child {
  margin-bottom: 0;
}

.validation-warnings, .validation-errors {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.warning-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  background: rgba(255, 152, 0, 0.1);
  border-radius: 6px;
  color: #FF9800;
}

.error-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem;
  background: rgba(244, 67, 54, 0.1);
  border-radius: 6px;
  color: #f44336;
}

.validation-error {
  background: rgba(244, 67, 54, 0.1);
  border: 1px solid #f44336;
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.validation-error h5 {
  margin: 0 0 0.5rem 0;
  color: #f44336;
}

.validation-error p {
  margin: 0;
  color: #ffcdd2;
}

.validation-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
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

.validate-btn {
  background: linear-gradient(135deg, #2196F3, #1976D2);
  color: white;
}

.validate-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #1976D2, #1565C0);
}

.load-btn {
  background: linear-gradient(135deg, #4CAF50, #45a049);
  color: white;
}

.load-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, #45a049, #3d8b40);
}
</style>