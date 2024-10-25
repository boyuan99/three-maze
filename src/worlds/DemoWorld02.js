import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'

export class DemoWorld02 extends BaseWorld {
  constructor(canvas) {
    super(canvas, {
      cameraConfig: {
        position: new THREE.Vector3(8, 8, 8),
        fov: 60
      },
      rendererConfig: {
        shadows: true,
        physicallyCorrectLights: true
      },
      useOrbitControls: true,
      physicsConfig: {
        gravity: { x: 0, y: -9.81, z: 0 }
      },
      lights: [
        {
          type: 'ambient',
          color: 0x404040,
          intensity: 0.5
        },
        {
          type: 'directional',
          color: 0xffffff,
          intensity: 1.5,
          position: new THREE.Vector3(5, 10, 5),
          castShadow: true
        },
        {
          type: 'point',
          color: 0xff9000,
          intensity: 1,
          position: new THREE.Vector3(-3, 4, 0),
          distance: 10,
          decay: 2
        }
      ]
    })

    this.objectCount = 0
    this.lastSpawnTime = 0
    this.spawnInterval = 2000 // ms
  }

  async setupScene() {
    // Create ground plane with texture
    const groundGeometry = new THREE.BoxGeometry(20, 0.2, 20)
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x808080,
      roughness: 0.7,
      metalness: 0.1
    })

    this.createObject({
      geometry: groundGeometry,
      material: groundMaterial,
      position: new THREE.Vector3(0, -0.1, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.8
      },
      receiveShadow: true,
      name: 'ground'
    })

    // Create ramp
    this.createObject({
      geometry: new THREE.BoxGeometry(4, 0.2, 6),
      material: new THREE.MeshStandardMaterial({ color: 0x8b4513 }),
      position: new THREE.Vector3(-6, 2, 0),
      rotation: new THREE.Euler(Math.PI / 6, 0, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.3
      },
      castShadow: true,
      receiveShadow: true,
      name: 'ramp'
    })

    // Create walls to contain objects
    const wallMaterial = new THREE.MeshStandardMaterial({
      color: 0x505050,
      transparent: true,
      opacity: 0.5
    })

    // Back wall
    this.createObject({
      geometry: new THREE.BoxGeometry(20, 4, 0.2),
      material: wallMaterial,
      position: new THREE.Vector3(0, 2, -10),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.1
      },
      castShadow: true,
      receiveShadow: true,
      name: 'wallBack'
    })

    // Side walls
    const wallGeometry = new THREE.BoxGeometry(0.2, 4, 20)
    this.createObject({
      geometry: wallGeometry,
      material: wallMaterial.clone(),
      position: new THREE.Vector3(-10, 2, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.1
      },
      castShadow: true,
      receiveShadow: true,
      name: 'wallLeft'
    })

    this.createObject({
      geometry: wallGeometry,
      material: wallMaterial.clone(),
      position: new THREE.Vector3(10, 2, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.1
      },
      castShadow: true,
      receiveShadow: true,
      name: 'wallRight'
    })

    // Create initial objects
    this.spawnRandomObject()
    this.spawnRandomObject()
    this.spawnRandomObject()
  }

  spawnRandomObject() {
    const shapes = ['sphere', 'cuboid', 'cylinder', 'capsule']
    const shape = shapes[Math.floor(Math.random() * shapes.length)]

    let geometry
    switch(shape) {
      case 'sphere':
        geometry = new THREE.SphereGeometry(0.5)
        break
      case 'cuboid':
        geometry = new THREE.BoxGeometry(1, 1, 1)
        break
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(0.3, 0.3, 1)
        break
      case 'capsule':
        geometry = new THREE.CapsuleGeometry(0.3, 0.5, 4, 8)
        break
    }

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(Math.random(), 0.7, 0.5),
      roughness: 0.7,
      metalness: 0.3
    })

    this.createObject({
      geometry,
      material,
      position: new THREE.Vector3(-6, 6, Math.random() * 4 - 2),
      rotation: new THREE.Euler(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI
      ),
      physics: true,
      physicsOptions: {
        type: 'dynamic',
        shape,
        restitution: 0.3 + Math.random() * 0.4,
        friction: 0.3 + Math.random() * 0.4
      },
      castShadow: true,
      receiveShadow: true,
      name: `object_${this.objectCount++}`
    })
  }

  update() {
    // Spawn new objects periodically
    const currentTime = Date.now()
    if (currentTime - this.lastSpawnTime > this.spawnInterval) {
      this.spawnRandomObject()
      this.lastSpawnTime = currentTime

      // Remove old objects if there are too many
      if (this.objectCount > 20) {
        const oldestObjectName = `object_${this.objectCount - 21}`
        this.removeObject(oldestObjectName)
      }
    }

    // Clean up objects that fell below the ground
    this.objects.forEach((object, name) => {
      if (object.mesh && object.mesh.position.y < -10) {
        this.removeObject(name)
      }
    })
  }

  setupPreviewState() {
    super.setupPreviewState()
    // Pause physics and set specific preview positions for objects
    this.objects.forEach((object, name) => {
      if (object.mesh && name.startsWith('object_')) {
        const angle = parseInt(name.split('_')[1]) * (Math.PI / 5)
        const radius = 3
        object.mesh.position.set(
          Math.cos(angle) * radius,
          2,
          Math.sin(angle) * radius
        )
        object.mesh.rotation.set(0, angle, 0)
      }
    })
  }
}