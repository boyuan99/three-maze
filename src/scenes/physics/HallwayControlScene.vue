<script setup>
import { ref, onMounted, onUnmounted, shallowRef } from 'vue'
import * as THREE from 'three'
import { FixedCam } from '@/utils/FixedCam.js'

// Use public asset path (served from public/assets/)
const wallTextureUrl = '/assets/Chess_Pattern.jpg'
import { KeyboardController } from '@/utils/KeyboardController.js'
import { RapierDebugRenderer } from "@/utils/RapierDebugRenderer.js"
import RAPIER from '@dimforge/rapier3d-compat'

defineOptions({
  name: 'HallwayControlScene'
})

const showInfo = ref(true)
const isPointerLocked = ref(false)

// Constants
const HALLWAY_LENGTH = 200
const HALLWAY_WIDTH = 20
const WALL_HEIGHT = 10
const WALL_THICKNESS = 1
const BLUE_SEGMENT_LENGTH = 30
const PLAYER_RADIUS = 0.5

// Component state
const canvas = ref(null)
const isActive = ref(true)

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

  // Create floor
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

  // Create main walls
  createSegment(
    new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, HALLWAY_LENGTH - 2 * BLUE_SEGMENT_LENGTH),
    sideWallMaterial,
    new THREE.Vector3(-HALLWAY_WIDTH / 2 - WALL_THICKNESS / 2, WALL_HEIGHT / 2, 0)
  )
  createSegment(
    new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, HALLWAY_LENGTH - 2 * BLUE_SEGMENT_LENGTH),
    sideWallMaterial,
    new THREE.Vector3(HALLWAY_WIDTH / 2 + WALL_THICKNESS / 2, WALL_HEIGHT / 2, 0)
  )

  // Create blue walls
  const blueWallPositions = [
    { x: -HALLWAY_WIDTH / 2 - WALL_THICKNESS / 2, z: HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2 },
    { x: HALLWAY_WIDTH / 2 + WALL_THICKNESS / 2, z: HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2 },
    { x: -HALLWAY_WIDTH / 2 - WALL_THICKNESS / 2, z: -(HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2) },
    { x: HALLWAY_WIDTH / 2 + WALL_THICKNESS / 2, z: -(HALLWAY_LENGTH / 2 - BLUE_SEGMENT_LENGTH / 2) }
  ]

  blueWallPositions.forEach(pos => {
    createSegment(
      new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, BLUE_SEGMENT_LENGTH),
      blueMaterial,
      new THREE.Vector3(pos.x, WALL_HEIGHT / 2, pos.z)
    )
  })

  // Create end walls
  createSegment(
    new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_HEIGHT, WALL_THICKNESS),
    blueMaterial,
    new THREE.Vector3(0, WALL_HEIGHT / 2, HALLWAY_LENGTH / 2 + WALL_THICKNESS / 2)
  )
  createSegment(
    new THREE.BoxGeometry(HALLWAY_WIDTH, WALL_HEIGHT, WALL_THICKNESS),
    blueMaterial,
    new THREE.Vector3(0, WALL_HEIGHT / 2, -(HALLWAY_LENGTH / 2 + WALL_THICKNESS / 2))
  )

  scene.add(group)
  return group
}

async function init() {
  if (!canvas.value) return

  // Initialize scene
  const scene = new THREE.Scene()

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
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })

  // Create player
  const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(0, PLAYER_RADIUS, 0)
    .setLinearDamping(5)
    .setAngularDamping(5)

  const playerBody = world.createRigidBody(playerBodyDesc)
  world.createCollider(
    RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
      .setRestitution(0)
      .setFriction(1),
    playerBody
  )

  // Set up controls
  const fixedCam = new FixedCam(scene, camera, renderer)
  const keyboard = new KeyboardController(renderer)
  const debugRenderer = new RapierDebugRenderer(scene, world)

  // Update state
  state.value = {
    scene,
    camera,
    renderer,
    world,
    playerBody,
    fixedCam,
    keyboard,
    debugRenderer
  }

  // Create hallway segments
  await createHallwaySegment(new THREE.Vector3(0, 0, 0))
  await createHallwaySegment(new THREE.Vector3(HALLWAY_LENGTH, 0, 0))

  window.addEventListener('resize', onWindowResize)
}

function animate() {
  if (!isActive.value) return

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

  requestAnimationFrame(animate)

  const moveDirection = new THREE.Vector3(0, 0, 0)
  const speed = 35 // Adjust this value to control movement speed

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

  world.step()
  debugRenderer.update()

  // Update camera
  const playerPosition = playerBody.translation()
  fixedCam.update({
    position: new THREE.Vector3(
      playerPosition.x,
      playerPosition.y + 1.6,
      playerPosition.z
    )
  })

  renderer.render(scene, camera)
}

function onWindowResize() {
  const { camera, renderer } = state.value
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}

onMounted(async () => {
  await init()
  animate()

  // Add pointer lock change listener
  document.addEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
})

onUnmounted(() => {
  isActive.value = false
  window.removeEventListener('resize', onWindowResize)

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

  document.removeEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
})
</script>

<template>
  <div class="scene-container">
    <canvas ref="canvas"></canvas>
    
    <!-- Add the translucent overlay -->
    <div v-if="!isPointerLocked" class="scene-overlay" @click="canvas.requestPointerLock()">
      <div class="activate-prompt">
        Click anywhere to activate controls
      </div>
    </div>

    <!-- Existing overlays -->
    <div class="overlay-info" v-if="showInfo">
      <div class="info-panel">
        <h3>Hallway Control Scene</h3>
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
    <button
      v-else
      class="toggle-info-mini"
      @click="showInfo = true"
    >
      Show Info
    </button>
  </div>
</template>

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
  background: rgba(0, 0, 0, 0.5);  /* Dark translucent overlay */
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