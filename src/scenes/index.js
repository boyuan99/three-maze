import CustomScene from '@/scenes/CustomScene.vue'
import {
  predefinedGalleryScenes,
  predefinedPhysicsMazeScenes,
  predefinedSerialControlScenes
} from '@/stores/scenes'

// Combine all predefined scenes for route generation
const allPredefinedScenes = [
  ...predefinedGalleryScenes,
  ...predefinedPhysicsMazeScenes,
  ...predefinedSerialControlScenes
]

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
        const id = to.params.id
        if (id && id.startsWith('physics_custom_')) {
          to.matched[0].components.default = to.matched[0].components.physics
        } else if (id && id.startsWith('serial_custom_')) {
          to.matched[0].components.default = to.matched[0].components.serial
        }
        next()
      },
      props: true
    }
  ]

  // Add routes for predefined scenes
  allPredefinedScenes.forEach(scene => {
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
