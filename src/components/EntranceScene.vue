<script setup>
import {ref, onMounted} from 'vue'
import {useRouter} from 'vue-router'
import {
  scenes,
  galleryScenes,
  generatePreviews, 
  loadCustomScene, 
  removeCustomScene, 
  loadStoredScenes 
} from '@/scenes'
import NavigationBar from '@/components/NavigationBar.vue'

const router = useRouter()
const previews = ref({})
const previewsLoaded = ref(false)
const customScenes = ref([])
const loadingScene = ref(false)
const error = ref(null)
const fileInput = ref(null)

// Load previews when component mounts
onMounted(async () => {
  try {
    // First load stored scenes
    await loadStoredScenes()

    // Then generate previews
    const result = await generatePreviews()
    previews.value = result
    previewsLoaded.value = true
  } catch (error) {
    console.error('Error loading scenes and previews:', error)
    previewsLoaded.value = true
  }
})


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

      console.log('EntranceScene: Loading custom scene file:', fileData.name)

      // Create a File-like object from the data
      const file = new File([fileData.content], fileData.name, { type: 'application/json' })
      const customScene = await loadCustomScene(file)
      console.log('EntranceScene: Custom scene loaded:', customScene)

      // Generate preview
      previews.value[customScene.id] = await customScene.previewGenerator()

      // Ensure scene is registered before opening
      await new Promise(resolve => setTimeout(resolve, 100))

      // Open the scene
      handleSceneSelect(customScene.id)
    } catch (err) {
      console.error('EntranceScene: Error loading custom scene:', err)
      error.value = err.message
    } finally {
      loadingScene.value = false
    }
  } else {
    // Fall back to file input for web mode
    fileInput.value.click()
  }
}

const handleSceneSelect = (sceneId) => {
  console.log('EntranceScene: Selecting scene:', sceneId)
  const scene = [...scenes].find(s => s.id === sceneId)

  if (window.electron) {
    console.log('EntranceScene: Opening in Electron:', sceneId)
    window.electron.openScene(sceneId, scene?.config)
  } else {
    const path = sceneId.startsWith('gallery_custom_')
        ? `/scene/custom/${sceneId}`
        : `/scene/${sceneId}`
    console.log('EntranceScene: Opening in browser:', path)
    router.push(path)
  }
}

const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  loadingScene.value = true
  error.value = null

  try {
    console.log('EntranceScene: Loading custom scene file:', file.name)
    const customScene = await loadCustomScene(file)
    console.log('EntranceScene: Custom scene loaded:', customScene)

    // Generate preview
    previews.value[customScene.id] = await customScene.previewGenerator()

    // Clear file input
    event.target.value = null

    // Ensure scene is registered before opening
    await new Promise(resolve => setTimeout(resolve, 100))

    // Open the scene
    handleSceneSelect(customScene.id)
  } catch (err) {
    console.error('EntranceScene: Error loading custom scene:', err)
    error.value = err.message
  } finally {
    loadingScene.value = false
  }
}


const handleDeleteScene = async (sceneId) => {
  if (confirm('Are you sure you want to delete this custom scene?')) {
    const removed = removeCustomScene(sceneId)
    if (removed) {
      delete previews.value[sceneId]
    }
  }
}
</script>

<template>
  <div class="entrance-wrapper">
    <NavigationBar />
    <div class="entrance-container">
      <div class="entrance-content">
        <h1 class="title">Three-Maze Scenes</h1>

        <!-- Scene loading error modal -->
        <div v-if="error" class="error-modal">
          <div class="error-content">
            <h3>Error Loading Scene</h3>
            <p>{{ error }}</p>
            <button @click="error = null">Close</button>
          </div>
        </div>

        <div class="scene-grid">
          <!-- Load Scene Card -->
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

          <!-- Gallery Scenes -->
          <div
              v-for="scene in galleryScenes"
              :key="scene.id"
              class="scene-card"
              @click="handleSceneSelect(scene.id)"
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
              >
            </div>
            <div class="scene-info">
              <h2 class="scene-title">{{ scene.name }}</h2>
              <p class="scene-description">{{ scene.description }}</p>
            </div>
          </div>

          <!-- Custom Scenes -->
          <div
              v-for="scene in scenes.filter(s => s.id.startsWith('gallery_custom_'))"
              :key="scene.id"
              class="scene-card"
              @click="handleSceneSelect(scene.id)"
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
              >
            </div>
            <div class="scene-info">
              <div class="scene-header">
                <h2 class="scene-title">{{ scene.name }}</h2>
                <button
                    class="delete-button"
                    @click.stop="handleDeleteScene(scene.id)"
                    title="Delete custom scene"
                >
                  ×
                </button>
              </div>
              <p class="scene-description">{{ scene.description }}</p>
            </div>
          </div>
        </div>

        <!-- Loading overlay -->
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
</style>