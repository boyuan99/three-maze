import * as THREE from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import {OrbitControls} from 'three/addons/controls/OrbitControls.js'

export class BaseWorld {
  constructor(canvas, options = {}) {
    // First create default configurations
    const defaultOptions = {
      // Renderer settings
      rendererConfig: {
        alpha: false,
        antialias: true,
        shadows: false,
        physicallyCorrectLights: false,
      },

      // Camera settings
      cameraConfig: {
        fov: 75,
        near: 0.1,
        far: 1000,
        position: new THREE.Vector3(5, 5, 5),
        target: new THREE.Vector3(0, 0, 0),
      },

      // Physics settings
      usePhysics: true,
      physicsConfig: {
        gravity: {x: 0, y: -300, z: 0},
      },

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

      // Fog settings
      fogConfig: {
        enabled: false,
        type: 'linear',  // 'linear' or 'exponential'
        color: 0xffffff,
        near: 10,
        far: 100,
        density: 0.01,   // Only used for exponential type
      },
    }

    this.options = this.deepMerge(defaultOptions, options)
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


  // Initialize THREE.js renderer
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

  // Initialize camera
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

    this.setupFog()

    await this.setupScene()

    if (this.canvas) {
      window.addEventListener('resize', this.onWindowResize.bind(this))
      this.animate()
    }
  }

  // Initialize physics engine
  async initPhysics() {
    await RAPIER.init()
    this.physics = new RAPIER.World(this.options.physicsConfig.gravity)
  }

  // Initialize orbit controls
  initControls() {
    this.controls = new OrbitControls(this.camera, this.canvas)
    Object.assign(this.controls, this.options.controlsConfig)
  }

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
    })
  }

  setupFog() {
    const fogConfig = this.options.fogConfig
    if (!fogConfig || !fogConfig.enabled) return

    if (fogConfig.type === 'exponential') {
      this.scene.fog = new THREE.FogExp2(fogConfig.color, fogConfig.density)
    } else {
      this.scene.fog = new THREE.Fog(fogConfig.color, fogConfig.near, fogConfig.far)
    }
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
  }

  animate() {
    if (!this.isActive || !this.renderer) return

    requestAnimationFrame(this.animate.bind(this))

    if (this.physics) {
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
  }

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
    this._originalStates = new Map()
    this.objects.forEach((obj, name) => {
      if (obj.mesh) {
        this._originalStates.set(name, {
          position: obj.mesh.position.clone(),
          rotation: obj.mesh.rotation.clone()
        })
      }
    })
  }

  restoreMainState() {
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
  }

  dispose() {
    this.isActive = false
    if (this.physics) this.physics.free()
    if (this.renderer) {
      window.removeEventListener('resize', this.onWindowResize)
      if (this.controls) {
        this.controls.dispose()
        this.controls = null
      }
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

  setupScene() {
    console.warn('setupScene() not implemented')
  }

  update() {
  }

  onWindowResize() {
    if (!this.renderer || !this.canvas) return

    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight

    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

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

function isObject(item) {
  return (item && typeof item === 'object' && !Array.isArray(item))
}