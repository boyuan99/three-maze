import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import { createPinia } from 'pinia'
import App from './App.vue'
import { generateRoutes } from './scenes'
import { useScenesStore } from './stores/scenes'

async function initApp() {
  const app = createApp(App)

  // Create and use Pinia
  const pinia = createPinia()
  app.use(pinia)

  // Load stored scenes before creating router
  const scenesStore = useScenesStore()
  await scenesStore.loadStoredScenes()

  // Create router after scenes are loaded
  const router = createRouter({
    history: createWebHashHistory(),
    routes: generateRoutes()
  })

  app.use(router)
  app.mount('#app')
}

initApp()