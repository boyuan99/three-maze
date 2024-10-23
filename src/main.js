import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import EntranceScene from './scenes/EntranceScene.vue'
import Scene1 from './scenes/Scene1.vue'
import Scene2 from './scenes/Scene2.vue'

const routes = [
  {
    path: '/',
    name: 'entrance',
    component: EntranceScene
  },
  {
    path: '/scene/scene1',
    name: 'scene1',
    component: Scene1
  },
  {
    path: '/scene/scene2',
    name: 'scene2',
    component: Scene2
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

const app = createApp(App)
app.use(router)
app.mount('#app')