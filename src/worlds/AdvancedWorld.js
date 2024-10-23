import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { World } from './World'

export class AdvancedWorld extends World {
  constructor(canvas) {
    super(canvas)
  }

  async init() {
    await super.init()
    this.addAdvancedObjects()
  }

  addAdvancedObjects() {
    // Add some dynamic objects
    for (let i = 0; i < 5; i++) {
      const size = 0.5
      const cubeGeometry = new THREE.BoxGeometry(size, size, size)
      const cubeMaterial = new THREE.MeshStandardMaterial({
        color: Math.random() * 0xffffff
      })
      const cube = new THREE.Mesh(cubeGeometry, cubeMaterial)

      // Random position above ground
      const x = (Math.random() - 0.5) * 6
      const y = Math.random() * 5 + 2
      const z = (Math.random() - 0.5) * 6

      cube.position.set(x, y, z)
      this.scene.add(cube)

      // Add physics body
      const rigidBody = this.physics.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y, z)
      )

      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(size/2, size/2, size/2),
        rigidBody
      )

      this.objects.push({ mesh: cube, body: rigidBody })
    }
  }
}
