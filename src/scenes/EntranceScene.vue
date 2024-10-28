<script setup>
import {ref} from 'vue'
import {useRouter} from 'vue-router'
import {scenes, generatePreviews} from '@/scenes'

const router = useRouter()
const previews = ref({})
const previewsLoaded = ref(false)

// Load previews when component mounts
generatePreviews().then(result => {
  previews.value = result
  previewsLoaded.value = true
}).catch(error => {
  console.error('Error loading previews:', error)
  previewsLoaded.value = true
})

const handleSceneSelect = (sceneId) => {
  if (window.electron) {
    window.electron.openScene(sceneId)
  } else {
    router.push(`/scene/${sceneId}`)
  }
}
</script>

<template>
  <div class="entrance-wrapper">
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