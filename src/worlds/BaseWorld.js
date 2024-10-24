import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export class BaseWorld {
  constructor(canvas, options = {}) {
    // Default configurations
    this.options = {
      // Renderer settings
      alpha: false,
      antialias: true,
      shadows: false,
      physicallyCorrectLights: false,

      // Camera settings
      fov: 75,
      near: 0.1,
      far: 1000,
      position: new THREE.Vector3(5, 5, 5),
      target: new THREE.Vector3(0, 0, 0),

      // Physics settings
      usePhysics: true,
      gravity: { x: 0, y: -9.81, z: 0 },

      // Controls settings
      useOrbitControls: false,
      controlsConfig: {
        enableDamping: true,
        dampingFactor: 0.05,
        enableZoom: true,
        enablePan: true,
        autoRotate: false
      },

      // Default lighting
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
      ],
      ...options
    }

    this.canvas = canvas
    this.scene = new THREE.Scene()
    this.objects = new Map()
    this.isActive = true
    this.controls = null
    this.physics = null
    this.lights = new Map()

    this.initRenderer()
    this.initCamera()
  }

  // Initialize THREE.js renderer
  initRenderer() {
    if (!this.canvas) return

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.options.antialias,
      alpha: this.options.alpha
    })

    if (this.options.shadows) {
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }

    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
  }

  // Initialize camera
  initCamera() {
    const aspect = this.canvas ?
      this.canvas.clientWidth / this.canvas.clientHeight :
      window.innerWidth / window.innerHeight

    this.camera = new THREE.PerspectiveCamera(
      this.options.fov,
      aspect,
      this.options.near,
      this.options.far
    )

    this.camera.position.copy(this.options.position)
    this.camera.lookAt(this.options.target)
  }

  // Main initialization
  async init() {
    if (this.options.usePhysics) {
      await this.initPhysics()
    }

    if (this.options.useOrbitControls && this.canvas) {
      this.initControls()
    }

    if (this.options.lights) {
      this.setupLights()
    }

    await this.setupScene()

    if (this.canvas) {
      window.addEventListener('resize', this.onWindowResize.bind(this))
      this.animate()
    }
  }

  // Initialize physics engine
  async initPhysics() {
    await RAPIER.init()
    this.physics = new RAPIER.World(this.options.gravity)
  }

  // Initialize orbit controls
  initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas)
    Object.assign(this.controls, this.options.controlsConfig)
  }

  // Setup lighting
  setupLights() {
    this.options.lights.forEach((light, index) => {
      let lightObject

      switch (light.type.toLowerCase()) {
        case 'ambient':
          lightObject = new THREE.AmbientLight(light.color, light.intensity)
          break
        case 'directional':
          lightObject = new THREE.DirectionalLight(light.color, light.intensity)
          if (light.position) lightObject.position.copy(light.position)
          if (light.castShadow) {
            lightObject.castShadow = true
            lightObject.shadow.mapSize.width = 2048
            lightObject.shadow.mapSize.height = 2048
          }
          break
        case 'point':
          lightObject = new THREE.PointLight(
            light.color,
            light.intensity,
            light.distance,
            light.decay
          )
          if (light.position) lightObject.position.copy(light.position)
          break
        case 'spot':
          lightObject = new THREE.SpotLight(
            light.color,
            light.intensity,
            light.distance,
            light.angle,
            light.penumbra,
            light.decay
          )
          if (light.position) lightObject.position.copy(light.position)
          break
      }

      if (lightObject) {
        this.lights.set(`${light.type}_${index}`, lightObject)
        this.scene.add(lightObject)
      }
    })
  }

  // Create object with optional physics
  createObject({
    geometry,
    material,
    position = new THREE.Vector3(0, 0, 0),
    rotation = new THREE.Euler(0, 0, 0),
    scale = new THREE.Vector3(1, 1, 1),
    physics = false,
    physicsOptions = {},
    castShadow = false,
    receiveShadow = false,
    name = `object_${this.objects.size}`
  }) {
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.copy(position)
    mesh.rotation.copy(rotation)
    mesh.scale.copy(scale)
    mesh.castShadow = castShadow
    mesh.receiveShadow = receiveShadow

    this.scene.add(mesh)
    const objectData = { mesh }

    if (physics && this.physics) {
      const {
        type = 'dynamic',
        shape = 'cuboid',
        restitution = 0.5,
        friction = 0.5,
        colliderScale = 1.0
      } = physicsOptions

      let rigidBodyDesc
      switch (type) {
        case 'static':
          rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
          break
        case 'kinematic':
          rigidBodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
          break
        case 'dynamic':
        default:
          rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      }

      const body = this.physics.createRigidBody(
        rigidBodyDesc.setTranslation(position.x, position.y, position.z)
      )

      let colliderDesc
      const size = new THREE.Vector3()
      geometry.computeBoundingBox()
      geometry.boundingBox.getSize(size)
      size.multiplyScalar(0.5 * colliderScale)

      switch (shape) {
        case 'sphere':
          colliderDesc = RAPIER.ColliderDesc.ball(size.x)
          break
        case 'capsule':
          colliderDesc = RAPIER.ColliderDesc.capsule(size.y, size.x)
          break
        case 'cuboid':
        default:
          colliderDesc = RAPIER.ColliderDesc.cuboid(size.x, size.y, size.z)
      }

      colliderDesc.setRestitution(restitution)
      colliderDesc.setFriction(friction)

      const collider = this.physics.createCollider(colliderDesc, body)
      objectData.body = body
      objectData.collider = collider
    }

    this.objects.set(name, objectData)
    return objectData
  }

  // Animation loop
  animate() {
    if (!this.isActive || !this.renderer) return

    requestAnimationFrame(this.animate.bind(this))

    if (this.physics) {
      this.physics.step()

      // Update physics objects
      this.objects.forEach(object => {
        if (object.body) {
          const position = object.body.translation()
          object.mesh.position.set(position.x, position.y, position.z)

          const rotation = object.body.rotation()
          object.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
        }
      })
    }

    if (this.controls) {
      this.controls.update()
    }

    this.update()
    this.renderer.render(this.scene, this.camera)
  }

  // Preview generation
  getPreviewRender(width = 300, height = 200) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const previewRenderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true
    })
    previewRenderer.setSize(width, height)

    const previewCamera = this.camera.clone()
    previewCamera.aspect = width / height
    previewCamera.updateProjectionMatrix()

    this.setupPreviewState()
    previewRenderer.render(this.scene, previewCamera)
    this.restoreMainState()

    const dataURL = canvas.toDataURL('image/png')
    previewRenderer.dispose()

    return dataURL
  }

  setupPreviewState() {
    this._originalPositions = new Map()
    this.objects.forEach((obj, name) => {
      if (obj.mesh) {
        this._originalPositions.set(name, {
          position: obj.mesh.position.clone(),
          rotation: obj.mesh.rotation.clone()
        })
      }
    })
  }

  restoreMainState() {
    if (this._originalPositions) {
      this.objects.forEach((obj, name) => {
        const originalState = this._originalPositions.get(name)
        if (originalState && obj.mesh) {
          obj.mesh.position.copy(originalState.position)
          obj.mesh.rotation.copy(originalState.rotation)
        }
      })
      this._originalPositions = null
    }
  }

  // Cleanup
  dispose() {
    this.isActive = false
    if (this.physics) this.physics.free()
    if (this.renderer) {
      window.removeEventListener('resize', this.onWindowResize)
      this.controls?.dispose()
    }

    this.objects.forEach(object => {
      if (object.mesh) {
        object.mesh.geometry.dispose()
        object.mesh.material.dispose()
      }
    })

    this.objects.clear()
    this.lights.clear()

    if (this.renderer) {
      this.renderer.dispose()
    }
  }

  // Abstract method for scene setup
  setupScene() {
    console.warn('setupScene() not implemented')
  }

  // Abstract method for custom updates
  update() {}

  // Window resize handler
  onWindowResize() {
    if (!this.renderer || !this.canvas) return

    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  // Get object by name
  getObject(name) {
    return this.objects.get(name)
  }

  removeObject(name) {
    const objectData = this.objects.get(name)
    if (objectData) {
      if (objectData.mesh) {
        this.scene.remove(objectData.mesh)
        objectData.mesh.geometry.dispose()
        objectData.mesh.material.dispose()
      }
      if (objectData.body && this.physics) {
        this.physics.removeRigidBody(objectData.body)
      }
      this.objects.delete(name)
    }
  }
}