<script setup>
import { ref, onMounted, computed, watch, toRaw } from 'vue'
import { useRouter } from 'vue-router'
import { VueDraggable } from 'vue-draggable-plus'
import { useScenesStore } from '@/stores/scenes'
import { storageService } from '@/storage.js'
import NavigationBar from '@/components/NavigationBar.vue'

const STORAGE_KEY = 'serialControlSceneOrder'

const router = useRouter()
const scenesStore = useScenesStore()
const previews = ref({})
const previewsLoaded = ref(false)
const loadingScene = ref(false)
const error = ref(null)
const fileInput = ref(null)
const experimentFileInput = ref(null)
const selectedSceneForExperiment = ref(null)
const sceneExperimentFiles = ref({})
const orderedScenes = ref([])

// Get all serial control scenes from store (reactive)
const allScenes = computed(() => scenesStore.serialControlScenes)

// Load and apply saved order
const loadSavedOrder = () => {
  const savedOrder = localStorage.getItem(STORAGE_KEY)
  const currentScenes = allScenes.value

  if (savedOrder) {
    try {
      const orderIds = JSON.parse(savedOrder)
      const sorted = []
      const remaining = [...currentScenes]

      for (const id of orderIds) {
        const index = remaining.findIndex(s => s.id === id)
        if (index !== -1) {
          sorted.push(remaining.splice(index, 1)[0])
        }
      }
      sorted.push(...remaining)
      orderedScenes.value = sorted
    } catch (e) {
      orderedScenes.value = currentScenes
    }
  } else {
    orderedScenes.value = currentScenes
  }
}

// Save order to localStorage
const saveOrder = () => {
  const orderIds = orderedScenes.value.map(s => s.id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orderIds))
}

// Handle drag end
const onDragEnd = () => {
  saveOrder()
}

// Watch for scene changes and update order (Pinia store is reactive)
watch(allScenes, () => {
  loadSavedOrder()
}, { deep: true })

onMounted(async () => {
  try {
    // Load saved order
    loadSavedOrder()

    // Generate previews using store
    const result = await scenesStore.generatePreviews()
    previews.value = result
    previewsLoaded.value = true

    // Load stored experiment file associations
    await loadStoredExperimentFiles()
  } catch (err) {
    console.error('Error generating previews:', err)
    previewsLoaded.value = true
  }
})

async function loadStoredExperimentFiles() {
  try {
    const storedFiles = await storageService.getStoredControlFiles()
    Object.entries(storedFiles).forEach(([sceneId, fileData]) => {
      if (fileData.type === 'python') {
        sceneExperimentFiles.value[sceneId] = {
          name: fileData.name,
          filename: fileData.filename || fileData.name
        }
      }
    })
    console.log('Loaded experiment files for', Object.keys(sceneExperimentFiles.value).length, 'scenes')
  } catch (error) {
    console.error('Error loading stored experiment files:', error)
  }
}

const handleLoadScene = async () => {
  // Use Electron dialog if available (with default mazes folder)
  if (window.electron?.selectMazeFile) {
    loadingScene.value = true
    error.value = null

    try {
      const fileData = await window.electron.selectMazeFile()

      if (!fileData) {
        // User cancelled
        loadingScene.value = false
        return
      }

      console.log('Loading custom scene file:', fileData.name, 'from:', fileData.mazeDir)

      // Create a File-like object from the data
      const file = new File([fileData.content], fileData.name, { type: 'application/json' })
      const customScene = await scenesStore.loadCustomScene(file, 'serial_custom_', fileData.mazeDir)
      console.log('Custom scene loaded:', customScene)

      previews.value[customScene.id] = await customScene.previewGenerator()

      await new Promise(resolve => setTimeout(resolve, 100))

      console.log('Scene loaded successfully. Select a Python experiment file to enable it.')
    } catch (err) {
      console.error('Error loading custom scene:', err)
      error.value = err.message
    } finally {
      loadingScene.value = false
    }
  } else {
    // Fall back to file input for web mode
    fileInput.value.click()
  }
}

const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  loadingScene.value = true
  error.value = null

  try {
    console.log('Loading custom scene file:', file.name)
    const customScene = await scenesStore.loadCustomScene(file, 'serial_custom_')
    console.log('Custom scene loaded:', customScene)

    previews.value[customScene.id] = await customScene.previewGenerator()

    event.target.value = null
    await new Promise(resolve => setTimeout(resolve, 100))

    console.log('Scene loaded successfully. Select a Python experiment file to enable it.')
  } catch (err) {
    console.error('Error loading custom scene:', err)
    error.value = err.message
  } finally {
    loadingScene.value = false
  }
}

const handleDeleteScene = async (sceneId, event) => {
  event.stopPropagation()
  if (confirm('Are you sure you want to delete this custom scene?')) {
    const removed = await scenesStore.removeCustomScene(sceneId)
    if (removed) {
      delete previews.value[sceneId]

      // Also delete associated experiment file
      if (sceneExperimentFiles.value[sceneId]) {
        await storageService.deleteControlFile(sceneId)
        delete sceneExperimentFiles.value[sceneId]
      }
    }
  }
}


const handleSceneSelect = (sceneId, shouldOpen = false) => {
  if (!shouldOpen) return

  // For custom scenes, require Python experiment file
  if (sceneId.startsWith('serial_custom_') && !sceneExperimentFiles.value[sceneId]) {
    error.value = 'Please select a Python experiment file for this scene before opening.'
    return
  }

  // Find the scene configuration
  const scene = scenesStore.getSceneById(sceneId)

  // Prepare scene data with config, mazeDir, and experiment file info
  const sceneData = {
    config: scene?.config ? toRaw(scene.config) : null,
    mazeDir: scene?.config?._mazeDir || null,
    experimentFile: sceneExperimentFiles.value[sceneId]?.filename || null
  }

  console.log('Opening scene with data:', sceneData)

  if (window.electron) {
    window.electron.openScene(sceneId, sceneData)
  } else {
    // Store experiment file info in session storage for web mode
    if (sceneExperimentFiles.value[sceneId]) {
      sessionStorage.setItem(`experimentFile_${sceneId}`, sceneExperimentFiles.value[sceneId].filename)
    }
    router.push(sceneId.startsWith('serial_custom_')
        ? `/scene/custom/${sceneId}`
        : `/scene/${sceneId}`)
  }
}

const handleOpenScene = (sceneId) => {
  handleSceneSelect(sceneId, true)
}

const selectExperimentFile = async (sceneId) => {
  selectedSceneForExperiment.value = sceneId

  // Use Electron dialog if available (with default experiments folder)
  if (window.electron?.selectExperimentFile) {
    try {
      const fileData = await window.electron.selectExperimentFile()

      if (!fileData) {
        // User cancelled
        selectedSceneForExperiment.value = null
        return
      }

      // Only accept Python files
      if (!fileData.name.endsWith('.py')) {
        error.value = 'Please select a Python (.py) experiment file'
        selectedSceneForExperiment.value = null
        return
      }

      // Store experiment file association
      const experimentFileData = {
        name: fileData.name,
        filename: fileData.name,
        content: fileData.content,
        type: 'python'
      }

      sceneExperimentFiles.value[selectedSceneForExperiment.value] = {
        name: fileData.name,
        filename: fileData.name
      }

      // Persist to storage
      try {
        await storageService.storeControlFile(selectedSceneForExperiment.value, experimentFileData)
        console.log('Experiment file stored successfully:', fileData.name)
      } catch (err) {
        console.warn('Failed to store experiment file:', err)
      }

      selectedSceneForExperiment.value = null
    } catch (err) {
      console.error('Error reading experiment file:', err)
      error.value = err.message
      selectedSceneForExperiment.value = null
    }
  } else {
    // Fall back to file input for web mode
    experimentFileInput.value.click()
  }
}

const handleExperimentFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file || !selectedSceneForExperiment.value) return

  try {
    // Only accept Python files
    if (!file.name.endsWith('.py')) {
      error.value = 'Please select a Python (.py) experiment file'
      event.target.value = null
      selectedSceneForExperiment.value = null
      return
    }

    const content = await file.text()

    // Store experiment file association
    const experimentFileData = {
      name: file.name,
      filename: file.name,
      content: content,
      type: 'python'
    }

    sceneExperimentFiles.value[selectedSceneForExperiment.value] = {
      name: file.name,
      filename: file.name
    }

    // Persist to storage
    try {
      await storageService.storeControlFile(selectedSceneForExperiment.value, experimentFileData)
      console.log('Experiment file stored successfully:', file.name)
    } catch (err) {
      console.warn('Failed to store experiment file:', err)
    }

    event.target.value = null
    selectedSceneForExperiment.value = null
  } catch (err) {
    console.error('Error reading experiment file:', err)
    error.value = err.message
  }
}

const canOpenScene = (sceneId) => {
  // Predefined scenes can always be opened
  if (!sceneId.startsWith('serial_custom_')) {
    return true
  }
  // Custom scenes require experiment file
  return !!sceneExperimentFiles.value[sceneId]
}


</script>

<template>
  <div class="entrance-wrapper">
    <NavigationBar />
    <div class="entrance-container">
      <div class="entrance-content">
        <h1 class="title">Serial Control Scenes</h1>
        

        <div v-if="error" class="error-modal">
          <div class="error-content">
            <h3>Error Loading Scene</h3>
            <p>{{ error }}</p>
            <button @click="error = null">Close</button>
          </div>
        </div>
        
        <!-- Scene Grid -->
        <div class="scene-grid">
          <!-- Load Custom Scene Card (Fixed, Not Draggable) -->
          <div
            class="scene-card load-scene-card"
            @click="handleLoadScene"
            :class="{ 'is-loading': loadingScene }"
          >
            <div class="scene-preview load-scene-preview">
              <div class="load-scene-icon">
                <div v-if="loadingScene" class="loading-spinner"></div>
                <span v-else class="plus-icon">+</span>
              </div>
            </div>
            <div class="scene-info">
              <h2 class="scene-title">Load Custom Scene</h2>
              <p class="scene-description">
                Import a custom JSON scene configuration
              </p>
            </div>
            <input
              ref="fileInput"
              type="file"
              accept=".json"
              class="hidden-input"
              @change="handleFileSelect"
            >
          </div>

          <!-- Draggable Scene Cards -->
          <VueDraggable
              v-model="orderedScenes"
              class="draggable-container"
              animation="150"
              ghostClass="ghost-card"
              @end="onDragEnd"
          >
            <div
                v-for="scene in orderedScenes"
                :key="scene.id"
                class="scene-card"
            >
              <div class="scene-preview">
                <div v-if="!previewsLoaded || !previews[scene.id]" class="preview-loading">
                  Loading preview...
                </div>
                <img
                    v-else
                    :src="previews[scene.id]"
                    :alt="scene.name"
                    class="preview-image"
                />
              </div>
              <div class="scene-info">
                <div class="scene-header">
                  <h2 class="scene-title">{{ scene.name }}</h2>
                  <button
                      v-if="scene.id.startsWith('serial_custom_')"
                      class="delete-button"
                      @click.stop="handleDeleteScene(scene.id, $event)"
                      title="Delete custom scene"
                  >
                    ×
                  </button>
                </div>
                <p class="scene-description">{{ scene.description }}</p>

                <!-- Experiment file info for custom scenes -->
                <template v-if="scene.id.startsWith('serial_custom_')">
                  <div v-if="sceneExperimentFiles[scene.id]" class="control-file-info">
                    <p>✓ Experiment: {{ sceneExperimentFiles[scene.id].name }}</p>
                  </div>
                  <div v-else class="control-file-info">
                    <p style="color: #ff6b6b;">⚠ No Python experiment selected</p>
                  </div>
                </template>

                <div class="scene-actions">
                  <button
                      class="action-button open-button"
                      @click="handleOpenScene(scene.id)"
                      :disabled="!canOpenScene(scene.id)"
                      :class="{ 'disabled': !canOpenScene(scene.id) }"
                  >
                    Open Scene
                  </button>
                  <button
                      v-if="scene.id.startsWith('serial_custom_')"
                      class="action-button code-button"
                      @click="selectExperimentFile(scene.id)"
                  >
                    Select Experiment
                  </button>
                </div>
              </div>
            </div>
          </VueDraggable>
        </div>

        <input
          ref="experimentFileInput"
          type="file"
          accept=".py"
          class="hidden-input"
          @change="handleExperimentFileSelect"
        >

        <div v-if="loadingScene" class="loading-overlay">
          <div class="loading-content">
            <div class="loading-spinner"></div>
            <p>Loading scene...</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entrance-wrapper {
  width: 100vw;
  height: 100vh;
  overflow-y: auto;
  background-color: #1a1a1a;
}

.entrance-container {
  min-height: 100vh;
  display: flex;
  justify-content: center;
  padding: 2rem;
  padding-top: 80px;
}

.entrance-content {
  width: 100%;
  max-width: 1700px;
  position: relative;
}

.title {
  color: white;
  font-size: 2.5rem;
  text-align: center;
  margin-bottom: 3rem;
  padding-top: 1rem;
}

.scene-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
  padding: 1rem;
  margin-bottom: 2rem;
  justify-items: start;
}

.scene-card {
  width: 100%;
  min-width: 300px;
  max-width: 400px;
  background-color: #2a2a2a;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.3s ease;
  height: 100%;
  position: relative;
}

.scene-card:hover {
  transform: translateY(-5px);
  background-color: #3a3a3a;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.load-scene-card {
  border: 2px dashed #4a4a4a;
  background-color: #2a2a2a;
}

.load-scene-card:hover {
  border-color: #666;
  background-color: #3a3a3a;
}

.scene-preview {
  width: 100%;
  height: 200px;
  background-color: #232323;
  position: relative;
}

.load-scene-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #232323;
}

.load-scene-icon {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background-color: #3a3a3a;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
}

.plus-icon {
  font-size: 48px;
  color: #666;
}

.preview-loading {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  color: #666;
}

.preview-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.scene-info {
  padding: 1.5rem;
}

.scene-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.scene-title {
  color: white;
  font-size: 1.5rem;
  margin: 0;
}

.scene-description {
  color: #aaa;
  font-size: 1rem;
  line-height: 1.4;
  margin: 0;
}

.hidden-input {
  display: none;
}

.delete-button {
  background: none;
  border: none;
  color: #ff4444;
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  transition: all 0.3s ease;
}

.delete-button:hover {
  background-color: rgba(255, 68, 68, 0.1);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #666;
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.loading-content {
  text-align: center;
  color: white;
}

.error-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.error-content {
  background-color: #2a2a2a;
  padding: 2rem;
  border-radius: 12px;
  max-width: 400px;
  width: 90%;
  text-align: center;
}

.error-content h3 {
  color: #ff4444;
  margin-bottom: 1rem;
}

.error-content p {
  color: white;
  margin-bottom: 1.5rem;
}

.error-content button {
  background-color: #3a3a3a;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.3s ease;
}

.error-content button:hover {
  background-color: #4a4a4a;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Scrollbar styling */
.entrance-wrapper::-webkit-scrollbar {
  width: 10px;
}

.entrance-wrapper::-webkit-scrollbar-track {
  background: #1a1a1a;
}

.entrance-wrapper::-webkit-scrollbar-thumb {
  background: #3a3a3a;
  border-radius: 5px;
}

.entrance-wrapper::-webkit-scrollbar-thumb:hover {
  background: #4a4a4a;
}

.monitor-card {
  min-height: 400px;
  cursor: default !important;
}

.monitor-card:hover {
  transform: none !important;
  background-color: #2a2a2a !important;
  box-shadow: none !important;
}

.scene-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
}

.action-button {
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s ease;
  flex: 1;
}

.open-button {
  background-color: #4a4a9a;
  color: white;
}

.open-button:hover {
  background-color: #5a5aaa;
}

.code-button {
  background-color: #3a3a3a;
  color: white;
}

.code-button:hover {
  background-color: #4a4a4a;
}

.control-file-info {
  margin: 10px 0;
  padding: 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-size: 0.9em;
}

.control-file-info p {
  margin: 0;
}

.action-button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: #666;
}

.action-button.disabled:hover {
  background: #666;
}

/* Drag and drop styles */
.draggable-container {
  display: contents;
}

.ghost-card {
  opacity: 0.5;
  background: #3a3a3a !important;
}

.scene-card {
  cursor: grab;
}

.scene-card:active {
  cursor: grabbing;
}

.load-scene-card {
  cursor: pointer;
}
</style>