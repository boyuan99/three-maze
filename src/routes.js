import EntranceScene from '@/scenes/EntranceScene.vue'
import Scene1 from '@/scenes/DemoScene1.vue'
import Scene2 from '@/scenes/DemoScene2.vue'
import HallwayScene from "@/scenes/HallwayScene.vue";

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
  },
  {
    path: '/scene/hallway',
    name: 'hallway',
    component: HallwayScene
  }
]