<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    
    <!-- Add the pointer lock overlay -->
    <div v-if="!isPointerLocked" class="scene-overlay" @click="canvas.requestPointerLock()">
      <div class="activate-prompt">
        Click anywhere to activate controls
      </div>
    </div>

    <!-- Info overlay -->
    <div class="overlay-info" v-if="showInfo">
      <div class="info-panel">
        <h3>Hallway Control Scene</h3>
        <p>Position:</p>
        <ul>
          <li>X: {{ position.x.toFixed(2) }}</li>
          <li>Y: {{ position.y.toFixed(2) }}</li>
          <li>Z: {{ position.z.toFixed(2) }}</li>
          <li>θ: {{ position.theta.toFixed(2) }}</li>
        </ul>
        <p>Controls:</p>
        <ul>
          <li>WASD - Move around</li>
          <li>Mouse - Look around</li>
          <li>Click - Unlock mouse</li>
          <li>ESC - Release mouse</li>
        </ul>
      </div>
      <button class="toggle-info" @click="showInfo = false">Hide Info</button>
    </div>
    <button v-else class="toggle-info-mini" @click="showInfo = true">Show Info</button>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import wallTextureUrl from '@/assets/Chess_Pattern.jpg'
import { FixedCam } from '@/utils/FixedCam.js'
import { KeyboardController } from '@/utils/KeyboardController.js'
import { RapierDebugRenderer } from "@/utils/RapierDebugRenderer.js"
import RAPIER from '@dimforge/rapier3d-compat'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import skyboxUrl from '@/assets/evening_road_01_puresky_1k.exr'

defineOptions({
  name: 'NewHallwayControlScene'
})

// Constants
const HALLWAY_LENGTH = 200
const HALLWAY_WIDTH = 40
const WALL_HEIGHT = 10
const WALL_THICKNESS = 1
const BLUE_SEGMENT_LENGTH = 30
const PLAYER_RADIUS = 0.5

// Preview generator (exported for use in index.js)
const generatePreview = async (width = 300, height = 200) => {
  const tempCanvas = document.createElement('canvas')
  tempCanvas.width = width
  tempCanvas.height = height
  canvas.value = tempCanvas

  await init()
  const { scene, camera, renderer, world } = state.value
  
  // Adjust camera for preview
  camera.position.set(50, 30, 50)
  camera.lookAt(0, 0, 0)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  
  renderer.setSize(width, height)
  renderer.render(scene, camera)
  
  const preview = tempCanvas.toDataURL('image/png')
  
  // Cleanup
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

  if (renderer) {
    renderer.dispose()
  }

  if (world) {
    world.free()
  }
  
  // Reset state and canvas
  state.value = {
    scene: null,
    camera: null,
    renderer: null,
    world: null,
    playerBody: null,
    fixedCam: null,
    keyboard: null,
    debugRenderer: null,
  }
  canvas.value = null

  return preview
}

// Make generatePreview available for external use
defineExpose({ generatePreview })

// Component state
const canvas = ref(null)
const isActive = ref(true)
const showInfo = ref(true)
const isPointerLocked = ref(false)
const position = ref({ x: 0, y: 0, z: 0, theta: 0 })
const error = ref(null)

// Scene state
const state = shallowRef({
  scene: null,
  camera: null,
  renderer: null,
  world: null,
  playerBody: null,
  fixedCam: null,
  keyboard: null,
  debugRenderer: null,
})

// Add new state variables
const fallStartTime = ref(null)
const FALL_RESET_TIME = 3000
const FALL_TOLERANCE = 0.05;

async function createHallwaySegment(position, rotation = 0) {
  const { scene, world } = state.value
  const group = new THREE.Group()
  group.position.copy(position)
  group.rotation.y = rotation

  // Load textures
  const textureLoader = new THREE.TextureLoader()
  const pictureTexture = await new Promise(resolve =>
    textureLoader.load(wallTextureUrl, resolve)
  )

  // Configure textures
  pictureTexture.wrapS = THREE.RepeatWrapping
  pictureTexture.wrapT = THREE.RepeatWrapping
  pictureTexture.repeat.set(HALLWAY_WIDTH / 100, HALLWAY_LENGTH / 100)

  // Materials
  const floorMaterial = new THREE.MeshStandardMaterial({
    map: pictureTexture,
    roughness: 0.8
  })
  const blueMaterial = new THREE.MeshStandardMaterial({
    color: 0x0000ff,
    roughness: 0.7,
    metalness: 0.2
  })

  // Helper function to create segments
  function createSegment(geometry, material, pos, isStatic = true) {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(pos)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    if (isStatic && world) {
      const worldPos = new THREE.Vector3()
      mesh.getWorldPosition(worldPos)
      const bodyDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(worldPos.x, worldPos.y, worldPos.z)
      const body = world.createRigidBody(bodyDesc)

      const halfSize = new THREE.Vector3()
      geometry.computeBoundingBox()
      geometry.boundingBox.getSize(halfSize).multiplyScalar(0.5)

      world.createCollider(
        RAPIER.ColliderDesc.cuboid(halfSize.x, halfSize.y, halfSize.z),
        body
      )
    }
  }

  // Create main floor (middle section)
  createSegment(
    new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_THICKNESS, HALLWAY_LENGTH - 2 * BLUE_SEGMENT_LENGTH),
    floorMaterial,
    new THREE.Vector3(0, -WALL_THICKNESS / 2, 0)
  )

  // Create blue floor ends
  createSegment(
    new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_THICKNESS, BLUE_SEGMENT_LENGTH),
    blueMaterial,
    new THREE.Vector3(0, -WALL_THICKNESS / 2, HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2)
  )
  createSegment(
    new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_THICKNESS, BLUE_SEGMENT_LENGTH),
    blueMaterial,
    new THREE.Vector3(0, -WALL_THICKNESS / 2, -(HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2))
  )

  scene.add(group)
  return group
}

async function init() {
  if (!canvas.value) return

  try {
    // Initialize scene
    const scene = new THREE.Scene()
    
    // Load and set background
    const exrLoader = new EXRLoader()
    const texture = await new Promise((resolve) => 
      exrLoader.load(skyboxUrl, resolve)
    )
    texture.mapping = THREE.EquirectangularReflectionMapping
    scene.background = texture
    scene.environment = texture

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambientLight)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0)
    directionalLight.position.set(10, 20, 10)
    directionalLight.castShadow = true
    scene.add(directionalLight)

    const pointLight = new THREE.PointLight(0xffffff, 1, 50, 2)
    pointLight.position.set(0, 5, 0)
    scene.add(pointLight)

    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    )

    const renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
    renderer.setSize(window.innerWidth, window.innerHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap

    // Initialize physics
    await RAPIER.init()
    const world = new RAPIER.World({ x: 0, y: -20, z: 0 })

    // Create player
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, PLAYER_RADIUS, 0)
      .setLinearDamping(0.9)
      .setAngularDamping(0.9)

    const playerBody = world.createRigidBody(playerBodyDesc)
    world.createCollider(
      RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
        .setRestitution(0)
        .setFriction(1),
      playerBody
    )

    // First update state with the renderer
    state.value = {
      scene,
      camera,
      renderer,
      world,
      playerBody,
      fixedCam: null,
      keyboard: null,
      debugRenderer: null
    }

    // Then create controllers that need the renderer
    const keyboard = new KeyboardController(state.value.renderer)
    const fixedCam = new FixedCam(scene, camera, renderer)
    const debugRenderer = new RapierDebugRenderer(scene, world)

    // Update state with controllers
    state.value = {
      ...state.value,
      fixedCam,
      keyboard,
      debugRenderer
    }

    // Create hallway
    await createHallwaySegment(new THREE.Vector3(0, 0, 0))

    window.addEventListener('resize', onWindowResize)
  } catch (err) {
    console.error('Error in setup:', err)
    error.value = err.message
  }
}

function onWindowResize() {
  const { camera, renderer } = state.value
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

// Modify onMounted to include keyboard/mouse controls
onMounted(async () => {
  console.log('Component mounting...')
  await init()
  
  // Add pointer lock change listener
  document.addEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })

  // Add mousemove listener for camera control
  document.addEventListener('mousemove', (event) => {
    if (isPointerLocked.value && state.value.fixedCam) {
      state.value.fixedCam.onMouseMove(event)
    }
  })

  // Start animation loop
  animate()
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
    fixedCam,
    keyboard,
    debugRenderer
  } = state.value

  // Check if all required objects are initialized
  if (!scene || !camera || !renderer || !world || !playerBody) return

  // Handle keyboard input
  const moveDirection = new THREE.Vector3(0, 0, 0)
  const speed = 35

  if (keyboard.keyMap['KeyW']) moveDirection.z -= 1
  if (keyboard.keyMap['KeyS']) moveDirection.z += 1
  if (keyboard.keyMap['KeyA']) moveDirection.x -= 1
  if (keyboard.keyMap['KeyD']) moveDirection.x += 1

  moveDirection.normalize().multiplyScalar(speed)
  moveDirection.applyEuler(new THREE.Euler(0, fixedCam.yaw.rotation.y, 0))

  // Directly set velocity instead of applying force
  playerBody.setLinvel(
    {
      x: moveDirection.x,
      y: playerBody.linvel().y, // Preserve vertical velocity for gravity
      z: moveDirection.z
    },
    true
  )

  // Retrieve the current physics position
  const bodyPosition = playerBody.translation();

  // Update the tracked horizontal position only when not falling
  if (!fallStartTime.value) {
    // Store the stable x (physics x) and stable z (stored in position.y)
    position.value.x = bodyPosition.x;
    position.value.y = bodyPosition.z;
  }

  // Always update the view direction (theta)
  position.value.theta = fixedCam.yaw.rotation.y;

  // Update the camera position differently based on whether the player is falling or not
  if (!fallStartTime.value) {
    // Normal update uses the live physics position
    fixedCam.update({
        position: new THREE.Vector3(
            bodyPosition.x,
            bodyPosition.y + 2,
            bodyPosition.z
        )
    });
  } else {
    // Falling: freeze x and z using the last stable position, update y from the physics body
    fixedCam.update({
        position: new THREE.Vector3(
            position.value.x, // frozen x
            bodyPosition.y + 2, // live y (if you want the vertical fall to be reflected)
            position.value.y  // frozen z (note: position.value.y is storing the physics z)
        )
    });
  }

  // Check for falling with tolerance
  const currentY = playerBody.translation().y

  if (currentY < PLAYER_RADIUS - FALL_TOLERANCE && !fallStartTime.value) {
    // Start tracking fall time
    fallStartTime.value = Date.now()
  } else if (currentY >= PLAYER_RADIUS - FALL_TOLERANCE) {
    // Reset fall timer when not falling
    fallStartTime.value = null
  }

  // Check if we've been falling for too long
  if (fallStartTime.value && (Date.now() - fallStartTime.value > FALL_RESET_TIME)) {
    // Reset position
    playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
    playerBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
    
    // Reset the tracked theta
    position.value.theta = 0
    
    // Also reset the camera's orientation (if fixedCam exists)
    if (state.value.fixedCam) {
      state.value.fixedCam.yaw.rotation.y = 0
      state.value.fixedCam.pitch.rotation.x = 0
    }
    
    fallStartTime.value = null
    console.log('Reset position due to fall timeout')
  }

  // Check if we should reset the trial
  if (Math.abs(bodyPosition.z) >= HALLWAY_LENGTH / 2) {
    // Reset position
    position.value.x = 0
    position.value.y = 0
    position.value.z = 0
    position.value.theta = 0
    // Reset player position
    playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
    playerBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true)
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    playerBody.setAngvel({ x: 0, y: 0, z: 0 }, true)
    console.log('Trial reset due to position limit')
  }

  // Step physics and render
  world.step()
  debugRenderer.update()
  renderer.render(scene, camera)
}

onUnmounted(() => {
  isActive.value = false
  window.removeEventListener('resize', onWindowResize)

  // Remove mouse control listeners
  document.removeEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
  document.removeEventListener('mousemove', (event) => {
    if (isPointerLocked.value && state.value.fixedCam) {
      state.value.fixedCam.onMouseMove(event)
    }
  })

  const currentState = state.value
  if (!currentState) return

  const { scene, renderer, world } = currentState

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

  if (renderer) {
    renderer.dispose()
  }

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

.overlay-info {
  position: absolute;
  top: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
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

button {
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  transition: background 0.3s ease;
}

button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.toggle-info-mini {
  position: absolute;
  top: 20px;
  right: 20px;
}

.scene-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.5);
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
}

.activate-prompt {
  color: white;
  font-size: 1.5em;
  padding: 20px 40px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  backdrop-filter: blur(2px);
}

.activate-prompt:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style> 