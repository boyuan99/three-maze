<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>

    <div v-if="error" class="error-overlay">
      <div class="error-content">
        <h3>Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Info overlay -->
    <div class="overlay-info" v-if="!error">
      <div class="info-panel">
        <h3>{{ sceneName }}</h3>
        <p>{{ sceneDescription }}</p>
        <div v-if="connected">
          <p><strong>Backend:</strong> <span style="color: #4ade80;">● Connected</span></p>
          <p v-if="experimentFile"><strong>Experiment:</strong> {{ experimentFile }}</p>
          <p><strong>Experiment Status:</strong>
            <span :style="{ color: experimentRunning ? '#4ade80' : '#ff6b6b' }">
              {{ experimentRunning ? '● Running' : '○ Not Running' }}
            </span>
          </p>
          <p><strong>Serial Port:</strong>
            <span :style="{ color: serialConnected ? '#4ade80' : '#ff6b6b' }">
              {{ serialConnected ? '● Connected' : '○ Disconnected' }}
            </span>
            <span v-if="serialPort"> ({{ serialPort }})</span>
          </p>
          <p><strong>Data Rate:</strong> {{ dataRate.toFixed(1) }} Hz</p>
          <p><strong>Position:</strong></p>
          <ul style="margin-left: 20px; font-size: 0.9em;">
            <li>X: {{ position.x.toFixed(2) }} m</li>
            <li>Y: {{ position.y.toFixed(2) }} m</li>
            <li>θ: {{ (position.theta * 180 / Math.PI).toFixed(1) }}°</li>
          </ul>
          <p v-if="lastSerialData"><strong>Last Data:</strong></p>
          <ul v-if="lastSerialData" style="margin-left: 20px; font-size: 0.9em;">
            <li>dx: {{ lastSerialData.x }}</li>
            <li>dy: {{ lastSerialData.y }}</li>
            <li>dθ: {{ lastSerialData.theta }}</li>
          </ul>
        </div>
        <div v-else>
          <p style="color: #ff6b6b;">⚠ Not connected to backend</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { scenes } from '@/scenes'
import * as THREE from 'three'
import { FixedFollowCam } from '@/utils/FixedFollowCam.js'
import RAPIER from '@dimforge/rapier3d-compat'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader'
import { MinimalBackendClient } from '@/services/MinimalBackendClient'

const route = useRoute()
const canvas = ref(null)
const error = ref(null)
const isActive = ref(true)
const experimentFile = ref(null)
const sceneName = ref('Python Custom Scene')
const sceneDescription = ref('Custom scene with Python backend')

// Physics constants
const PLAYER_RADIUS = 0.5

// Scene state
const state = shallowRef({
  scene: null,
  camera: null,
  renderer: null,
  world: null,
  playerBody: null,
  fixedCam: null,
  sceneObjects: []
})

// Backend connection
const backendClient = new MinimalBackendClient()
const connected = ref(false)
const experimentRunning = ref(false)
const serialConnected = ref(false)
const serialPort = ref(null)
const dataRate = ref(0)
const lastSerialData = ref(null)

// Track position
const position = ref({
  x: 0,
  y: 0,
  theta: 0
})

// Serial data buffer
const serialData = ref(null)

// Backend position confirmation
const pendingBackendPosition = ref(null)

// Event-driven position update: send position after processing serial data
let pendingSerialData = null  // Holds serial data until position is sent
const POSITION_RESET_THRESHOLD = 0.5  // 0.5m difference triggers reset

// Animation loop
function animate() {
  if (!isActive.value) return

  requestAnimationFrame(animate)

  const { scene, camera, renderer, world, playerBody, fixedCam } = state.value

  if (!scene || !camera || !renderer || !world || !playerBody) return

  // === 1. Handle serial data from Python backend ===
  // Backend sends RAW data: {x, y, theta} displacement values
  // Frontend calculates world coordinates using CURRENT theta (avoids lag)
  // This matches the old NewSerialHallwayScene.vue implementation
  if (serialData.value) {
    try {
      const data = serialData.value

      // Physics constants (matching backend and old implementation)
      const ENCODER_TO_CM = 0.0364  // Conversion factor
      const DT = 1.0 / 20.0  // 20Hz sampling rate
      const MAX_LINEAR_VELOCITY = 100  // m/s

      // Get raw displacement values from backend
      const rawX = parseFloat(data.x) || 0
      const rawY = parseFloat(data.y) || 0
      const rawTheta = parseFloat(data.theta) || 0

      // Convert displacement to velocity (same as old implementation)
      const vx = Math.min(Math.max(rawX * ENCODER_TO_CM / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
      const vy = Math.min(Math.max(rawY * ENCODER_TO_CM / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)

      // Calculate world velocities using CURRENT theta (key difference from backend calculation)
      // This uses position.value.theta which is the current frame's theta, not lagged
      // Formula matches exactly NewSerialHallwayScene.vue lines 104-105
      const worldVx = -vx * Math.cos(position.value.theta) - vy * Math.sin(position.value.theta)
      const worldVz = vx * Math.sin(position.value.theta) - vy * Math.cos(position.value.theta)

      // Apply world velocity to physics body
      playerBody.setLinvel({
        x: worldVx,
        y: playerBody.linvel().y,  // Preserve vertical velocity (gravity)
        z: worldVz
      }, true)

      // Handle rotation (same as before)
      const deltaTheta = rawTheta * 0.05
      position.value.theta += deltaTheta
      playerBody.setRotation({
        x: 0,
        y: position.value.theta,
        z: 0
      }, true)

      // EVENT-DRIVEN: Mark that we need to send position update after physics step
      pendingSerialData = data
      serialData.value = null
    } catch (err) {
      console.error('Error processing serial data:', err)
    }
  }

  // === 2. Handle backend position confirmation (for resets) ===
  if (pendingBackendPosition.value) {
    const backend = pendingBackendPosition.value
    
    // Check if this is a reset command (action === 'set')
    if (backend.action === 'set') {
      // Reset command: teleport player to specified position
      playerBody.setTranslation({
        x: backend.x,
        y: backend.y,
        z: backend.z
      }, true)

      // Clear velocity
      playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)

      position.value.theta = backend.theta
      playerBody.setRotation({
        x: 0,
        y: backend.theta,
        z: 0
      }, true)

      // Update camera immediately
      if (fixedCam) {
        fixedCam.update({
          position: new THREE.Vector3(
            backend.x,
            backend.y + 1.6,
            backend.z
          ),
          rotation: backend.theta
        })
      }
      
      console.log('Player reset to:', backend.x, backend.y, backend.z)
    }
    // action === 'update' means normal confirmation, no action needed

    pendingBackendPosition.value = null
  }

  // === 3. Step physics world ===
  world.step()

  // === 4. Update position tracking from physics ===
  const bodyPosition = playerBody.translation()

  position.value.x = bodyPosition.x
  position.value.y = bodyPosition.z  // Three.js Z is our game Y

  // === 5. Update camera to follow player ===
  if (fixedCam) {
    fixedCam.update({
      position: new THREE.Vector3(
        bodyPosition.x,
        bodyPosition.y + 1.6,  // Eye height
        bodyPosition.z
      ),
      rotation: position.value.theta
    })
  }

  // === 6. EVENT-DRIVEN: Send position update after processing serial data ===
  // Only send when we have new serial data that was just processed
  if (pendingSerialData && backendClient && backendClient.connected) {
    const posUpdate = {
      seq: pendingSerialData.seq,  // Include sequence number for matching
      x: bodyPosition.x,
      y: bodyPosition.y,  // Height
      z: bodyPosition.z,  // Forward/backward
      theta: position.value.theta
    }

    backendClient.send('position_update', posUpdate)
    pendingSerialData = null  // Clear after sending
  }

  // === 7. Render ===
  renderer.render(scene, camera)
}

// Handle incoming serial data from Python backend
function handleSerialData(data) {
  serialData.value = data
  lastSerialData.value = data

  if (!serialConnected.value) {
    serialConnected.value = true
  }
}

// Handle experiment state updates (for status display only, NOT for motion control)
// Motion is controlled exclusively by serial_data events
function handleExperimentState(stateData) {
  // Update display position (for info panel only)
  if (stateData.player?.position) {
    position.value.x = stateData.player.position[0]
    position.value.y = stateData.player.position[1]
    position.value.theta = stateData.player.position[3]
  }

  // Update experiment status
  if (stateData.state === 'running') {
    experimentRunning.value = true
  } else if (stateData.state === 'stopped') {
    experimentRunning.value = false
  }

  // Update serial port info
  if (stateData.serial_port) {
    serialPort.value = stateData.serial_port
  }

  if (stateData.serial_connected !== undefined) {
    serialConnected.value = stateData.serial_connected
  }

  if (stateData.serial_data_rate !== undefined) {
    dataRate.value = stateData.serial_data_rate
  }
}

function onWindowResize() {
  const { camera, renderer } = state.value
  if (!camera || !renderer) return

  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

// Create scene geometry from config
async function createSceneFromConfig(scene, sceneConfig) {
  const textureLoader = new THREE.TextureLoader()

  console.log('Creating scene from config, object count:', sceneConfig.objects?.length || 0)

  // Process objects from config
  if (sceneConfig.objects) {
    for (const objConfig of sceneConfig.objects) {
      console.log('Creating object:', objConfig.name, 'type:', objConfig.geometry.type)
      let geometry

      // Create geometry based on type
      switch (objConfig.geometry.type) {
        case 'box':
          geometry = new THREE.BoxGeometry(
            objConfig.geometry.width || 1,
            objConfig.geometry.height || 1,
            objConfig.geometry.depth || 1
          )
          break
        case 'sphere':
          geometry = new THREE.SphereGeometry(
            objConfig.geometry.radius || 1,
            objConfig.geometry.segments || 32
          )
          break
        case 'cylinder':
          geometry = new THREE.CylinderGeometry(
            objConfig.geometry.radiusTop || 1,
            objConfig.geometry.radiusBottom || 1,
            objConfig.geometry.height || 1
          )
          break
        default:
          console.warn(`Unsupported geometry type: ${objConfig.geometry.type}`)
          continue
      }

      // Create material
      const material = new THREE.MeshStandardMaterial({
        color: objConfig.material?.color || 0xffffff,
        metalness: objConfig.material?.metalness || 0,
        roughness: objConfig.material?.roughness || 1
      })

      // Load texture if specified
      if (objConfig.material?.map) {
        try {
          // Use texture path directly from JSON (should already be in standard format)
          const texturePath = objConfig.material.map

          console.log('Loading texture:', texturePath)

          const texture = await new Promise((resolve, reject) => {
            textureLoader.load(
              texturePath,
              resolve,
              undefined,
              reject
            )
          })

          if (objConfig.material.repeat) {
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.RepeatWrapping
            texture.repeat.set(
              objConfig.material.repeat.x,
              objConfig.material.repeat.y
            )
          }

          material.map = texture
          material.needsUpdate = true
          console.log('Texture loaded successfully')
        } catch (error) {
          console.warn(`Failed to load texture: ${objConfig.material.map}, using flat color instead`, error.message)
          // Continue with flat color material
        }
      }

      // Create mesh
      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(
        objConfig.position?.x || 0,
        objConfig.position?.y || 0,
        objConfig.position?.z || 0
      )
      mesh.rotation.set(
        objConfig.rotation?.x || 0,
        objConfig.rotation?.y || 0,
        objConfig.rotation?.z || 0
      )
      mesh.castShadow = objConfig.castShadow || false
      mesh.receiveShadow = objConfig.receiveShadow || false

      scene.add(mesh)
      state.value.sceneObjects.push(mesh)
      console.log('Object created and added to scene:', objConfig.name)
    }
  }

  console.log('Scene creation complete, total objects:', state.value.sceneObjects.length)
}

// Create physics colliders from scene objects
function createPhysicsFromConfig(world, sceneConfig) {
  if (!sceneConfig.objects) return

  for (const objConfig of sceneConfig.objects) {
    // Only create colliders for physics-enabled objects
    if (!objConfig.physics?.enabled) continue

    const bodyDesc = objConfig.physics.type === 'dynamic'
      ? RAPIER.RigidBodyDesc.dynamic()
      : RAPIER.RigidBodyDesc.fixed()

    bodyDesc.setTranslation(
      objConfig.position?.x || 0,
      objConfig.position?.y || 0,
      objConfig.position?.z || 0
    )

    const body = world.createRigidBody(bodyDesc)

    // Create collider based on geometry
    let colliderDesc
    switch (objConfig.geometry.type) {
      case 'box':
        colliderDesc = RAPIER.ColliderDesc.cuboid(
          (objConfig.geometry.width || 1) / 2,
          (objConfig.geometry.height || 1) / 2,
          (objConfig.geometry.depth || 1) / 2
        )
        break
      case 'sphere':
        colliderDesc = RAPIER.ColliderDesc.ball(objConfig.geometry.radius || 1)
        break
      case 'cylinder':
        colliderDesc = RAPIER.ColliderDesc.cylinder(
          (objConfig.geometry.height || 1) / 2,
          objConfig.geometry.radiusTop || 1
        )
        break
      default:
        continue
    }

    if (colliderDesc) {
      colliderDesc.setRestitution(objConfig.physics.restitution || 0)
      colliderDesc.setFriction(objConfig.physics.friction || 0.5)
      world.createCollider(colliderDesc, body)
    }
  }
}

onMounted(async () => {
  console.log('========== PythonCustomScene: Component mounting ==========')
  console.log('Initial position state:', position.value)

  if (!canvas.value) return

  try {
    // Get scene configuration
    let sceneConfig = null
    const sceneId = route.params.id
    console.log('PythonCustomScene: Scene ID:', sceneId)

    if (window.electron) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const data = await window.electron.getSceneConfig()
      console.log('PythonCustomScene: Received data:', data)

      if (data && data.config) {
        sceneConfig = data.config
        experimentFile.value = data.experimentFile
        sceneName.value = sceneConfig.name || 'Python Custom Scene'
        sceneDescription.value = sceneConfig.description || 'Custom scene with Python backend'
      }
    } else {
      const scene = scenes.find(s => s.id === sceneId)
      sceneConfig = scene?.config
      const storedFile = sessionStorage.getItem(`experimentFile_${sceneId}`)
      if (storedFile) {
        experimentFile.value = storedFile
      }
    }

    if (!sceneConfig) {
      error.value = 'Scene configuration not found'
      return
    }

    // Initialize RAPIER physics
    await RAPIER.init()

    // Create scene
    const scene = new THREE.Scene()

    // Load background if specified
    if (sceneConfig.skybox) {
      try {
        const exrLoader = new EXRLoader()
        // Use skybox path directly from JSON (should already be in standard format)
        const skyboxPath = sceneConfig.skybox

        console.log('Loading skybox from:', skyboxPath)
        const texture = await new Promise(resolve =>
          exrLoader.load(skyboxPath, resolve)
        )
        texture.mapping = THREE.EquirectangularReflectionMapping
        scene.background = texture
        scene.environment = texture
        console.log('Skybox loaded successfully')
      } catch (err) {
        console.warn('Failed to load skybox, continuing without background:', err.message)
        // Continue without skybox - not a critical error
      }
    }

    // Setup camera
    const camera = new THREE.PerspectiveCamera(
      sceneConfig.camera?.fov || 75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    )
    // Start camera at player eye level (1.6m high), looking forward
    camera.position.set(0, 1.6, 0)

    // Setup renderer
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas.value,
      antialias: true,
      toneMapping: THREE.ACESFilmicToneMapping,
      toneMappingExposure: 1.0
    })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.physicallyCorrectLights = true

    // Add lights from config or defaults
    const lights = sceneConfig.lights || [
      { type: 'ambient', color: 0xffffff, intensity: 0.5 },
      { type: 'directional', color: 0xffffff, intensity: 1, position: { x: 5, y: 5, z: 5 }, castShadow: true }
    ]

    for (const lightConfig of lights) {
      let light
      switch (lightConfig.type) {
        case 'ambient':
          light = new THREE.AmbientLight(lightConfig.color, lightConfig.intensity)
          scene.add(light)
          break
        case 'directional':
          light = new THREE.DirectionalLight(lightConfig.color, lightConfig.intensity)
          if (lightConfig.position) {
            light.position.set(lightConfig.position.x, lightConfig.position.y, lightConfig.position.z)
          }
          light.castShadow = lightConfig.castShadow || false
          scene.add(light)
          break
        case 'point':
          light = new THREE.PointLight(lightConfig.color, lightConfig.intensity, 50, 2)
          if (lightConfig.position) {
            light.position.set(lightConfig.position.x, lightConfig.position.y, lightConfig.position.z)
          }
          light.castShadow = lightConfig.castShadow || false
          scene.add(light)
          break
      }
    }

    // Create scene geometry from config
    await createSceneFromConfig(scene, sceneConfig)

    // Create physics world
    const world = new RAPIER.World({ x: 0, y: -500, z: 0 })

    // Create physics colliders from config
    createPhysicsFromConfig(world, sceneConfig)

    // Create player physics body
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, PLAYER_RADIUS, 0)
      .setLinearDamping(0)
      .setAngularDamping(0)

    const playerRigidBody = world.createRigidBody(playerBodyDesc)
    world.createCollider(
      RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
        .setRestitution(0)
        .setFriction(0),
      playerRigidBody
    )

    // Create FixedFollowCam
    const fixedCam = new FixedFollowCam(scene, camera, renderer, {
      disableMouseControl: true
    })

    // Store references
    state.value = {
      scene,
      camera,
      renderer,
      world,
      playerBody: playerRigidBody,
      fixedCam,
      sceneObjects: state.value.sceneObjects
    }

    // Set initial camera position and orientation using FixedFollowCam
    const initialPlayerPos = playerRigidBody.translation()
    fixedCam.update({
      position: new THREE.Vector3(
        initialPlayerPos.x,
        initialPlayerPos.y + 1.6, // Eye height above player
        initialPlayerPos.z
      ),
      rotation: 0 // Looking forward (along -Z axis)
    })
    console.log('Camera position:', camera.position)
    console.log('Scene children count:', scene.children.length)

    // Add window resize handler
    window.addEventListener('resize', onWindowResize)

    // Start animation loop
    animate()
    console.log('PythonCustomScene: Animation loop started')

    // Connect to Python backend
    try {
      await backendClient.connect()
      connected.value = true
      console.log('PythonCustomScene: Connected to backend')

      // Set up event listeners
      backendClient.on('serial_data', handleSerialData)
      backendClient.on('experiment_state', handleExperimentState)
      backendClient.on('position_confirm', (data) => {
        // Backend confirms position (or sends reset position)
        pendingBackendPosition.value = data
      })
      backendClient.on('error', (data) => {
        console.error('[ERROR] Backend error:', data)
        error.value = `Backend error: ${data.message || JSON.stringify(data)}`
      })
      backendClient.on('experiment_registered', (data) => {
        experimentRunning.value = true
      })
      backendClient.on('experiment_started', (data) => {
        experimentRunning.value = true
        if (data.serial_port) {
          serialPort.value = data.serial_port
        }
        if (data.serial_connected !== undefined) {
          serialConnected.value = data.serial_connected
        }
      })

      // Register (load) experiment if specified
      if (experimentFile.value) {
        const registerResponse = await backendClient.send('experiment_register', {
          filename: experimentFile.value,
          config: {}
        })

        if (registerResponse && registerResponse.type === 'experiment_registered') {
          experimentRunning.value = true
        } else if (registerResponse && registerResponse.type === 'experiment_error') {
          console.error('[ERROR] Failed to register experiment:', registerResponse.data.error)
          error.value = `Failed to load experiment: ${registerResponse.data.error}`
          return
        }
      }

      // Start experiment (just notification, actual start happens in register)
      await backendClient.send('experiment_start', {})
    } catch (err) {
      console.error('PythonCustomScene: Backend connection error:', err)
      error.value = 'Failed to connect to Python backend: ' + err.message
    }

  } catch (err) {
    console.error('PythonCustomScene: Error in setup:', err)
    error.value = err.message
  }
})

onUnmounted(async () => {
  isActive.value = false

  window.removeEventListener('resize', onWindowResize)

  // Disconnect backend with proper cleanup
  if (backendClient && backendClient.connected) {
    try {
      // Send unregister first for proper cleanup
      if (experimentRunning.value) {
        await backendClient.send('experiment_unregister', {})
      }

      // Then send stop
      await backendClient.send('experiment_stop', {})

      // Disconnect
      backendClient.disconnect()
    } catch (err) {
      console.error('[ERROR] Error during cleanup:', err)
    }
  }

  // Reset all state
  position.value = { x: 0, y: 0, theta: 0 }
  serialData.value = null
  experimentRunning.value = false

  const currentState = state.value
  if (!currentState) return

  const { scene, renderer, world, sceneObjects } = currentState

  // Clean up scene
  if (scene) {
    scene.traverse(object => {
      if (object.geometry) object.geometry.dispose()
      if (object.material) {
        if (Array.isArray(object.material)) {
          object.material.forEach(mat => mat.dispose())
        } else {
          object.material.dispose()
        }
      }
    })
  }

  // Clean up renderer
  if (renderer) {
    renderer.dispose()
  }

  // Clean up physics world
  if (world) {
    world.free()
  }
})
</script>

<style scoped>
.scene-container {
  width: 100vw;
  height: 100vh;
  position: relative;
  overflow: hidden;
}

canvas {
  width: 100%;
  height: 100%;
}

.error-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.error-content {
  background: #ff4444;
  padding: 20px;
  border-radius: 8px;
  color: white;
  text-align: center;
}

.overlay-info {
  position: absolute;
  top: 20px;
  right: 20px;
  z-index: 100;
}

.info-panel {
  background: rgba(0, 0, 0, 0.7);
  padding: 20px;
  border-radius: 8px;
  color: white;
  min-width: 250px;
}

.info-panel h3 {
  margin: 0 0 10px 0;
  text-align: center;
}

.info-panel p {
  margin: 5px 0;
}

.info-panel ul {
  margin: 0;
  padding-left: 20px;
}

.info-panel li {
  margin: 5px 0;
}
</style>
