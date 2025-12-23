<script setup>
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { useScenesStore } from '@/stores/scenes'
import { CustomWorld } from '@/worlds/CustomWorld'

const route = useRoute()
const scenesStore = useScenesStore()
const canvas = ref(null)
const world = shallowRef(null)
const showInfo = ref(true)
const sceneName = ref('Custom Scene')
const sceneDescription = ref('A loaded custom scene')
const error = ref(null)

onMounted(async () => {
  console.log('CustomScene: Mounting component')
  console.log('CustomScene: Route params:', route.params)

  if (!canvas.value) {
    console.error('CustomScene: Canvas not found')
    return
  }

  let sceneConfig = null
  const sceneId = route.params.id
  console.log('CustomScene: Looking for scene with ID:', sceneId)

  if (window.electron) {
    console.log('CustomScene: Running in Electron mode')
    try {
      // Add a small delay to ensure IPC is ready
      await new Promise(resolve => setTimeout(resolve, 500))

      const data = await window.electron.getSceneConfig()
      console.log('CustomScene: Received data from electron:', data)

      if (data && data.config) {
        sceneConfig = data.config
        console.log('CustomScene: Got config from electron:', sceneConfig)
      } else {
        console.error('CustomScene: No config in electron data')
      }
    } catch (err) {
      console.error('CustomScene: Error getting config from electron:', err)
      error.value = 'Failed to get scene configuration from Electron'
    }
  } else {
    console.log('CustomScene: Running in browser mode')
    const scene = scenesStore.getSceneById(sceneId)
    console.log('CustomScene: Found scene:', scene)
    sceneConfig = scene?.config
  }

  if (!sceneConfig) {
    const errorMsg = 'Scene configuration not found for: ' + sceneId
    console.error('CustomScene:', errorMsg)
    error.value = errorMsg
    return
  }

  // Update scene info
  console.log('CustomScene: Initializing with config:', sceneConfig)
  sceneName.value = sceneConfig.name
  sceneDescription.value = sceneConfig.description || 'A loaded custom scene'

  // Initialize world with configuration
  try {
    world.value = new CustomWorld(canvas.value, sceneConfig)
    await world.value.init()
    console.log('CustomScene: World initialized successfully')
  } catch (err) {
    console.error('CustomScene: Error initializing world:', err)
    error.value = 'Error initializing world: ' + err.message
  }
})

onBeforeUnmount(() => {
  console.log('CustomScene: Unmounting component')
  if (world.value) {
    world.value.dispose()
    world.value = null
  }
})
</script>

<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>

    <!-- Error Display -->
    <div v-if="error" class="error-overlay">
      <div class="error-content">
        <h3>Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Info Overlay -->
    <div v-else-if="showInfo" class="overlay-info">
      <div class="info-panel">
        <h3>{{ sceneName }}</h3>
        <p>{{ sceneDescription }}</p>
        <p>Use mouse/touch to:</p>
        <ul>
          <li>Drag to rotate view</li>
          <li>Scroll to zoom</li>
          <li>Right-click drag to pan</li>
        </ul>
      </div>
      <button class="toggle-info" @click="showInfo = false">Hide Info</button>
    </div>
    <button
      v-else
      class="toggle-info-mini"
      @click="showInfo = true"
    >
      Show Info
    </button>
  </div>
</template>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
}

canvas {
  width: 100%;
  height: 100%;
}

.overlay-info {
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

.info-panel {
  background: rgba(0, 0, 0, 0.7);
  padding: 20px;
  border-radius: 8px;
  color: white;
  min-width: 200px;
}

.info-panel h3 {
  margin: 0 0 15px 0;
  text-align: center;
}

.info-panel ul {
  margin: 0;
  padding-left: 20px;
}

.info-panel li {
  margin: 5px 0;
}

button {
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  transition: background 0.3s ease;
}

button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.toggle-info-mini {
  position: absolute;
  top: 20px;
  right: 20px;
}

.error-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.error-content {
  background: #2a2a2a;
  padding: 2rem;
  border-radius: 8px;
  max-width: 400px;
  text-align: center;
}

.error-content h3 {
  color: #ff4444;
  margin-bottom: 1rem;
}

.error-content p {
  color: white;
  margin: 0;
}
</style>