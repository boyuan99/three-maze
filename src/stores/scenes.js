import { defineStore } from 'pinia'
import { createApp } from 'vue'
import { storageService } from '@/storage.js'

// World classes
import { DemoWorld01 } from '@/worlds/DemoWorld01.js'
import { DemoWorld02 } from '@/worlds/DemoWorld02.js'
import { HallwayWorld } from '@/worlds/HallwayWorld.js'
import { CustomWorld } from '@/worlds/CustomWorld.js'
import { PhysicsCustomWorld } from '@/worlds/PhysicsCustomWorld.js'

// Scene components
import Scene1 from '@/scenes/gallery/DemoScene1.vue'
import Scene2 from '@/scenes/gallery/DemoScene2.vue'
import HallwayScene from '@/scenes/gallery/HallwayScene.vue'
import HallwayControlScene from '@/scenes/physics/HallwayControlScene.vue'
import HallwayControlScene02 from '@/scenes/physics/HallwayControlScene02.vue'
import WebSocketSerialMonitor from '@/scenes/serial/WebSocketSerialMonitor.vue'

// Predefined gallery scenes
const predefinedGalleryScenes = [
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

// Predefined physics maze scenes
const predefinedPhysicsMazeScenes = [
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

// Predefined serial control scenes
const predefinedSerialControlScenes = [
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
  }
]

const validateSceneConfig = (config) => {
  const required = ['name', 'objects']
  const missing = required.filter(field => !config[field])
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`)
  }
  return true
}

export const useScenesStore = defineStore('scenes', {
  state: () => ({
    // Custom scenes (loaded from storage)
    customGalleryScenes: [],
    customPhysicsMazeScenes: [],
    customSerialControlScenes: [],
    // Initialization flag
    initialized: false
  }),

  getters: {
    // All gallery scenes (predefined + custom)
    galleryScenes: (state) => {
      return [...predefinedGalleryScenes, ...state.customGalleryScenes]
    },

    // All physics maze scenes (predefined + custom)
    physicsMazeScenes: (state) => {
      return [...predefinedPhysicsMazeScenes, ...state.customPhysicsMazeScenes]
    },

    // All serial control scenes (predefined + custom)
    serialControlScenes: (state) => {
      return [...predefinedSerialControlScenes, ...state.customSerialControlScenes]
    },

    // All scenes combined
    allScenes: (state) => {
      return [
        ...predefinedGalleryScenes,
        ...state.customGalleryScenes,
        ...predefinedPhysicsMazeScenes,
        ...state.customPhysicsMazeScenes,
        ...predefinedSerialControlScenes,
        ...state.customSerialControlScenes
      ]
    },

    // Find scene by ID
    getSceneById: (state) => (sceneId) => {
      const allScenes = [
        ...predefinedGalleryScenes,
        ...state.customGalleryScenes,
        ...predefinedPhysicsMazeScenes,
        ...state.customPhysicsMazeScenes,
        ...predefinedSerialControlScenes,
        ...state.customSerialControlScenes
      ]
      return allScenes.find(s => s.id === sceneId)
    }
  },

  actions: {
    // Load stored scenes from storage service
    async loadStoredScenes() {
      if (this.initialized) return

      try {
        const storedScenes = await storageService.getStoredScenes()

        Object.values(storedScenes).forEach(storedScene => {
          this._addStoredScene(storedScene)
        })

        this.initialized = true
        console.log('Stored scenes loaded successfully')
        console.log('Custom gallery scenes:', this.customGalleryScenes.length)
        console.log('Custom physics maze scenes:', this.customPhysicsMazeScenes.length)
        console.log('Custom serial control scenes:', this.customSerialControlScenes.length)
      } catch (error) {
        console.error('Error loading stored scenes:', error)
      }
    },

    // Internal method to add a stored scene
    _addStoredScene(storedScene) {
      let componentPath, worldClass, targetArray

      if (storedScene.id.startsWith('physics_custom_')) {
        componentPath = () => import('@/scenes/PhysicsCustomScene.vue')
        worldClass = PhysicsCustomWorld
        targetArray = this.customPhysicsMazeScenes
      } else if (storedScene.id.startsWith('serial_custom_')) {
        componentPath = () => import('@/scenes/serial/PythonCustomScene.vue')
        worldClass = CustomWorld
        targetArray = this.customSerialControlScenes
      } else {
        componentPath = () => import('@/scenes/CustomScene.vue')
        worldClass = CustomWorld
        targetArray = this.customGalleryScenes
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

      // Check if already exists
      const existingIndex = targetArray.findIndex(s => s.id === storedScene.id)
      if (existingIndex >= 0) {
        targetArray[existingIndex] = customScene
      } else {
        targetArray.push(customScene)
      }
    },

    // Load a custom scene from file
    async loadCustomScene(file, prefix = 'gallery_custom_', mazeDir = null) {
      try {
        const content = await file.text()
        const sceneConfig = JSON.parse(content)

        validateSceneConfig(sceneConfig)

        // Store the maze directory in the config for texture resolution
        if (mazeDir) {
          sceneConfig._mazeDir = mazeDir
        }

        const timestamp = Date.now()
        const sceneId = `${prefix}${timestamp}`

        let componentPath, worldClass, targetArray

        if (prefix === 'physics_custom_') {
          componentPath = () => import('@/scenes/PhysicsCustomScene.vue')
          worldClass = PhysicsCustomWorld
          targetArray = this.customPhysicsMazeScenes
        } else if (prefix === 'serial_custom_') {
          componentPath = () => import('@/scenes/serial/PythonCustomScene.vue')
          worldClass = CustomWorld
          targetArray = this.customSerialControlScenes
        } else {
          componentPath = () => import('@/scenes/CustomScene.vue')
          worldClass = CustomWorld
          targetArray = this.customGalleryScenes
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

        // Add to appropriate array (reactive update)
        targetArray.push(customScene)

        // Store using storage service
        await storageService.storeScene({
          id: sceneId,
          config: sceneConfig,
          mazeDir: mazeDir
        })

        return customScene
      } catch (error) {
        console.error('Error loading custom scene:', error)
        throw new Error(`Failed to load scene: ${error.message}`)
      }
    },

    // Remove a custom scene
    async removeCustomScene(sceneId) {
      let targetArray
      let removed = false

      if (sceneId.startsWith('physics_custom_')) {
        targetArray = this.customPhysicsMazeScenes
      } else if (sceneId.startsWith('serial_custom_')) {
        targetArray = this.customSerialControlScenes
      } else if (sceneId.startsWith('gallery_custom_')) {
        targetArray = this.customGalleryScenes
      } else {
        return false
      }

      const index = targetArray.findIndex(s => s.id === sceneId)
      if (index !== -1) {
        targetArray.splice(index, 1)
        removed = true

        // Delete from storage
        await storageService.deleteScene(sceneId)

        // Also delete associated experiment file if it exists
        try {
          await storageService.deleteControlFile(sceneId)
        } catch (error) {
          console.warn('No experiment file to delete for scene:', sceneId)
        }
      }

      return removed
    },

    // Generate previews for all scenes
    async generatePreviews() {
      const previews = {}
      const allScenes = this.allScenes

      for (const scene of allScenes) {
        try {
          previews[scene.id] = await scene.previewGenerator()
        } catch (error) {
          console.error(`Error generating preview for ${scene.id}:`, error)
        }
      }

      return previews
    }
  }
})

// Export predefined scenes for route generation (needed before store is available)
export { predefinedGalleryScenes, predefinedPhysicsMazeScenes, predefinedSerialControlScenes }

// Validate function export
export const validateCustomScene = validateSceneConfig
