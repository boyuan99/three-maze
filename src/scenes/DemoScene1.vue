<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<script>
import { onMounted, onUnmounted, ref } from 'vue'
import { DemoWorld01 } from '../worlds/DemoWorld01.js'

export default {
  name: 'Scene1',
  setup() {
    const canvas = ref(null)
    let world = null

    onMounted(() => {
      world = new DemoWorld01(canvas.value)
      world.init()
    })

    onUnmounted(() => {
      if (world) {
        world.dispose()
      }
    })

    return {
      canvas
    }
  }
}
</script>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
}

canvas {
  width: 100%;
  height: 100%;
}
</style>