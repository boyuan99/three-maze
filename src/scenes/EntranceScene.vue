<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()

const scenes = ref([
  {
    id: 'scene1',
    name: 'Basic Physics Scene',
    description: 'A simple scene with basic physics interactions',
  },
  {
    id: 'scene2',
    name: 'Advanced Scene',
    description: 'More complex physics and interactions',
  }
])

const handleSceneSelect = (sceneId) => {
  if (window.electron) {
    window.electron.openScene(sceneId)
  } else {
    router.push(`/scene/${sceneId}`)
  }
}
</script>

<template>
  <div class="entrance-container">
    <div class="entrance-content">
      <h1 class="title">Select a Scene</h1>
      <div class="scene-grid">
        <div
          v-for="scene in scenes"
          :key="scene.id"
          class="scene-card"
          @click="handleSceneSelect(scene.id)"
        >
          <div class="scene-preview">
            <div class="preview-placeholder">
              {{ scene.name }}
            </div>
          </div>
          <div class="scene-info">
            <h2 class="scene-title">{{ scene.name }}</h2>
            <p class="scene-description">{{ scene.description }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.entrance-container {
  width: 100vw;
  height: 100vh;
  background-color: #1a1a1a;
  display: flex;
  justify-content: center;
  align-items: center;
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
}

.scene-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
  padding: 1rem;
}

.scene-card {
  background-color: #2a2a2a;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.3s ease;
}

.scene-card:hover {
  transform: translateY(-5px);
  background-color: #3a3a3a;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
}

.scene-preview {
  width: 100%;
  height: 200px;
  background-color: #333;
}

.preview-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  font-size: 1.5rem;
  color: #666;
  background-color: #232323;
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
</style>
