import {BaseWorld} from './BaseWorld'
import * as THREE from 'three'

export class DemoWorld01 extends BaseWorld {
  constructor(canvas) {
    super(canvas, {
      cameraConfig: {
        position: new THREE.Vector3(8, 8, 8)
      },
      rendererConfig: {
        shadows: true
      },
      useOrbitControls: true,
      controlsConfig: {
        autoRotate: true,
        autoRotateSpeed: 1.0
      },
      lights: [
        {
          type: 'ambient',
          color: 0xffffff,
          intensity: 1
        },
        {
          type: 'spot',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(10, 10, 5),
          castShadow: true,
          angle: Math.PI / 4,
          penumbra: 1
        },
        {
          type: 'point',
          color: 0xff4444,
          intensity: 3,
          position: new THREE.Vector3(-5, 3, -5)
        }
      ]
    })
  }

  async setupScene() {
    // Create ground
    this.createObject({
      geometry: new THREE.BoxGeometry(20, 0.1, 20),
      material: new THREE.MeshStandardMaterial({
        color: 0x404040,
        roughness: 0.7,
        metalness: 0.1
      }),
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(0, 0, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.8
      },
      receiveShadow: true,
      name: 'ground'
    })

    // Create a ramp
    this.createObject({
      geometry: new THREE.BoxGeometry(8, 0.2, 4),
      material: new THREE.MeshStandardMaterial({
        color: 0x808080,
        roughness: 0.5,
        metalness: 0.2
      }),
      position: new THREE.Vector3(0, 2, -5),
      rotation: new THREE.Euler(Math.PI / 6, 0, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.1
      },
      castShadow: true,
      receiveShadow: true,
      name: 'ramp'
    })

    // Create various physics objects to roll down the ramp
    const physicsObjects = [
      // Sphere
      {
        geometry: new THREE.SphereGeometry(0.5),
        material: new THREE.MeshStandardMaterial({
          color: 0xff0000,
          metalness: 0.7,
          roughness: 0.3
        }),
        position: new THREE.Vector3(0, 5, -3),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'sphere',
          restitution: 0.8,
          friction: 0.1
        }
      },
      // Large cube
      {
        geometry: new THREE.BoxGeometry(1, 1, 1),
        material: new THREE.MeshStandardMaterial({
          color: 0x00ff00,
          metalness: 0.4,
          roughness: 0.6
        }),
        position: new THREE.Vector3(-2, 6, -3),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'cuboid',
          restitution: 0.5,
          friction: 0.3
        }
      },
      // Cylinder
      {
        geometry: new THREE.CylinderGeometry(0.3, 0.3, 1.2, 16),
        material: new THREE.MeshStandardMaterial({
          color: 0x0000ff,
          metalness: 0.5,
          roughness: 0.5
        }),
        position: new THREE.Vector3(2, 7, -3),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'cylinder',
          restitution: 0.6,
          friction: 0.2
        }
      }
    ]

    // Add all physics objects
    physicsObjects.forEach((obj, index) => {
      this.createObject({
        ...obj,
        castShadow: true,
        name: `physics_object_${index}`
      })
    })

    // Add decorative pillars around the scene
    const pillarPositions = [
      [-6, 0, -6],
      [6, 0, -6],
      [-6, 0, 6],
      [6, 0, 6]
    ]

    pillarPositions.forEach((pos, index) => {
      // Create base
      this.createObject({
        geometry: new THREE.CylinderGeometry(0.8, 1, 0.5, 8),
        material: new THREE.MeshStandardMaterial({
          color: 0xdddddd,
          metalness: 0.3,
          roughness: 0.7
        }),
        position: new THREE.Vector3(pos[0], pos[1] + 0.25, pos[2]),
        physics: false,
        castShadow: true,
        receiveShadow: true,
        name: `pillar_base_${index}`
      })

      // Create pillar
      this.createObject({
        geometry: new THREE.CylinderGeometry(0.5, 0.5, 4, 8),
        material: new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          metalness: 0.3,
          roughness: 0.7
        }),
        position: new THREE.Vector3(pos[0], pos[1] + 2.5, pos[2]),
        physics: false,
        castShadow: true,
        receiveShadow: true,
        name: `pillar_${index}`
      })

      // Create top
      this.createObject({
        geometry: new THREE.CylinderGeometry(0.7, 0.5, 0.5, 8),
        material: new THREE.MeshStandardMaterial({
          color: 0xdddddd,
          metalness: 0.3,
          roughness: 0.7
        }),
        position: new THREE.Vector3(pos[0], pos[1] + 4.75, pos[2]),
        physics: false,
        castShadow: true,
        receiveShadow: true,
        name: `pillar_top_${index}`
      })
    })

    // Add floating rotating rings
    const ringColors = [0xffff00, 0xff00ff, 0x00ffff]
    ringColors.forEach((color, index) => {
      this.createObject({
        geometry: new THREE.TorusGeometry(1, 0.1, 16, 32),
        material: new THREE.MeshStandardMaterial({
          color: color,
          metalness: 0.8,
          roughness: 0.2,
          emissive: color,
          emissiveIntensity: 0.2
        }),
        position: new THREE.Vector3(
          Math.cos(index * (Math.PI * 2 / 3)) * 4-3,
          2,
          Math.sin(index * (Math.PI * 2 / 3)) * 4
        ),
        physics: false,
        castShadow: true,
        name: `ring_${index}`
      })
    })
  }

  update() {
    // Update rotating rings
    const time = Date.now() * 0.001
    this.objects.forEach((obj, name) => {
      if (name.startsWith('ring_') && obj.mesh) {
        const index = parseInt(name.split('_')[1])
        obj.mesh.rotation.x = Math.sin(time + index) * 0.5
        obj.mesh.rotation.y += 0.02
        obj.mesh.rotation.z = Math.cos(time + index) * 0.5
        obj.mesh.position.y = 2 + Math.sin(time * 2 + index) * 0.5
      }
    })
  }

  setupPreviewState() {
    super.setupPreviewState()
    this._previewPositions = new Map()

    this.objects.forEach((obj, name) => {
      if (name.startsWith('physics_object_') && obj.mesh) {
        this._previewPositions.set(name, {
          position: obj.mesh.position.clone(),
          rotation: obj.mesh.rotation.clone(),
          bodyPosition: obj.body ? obj.body.translation() : null,
          bodyRotation: obj.body ? obj.body.rotation() : null
        })

        const index = parseInt(name.split('_')[2])
        const angle = (index / 3) * Math.PI * 2
        const radius = 3

        // Update both mesh and physics body
        obj.mesh.position.set(
          Math.cos(angle) * radius,
          3,
          Math.sin(angle) * radius
        )

        if (obj.body) {
          obj.body.setTranslation({
            x: Math.cos(angle) * radius,
            y: 3,
            z: Math.sin(angle) * radius
          })
        }
      }
    })
  }

  restoreMainState() {
    super.restoreMainState()
    if (this._previewPositions) {
      this.objects.forEach((obj, name) => {
        const originalState = this._previewPositions.get(name)
        if (originalState && obj.mesh) {
          obj.mesh.position.copy(originalState.position)
          obj.mesh.rotation.copy(originalState.rotation)

          // Restore physics body state
          if (obj.body && originalState.bodyPosition && originalState.bodyRotation) {
            obj.body.setTranslation(originalState.bodyPosition)
            obj.body.setRotation(originalState.bodyRotation)
          }
        }
      })
      this._previewPositions = null
    }
  }
}