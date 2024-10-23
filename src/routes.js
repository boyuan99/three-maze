import EntranceScene from './scenes/EntranceScene.vue'
import Scene1 from './scenes/Scene1.vue'
import Scene2 from './scenes/Scene2.vue'

export default [
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