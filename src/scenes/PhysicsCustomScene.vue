<script setup>
import { ref, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { scenes } from '@/scenes'
import { PhysicsCustomWorld } from '@/worlds/PhysicsCustomWorld'

const route = useRoute()
const canvas = ref(null)
const world = shallowRef(null)
const showInfo = ref(true)
const sceneName = ref('Physics Scene')
const sceneDescription = ref('A physics-enabled scene with first-person controls')
const error = ref(null)
const isPointerLocked = ref(false)

onMounted(async () => {
  console.log('PhysicsCustomScene: Mounting component')
  console.log('PhysicsCustomScene: Route params:', route.params)
  console.log('PhysicsCustomScene: Available scenes:', scenes)

  if (!canvas.value) {
    console.error('PhysicsCustomScene: Canvas not found')
    return
  }

  let sceneConfig = null
  const sceneId = route.params.id
  console.log('PhysicsCustomScene: Looking for scene with ID:', sceneId)

  if (window.electron) {
    console.log('PhysicsCustomScene: Running in Electron mode')
    try {
      // Add a small delay to ensure IPC is ready
      await new Promise(resolve => setTimeout(resolve, 500))

      const data = await window.electron.getSceneConfig()
      console.log('PhysicsCustomScene: Received data from electron:', data)

      if (data && data.config) {
        sceneConfig = data.config
        console.log('PhysicsCustomScene: Got config from electron:', sceneConfig)
      } else {
        console.error('PhysicsCustomScene: No config in electron data')
      }
    } catch (err) {
      console.error('PhysicsCustomScene: Error getting config from electron:', err)
      error.value = 'Failed to get scene configuration from Electron'
    }
  } else {
    console.log('PhysicsCustomScene: Running in browser mode')
    const scene = scenes.find(s => s.id === sceneId)
    console.log('PhysicsCustomScene: Found scene:', scene)
    sceneConfig = scene?.config
  }

  if (!sceneConfig) {
    const errorMsg = 'Scene configuration not found for: ' + sceneId
    console.error('PhysicsCustomScene:', errorMsg)
    error.value = errorMsg
    return
  }

  // Update scene info
  console.log('PhysicsCustomScene: Initializing with config:', sceneConfig)
  sceneName.value = sceneConfig.name
  sceneDescription.value = sceneConfig.description || 'A physics-enabled scene with first-person controls'

  // Initialize world with configuration
  try {
    world.value = new PhysicsCustomWorld(canvas.value, sceneConfig)
    await world.value.init()
    console.log('PhysicsCustomScene: World initialized successfully')
    
    // Setup pointer lock event listener
    document.addEventListener('pointerlockchange', () => {
      isPointerLocked.value = document.pointerLockElement === canvas.value
    })
  } catch (err) {
    console.error('PhysicsCustomScene: Error initializing world:', err)
    error.value = 'Error initializing world: ' + err.message
  }
})

onBeforeUnmount(() => {
  console.log('PhysicsCustomScene: Unmounting component')
  if (world.value) {
    world.value.dispose()
    world.value = null
  }
  
  document.removeEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
})

const activateControls = () => {
  if (canvas.value && world.value) {
    world.value.requestPointerLock()
  }
}
</script>

<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    
    <!-- Pointer Lock Overlay -->
    <div v-if="!isPointerLocked && !error" class="scene-overlay" @click="activateControls">
      <div class="activate-prompt">
        Click anywhere to activate controls
      </div>
    </div>

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
        <p>Controls:</p>
        <ul>
          <li>WASD - Move around</li>
          <li>Space - Jump</li>
          <li>Mouse - Look around</li>
          <li>Click - Unlock mouse</li>
          <li>ESC - Release mouse</li>
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

.scene-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
}

.activate-prompt {
  color: white;
  font-size: 1.5em;
  padding: 20px 40px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  backdrop-filter: blur(2px);
}

.activate-prompt:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style> 