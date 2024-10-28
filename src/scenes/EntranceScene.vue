<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { scenes, generatePreviews, addLoadedScene } from '@/scenes'
import { LoadedWorld } from '@/worlds/LoadedWorld'

const router = useRouter()
const previews = ref({})
const previewsLoaded = ref(false)
const fileInput = ref(null)
const loadError = ref(null)
const recentScenes = ref([])

const RECENT_SCENES_KEY = 'recentCustomScenes'
const MAX_RECENT_SCENES = 5

// Load previews and recent scenes when component mounts
onMounted(async () => {
  loadRecentScenes()
  try {
    previews.value = await generatePreviews()
    previewsLoaded.value = true
  } catch (error) {
    console.error('Error loading previews:', error)
    previewsLoaded.value = true
  }
})

// Load recent scenes from localStorage
const loadRecentScenes = () => {
  try {
    const saved = localStorage.getItem(RECENT_SCENES_KEY)
    if (saved) {
      recentScenes.value = JSON.parse(saved)
    }
  } catch (error) {
    console.error('Error loading recent scenes:', error)
  }
}

// Save recent scenes to localStorage
const saveRecentScenes = () => {
  try {
    localStorage.setItem(RECENT_SCENES_KEY, JSON.stringify(recentScenes.value))
  } catch (error) {
    console.error('Error saving recent scenes:', error)
  }
}

// Add a scene to recent scenes
const addRecentScene = (scene) => {
  // Remove if already exists
  recentScenes.value = recentScenes.value.filter(s => s.id !== scene.id)

  // Add to beginning of array
  recentScenes.value.unshift(scene)

  // Limit to max number of recent scenes
  if (recentScenes.value.length > MAX_RECENT_SCENES) {
    recentScenes.value.pop()
  }

  saveRecentScenes()
}

// Remove a scene from recent scenes
const removeRecentScene = (sceneId) => {
  recentScenes.value = recentScenes.value.filter(s => s.id !== sceneId)
  saveRecentScenes()
}

// Load a recent scene
const loadRecentScene = (scene) => {
  router.push({
    name: 'loadedScene',
    params: { id: scene.id }
  })
}

// Handle default scene selection
const handleSceneSelect = (sceneId) => {
  if (window.electron) {
    window.electron.openScene(sceneId)
  } else {
    router.push(`/scene/${sceneId}`)
  }
}

// Handle loading new scene file
const handleLoadMore = () => {
  if (!fileInput.value) {
    fileInput.value = document.createElement('input')
    fileInput.value.type = 'file'
    fileInput.value.accept = '.json'
    fileInput.value.style.display = 'none'

    fileInput.value.addEventListener('change', handleFileSelect)
    document.body.appendChild(fileInput.value)
  }

  fileInput.value.click()
}

// Handle file selection
const handleFileSelect = async (event) => {
  const file = event.target.files[0]
  if (!file) return

  try {
    // Read file content
    const content = await readFileContent(file)
    const sceneData = JSON.parse(content)

    // Validate scene configuration
    if (!LoadedWorld.validateSceneConfig(sceneData)) {
      throw new Error('Invalid scene configuration')
    }

    // Generate sceneId and add to loaded scenes
    const sceneId = addLoadedScene(sceneData)

    // Add to recent scenes
    addRecentScene({
      id: sceneId,
      name: sceneData.name || 'Custom Scene',
      preview: null // You could generate a preview here if needed
    })

    // Navigate to the scene
    router.push({
      name: 'loadedScene',
      params: { id: sceneId }
    })

  } catch (error) {
    console.error('Error loading scene:', error)
    loadError.value = `Error loading scene: ${error.message}`
  }

  // Reset file input
  event.target.value = null
}

// Helper to read file content
const readFileContent = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = (e) => reject(e)
    reader.readAsText(file)
  })
}
</script>

<template>
  <div class="entrance-wrapper">
    <div class="entrance-container">
      <div class="entrance-content">
        <h1 class="title">Select a Scene to Observe</h1>

        <!-- Loading error message -->
        <div v-if="loadError" class="error-message">
          {{ loadError }}
          <button @click="loadError = null" class="error-close">×</button>
        </div>

        <div class="scene-grid">
          <!-- Default scenes -->
          <div
            v-for="scene in scenes"
            :key="scene.id"
            class="scene-card"
            @click="handleSceneSelect(scene.id)"
          >
            <div class="scene-preview">
              <div v-if="!previewsLoaded" class="preview-loading">
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

          <!-- Recently loaded scenes -->
          <div
            v-for="(scene, index) in recentScenes"
            :key="scene.id"
            class="scene-card recent-scene"
          >
            <div class="scene-preview" @click="loadRecentScene(scene)">
              <img
                :src="scene.preview || previews['hallway']"
                :alt="scene.name"
                class="preview-image"
              >
            </div>
            <div class="scene-info">
              <h2 class="scene-title">{{ scene.name || `Custom Scene ${index + 1}` }}</h2>
              <p class="scene-description">Recent custom scene</p>
              <button
                class="remove-recent"
                @click.stop="removeRecentScene(scene.id)"
              >
                Remove
              </button>
            </div>
          </div>

          <!-- Load More Card -->
          <div class="scene-card load-more-card" @click="handleLoadMore">
            <div class="scene-preview load-more-preview">
              <div class="load-more-icon">+</div>
            </div>
            <div class="scene-info">
              <h2 class="scene-title">Load Custom Scene</h2>
              <p class="scene-description">Load a scene configuration from your computer</p>
            </div>
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
}

.entrance-content {
  width: 100%;
  max-width: 1200px;
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
}

.scene-card {
  background-color: #2a2a2a;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.3s ease;
  height: 100%;
}

.scene-card:hover {
  transform: translateY(-5px);
  background-color: #3a3a3a;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.scene-preview {
  width: 100%;
  height: 200px;
  background-color: #232323;
  position: relative;
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

.scene-title {
  color: white;
  font-size: 1.5rem;
  margin: 0 0 0.5rem 0;
}

.scene-description {
  color: #aaa;
  font-size: 1rem;
  line-height: 1.4;
  margin: 0;
}

.load-more-card {
  border: 2px dashed #3a3a3a;
  background-color: transparent;
}

.load-more-preview {
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: transparent;
}

.load-more-icon {
  font-size: 4rem;
  color: #3a3a3a;
  transition: color 0.3s ease;
}

.load-more-card:hover .load-more-icon {
  color: #5a5a5a;
}

.error-message {
  background-color: #ff4444;
  color: white;
  padding: 1rem;
  margin: 1rem 0;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.error-close {
  background: none;
  border: none;
  color: white;
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0 0.5rem;
}

.recent-scene {
  border: 2px solid #3a3a3a;
}

.remove-recent {
  background: #ff4444;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  cursor: pointer;
  margin-top: 0.5rem;
}

.remove-recent:hover {
  background: #ff6666;
}

* {
  scroll-behavior: smooth;
}

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