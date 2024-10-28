import { DemoWorld01 } from '@/worlds/DemoWorld01.js'
import { DemoWorld02 } from '@/worlds/DemoWorld02.js'
import { HallwayWorld } from '@/worlds/HallwayWorld.js'
import Scene1 from '@/scenes/DemoScene1.vue'
import Scene2 from '@/scenes/DemoScene2.vue'
import HallwayScene from '@/scenes/HallwayScene.vue'
import LoadedScene from "@/scenes/LoadedScene.vue"

// Store for loaded scenes
export const loadedScenes = new Map()

// Central scene configuration
export const scenes = [
  {
    id: 'scene1',
    path: '/scene/scene1',
    name: 'Basic Physics Scene 01',
    description: 'A simple scene with basic physics interactions attached to certain objects',
    component: Scene1,
    worldClass: DemoWorld01,
    previewGenerator: async () => {
      const world = new DemoWorld01(null)
      await world.init()
      const preview = world.getPreviewRender()
      world.dispose()
      return preview
    }
  },
  {
    id: 'scene2',
    path: '/scene/scene2',
    name: 'Basic Physics Scene 02',
    description: 'More complex physics and interactions',
    component: Scene2,
    worldClass: DemoWorld02,
    previewGenerator: async () => {
      const world = new DemoWorld02(null)
      await world.init()
      const preview = world.getPreviewRender()
      world.dispose()
      return preview
    }
  },
  {
    id: 'hallway',
    path: '/scene/hallway',
    name: 'Hallway Scene',
    description: 'First-person maze exploration with physics',
    component: HallwayScene,
    worldClass: HallwayWorld,
    previewGenerator: async () => {
      const world = new HallwayWorld(null)
      await world.init()
      const preview = world.getPreviewRender()
      world.dispose()
      return preview
    }
  }
]

// Generate routes automatically from scenes
export const generateRoutes = () => {
  const routes = [
    {
      path: '/',
      name: 'entrance',
      component: () => import('@/scenes/EntranceScene.vue')
    },
    {
      path: '/loaded-scene/:id',  // Updated to use route parameter
      name: 'loadedScene',
      component: LoadedScene,
      props: true,
    }
  ]

  scenes.forEach(scene => {
    routes.push({
      path: scene.path,
      name: scene.id,
      component: scene.component
    })
  })

  return routes
}

// Helper to generate all previews
export const generatePreviews = async () => {
  const previews = {}
  for (const scene of scenes) {
    try {
      previews[scene.id] = await scene.previewGenerator()
    } catch (error) {
      console.error(`Error generating preview for ${scene.id}:`, error)
    }
  }
  return previews
}

// Helper functions for loaded scenes
export const addLoadedScene = (sceneData) => {
  const sceneId = `custom-${Date.now()}`
  loadedScenes.set(sceneId, sceneData)
  return sceneId
}

export const getLoadedScene = (id) => {
  return loadedScenes.get(id)
}

export const removeLoadedScene = (id) => {
  loadedScenes.delete(id)
}

// Helper to generate preview for loaded scenes
export const generateLoadedScenePreview = async (sceneData) => {
  try {
    const world = new LoadedWorld(null, sceneData)
    await world.init()
    const preview = world.getPreviewRender()
    world.dispose()
    return preview
  } catch (error) {
    console.error('Error generating preview for loaded scene:', error)
    return null
  }
}