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
// ... existing imports ...
import { KeyboardController } from '@/utils/KeyboardController.js'

// Add new refs
const showInfo = ref(true)
const isPointerLocked = ref(false)
const position = ref({ x: 0, y: 0, theta: 0 })

// Modify onMounted to include keyboard/mouse controls
onMounted(async () => {
  console.log('Component mounting...')
  
  if (canvas.value) {
    try {
      // ... existing scene setup code ...

      // Add keyboard controller
      const keyboard = new KeyboardController(renderer)
      
      // Update state to include keyboard
      state.value = {
        scene,
        camera,
        renderer,
        world: physicsWorld,
        playerBody: playerRigidBody,
        fixedCam: new FixedFollowCam(scene, camera, renderer),
        keyboard
      }

      // Add pointer lock change listener
      document.addEventListener('pointerlockchange', () => {
        isPointerLocked.value = document.pointerLockElement === canvas.value
      })

      // Start animation loop
      animate()

    } catch (err) {
      console.error('Error in setup:', err)
      error.value = err.message
    }
  }
})

// Modify animate function to use keyboard input
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
    keyboard
  } = state.value

  // Check if all required objects are initialized
  if (!scene || !camera || !renderer || !world || !playerBody) return

  // Handle keyboard input
  const moveForce = new THREE.Vector3(0, 0, 0)
  const maxSpeed = 50
  const rawSpeed = 5

  if (keyboard.keyMap['KeyW']) moveForce.z -= rawSpeed
  if (keyboard.keyMap['KeyS']) moveForce.z += rawSpeed
  if (keyboard.keyMap['KeyA']) moveForce.x -= rawSpeed
  if (keyboard.keyMap['KeyD']) moveForce.x += rawSpeed

  moveForce.applyEuler(new THREE.Euler(0, fixedCam.yaw.rotation.y, 0))

  if (moveForce.length() > 0) {
    playerBody.applyImpulse(moveForce, true)
  }

  // Limit speed
  const velocity = playerBody.linvel()
  const speed = Math.sqrt(velocity.x ** 2 + velocity.z ** 2)
  if (speed > maxSpeed) {
    const scaleFactor = maxSpeed / speed
    playerBody.setLinvel({
      x: velocity.x * scaleFactor,
      y: velocity.y,
      z: velocity.z * scaleFactor
    }, true)
  }

  // Update position tracking
  const bodyPosition = playerBody.translation()
  position.value.x = bodyPosition.x
  position.value.y = bodyPosition.z
  position.value.theta = fixedCam.yaw.rotation.y

  // Check if we should reset the trial
  if (Math.abs(position.value.y) >= HALLWAY_LENGTH / 2) {
    // Reset position
    position.value.x = 0
    position.value.y = 0
    position.value.theta = 0

    // Reset player position
    playerBody.setTranslation({ x: 0, y: PLAYER_RADIUS, z: 0 }, true)
    playerBody.setRotation({ x: 0, y: 0, z: 0 }, true)
    playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true)
    console.log('Trial reset due to position limit')
  }

  // Step physics and render
  world.step()
  renderer.render(scene, camera)
}

// Modify onUnmounted to clean up pointer lock
onUnmounted(() => {
  // ... existing cleanup code ...
  
  document.removeEventListener('pointerlockchange', () => {
    isPointerLocked.value = document.pointerLockElement === canvas.value
  })
})
</script>

<style scoped>
// ... existing styles ...

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