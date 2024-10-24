import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'

export class DemoWorld01 extends BaseWorld {
    constructor(canvas) {
    super(canvas, {
      cameraConfig: {
        position: new THREE.Vector3(5, 5, 5)
      },
      rendererConfig: {
        shadows: true
      },
      useOrbitControls: true,
      lights: [
        {
          type: 'ambient',
          color: 0xffffff,
          intensity: 0.5
        },
        {
          type: 'directional',
          color: 0xffffff,
          intensity: 1,
          position: new THREE.Vector3(5, 5, 5),
          castShadow: true
        }
      ]
    })
  }

  async setupScene() {
    // Create ground
    this.createObject({
      geometry: new THREE.PlaneGeometry(10, 10),
      material: new THREE.MeshStandardMaterial({ color: 0x808080 }),
      position: new THREE.Vector3(0, 0, 0),
      rotation: new THREE.Euler(-Math.PI / 2, 0, 0),
      physics: true,
      physicsOptions: {
        type: 'static',
        shape: 'cuboid',
        friction: 0.5
      },
      receiveShadow: true,
      name: 'ground'
    })

    // Create bouncing cube
    this.createObject({
      geometry: new THREE.BoxGeometry(),
      material: new THREE.MeshStandardMaterial({ color: 0x00ff00 }),
      position: new THREE.Vector3(0, 3, 0),
      physics: true,
      physicsOptions: {
        type: 'dynamic',
        shape: 'cuboid',
        restitution: 0.7,
        friction: 0.3
      },
      castShadow: true,
      name: 'cube'
    })
  }

  setupPreviewState() {
    super.setupPreviewState()
    const cube = this.getObject('cube')
    if (cube?.mesh) {
      // Store original position before modifying
      this._previewPositions = new Map()
      this._previewPositions.set('cube', cube.mesh.position.clone())

      // Set preview position
      cube.mesh.position.set(0, 1, 0)
    }
  }

  restoreMainState() {
    super.restoreMainState()
    if (this._previewPositions) {
      const cube = this.getObject('cube')
      if (cube?.mesh) {
        const originalPosition = this._previewPositions.get('cube')
        if (originalPosition) {
          cube.mesh.position.copy(originalPosition)
        }
      }
      this._previewPositions = null
    }
  }
}