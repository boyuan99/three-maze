<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    
    <div v-if="error" class="error-overlay">
      <div class="error-content">
        <h3>Serial Error</h3>
        <p>{{ error }}</p>
      </div>
    </div>

    <!-- Info overlay -->
    <div class="overlay-info">
      <div class="info-panel">
        <h3>Serial Hallway Scene</h3>
        <p>Position:</p>
        <ul>
          <li>X: {{ position.x.toFixed(2) }}</li>
          <li>Y: {{ position.y.toFixed(2) }}</li>
          <li>θ: {{ position.theta.toFixed(2) }}</li>
        </ul>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import { FixedFollowCam } from '@/utils/FixedFollowCam.js'
import RAPIER from '@dimforge/rapier3d-compat'
import wallTextureUrl from '@/assets/Chess_Pattern.jpg'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader'
import backgroundExr from '@/assets/evening_road_01_puresky_1k.exr'

const canvas = ref(null)
const error = ref(null)
const isActive = ref(true)
const HALLWAY_LENGTH = 200
const HALLWAY_WIDTH = 40
const WALL_HEIGHT = 10
const WALL_THICKNESS = 1
const BLUE_SEGMENT_LENGTH = 30
const PLAYER_RADIUS = 0.5
const MAX_LINEAR_VELOCITY = 100 // meters per second
const DT = 1/20 // 20Hz sampling rate

// Scene state
const state = shallowRef({
  scene: null,
  camera: null,
  renderer: null,
  world: null,
  playerBody: null,
  fixedCam: null,
})

// Track accumulated position
const position = ref({
  x: 0,
  y: 0, 
  theta: 0
})

// Add a ref to track incoming serial data
const serialData = ref(null)

// Add new constants for scene setup
const FAR = 1000

// Add fall detection state
const fallStartTime = ref(null)
const FALL_RESET_TIME = 5000

// Animation loop
function animate() {
  if (!isActive.value) return
  
  requestAnimationFrame(animate)

  const {
    scene,
    camera,
    renderer,
    world,
    playerBody,
    fixedCam
  } = state.value

  // Check if all required objects are initialized
  if (!scene || !camera || !renderer || !world || !playerBody) return

  // Handle any new serial data
  if (serialData.value) {
    try {
      // Convert displacement to velocity by dividing by DT
      const vx = Math.min(Math.max((parseFloat(serialData.value.x) || 0) * 0.0364 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
      const vy = Math.min(Math.max((parseFloat(serialData.value.y) || 0) * 0.0364 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
      
      // Calculate world velocities based on current orientation
      const worldVx = vx * Math.cos(position.value.theta) - vy * Math.sin(position.value.theta)
      const worldVz = -vx * Math.sin(position.value.theta) - vy * Math.cos(position.value.theta)

      // Only allow movement if not falling
      if (fallStartTime.value) {
        // If falling, only preserve vertical velocity and stop rotation
        playerBody.setLinvel({
          x: 0,
          y: playerBody.linvel().y,
          z: 0
        }, true)
        
        // Keep the current rotation frozen while falling
        playerBody.setRotation({
          x: 0,
          y: position.value.theta,
          z: 0
        }, true)
        
      } else {
        // Normal movement when not falling
        playerBody.setLinvel({
          x: worldVx,
          y: playerBody.linvel().y,
          z: worldVz
        }, true)
        
        // Handle rotation separately (direct angle control)
        const deltaTheta = (parseFloat(serialData.value.theta) || 0) * 0.05
        position.value.theta += deltaTheta
        
        // Set rotation directly
        playerBody.setRotation({
          x: 0,
          y: position.value.theta,
          z: 0
        }, true)
      }

      // Update position based on physics body
      const bodyPosition = playerBody.translation()
      position.value.x = bodyPosition.x
      position.value.y = bodyPosition.z

      // Update camera using FixedCam
      fixedCam.update({
        position: new THREE.Vector3(
          bodyPosition.x,
          bodyPosition.y + 2,
          bodyPosition.z
        ),
        rotation: position.value.theta
      })

      // Prepare and log data
      const logData = `${position.value.x.toFixed(3)}\t${-position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\n`
      window.electron.appendToLog(logData)

      // Clear the processed serial data
      serialData.value = null

      // Add fall detection and reset logic
      const currentY = playerBody.translation().y
      
      if (currentY < PLAYER_RADIUS && !fallStartTime.value) {
        // Start tracking fall time
        fallStartTime.value = Date.now()
      } else if (currentY >= PLAYER_RADIUS) {
        // Reset fall timer when not falling
        fallStartTime.value = null
      }

      // Check if we've been falling for too long
      if (fallStartTime.value && (Date.now() - fallStartTime.value > FALL_RESET_TIME)) {
        // Reset position
        playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
        playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
        
        // Reset rotation and theta
        position.value.theta = 0
        playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
        
        fallStartTime.value = null
        console.log('Reset position due to fall timeout')
      }

      // Check if we should reset the trial
      if (Math.abs(position.value.y) >= 70) {
        // Reset position
        position.value.x = 0
        position.value.y = 0
        position.value.theta = 0

        // Reset player position - start slightly above ground
        playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
        playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
        playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true) 
        console.log('Trial reset due to position limit or fall')

        // Deliver water reward after position reset
        window.electron.deliverWater()
          .then(result => {
            if (result.error) {
              console.error('Water delivery failed:', result.error)
            } else {
              console.log('Water delivered successfully')
              // Notify main process about reward delivery
              window.electron.sendMessage('reward-delivered')
            }
          })
          .catch(error => {
            console.error('Error in water delivery:', error)
          })
      }
    } catch (err) {
      console.error('Error processing serial data:', err)
    }
  }

  // Step physics world
  world.step()

  renderer.render(scene, camera)
}

// Handle incoming serial data
const updateFromSerial = (data) => {
  console.log('Received serial data:', data)
  serialData.value = data
}

function onWindowResize() {
  const { camera, renderer } = state.value
  if (!camera || !renderer) return
  
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

// Add function to create hallway geometry
async function createHallway(scene) {
  // Load texture
  const textureLoader = new THREE.TextureLoader()
  const pictureTexture = await new Promise(resolve =>
    textureLoader.load(wallTextureUrl, resolve)
  )

  pictureTexture.wrapS = THREE.RepeatWrapping
  pictureTexture.wrapT = THREE.RepeatWrapping
  pictureTexture.repeat.set(HALLWAY_WIDTH / 100, HALLWAY_LENGTH / 100)

  // Clone texture for walls
  const wallTexture = pictureTexture.clone()
  wallTexture.repeat.set(HALLWAY_LENGTH / 100, WALL_HEIGHT / 100)

  // Materials
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: pictureTexture,
    roughness: 0.8
  })
  const sideWallMaterial = new THREE.MeshStandardMaterial({
    map: wallTexture,
    roughness: 0.8
  })
  const blueMaterial = new THREE.MeshStandardMaterial({
    color: 0x0000ff,
    roughness: 0.7,
    metalness: 0.2
  })

  // Create floor
  const floorGeometry = new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_THICKNESS, HALLWAY_LENGTH - 2 * BLUE_SEGMENT_LENGTH)
  const floorMesh = new THREE.Mesh(floorGeometry, floorMaterial)
  floorMesh.position.set(0, -WALL_THICKNESS / 2, 0)
  floorMesh.receiveShadow = true
  scene.add(floorMesh)

  // Create blue floor ends
  const blueFloorGeometry = new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_THICKNESS, BLUE_SEGMENT_LENGTH)

  const blueFloor1 = new THREE.Mesh(blueFloorGeometry, blueMaterial)
  blueFloor1.position.set(0, -WALL_THICKNESS / 2, HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2)
  blueFloor1.receiveShadow = true
  scene.add(blueFloor1)

  const blueFloor2 = new THREE.Mesh(blueFloorGeometry, blueMaterial)
  blueFloor2.position.set(0, -WALL_THICKNESS / 2, -(HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2))
  blueFloor2.receiveShadow = true
  scene.add(blueFloor2)

}

// Modify onMounted to initialize scene directly
onMounted(async () => {
  console.log('Component mounting...')
  
  if (canvas.value) {
    try {
      // Initialize physics
      await RAPIER.init()
      
      // Create scene
      const scene = new THREE.Scene()
      
      // Add background loading
      const exrLoader = new EXRLoader()
      const texture = await new Promise(resolve => 
        exrLoader.load(backgroundExr, resolve)
      )
      texture.mapping = THREE.EquirectangularReflectionMapping
      scene.background = texture
      scene.environment = texture

      // Setup camera
      const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, FAR)
      camera.position.set(0, 4, 0)

      // Setup renderer with HDR
      const renderer = new THREE.WebGLRenderer({ 
        canvas: canvas.value, 
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,  // Better HDR tone mapping
        toneMappingExposure: 1.0  // Adjust this value to control brightness
      })
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.shadowMap.enabled = true
      renderer.physicallyCorrectLights = true

      // Add lights
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.5)
      scene.add(ambientLight)

      const lights = [
        { pos: new THREE.Vector3(0, 5, 0) },
        { pos: new THREE.Vector3(0, 5, -50) },
        { pos: new THREE.Vector3(0, 5, 50) }
      ]

      lights.forEach(light => {
        const pointLight = new THREE.PointLight(0xffffff, 1, 50, 2)
        pointLight.position.copy(light.pos)
        pointLight.castShadow = true
        scene.add(pointLight)
      })

      // Create hallway geometry
      await createHallway(scene)

      // Create physics world
      const world = new RAPIER.World({ x: 0, y: -500, z: 0 })

      // Create physics floor that matches the visual segments
      const floorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed())

      // Main floor segment
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          HALLWAY_WIDTH / 2,
          WALL_THICKNESS / 2,
          HALLWAY_LENGTH/2
        ),
        floorBody
      )

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

      // Store references
      state.value = {
        scene,
        camera,
        renderer,
        world,
        playerBody: playerRigidBody,
        fixedCam: new FixedFollowCam(scene, camera, renderer, {
          disableMouseControl: true
        })
      }

      // Set initial camera position
      camera.lookAt(0, 0, -10)

      // Add window resize handler
      window.addEventListener('resize', onWindowResize)
      console.log('Window resize handler added')
      
      // Start animation loop first
      animate()
      console.log('Animation loop started')

      // Initialize serial connection
      console.log('Initializing serial connection...')
      const result = await window.electron.initializeJsSerial()
      if (result.error) {
        console.error('Serial initialization failed:', result.error)
        error.value = result.error
        return
      }
      console.log('Serial connection initialized successfully')

      // Set up serial data handler
      window.electron.onSerialData((data) => {
        console.log('Hallway received serial data:', data)
        if (!state.value.playerBody) {
          console.log('Player body not ready, skipping update')
          return
        }
        updateFromSerial(data)
      })
      console.log('Serial data handler set up')

    } catch (err) {
      console.error('Error in setup:', err)
      error.value = err.message
    }
  }
})

onUnmounted(() => {
  console.log('Component unmounting...')
  
  isActive.value = false
  console.log('Animation loop stopped')
  
  window.removeEventListener('resize', onWindowResize)
  console.log('Window resize handler removed')

  const currentState = state.value
  if (!currentState) {
    console.log('No state to clean up')
    return
  }

  const { scene, renderer, world } = currentState

  // Clean up scene
  if (scene) {
    console.log('Cleaning up scene...')
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
    console.log('Disposing renderer...')
    renderer.dispose()
  }

  // Clean up physics world
  if (world) {
    console.log('Freeing physics world...')
    world.free()
  }

  // Close serial connection
  console.log('Closing serial connection...')
  window.electron.closeJsSerial()
    .then(() => console.log('Serial connection closed successfully'))
    .catch(err => console.error('Error closing serial connection:', err))
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
  min-width: 200px;
}

.info-panel h3 {
  margin: 0 0 15px 0;
  text-align: center;
}

.info-panel ul {
  margin: 0;
  padding-left: 20px;
}

.info-panel li {
  margin: 5px 0;
}
</style>