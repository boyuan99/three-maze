import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { BaseWorld } from './BaseWorld'
import { RapierDebugRenderer } from '@/utils/RapierDebugRenderer'
import { FixedCam } from '@/utils/FixedCam'
import { KeyboardController } from '@/utils/KeyboardController'
import { CustomWorld } from './CustomWorld'

export class PhysicsCustomWorld extends CustomWorld {
  constructor(canvas, sceneConfig) {
    super(canvas, sceneConfig)

    // Override some options for first-person controls
    this.options.useOrbitControls = false

    // Store additional properties for first-person controls
    this.keyboard = null
    this.fixedCam = null
    this.debugRenderer = null
    this.playerBody = null
    this.playerConfig = sceneConfig.player || {
      type: 'sphere',
      radius: 0.5,
      position: { x: 0, y: 0.5, z: 0 },
      physics: {
        enabled: true,
        type: 'dynamic',
        mass: 1,
        linearDamping: 0.9,
        angularDamping: 0.9,
        restitution: 0,
        friction: 1
      }
    }
    this.controlsConfig = sceneConfig.controls || {
      type: 'firstPerson',
      speed: 35,
      jumpForce: 10,
      mouseSensitivity: 0.002
    }

    this.isPointerLocked = false
  }

  async setupScene() {
    // Setup the scene using the parent class method
    await super.setupScene()

    // Set up first-person controls and player
    await this.setupFirstPersonControls()
  }

  async setupFirstPersonControls() {
    if (!this.canvas) return

    // Initialize keyboard controller
    this.keyboard = new KeyboardController(this.renderer)

    // Initialize fixed camera
    this.fixedCam = new FixedCam(this.scene, this.camera, this.renderer)

    // Set mouse sensitivity to match HallwayControlScene
    this.fixedCam.mouseSensitivity = this.controlsConfig.mouseSensitivity || 0.002

    // FIXED: Reset the camera's actual rotation
    this.camera.rotation.set(0, 0, 0)

    // Create debug renderer if needed
    this.debugRenderer = new RapierDebugRenderer(this.scene, this.physics)

    // Create player physics body
    await this.createPlayer()

    // Add pointer lock event listeners
    document.addEventListener('pointerlockchange', this.onPointerLockChange.bind(this))

    // Add mouse move event listener
    document.addEventListener('mousemove', this.onMouseMove.bind(this))

    // Initialize player position camera
    const playerPos = this.playerBody.translation()
    this.fixedCam.update({
      position: new THREE.Vector3(
        playerPos.x,
        playerPos.y + 2, // Eye height
        playerPos.z
      )
    })
  }

  createPlayer() {
    // Remove any existing player
    if (this.playerBody && this.physics) {
      this.physics.removeRigidBody(this.playerBody)
    }

    const playerPos = this.playerConfig.position || { x: 0, y: 0.5, z: 0 }
    const playerRadius = this.playerConfig.radius || 0.5

    // Create player rigid body
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(playerPos.x, playerPos.y, playerPos.z)
      .setLinearDamping(this.playerConfig.physics?.linearDamping || 0.9)
      .setAngularDamping(this.playerConfig.physics?.angularDamping || 0.9)
      // Explicitly set rotation to identity (no rotation)
      .setRotation({ x: 0, y: 0, z: 0, w: 1 })

    this.playerBody = this.physics.createRigidBody(playerBodyDesc)

    // Create player collider
    this.physics.createCollider(
      RAPIER.ColliderDesc.ball(playerRadius)
        .setRestitution(this.playerConfig.physics?.restitution || 0)
        .setFriction(this.playerConfig.physics?.friction || 1),
      this.playerBody
    )

    // Create visual representation of player (can be made invisible if desired)
    const playerGeometry = new THREE.SphereGeometry(playerRadius, 16, 16)
    const playerMaterial = new THREE.MeshStandardMaterial({
      color: 0xff0000,
      opacity: 0.5,
      transparent: true
    })

    const playerMesh = new THREE.Mesh(playerGeometry, playerMaterial)
    playerMesh.position.set(playerPos.x, playerPos.y, playerPos.z)
    playerMesh.castShadow = true
    playerMesh.visible = false // Hide player mesh by default

    this.scene.add(playerMesh)
    this.playerMesh = playerMesh

    return this.playerBody
  }

  update() {
    if (!this.playerBody || !this.keyboard || !this.fixedCam) return

    // Handle keyboard input
    const moveDirection = new THREE.Vector3(0, 0, 0)
    const speed = this.controlsConfig.speed || 35

    if (this.keyboard.keyMap['KeyW']) moveDirection.z -= 1
    if (this.keyboard.keyMap['KeyS']) moveDirection.z += 1
    if (this.keyboard.keyMap['KeyA']) moveDirection.x -= 1
    if (this.keyboard.keyMap['KeyD']) moveDirection.x += 1

    // Add jump functionality
    if (this.keyboard.keyMap['Space'] && this.isGrounded()) {
      const jumpForce = this.controlsConfig.jumpForce || 10
      const currentVel = this.playerBody.linvel()
      this.playerBody.setLinvel(
        { x: currentVel.x, y: jumpForce, z: currentVel.z },
        true
      )
    }

    // Always apply direction - even if zero
    // This ensures the player stops when no keys are pressed
    moveDirection.normalize().multiplyScalar(speed)
    moveDirection.applyEuler(new THREE.Euler(0, this.fixedCam.yaw.rotation.y, 0))

    // Set velocity directly
    this.playerBody.setLinvel(
      {
        x: moveDirection.x,
        y: this.playerBody.linvel().y, // Preserve vertical velocity for gravity
        z: moveDirection.z
      },
      true
    )

    // Update camera position based on player position
    const playerPosition = this.playerBody.translation()

    // Ensure camera position consistent with HallwayControlScene
    this.fixedCam.update({
      position: new THREE.Vector3(
        playerPosition.x,
        playerPosition.y + 2, // Match HallwayControlScene's height
        playerPosition.z
      )
    })

    // Update debug renderer if available
    if (this.debugRenderer) {
      this.debugRenderer.update()
    }
  }

  isGrounded() {
    // Simple ground check - can be improved with raycasting
    const position = this.playerBody.translation()
    const playerRadius = this.playerConfig.radius || 0.5
    return position.y <= playerRadius + 0.1
  }

  onPointerLockChange() {
    this.isPointerLocked = document.pointerLockElement === this.canvas
  }

  onMouseMove(event) {
    if (this.isPointerLocked && this.fixedCam) {
      // Ensure using correct mouse sensitivity
      const sensitivity = this.controlsConfig.mouseSensitivity || 0.002;

      // Use sensitivity to update FixedCam
      this.fixedCam.onMouseMove(event, sensitivity);
    }
  }

  requestPointerLock() {
    if (this.canvas && !this.isPointerLocked) {
      this.canvas.requestPointerLock()
    }
  }

  dispose() {
    // Remove event listeners
    document.removeEventListener('pointerlockchange', this.onPointerLockChange.bind(this))
    document.removeEventListener('mousemove', this.onMouseMove.bind(this))

    // Dispose of additional resources
    if (this.keyboard) {
      this.keyboard = null
    }

    if (this.debugRenderer) {
      this.debugRenderer = null
    }

    // Call parent dispose method
    super.dispose()
  }

  async generateBetterPreview(width = 300, height = 200) {
    // Create a temporary canvas if needed
    const previewCanvas = document.createElement('canvas')
    previewCanvas.width = width
    previewCanvas.height = height

    // Create a temporary renderer
    const previewRenderer = new THREE.WebGLRenderer({
      canvas: previewCanvas,
      antialias: true
    })
    previewRenderer.setSize(width, height)

    // Save current camera state
    const originalCameraPosition = this.camera ? this.camera.position.clone() : null
    const originalCameraRotation = this.camera ? this.camera.rotation.clone() : null

    // Position camera for a good preview angle
    if (this.camera) {
      this.camera.position.set(50, 30, 50)
      this.camera.lookAt(0, 0, 0)
      this.camera.updateProjectionMatrix()
    }

    // Render scene
    if (this.scene && this.camera) {
      previewRenderer.render(this.scene, this.camera)
    }

    // Capture image
    const dataURL = previewCanvas.toDataURL('image/png')

    // Restore camera state if needed
    if (this.camera && originalCameraPosition && originalCameraRotation) {
      this.camera.position.copy(originalCameraPosition)
      this.camera.rotation.copy(originalCameraRotation)
      this.camera.updateProjectionMatrix()
    }

    // Cleanup
    previewRenderer.dispose()

    return dataURL
  }

  // Override the getPreviewRender method from BaseWorld
  getPreviewRender(width = 300, height = 200) {
    // If we're already initialized, use the enhanced method
    if (this.scene && this.camera) {
      return this.generateBetterPreview(width, height)
    }

    // Otherwise fall back to the parent implementation
    return super.getPreviewRender(width, height)
  }
} 