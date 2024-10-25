<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    <div class="overlay-info" v-if="showInfo">
      <div class="info-panel">
        <h3>3D Hallway Scene</h3>
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

<script>
import { onMounted, onBeforeUnmount, ref, shallowRef } from 'vue'
import { HallwayWorld } from '../worlds/HallwayWorld.js'

export default {
  name: 'HallwayScene',
  setup() {
    const canvas = ref(null)
    const world = shallowRef(null)
    const showInfo = ref(true)

    onMounted(async () => {
      if (canvas.value) {
        world.value = new HallwayWorld(canvas.value)
        await world.value.init()
      }
    })

    onBeforeUnmount(() => {
      if (world.value) {
        world.value.dispose()
        world.value = null
      }
    })

    return {
      canvas,
      showInfo
    }
  }
}
</script>

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
</style>