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
import { HallwayWorld } from '../../worlds/HallwayWorld.js'
import { FixedFollowCam } from '@/utils/FixedFollowCam.js'
import RAPIER from '@dimforge/rapier3d-compat'

const canvas = ref(null)
const error = ref(null)
const isActive = ref(true)
const HALLWAY_LENGTH = 200
const HALLWAY_WIDTH = 20
const WALL_HEIGHT = 10
const WALL_THICKNESS = 1
const BLUE_SEGMENT_LENGTH = 30
const PLAYER_RADIUS = 0.5
const MAX_LINEAR_VELOCITY = 100 // meters per second
const DT = 1/20 // 20Hz sampling rate
const PUNISHMENT_ROOM_SIZE = 10
const PUNISHMENT_DURATION = 5000 // 5 seconds

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
        // Convert the current displacement into velocity by dividing by DT
        const vx = Math.min(Math.max((parseFloat(serialData.value.x) || 0) * 0.0364 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
        const vy = Math.min(Math.max((parseFloat(serialData.value.y) || 0) * 0.0364 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
        
        // Calculate velocity in world coordinates based on the current angle
        const worldVx = vx * Math.cos(position.value.theta) - vy * Math.sin(position.value.theta)
        const worldVz = -vx * Math.sin(position.value.theta) - vy * Math.cos(position.value.theta)
        
        // Directly set the calculated velocity to the physics body
        playerBody.setLinvel({ x: worldVx, y: 0, z: worldVz }, true)

        // Update the tracking position based on the physics body's position
        const bodyPosition = playerBody.translation()
        position.value.x = bodyPosition.x
        position.value.y = bodyPosition.z

        // Process the change in angle
        const deltaTheta = (parseFloat(serialData.value.theta) || 0) * 0.05
        position.value.theta += deltaTheta
        playerBody.setRotation({ x: 0, y: position.value.theta, z: 0 }, true)

        // Update the follow camera based on the player's current position and rotation
        state.value.fixedCam.update({
          position: new THREE.Vector3(bodyPosition.x, bodyPosition.y + 2, bodyPosition.z),
          rotation: position.value.theta
        })

        // Check for both wall collision and maze completion (end condition)
        const wallCollisionThreshold = 8.5  // Slightly less than the theoretical maximum
        const hitWall = Math.abs(position.value.x) >= wallCollisionThreshold
        const reachedEnd = Math.abs(position.value.y) >= 70

        if (hitWall || reachedEnd) {
          if (reachedEnd) {
            console.log('Trial completed - delivering reward')
            // Reset the position
            position.value.x = 0
            position.value.y = 0
            position.value.theta = 0
            playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
            playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)

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
            position.value.x = 0
            position.value.y = 0
            position.value.theta = 0
            playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
            playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
            startPunishment()
          }
        }

        // In normal mode, record the updated position information in the log
        const logData = `${position.value.x.toFixed(3)}\t${-position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\n`
        window.electron.appendToLog(logData)
      } else {
        // In punishment mode, the physics state remains at the origin; log using the origin coordinates
        const origin = { x: 0, y: 0, theta: 0 }
        const logData = `${origin.x.toFixed(3)}\t${-origin.y.toFixed(3)}\t${origin.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\n`
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

  // Render appropriate scene
  if (inPunishment) {
    // Calculate and display remaining punishment time
    const timeLeft = Math.max(0, (punishmentEndTime - Date.now()) / 1000)
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
  const roomGeometry = new THREE.BoxGeometry(
    PUNISHMENT_ROOM_SIZE,
    PUNISHMENT_ROOM_SIZE,
    PUNISHMENT_ROOM_SIZE
  )
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
  const { playerBody } = state.value
  
  // Store original position for restoration after punishment
  const originalPos = {
    x: position.value.x,
    y: position.value.y,
    theta: position.value.theta
  }

  // Set punishment state
  state.value.inPunishment = true
  state.value.punishmentEndTime = Date.now() + PUNISHMENT_DURATION

  // Reset position during punishment
  position.value.x = 0
  position.value.y = 0
  position.value.theta = 0
  
  // Update physics body
  playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
  playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)

  // Schedule end of punishment
  setTimeout(() => {
    state.value.inPunishment = false
    
    // Return to original position
    position.value = originalPos
    playerBody.setTranslation(
      { x: originalPos.x, y: 2, z: originalPos.y },
      true
    )
    playerBody.setRotation(
      { x: 0, y: originalPos.theta, z: 0 },
      true
    )
  }, PUNISHMENT_DURATION)
}

onMounted(async () => {
  console.log('Component mounting...')
  
  if (canvas.value) {
    try {
      // Initialize physics first
      console.log('Initializing RAPIER...')
      await RAPIER.init()
      
      // Initialize world (this creates the visual hallway)
      console.log('Initializing HallwayWorld...')
      const world = new HallwayWorld(canvas.value, {
        useOrbitControls: false,
        frameRate: 60
      })
      await world.init()
      console.log('HallwayWorld initialized successfully')

      // Create physics world
      const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 })

      // Add physics colliders without visual meshes
      // Floor
      const floorBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.cuboid(
          HALLWAY_WIDTH / 2,
          WALL_THICKNESS / 2,
          HALLWAY_LENGTH / 2
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

      // Create player physics body
      const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, PLAYER_RADIUS, 0)
        .setLinearDamping(0.9)
        .setAngularDamping(0.9)

      const playerRigidBody = physicsWorld.createRigidBody(playerBodyDesc)
      physicsWorld.createCollider(
        RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
          .setRestitution(0)
          .setFriction(1),
        playerRigidBody
      )

      // Store references
      state.value = {
        scene: world.scene,
        camera: world.camera,
        renderer: world.renderer,
        world: physicsWorld,
        playerBody: playerRigidBody,
        fixedCam: new FixedFollowCam(world.scene, world.camera, world.renderer, {
          disableMouseControl: true
        }),
        punishmentScene: null,
        punishmentCamera: null,
        inPunishment: false,
        punishmentEndTime: 0
      }

      // Set initial camera position
      world.camera.position.set(0, 4, 0)
      world.camera.lookAt(0, 0, -10)

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

      // Setup punishment room
      setupPunishmentRoom()

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
</style>