import { DemoWorld01 } from '@/worlds/DemoWorld01.js'
import { DemoWorld02 } from '@/worlds/DemoWorld02.js'
import { HallwayWorld } from '@/worlds/HallwayWorld.js'
import { CustomWorld } from '@/worlds/CustomWorld.js'
import Scene1 from '@/scenes/DemoScene1.vue'
import Scene2 from '@/scenes/DemoScene2.vue'
import HallwayScene from '@/scenes/HallwayScene.vue'
import CustomScene from '@/scenes/CustomScene.vue'

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
    // Generic route for custom scenes should come first
    {
      path: '/scene/custom/:id',
      name: 'custom-scene',
      component: () => import('@/scenes/CustomScene.vue'),
      props: true
    }
  ]

  // Add routes for predefined scenes
  scenes.forEach(scene => {
    if (!scene.id.startsWith('custom_')) {
      routes.push({
        path: scene.path,
        name: scene.id,
        component: scene.component
      })
    }
  })

  return routes
}

export const loadCustomScene = async (file) => {
  try {
    const content = await file.text()
    const sceneConfig = JSON.parse(content)

    validateSceneConfig(sceneConfig)

    const timestamp = Date.now()
    const sceneId = `custom_${timestamp}`

    const customScene = {
      id: sceneId,
      path: `/scene/custom/${sceneId}`, // Update path format
      name: sceneConfig.name,
      description: sceneConfig.description || 'Custom loaded scene',
      component: () => import('@/scenes/CustomScene.vue'),
      worldClass: CustomWorld,
      config: sceneConfig,
      previewGenerator: async () => {
        const world = new CustomWorld(null, sceneConfig)
        await world.init()
        const preview = world.getPreviewRender()
        world.dispose()
        return preview
      }
    }

    scenes.push(customScene)
    return customScene
  } catch (error) {
    console.error('Error loading custom scene:', error)
    throw new Error(`Failed to load scene: ${error.message}`)
  }
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

// Function to validate scene configuration
const validateSceneConfig = (config) => {
  const required = ['name', 'objects']
  const missing = required.filter(field => !config[field])

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`)
  }

  return true
}


// Export validation function for use in other components
export const validateCustomScene = validateSceneConfig

// Function to remove a custom scene
export const removeCustomScene = (sceneId) => {
  const index = scenes.findIndex(scene => scene.id === sceneId)
  if (index !== -1 && sceneId.startsWith('custom_')) {
    scenes.splice(index, 1)
    return true
  }
  return false
}