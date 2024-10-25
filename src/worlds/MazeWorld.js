import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'
import { createTexturedHallway } from '@/utils/HallwayModule.js'
import { FixedCam } from '@/utils/FixedCam'
import { KeyboardController } from '@/utils/KeyboardController'


export class MazeWorld extends BaseWorld {
  constructor(canvas) {
    super(canvas, {
      cameraConfig: {
        fov: 75,
        near: 0.1,
        far: 1000,
        position: new THREE.Vector3(0, 5, 10),
        target: new THREE.Vector3(0, 0, 0)
      },
      rendererConfig: {
        shadows: true,
        antialias: true
      },
      physicsConfig: {
        gravity: { x: 0.0, y: -9.81, z: 0.0 }
      },
      useOrbitControls: false,
      lights: [
        {
          type: 'ambient',
          color: 0xffffff,
          intensity: 0.6
        },
        {
          type: 'directional',
          color: 0xffffff,
          intensity: 0.8,
          position: new THREE.Vector3(0, 20, 0),
          castShadow: true
        }
      ]
    })

    // Player control properties
    this.ballBody = null
    this.fixedCam = null
    this.keyboard = null
  }

  async setupScene() {
    // Create the hallway
    const hallway = createTexturedHallway()
    this.scene.add(hallway)

    // Add physics to hallway
    hallway.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.computeBoundingBox()
        const bbox = child.geometry.boundingBox
        const width = bbox.max.x - bbox.min.x
        const height = bbox.max.y - bbox.min.y
        const depth = bbox.max.z - bbox.min.z

        this.createObject({
          geometry: child.geometry.clone(),
          material: child.material,
          position: child.position,
          physics: true,
          physicsOptions: {
            type: 'static',
            shape: 'cuboid',
            friction: 1,
            restitution: 0
          },
          receiveShadow: true,
          name: `hallway_${child.uuid}`
        })
      }
    })

    if (this.canvas) {
      // Create ball (player)
      const ballRadius = 1
      const ballGeometry = new THREE.SphereGeometry(ballRadius)
      const ballMaterial = new THREE.MeshPhongMaterial({ color: 0xff0000 })

      const playerObject = this.createObject({
        geometry: ballGeometry,
        material: ballMaterial,
        position: new THREE.Vector3(0, 1, 0),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'sphere',
          friction: 1,
          restitution: 0
        },
        castShadow: true,
        name: 'player'
      })

      this.ballBody = playerObject.body
      this.ballBody.setLinearDamping(0.9)
      this.ballBody.setAngularDamping(0.9)
      this.ballBody.setAdditionalMass(0.0001)

      // Initialize controllers
      this.setupControllers()
    }
  }

  setupControllers() {
    if (!this.canvas) return

    this.fixedCam = new FixedCam(this.scene, this.camera, this.renderer)
    this.keyboard = new KeyboardController(this.renderer)
  }

  update() {
    if (!this.ballBody || !this.fixedCam || !this.keyboard) return

    const moveForce = new THREE.Vector3(0, 0, 0)
    const maxSpeed = 50
    const rawSpeed = 20
    const isMoving = this.keyboard.keyMap['KeyW'] || this.keyboard.keyMap['KeyA'] ||
                    this.keyboard.keyMap['KeyS'] || this.keyboard.keyMap['KeyD']

    if (isMoving) {
      if (this.keyboard.keyMap['KeyW']) moveForce.z -= rawSpeed
      if (this.keyboard.keyMap['KeyS']) moveForce.z += rawSpeed
      if (this.keyboard.keyMap['KeyA']) moveForce.x -= rawSpeed
      if (this.keyboard.keyMap['KeyD']) moveForce.x += rawSpeed

      moveForce.applyEuler(new THREE.Euler(0, this.fixedCam.yaw.rotation.y, 0))

      this.ballBody.applyImpulse(moveForce, true)
    } else {
      this.ballBody.setLinvel({x: 0, y: 0, z: 0}, true)
      this.ballBody.setAngvel({x: 0, y: 0, z: 0}, true)
    }

    const velocity = this.ballBody.linvel()
    const speed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2)
    if (speed > maxSpeed) {
      const scaleFactor = maxSpeed / speed
      this.ballBody.setLinvel({
        x: velocity.x * scaleFactor,
        y: velocity.y * scaleFactor,
        z: velocity.z * scaleFactor
      }, true)
    }

    // Update camera position
    const ballPosition = this.ballBody.translation()
    this.fixedCam.update({
      position: new THREE.Vector3(ballPosition.x, ballPosition.y + 1, ballPosition.z)
    })
  }

  setupPreviewState() {
    super.setupPreviewState()

    // Set up a nice camera angle for the preview
    this.camera.position.set(20, 30, 50)
    this.camera.lookAt(0, 0, 0)
  }

  dispose() {
    super.dispose()

    // Remove controller event listeners
    this.keyboard?.dispose?.()
    this.fixedCam?.dispose?.()
  }
}