import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

export class World {
  constructor(canvas) {
    this.canvas = canvas
    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000)
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true
    })

    this.physics = null
    this.objects = []
  }

  async init() {
    // Initialize Rapier physics
    await RAPIER.init()
    this.physics = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 })

    // Setup scene
    this.setupScene()

    // Start animation loop
    this.animate()

    // Handle window resize
    window.addEventListener('resize', this.onWindowResize.bind(this))
  }

  setupScene() {
    // Set renderer size
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)

    // Setup camera
    this.camera.position.set(5, 5, 5)
    this.camera.lookAt(0, 0, 0)

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5)
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
    directionalLight.position.set(5, 5, 5)

    this.scene.add(ambientLight)
    this.scene.add(directionalLight)

    // Add ground plane
    const groundGeometry = new THREE.PlaneGeometry(10, 10)
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x808080 })
    const ground = new THREE.Mesh(groundGeometry, groundMaterial)
    ground.rotation.x = -Math.PI / 2
    this.scene.add(ground)

    // Add physics ground
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(5.0, 0.1, 5.0)
    )
  }

  animate() {
    requestAnimationFrame(this.animate.bind(this))
    this.physics.step()

    // Update physics objects
    for (const object of this.objects) {
      const position = object.body.translation()
      object.mesh.position.set(position.x, position.y, position.z)

      const rotation = object.body.rotation()
      object.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
    }

    this.renderer.render(this.scene, this.camera)
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  dispose() {
    this.physics.free()
    window.removeEventListener('resize', this.onWindowResize)

    // Dispose of Three.js resources
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        if (object.material.map) object.material.map.dispose()
        object.material.dispose()
      }
    })

    this.renderer.dispose()
  }
}