import { DemoWorld01 } from '@/worlds/DemoWorld01.js'
import { DemoWorld02 } from '@/worlds/DemoWorld02.js'
import { HallwayWorld } from '@/worlds/HallwayWorld.js'
import { CustomWorld } from '@/worlds/CustomWorld.js'
import Scene1 from '@/scenes/gallery/DemoScene1.vue'
import Scene2 from '@/scenes/gallery/DemoScene2.vue'
import HallwayScene from '@/scenes/gallery/HallwayScene.vue'
import CustomScene from '@/scenes/CustomScene.vue'
import HallwayControlScene from "@/scenes/physics/HallwayControlScene.vue"
import HallwayControlScene02 from "@/scenes/physics/HallwayControlScene02.vue"

// WebSocket-based scenes (current architecture)
import WebSocketDemo from "@/scenes/serial/WebSocketDemo.vue"
import WebSocketSerialMonitor from "@/scenes/serial/WebSocketSerialMonitor.vue"
import { createApp } from 'vue'
import { storageService } from '@/storage.js'
import { PhysicsCustomWorld } from '@/worlds/PhysicsCustomWorld.js'
// Gallery scenes (Observe Gallery tab)
export const galleryScenes = [
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
  },
]

// Interactive Mazes tab
export const physicsMazeScenes = [
  {
    id: 'physics-maze',
    path: '/scene/physics-maze',
    name: 'Physics Maze',
    description: 'First-person maze exploration with textured walls and physics',
    component: HallwayControlScene,
    previewGenerator: async () => {
      const div = document.createElement('div')
      const app = createApp(HallwayControlScene)
      const instance = app.mount(div)
      try {
        const preview = await instance.generatePreview()
        return preview
      } finally {
        app.unmount()
        div.remove()
      }
    }
  },
  {
    id: 'physics-maze-02',
    path: '/scene/physics-maze-02',
    name: 'Physics Maze 02',
    description: 'First-person maze exploration with physics',
    component: HallwayControlScene02,
    previewGenerator: async () => {
      const div = document.createElement('div')
      const app = createApp(HallwayControlScene02)
      const instance = app.mount(div)
      try {
        const preview = await instance.generatePreview()
        return preview
      } finally {
        app.unmount()
        div.remove()
      }
    }
  }
]

// Serial Control tab
export const serialControlScenes = [
  {
    id: 'websocket-serial-monitor',
    path: '/scene/websocket-serial-monitor',
    name: 'Serial Monitor',
    description: 'Monitor and log serial port data in real-time via WebSocket',
    component: WebSocketSerialMonitor,
    previewGenerator: async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 200
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#1e1e1e'
      ctx.fillRect(0, 0, 300, 200)
      ctx.fillStyle = '#4ec9b0'
      ctx.font = 'bold 18px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('Serial Monitor', 150, 90)
      ctx.font = '14px Arial'
      ctx.fillStyle = '#858585'
      ctx.fillText('Real-time Data Display', 150, 115)
      return canvas.toDataURL()
    }
  },
  {
    id: 'websocket-demo',
    path: '/scene/websocket-demo',
    name: 'Backend Demo',
    description: 'Test WebSocket backend connection and hardware control',
    component: WebSocketDemo,
    previewGenerator: async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 200
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#1e1e1e'
      ctx.fillRect(0, 0, 300, 200)
      ctx.fillStyle = '#4ec9b0'
      ctx.font = 'bold 16px Arial'
      ctx.textAlign = 'center'
      ctx.fillText('Backend Demo', 150, 100)
      ctx.font = '14px Arial'
      ctx.fillStyle = '#858585'
      ctx.fillText('Hardware Testing', 150, 125)
      return canvas.toDataURL()
    }
  }
]

// Combine all scenes for general use
export const scenes = [...galleryScenes, ...physicsMazeScenes, ...serialControlScenes]

// Generate routes with tab structure
export const generateRoutes = () => {
  const routes = [
    {
      path: '/',
      name: 'entrance',
      component: () => import('@/components/EntranceScene.vue')
    },
    {
      path: '/physics-mazes',
      name: 'physics-mazes',
      component: () => import('@/components/PhysicsMazesScene.vue')
    },
    {
      path: '/serial-control',
      name: 'serial-control',
      component: () => import('@/components/SerialControlScene.vue')
    },
    {
      path: '/scene/custom/:id',
      name: 'custom-scene',
      components: {
        default: CustomScene,
        physics: () => import('@/scenes/PhysicsCustomScene.vue'),
        serial: () => import('@/scenes/serial/PythonCustomScene.vue')
      },
      beforeEnter: (to, from, next) => {
        const id = to.params.id;
        if (id && id.startsWith('physics_custom_')) {
          to.matched[0].components.default = to.matched[0].components.physics;
        } else if (id && id.startsWith('serial_custom_')) {
          to.matched[0].components.default = to.matched[0].components.serial;
        }
        next();
      },
      props: true
    }
  ]

  // Add routes for predefined scenes
  scenes.forEach(scene => {
    if (!scene.path.includes('/scene/custom/')) {
      routes.push({
        path: scene.path,
        name: scene.id,
        component: scene.component,
        props: true
      })
    }
  })

  return routes
}

export const loadCustomScene = async (file, prefix = 'gallery_custom_') => {
  try {
    const content = await file.text()
    const sceneConfig = JSON.parse(content)

    validateSceneConfig(sceneConfig)

    const timestamp = Date.now()
    const sceneId = `${prefix}${timestamp}`

    // Choose component based on the scene type
    let componentPath;
    let worldClass;

    if (prefix === 'physics_custom_') {
      componentPath = () => import('@/scenes/PhysicsCustomScene.vue');
      worldClass = PhysicsCustomWorld;
    } else if (prefix === 'serial_custom_') {
      componentPath = () => import('@/scenes/serial/PythonCustomScene.vue');
      worldClass = CustomWorld;  // Use CustomWorld for generic scenes
    } else {
      componentPath = () => import('@/scenes/CustomScene.vue');
      worldClass = CustomWorld;
    }

    const customScene = {
      id: sceneId,
      path: `/scene/custom/${sceneId}`,
      name: sceneConfig.name,
      description: sceneConfig.description || 'Custom loaded scene',
      component: componentPath,
      worldClass: worldClass,
      config: sceneConfig,
      previewGenerator: async () => {
        const world = new worldClass(null, sceneConfig)
        await world.init()
        const preview = world.getPreviewRender()
        world.dispose()
        return preview
      }
    }

    // Add to appropriate scene list
    if (prefix === 'physics_custom_') {
      physicsMazeScenes.push(customScene)
    } else if (prefix === 'serial_custom_') {
      serialControlScenes.push(customScene)
    }

    // Always add to main scenes array
    scenes.push(customScene)

    // Store using storage service
    await storageService.storeScene({
      id: sceneId,
      config: sceneConfig
    })

    return customScene
  } catch (error) {
    console.error('Error loading custom scene:', error)
    throw new Error(`Failed to load scene: ${error.message}`)
  }
}

export const loadStoredScenes = async () => {
  try {
    const storedScenes = await storageService.getStoredScenes()

    // Convert stored scenes back to scene objects and add them to scenes array
    Object.values(storedScenes).forEach(storedScene => {
      const existingIndex = scenes.findIndex(s => s.id === storedScene.id)

      // Determine the appropriate component and world class based on scene ID prefix
      let componentPath, worldClass, targetArray

      if (storedScene.id.startsWith('physics_custom_')) {
        componentPath = () => import('@/scenes/PhysicsCustomScene.vue')
        worldClass = PhysicsCustomWorld
        targetArray = physicsMazeScenes
      } else if (storedScene.id.startsWith('serial_custom_')) {
        componentPath = () => import('@/scenes/serial/PythonCustomScene.vue')
        worldClass = CustomWorld  // Use CustomWorld for generic scenes
        targetArray = serialControlScenes
      } else {
        // Default to gallery custom scene
        componentPath = () => import('@/scenes/CustomScene.vue')
        worldClass = CustomWorld
        targetArray = null // Will only be added to main scenes array
      }

      const customScene = {
        id: storedScene.id,
        path: `/scene/custom/${storedScene.id}`,
        name: storedScene.config.name,
        description: storedScene.config.description || 'Custom loaded scene',
        component: componentPath,
        worldClass: worldClass,
        config: storedScene.config,
        previewGenerator: async () => {
          const world = new worldClass(null, storedScene.config)
          await world.init()
          const preview = world.getPreviewRender()
          world.dispose()
          return preview
        }
      }

      // Update or add to main scenes array
      if (existingIndex >= 0) {
        scenes[existingIndex] = customScene
      } else {
        scenes.push(customScene)
      }

      // Add to appropriate specialized array if needed
      if (targetArray) {
        const specializedIndex = targetArray.findIndex(s => s.id === storedScene.id)
        if (specializedIndex >= 0) {
          targetArray[specializedIndex] = customScene
        } else {
          targetArray.push(customScene)
        }
      }
    })

    console.log('Stored scenes loaded successfully')
    console.log('Physics maze scenes:', physicsMazeScenes.length)
    console.log('Serial control scenes:', serialControlScenes.length)
    console.log('Total scenes:', scenes.length)
  } catch (error) {
    console.error('Error loading stored scenes:', error)
  }
}

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

const validateSceneConfig = (config) => {
  const required = ['name', 'objects']
  const missing = required.filter(field => !config[field])

  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`)
  }

  return true
}


export const validateCustomScene = validateSceneConfig

export const removeCustomScene = async (sceneId) => {
  const index = scenes.findIndex(scene => scene.id === sceneId)
  if (index !== -1 && (
    sceneId.startsWith('gallery_custom_') ||
    sceneId.startsWith('physics_custom_') ||
    sceneId.startsWith('serial_custom_')
  )) {
    scenes.splice(index, 1)

    // Also remove from specific scene list
    if (sceneId.startsWith('physics_custom_')) {
      const mazeIndex = physicsMazeScenes.findIndex(s => s.id === sceneId)
      if (mazeIndex !== -1) {
        physicsMazeScenes.splice(mazeIndex, 1)
      }
    } else if (sceneId.startsWith('serial_custom_')) {
      const serialIndex = serialControlScenes.findIndex(s => s.id === sceneId)
      if (serialIndex !== -1) {
        serialControlScenes.splice(serialIndex, 1)
      }
    }

    // Delete scene from storage
    await storageService.deleteScene(sceneId)

    // Also delete associated experiment file if it exists
    try {
      await storageService.deleteControlFile(sceneId)
    } catch (error) {
      console.warn('No experiment file to delete for scene:', sceneId)
    }

    return true
  }
  return false
}
