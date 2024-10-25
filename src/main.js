import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import { generateRoutes } from './scenes'

const router = createRouter({
  history: createWebHashHistory(),
  routes: generateRoutes()
})

const app = createApp(App)
app.use(router)
app.mount('#app')