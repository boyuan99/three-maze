import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'

export class BaseWorld {
  constructor(canvas, options = {}) {
    // Default configurations
    const defaultOptions = {
      rendererConfig: {
        alpha: false,
        antialias: true,
        shadows: false,
        physicallyCorrectLights: false,
      },
      cameraConfig: {
        fov: 75,
        near: 0.1,
        far: 1000,
        position: new THREE.Vector3(5, 5, 5),
        target: new THREE.Vector3(0, 0, 0),
      },
      usePhysics: true,
      physicsConfig: {
        gravity: {x: 0, y: -9.81, z: 0},
      },
      useOrbitControls: false,
      controlsConfig: {
        enableDamping: true,
        dampingFactor: 0.05,
        enableZoom: true,
        enablePan: true,
        autoRotate: false
      },
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
    }

    this.options = this.deepMerge(defaultOptions, options)
    this.canvas = canvas
    this.scene = new THREE.Scene()
    this.objects = new Map()
    this.isActive = true
    this.controls = null
    this.physics = null
    this.physicsInitialized = false
    this.lights = new Map()
    this._originalStates = null

    this.initRenderer()
    this.initCamera()
  }

  deepMerge(target, source) {
    const output = {...target}

    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(key => {
        if (isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, {[key]: source[key]})
          } else {
            output[key] = this.deepMerge(target[key], source[key])
          }
        } else {
          Object.assign(output, {[key]: source[key]})
        }
      })
    }
    return output
  }

  initRenderer() {
    if (!this.canvas) return

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.options.rendererConfig.antialias,
      alpha: this.options.rendererConfig.alpha
    })

    if (this.options.rendererConfig.shadows) {
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }

    if (this.options.rendererConfig.physicallyCorrectLights) {
      this.renderer.physicallyCorrectLights = true
    }

    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
    this.renderer.setPixelRatio(window.devicePixelRatio)
  }

  initCamera() {
    const aspect = this.canvas ?
      this.canvas.clientWidth / this.canvas.clientHeight :
      window.innerWidth / window.innerHeight

    this.camera = new THREE.PerspectiveCamera(
      this.options.cameraConfig.fov,
      aspect,
      this.options.cameraConfig.near,
      this.options.cameraConfig.far
    )

    this.camera.position.copy(this.options.cameraConfig.position)
    this.camera.lookAt(this.options.cameraConfig.target)
  }

  async init() {
    try {
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
    } catch (error) {
      console.error('Error during initialization:', error)
      throw error
    }
  }

  async initPhysics() {
    try {
      await RAPIER.init()
      this.physics = new RAPIER.World(this.options.physicsConfig.gravity)
      this.physicsInitialized = true
    } catch (error) {
      console.error('Failed to initialize physics:', error)
      this.physicsInitialized = false
      throw error
    }
  }

  initControls() {
    try {
      this.controls = new OrbitControls(this.camera, this.canvas)
      Object.assign(this.controls, this.options.controlsConfig)
    } catch (error) {
      console.error('Failed to initialize controls:', error)
    }
  }

  setupLights() {
    this.options.lights.forEach((light, index) => {
      let lightObject

      try {
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
            if (light.castShadow) {
              lightObject.castShadow = true
              lightObject.shadow.mapSize.width = 2048
              lightObject.shadow.mapSize.height = 2048
            }
            break
        }

        if (lightObject) {
          this.lights.set(`${light.type}_${index}`, lightObject)
          this.scene.add(lightObject)
        }
      } catch (error) {
        console.error(`Error setting up light ${light.type}:`, error)
      }
    })
  }

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
    try {
      const mesh = new THREE.Mesh(geometry, material)

      mesh.position.copy(position)
      mesh.scale.copy(scale)

      if (rotation instanceof THREE.Euler) {
        mesh.rotation.set(rotation.x, rotation.y, rotation.z, rotation.order)
      } else {
        mesh.rotation.set(rotation.x, rotation.y, rotation.z)
      }

      mesh.castShadow = castShadow
      mesh.receiveShadow = receiveShadow

      this.scene.add(mesh)
      const objectData = {mesh}

      if (physics && this.physicsInitialized && this.physics) {
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

        const quaternion = new THREE.Quaternion().setFromEuler(mesh.rotation)
        body.setRotation({x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w})

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
          case 'cylinder':
            colliderDesc = RAPIER.ColliderDesc.cylinder(size.y, size.x)
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
    } catch (error) {
      console.error('Error creating object:', error)
      return null
    }
  }

  animate() {
    if (!this.isActive || !this.renderer) return

    requestAnimationFrame(this.animate.bind(this))

    try {
      if (this.physicsInitialized && this.physics) {
        this.physics.step()

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
    } catch (error) {
      console.error('Error in animation loop:', error)
      this.isActive = false
    }
  }

  getPreviewRender(width = 300, height = 200) {
    try {
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
    } catch (error) {
      console.error('Error generating preview:', error)
      return null
    }
  }

  setupPreviewState() {
    try {
      this._originalStates = new Map()
      this.objects.forEach((obj, name) => {
        if (obj.mesh) {
          this._originalStates.set(name, {
            position: obj.mesh.position.clone(),
            rotation: obj.mesh.rotation.clone()
          })
        }
      })
    } catch (error) {
      console.error('Error setting up preview state:', error)
    }
  }

  restoreMainState() {
    try {
      if (this._originalStates) {
        this.objects.forEach((obj, name) => {
          const originalState = this._originalStates.get(name)
          if (originalState && obj.mesh) {
            obj.mesh.position.copy(originalState.position)
            obj.mesh.rotation.copy(originalState.rotation)
          }
        })
        this._originalStates = null
      }
    } catch (error) {
      console.error('Error restoring main state:', error)
    }
  }

  dispose() {
    this.isActive = false

    try {
      // Safely dispose of physics
      if (this.physicsInitialized && this.physics) {
        try {
          // Remove all physics bodies first
          this.objects.forEach(object => {
            if (object.body) {
              this.physics.removeRigidBody(object.body)
            }
          })
          this.physics.free()
        } catch (error) {
          console.warn('Error disposing physics world:', error)
        }
      }

      // Clean up renderer and event listeners
      if (this.renderer) {
        window.removeEventListener('resize', this.onWindowResize)
        this.controls?.dispose()
      }

      // Clean up objects
      this.objects.forEach(object => {
        if (object.mesh) {
          if (object.mesh.geometry) object.mesh.geometry.dispose()
          if (object.mesh.material) {
            if (object.mesh.material.map) object.mesh.material.map.dispose()
            object.mesh.material.dispose()
          }
        }
      })

      // Clear collections
      this.objects.clear()
      this.lights.clear()

      // Dispose renderer
      if (this.renderer) {
        this.renderer.dispose()
      }

      // Clear references
      this.physics = null
      this.physicsInitialized = false
      this._originalStates = null
    } catch (error) {
      console.error('Error during disposal:', error)
    }
  }

  setupScene() {
    console.warn('setupScene() not implemented')
  }

  update() {
    // Override in derived classes
  }

  onWindowResize() {
    if (!this.renderer || !this.canvas) return

    try {
      const width = this.canvas.clientWidth
      const height = this.canvas.clientHeight

      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(width, height)
    } catch (error) {
      console.error('Error handling window resize:', error)
    }
  }

  getObject(name) {
    return this.objects.get(name)
  }

  removeObject(name) {
    try {
      const objectData = this.objects.get(name)
      if (objectData) {
        if (objectData.mesh) {
          this.scene.remove(objectData.mesh)
          if (objectData.mesh.geometry) objectData.mesh.geometry.dispose()
          if (objectData.mesh.material) {
            if (objectData.mesh.material.map) objectData.mesh.material.map.dispose()
            objectData.mesh.material.dispose()
          }
        }

        if (this.physicsInitialized && this.physics && objectData.body) {
          try {
            this.physics.removeRigidBody(objectData.body)
          } catch (error) {
            console.warn('Error removing rigid body:', error)
          }
        }

        this.objects.delete(name)
      }
    } catch (error) {
      console.error('Error removing object:', error)
    }
  }

  // Helper method to safely remove all objects
  removeAllObjects() {
    try {
      const objectNames = Array.from(this.objects.keys())
      objectNames.forEach(name => this.removeObject(name))
    } catch (error) {
      console.error('Error removing all objects:', error)
    }
  }

  // Helper method to check if physics is ready
  isPhysicsReady() {
    return this.physicsInitialized && this.physics !== null
  }

  // Helper method to safely step physics
  stepPhysics() {
    if (this.isPhysicsReady()) {
      try {
        this.physics.step()
      } catch (error) {
        console.error('Error stepping physics:', error)
        this.physicsInitialized = false
      }
    }
  }

  // Helper method to safely update object transforms from physics
  updatePhysicsObjects() {
    if (!this.isPhysicsReady()) return

    this.objects.forEach(object => {
      if (object.body && object.mesh) {
        try {
          const position = object.body.translation()
          const rotation = object.body.rotation()

          object.mesh.position.set(position.x, position.y, position.z)
          object.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w)
        } catch (error) {
          console.warn('Error updating physics object:', error)
        }
      }
    })
  }
}

// Helper function to check if something is an object
function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item))
}