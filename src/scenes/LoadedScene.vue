<script>
import {ref, onMounted, onBeforeUnmount} from 'vue'
import {useRouter} from 'vue-router'
import {LoadedWorld} from '@/worlds/LoadedWorld'
import {getLoadedScene} from '@/scenes'

export default {
  name: 'LoadedScene',
  props: {
    id: {
      type: String,
      required: true
    }
  },

  setup(props) {
    const canvas = ref(null)
    const showInfo = ref(true)
    const sceneName = ref('Custom Scene')
    const error = ref(null)
    const router = useRouter()
    let world = null

    const goBack = () => {
      router.push('/')
    }

    onMounted(async () => {
      if (!canvas.value || !props.id) {
        error.value = 'Invalid scene configuration'
        return
      }

      try {
        const sceneData = getLoadedScene(props.id)
        if (!sceneData) {
          error.value = 'Scene not found'
          return
        }

        world = await LoadedWorld.loadFromFile(canvas.value, sceneData)
        sceneName.value = sceneData.name || 'Custom Scene'
      } catch (err) {
        console.error('Failed to load scene:', err)
        error.value = 'Failed to load scene'
      }
    })

    onBeforeUnmount(() => {
      if (world) {
        world.dispose()
        world = null
      }
    })

    return {
      canvas,
      showInfo,
      sceneName,
      error,
      goBack
    }
  }
}
</script>

<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    <div v-if="error" class="error-overlay">
      <div class="error-message">
        {{ error }}
        <button @click="goBack">Go Back</button>
      </div>
    </div>
    <div class="overlay-info" v-else-if="showInfo">
      <div class="info-panel">
        <h3>{{ sceneName }}</h3>
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

.error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
}

.error-message {
  background: #ff4444;
  color: white;
  padding: 2rem;
  border-radius: 8px;
  text-align: center;
}

.error-message button {
  margin-top: 1rem;
  padding: 0.5rem 1rem;
  background: white;
  color: #ff4444;
  border: none;
  border-radius: 4px;
  cursor: pointer;
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
</style>