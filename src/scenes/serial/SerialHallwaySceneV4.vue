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
        <h3>Serial Hallway Scene V4</h3>
        <p>Position:</p>
        <ul>
          <li>X: {{ position.x.toFixed(2) }}</li>
          <li>Y: {{ position.y.toFixed(2) }}</li>
          <li>θ: {{ position.theta.toFixed(2) }}</li>
        </ul>
        <div v-if="state.inPunishment" class="punishment-indicator">
          <p>TIMEOUT: {{ punishmentTimeLeft.toFixed(1) }}s</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef, computed } from 'vue'
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
const PUNISHMENT_DURATION = 5000 // 5 seconds

// Add new constants for scene setup
const FAR = 1000

// Scene state
const state = shallowRef({
  scene: null,
  camera: null,
  renderer: null,
  world: null,
  playerBody: null,
  fixedCam: null,
  punishmentCamera: null,
  punishmentScene: null,
  inPunishment: false,
  punishmentEndTime: 0
})

// Track accumulated position
const position = ref({
  x: 0,
  y: 0, 
  theta: 0
})

// Add a ref to track incoming serial data
const serialData = ref(null)

// Computed property for punishment timer display
const punishmentTimeLeft = computed(() => {
  if (!state.value.inPunishment) return 0
  return Math.max(0, (state.value.punishmentEndTime - Date.now()) / 1000)
})

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
    punishmentScene,
    punishmentCamera,
    inPunishment,
    punishmentEndTime
  } = state.value

  // Check if all required objects are initialized
  if (!scene || !camera || !renderer || !world || !playerBody) return

  // Handle any new serial data
  if (serialData.value) {
    try {
      if (!state.value.inPunishment) {
        // Normal mode processing:
        // Convert displacement to velocity by dividing by DT (using V3 scaling)
        const vx = Math.min(Math.max((parseFloat(serialData.value.x) || 0) * 0.0320 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
        const vy = Math.min(Math.max((parseFloat(serialData.value.y) || 0) * 0.0320 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
        
        // Calculate world velocities based on current orientation
        const worldVx = -vx * Math.cos(position.value.theta) - vy * Math.sin(position.value.theta)
        const worldVz = vx * Math.sin(position.value.theta) - vy * Math.cos(position.value.theta)
        
        // Normal movement when not in punishment
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

        // Update position based on physics body
        const bodyPosition = playerBody.translation()
        position.value.x = bodyPosition.x
        position.value.y = bodyPosition.z

        // Update camera using FixedCam
        state.value.fixedCam.update({
          position: new THREE.Vector3(
            bodyPosition.x,
            bodyPosition.y + 2,
            bodyPosition.z
          ),
          rotation: position.value.theta
        })

        // Check for both wall collision and maze completion (end condition)
        const wallCollisionThreshold = 18.5  // Adjusted for 40-unit wide hallway
        const hitWall = Math.abs(position.value.x) >= wallCollisionThreshold
        const reachedEnd = Math.abs(position.value.y) >= 70

        if (hitWall || reachedEnd) {
          if (reachedEnd) {
            console.log('Trial completed - delivering reward')
            // Reset the position
            position.value.x = 0
            position.value.y = 0
            position.value.theta = 0
            playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
            playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
            playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)

            // Deliver water reward only upon reaching the end
            window.electron.deliverWater()
              .then(result => {
                if (result.error) {
                  console.error('Water delivery failed:', result.error)
                } else {
                  console.log('Water delivered successfully')
                  window.electron.sendMessage('reward-delivered')
                }
              })
              .catch(error => {
                console.error('Error in water delivery:', error)
              })
          } else {
            console.log('Trial reset due to wall collision - starting punishment')
            startPunishment()
          }
        }

        // In normal mode, record the updated position information in the log
        const logData = `${position.value.x.toFixed(3)}\t${-position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\tstraight70v4\n`
        window.electron.appendToLog(logData)
      } else {
        // In punishment mode, stop all movement
        playerBody.setLinvel({ x: 0, y: playerBody.linvel().y, z: 0 }, true)
        playerBody.setRotation({ x: 0, y: position.value.theta, z: 0 }, true)
        
        // In punishment mode, log using the current coordinates
        const logData = `${position.value.x.toFixed(3)}\t${-position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\tstraight70v4\n`
        window.electron.appendToLog(logData)
      }
      // Clear the processed serial data
      serialData.value = null
    } catch (err) {
      console.error('Error processing serial data:', err)
    }
  }

  // Step physics world if not in punishment
  if (!inPunishment) {
    world.step()
  }

  // Check if punishment should end
  if (inPunishment && Date.now() >= punishmentEndTime) {
    endPunishment()
  }

  // Render appropriate scene
  if (inPunishment) {
    if (punishmentScene && punishmentCamera) {
      // Slowly rotate the punishment camera
      punishmentCamera.position.x = Math.sin(Date.now() * 0.001) * 2
      punishmentCamera.position.z = Math.cos(Date.now() * 0.001) * 2
      punishmentCamera.lookAt(0, 2, 0)
      
      renderer.render(punishmentScene, punishmentCamera)
    }
  } else {
    renderer.render(scene, camera)
  }
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

function setupPunishmentRoom() {
  // Create punishment scene
  const punishmentScene = new THREE.Scene()
  punishmentScene.background = new THREE.Color(0x000000)

  // Create punishment camera
  const punishmentCamera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  )
  punishmentCamera.position.set(0, 2, 0)
  punishmentCamera.lookAt(0, 2, -1)

  // Create a small room
  const roomGeometry = new THREE.BoxGeometry(10, 10, 10)
  const roomMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.BackSide
  })
  const room = new THREE.Mesh(roomGeometry, roomMaterial)
  punishmentScene.add(room)

  // Add dim light
  const ambientLight = new THREE.AmbientLight(0x111111)
  punishmentScene.add(ambientLight)

  // Store references
  state.value.punishmentScene = punishmentScene
  state.value.punishmentCamera = punishmentCamera
}

function startPunishment() {
  console.log('Starting punishment timeout')
  
  // Set punishment state
  state.value.inPunishment = true
  state.value.punishmentEndTime = Date.now() + PUNISHMENT_DURATION

  // Stop player movement
  const { playerBody } = state.value
  if (playerBody) {
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }
}

function endPunishment() {
  console.log('Ending punishment timeout')
  
  // End punishment state
  state.value.inPunishment = false
  state.value.punishmentEndTime = 0

  // Reset position to origin
  position.value.x = 0
  position.value.y = 0
  position.value.theta = 0

  const { playerBody } = state.value
  if (playerBody) {
    playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
    playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
  }
}

// Add function to create hallway geometry (same as V3 but with walls)
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

  // Add walls
  const wallGeometry = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, HALLWAY_LENGTH)
  
  // Left wall
  const leftWall = new THREE.Mesh(wallGeometry, sideWallMaterial)
  leftWall.position.set(-HALLWAY_WIDTH/2, WALL_HEIGHT/2, 0)
  leftWall.receiveShadow = true
  leftWall.castShadow = true
  scene.add(leftWall)

  // Right wall
  const rightWall = new THREE.Mesh(wallGeometry, sideWallMaterial)
  rightWall.position.set(HALLWAY_WIDTH/2, WALL_HEIGHT/2, 0)
  rightWall.receiveShadow = true
  rightWall.castShadow = true
  scene.add(rightWall)

  // Front and back walls
  const endWallGeometry = new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_HEIGHT, WALL_THICKNESS)
  
  const frontWall = new THREE.Mesh(endWallGeometry, sideWallMaterial)
  frontWall.position.set(0, WALL_HEIGHT/2, HALLWAY_LENGTH/2)
  frontWall.receiveShadow = true
  frontWall.castShadow = true
  scene.add(frontWall)

  const backWall = new THREE.Mesh(endWallGeometry, sideWallMaterial)
  backWall.position.set(0, WALL_HEIGHT/2, -HALLWAY_LENGTH/2)
  backWall.receiveShadow = true
  backWall.castShadow = true
  scene.add(backWall)
}

onMounted(async () => {
  console.log('SerialHallwaySceneV4 mounting...')
  
  if (canvas.value) {
    try {
      // Initialize physics
      await RAPIER.init()
      
      // Create scene
      const scene = new THREE.Scene()
      
      // Add background loading (same as V3)
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

      // Setup renderer with HDR (same as V3)
      const renderer = new THREE.WebGLRenderer({ 
        canvas: canvas.value, 
        antialias: true,
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.0
      })
      renderer.setSize(window.innerWidth, window.innerHeight)
      renderer.shadowMap.enabled = true
      renderer.physicallyCorrectLights = true

      // Add lights (same as V3)
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

      // Create hallway geometry (same as V3 but with walls)
      await createHallway(scene)

      // Create physics world
      const physicsWorld = new RAPIER.World({ x: 0, y: -500, z: 0 })

      // Create physics floor that matches the visual segments
      const floorBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())

      // Main floor segment
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          HALLWAY_WIDTH / 2,
          WALL_THICKNESS / 2,
          HALLWAY_LENGTH/2
        ),
        floorBody
      )

      // Left wall
      const leftWallBody = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(-HALLWAY_WIDTH/2, WALL_HEIGHT/2, 0)
      )
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          WALL_THICKNESS / 2,
          WALL_HEIGHT / 2,
          HALLWAY_LENGTH / 2
        ),
        leftWallBody
      )

      // Right wall
      const rightWallBody = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(HALLWAY_WIDTH/2, WALL_HEIGHT/2, 0)
      )
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          WALL_THICKNESS / 2,
          WALL_HEIGHT / 2,
          HALLWAY_LENGTH / 2
        ),
        rightWallBody
      )

      // Front wall
      const frontWallBody = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, WALL_HEIGHT/2, HALLWAY_LENGTH/2)
      )
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          HALLWAY_WIDTH / 2,
          WALL_HEIGHT / 2,
          WALL_THICKNESS / 2
        ),
        frontWallBody
      )

      // Back wall
      const backWallBody = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, WALL_HEIGHT/2, -HALLWAY_LENGTH/2)
      )
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          HALLWAY_WIDTH / 2,
          WALL_HEIGHT / 2,
          WALL_THICKNESS / 2
        ),
        backWallBody
      )

      // Create player physics body (same settings as V3)
      const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, PLAYER_RADIUS, 0)
        .setLinearDamping(0)
        .setAngularDamping(0)

      const playerRigidBody = physicsWorld.createRigidBody(playerBodyDesc)
      physicsWorld.createCollider(
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
        world: physicsWorld,
        playerBody: playerRigidBody,
        fixedCam: new FixedFollowCam(scene, camera, renderer, {
          disableMouseControl: true
        }),
        punishmentScene: null,
        punishmentCamera: null,
        inPunishment: false,
        punishmentEndTime: 0
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
        console.log('Hallway V4 received serial data:', data)
        if (!state.value.playerBody) {
          console.log('Player body not ready, skipping update')
          return
        }
        updateFromSerial(data)
      })
      console.log('Serial data handler set up')

      // Setup punishment room
      setupPunishmentRoom()

    } catch (err) {
      console.error('Error in setup:', err)
      error.value = err.message
    }
  }
})

onUnmounted(() => {
  console.log('SerialHallwaySceneV4 unmounting...')
  
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

  const { punishmentScene } = state.value
  if (punishmentScene) {
    punishmentScene.traverse(object => {
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

.punishment-indicator {
  margin-top: 15px;
  padding: 10px;
  background: rgba(255, 0, 0, 0.3);
  border-radius: 4px;
  text-align: center;
  font-weight: bold;
}

.punishment-indicator p {
  margin: 0;
  color: #ff6666;
}
</style>