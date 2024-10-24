<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
  </div>
</template>

<script>
import { onMounted, onUnmounted, ref } from 'vue'
import { DemoWorld02 } from '../worlds/DemoWorld02.js'

export default {
  name: 'Scene2',
  setup() {
    const canvas = ref(null)
    let world = null

    onMounted(() => {
      world = new DemoWorld02(canvas.value)
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