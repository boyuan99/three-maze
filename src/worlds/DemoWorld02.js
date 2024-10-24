import {BaseWorld} from './BaseWorld'
import * as THREE from 'three'

export class DemoWorld02 extends BaseWorld {
  constructor(canvas) {
    super(canvas, {
      position: new THREE.Vector3(8, 8, 8),
      useOrbitControls: true,
      shadows: true,
      lights: [
        {
          type: 'ambient',
          color: 0x404040,
          intensity: 0.5
        },
        {
          type: 'spot',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(10, 10, 5),
          castShadow: true,
          angle: Math.PI / 4,
          penumbra: 0.1
        },
        {
          type: 'point',
          color: 0xff4444,
          intensity: 0.5,
          position: new THREE.Vector3(-5, 3, -5)
        }
      ],
      controlsConfig: {
        autoRotate: true,
        autoRotateSpeed: 1.0
      }
    })
  }

  setupScene() {
    // Create ground
    this.createObject({
      geometry: new THREE.PlaneGeometry(15, 15),
      material: new THREE.MeshStandardMaterial({
        color: 0x808080,
        roughness: 0.7,
        metalness: 0.1
      }),
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.8
      },
      receiveShadow: true,
      name: 'ground'
    })

    // Create multiple physics objects
    const physicsObjects = [
      {
        geometry: new THREE.BoxGeometry(0.8, 0.8, 0.8),
        material: new THREE.MeshStandardMaterial({
          color: 0xff0000,
          metalness: 0.3,
          roughness: 0.4
        }),
        position: new THREE.Vector3(-1, 4, -1),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'cuboid',
          restitution: 0.7
        }
      },
      {
        geometry: new THREE.SphereGeometry(0.4),
        material: new THREE.MeshStandardMaterial({
          color: 0x00ff00,
          metalness: 0.5,
          roughness: 0.2
        }),
        position: new THREE.Vector3(0, 6, 0),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'sphere',
          restitution: 0.9
        }
      },
      {
        geometry: new THREE.TetrahedronGeometry(0.5),
        material: new THREE.MeshStandardMaterial({
          color: 0x0000ff,
          metalness: 0.2,
          roughness: 0.6
        }),
        position: new THREE.Vector3(1, 5, 1),
        physics: true,
        physicsOptions: {
          type: 'dynamic',
          shape: 'cuboid',
          restitution: 0.5
        }
      }
    ]

    // Add all physics objects to the scene
    physicsObjects.forEach((obj, index) => {
      this.createObject({
        ...obj,
        castShadow: true,
        name: `physics_object_${index}`
      })
    })

    // Add decorative objects (no physics)
    const decorations = [
      {
        geometry: new THREE.TorusGeometry(0.5, 0.1, 16, 32),
        material: new THREE.MeshStandardMaterial({
          color: 0xffff00,
          metalness: 0.8,
          roughness: 0.2
        }),
        position: new THREE.Vector3(-3, 0.5, -3),
        rotation: new THREE.Euler(Math.PI / 4, 0, 0)
      },
      {
        geometry: new THREE.CylinderGeometry(0.1, 0.1, 2),
        material: new THREE.MeshStandardMaterial({
          color: 0xff00ff,
          metalness: 0.3,
          roughness: 0.7
        }),
        position: new THREE.Vector3(3, 1, 3),
        rotation: new THREE.Euler(0, 0, Math.PI / 6)
      }
    ]

    // Add decorative elements
    decorations.forEach((dec, index) => {
      this.createObject({
        ...dec,
        physics: false,
        castShadow: true,
        name: `decoration_${index}`
      })
    })
  }

  update() {
    // Rotate decorative elements
    this.objects.forEach((obj, name) => {
      if (name.startsWith('decoration_') && obj.mesh) {
        obj.mesh.rotation.y += 0.01
      }
    })
  }

  setupPreviewState() {
    super.setupPreviewState()

    this._previewPositions = new Map()

    // Arrange physics objects in a nice pattern for preview
    this.objects.forEach((obj, name) => {
      if (name.startsWith('physics_object_') && obj.mesh) {
        // Store original position
        this._previewPositions.set(name, obj.mesh.position.clone())

        // Set preview position
        const index = parseInt(name.split('_')[2])
        const angle = (index / 3) * Math.PI * 2
        const radius = 1.5

        obj.mesh.position.set(
          Math.cos(angle) * radius,
          1 + index * 0.5,
          Math.sin(angle) * radius
        )
      }
    })
  }

  restoreMainState() {
    super.restoreMainState()
    if (this._previewPositions) {
      this.objects.forEach((obj, name) => {
        const originalPosition = this._previewPositions.get(name)
        if (originalPosition && obj.mesh) {
          obj.mesh.position.copy(originalPosition)
        }
      })
      this._previewPositions = null
    }
  }
}
