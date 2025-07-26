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
      const vx = Math.min(Math.max((parseFloat(serialData.value.x) || 0) * 0.0465 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
      const vy = Math.min(Math.max((parseFloat(serialData.value.y) || 0) * 0.0465 / DT, -MAX_LINEAR_VELOCITY), MAX_LINEAR_VELOCITY)
      
      // Calculate world velocities based on current orientation
      const worldVx = -vx * Math.cos(position.value.theta) - vy * Math.sin(position.value.theta)
      const worldVz = vx * Math.sin(position.value.theta) - vy * Math.cos(position.value.theta)

      // Set linear velocity directly on physics body
      playerBody.setLinvel({
        x: worldVx,
        y: 0,
        z: worldVz
      }, true)

      // Update position based on physics body
      const bodyPosition = playerBody.translation()
      position.value.x = bodyPosition.x
      position.value.y = bodyPosition.z

      // Handle rotation separately (direct angle control)
      const deltaTheta = (parseFloat(serialData.value.theta) || 0) * 0.05
      position.value.theta += deltaTheta

      // // Keep theta within -π to π
      // if (position.value.theta > Math.PI) {
      //   position.value.theta -= 2 * Math.PI
      // } else if (position.value.theta < -Math.PI) {
      //   position.value.theta += 2 * Math.PI
      // }

      // Set rotation directly
      playerBody.setRotation({
        x: 0,
        y: position.value.theta,
        z: 0
      }, true)

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
      const logData = `${position.value.x.toFixed(3)}\t${-position.value.y.toFixed(3)}\t${position.value.theta.toFixed(3)}\t${serialData.value.x || 0}\t${serialData.value.y || 0}\t${serialData.value.water ? 1 : 0}\t${serialData.value.timestamp}\tstraight70\n`
      window.electron.appendToLog(logData)

      // Clear the processed serial data
      serialData.value = null

      // Check if we should reset the trial
      if (Math.abs(position.value.y) >= 70) {
        // Reset position
        position.value.x = 0
        position.value.y = 0
        position.value.theta = 0

        // Reset player position
        playerBody.setTranslation({ x: 0, y: 2, z: 0 }, true)
        playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
        console.log('Trial reset due to Y position limit')

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
        })
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