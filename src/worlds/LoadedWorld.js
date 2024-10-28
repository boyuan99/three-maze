import {BaseWorld} from './BaseWorld'
import * as THREE from 'three'

export class LoadedWorld extends BaseWorld {
  constructor(canvas, config) {
    // Process the config before passing to super
    const processedConfig = {
      cameraConfig: {
        position: new THREE.Vector3(
          config.camera.position.x,
          config.camera.position.y,
          config.camera.position.z
        ),
        target: new THREE.Vector3(
          config.camera.target?.x || 0,
          config.camera.target?.y || 0,
          config.camera.target?.z || 0
        ),
        fov: config.camera.fov,
        near: config.camera.near,
        far: config.camera.far
      },
      rendererConfig: {
        ...config.renderer,
        physicallyCorrectLights: config.renderer.physicallyCorrectLights ?? true,
        shadowMap: config.renderer.shadows ? THREE.PCFSoftShadowMap : undefined
      },
      useOrbitControls: config.controls?.enabled ?? true,
      controlsConfig: {
        enableDamping: config.controls?.damping ?? true,
        dampingFactor: config.controls?.dampingFactor ?? 0.05,
        enableZoom: config.controls?.zoom ?? true,
        enablePan: config.controls?.pan ?? true,
        maxDistance: config.controls?.maxDistance,
        minDistance: config.controls?.minDistance
      },
      lights: config.lights?.map(light => ({
        ...light,
        color: typeof light.color === 'string' ?
          parseInt(light.color.replace('#', '0x'), 16) : light.color,
        position: light.position ? new THREE.Vector3(
          light.position.x,
          light.position.y,
          light.position.z
        ) : undefined
      })) || [],
      usePhysics: config.physics?.enabled ?? false,
      physicsConfig: {
        gravity: config.physics?.gravity ?? {x: 0, y: -9.81, z: 0}
      }
    }

    super(canvas, processedConfig)
    this.config = config
    this.materials = new Map()
    this.textures = new Map()
    this.geometries = new Map()
  }

  static async loadFromFile(canvas, sceneData) {
    try {
      if (!LoadedWorld.validateSceneConfig(sceneData)) {
        throw new Error('Invalid scene configuration')
      }

      // Clean up existing world if present
      if (window.currentWorld) {
        if (window.currentWorld.physicsInitialized) {
          await window.currentWorld.dispose()
        }
        window.currentWorld = null
      }

      const world = new LoadedWorld(canvas, sceneData)
      await world.init()

      window.currentWorld = world
      return world
    } catch (error) {
      console.error('Failed to load scene:', error)
      throw error
    }
  }


  static validateSceneConfig(config) {
    try {
      const required = {
        camera: ['position', 'fov', 'near', 'far'],
        renderer: ['antialias'],
        components: null
      }

      // Check required top-level properties
      for (const [key, props] of Object.entries(required)) {
        if (!config.hasOwnProperty(key)) {
          console.warn(`Missing required property: ${key}`)
          return false
        }

        if (props) {
          for (const prop of props) {
            if (!config[key].hasOwnProperty(prop)) {
              console.warn(`Missing required ${key} property: ${prop}`)
              return false
            }
          }
        }
      }

      return true
    } catch (error) {
      console.error('Error validating scene config:', error)
      return false
    }
  }

  async init() {
    try {
      await super.init()
      await this.setupScene()
    } catch (error) {
      console.error('Error initializing world:', error)
      this.createFallbackScene()
    }
  }


  async setupScene() {
    try {
      await this.loadTextures()
      await this.createMaterials()
      await this.createComponents()
    } catch (error) {
      console.error('Error setting up scene:', error)
      this.createFallbackScene()
    }
  }

  async loadTextures() {
    const textureLoader = new THREE.TextureLoader()

    const loadTexture = async (path) => {
      if (!path || typeof path !== 'string') {
        console.warn(`Invalid texture path: ${path}`)
        return null
      }

      return new Promise((resolve) => {
        textureLoader.load(
          path,
          (texture) => {
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.RepeatWrapping
            resolve(texture)
          },
          undefined,
          () => {
            console.warn(`Failed to load texture: ${path}`)
            resolve(null)
          }
        )
      })
    }

    try {
      if (!this.config.assets?.textures) {
        console.warn('No textures defined in scene configuration')
        return
      }

      const textureEntries = Object.entries(this.config.assets.textures)
      const loadedTextures = await Promise.all(
        textureEntries.map(async ([name, path]) => {
          const texture = await loadTexture(path)
          return [name, texture]
        })
      )

      loadedTextures.forEach(([name, texture]) => {
        if (texture) {
          this.textures.set(name, texture)
        }
      })

    } catch (error) {
      console.error('Error in texture loading process:', error)
    }
  }

  async createMaterials() {
    try {
      if (!this.config.materials) {
        console.warn('No materials defined in scene configuration')
        return
      }

      Object.entries(this.config.materials).forEach(([name, config]) => {
        const materialParams = {
          color: typeof config.color === 'string' ?
            parseInt(config.color.replace('#', '0x'), 16) :
            config.color || 0xcccccc,
          roughness: config.roughness ?? 0.5,
          metalness: config.metalness ?? 0.0,
        }

        if (config.texture && this.textures.has(config.texture)) {
          materialParams.map = this.textures.get(config.texture)

          if (config.textureRepeat) {
            materialParams.map.repeat.set(
              config.textureRepeat.x || 1,
              config.textureRepeat.y || 1
            )
          }
        }

        const material = new THREE.MeshStandardMaterial(materialParams)
        this.materials.set(name, material)
      })
    } catch (error) {
      console.error('Error creating materials:', error)
      this.materials.set('default', new THREE.MeshStandardMaterial({
        color: 0xcccccc,
        roughness: 0.5,
        metalness: 0.0
      }))
    }
  }

  createGeometry(config) {
    try {
      if (!config || typeof config !== 'object') {
        console.warn('Invalid geometry configuration:', config)
        return new THREE.BoxGeometry(1, 1, 1)
      }

      const type = config.type?.toLowerCase() || 'box'
      const dimensions = this.evaluateDimensions(config.dimensions || {})

      let geometry
      switch (type) {
        case 'box':
          geometry = new THREE.BoxGeometry(
            dimensions.width || 1,
            dimensions.height || 1,
            dimensions.depth || 1
          )
          break

        case 'sphere':
          geometry = new THREE.SphereGeometry(
            dimensions.radius || 0.5,
            dimensions.segments || 32,
            dimensions.rings || 32
          )
          break

        case 'cylinder':
          geometry = new THREE.CylinderGeometry(
            dimensions.radiusTop || 0.5,
            dimensions.radiusBottom || 0.5,
            dimensions.height || 1,
            dimensions.segments || 32
          )
          break

        default:
          console.warn(`Unsupported geometry type: ${type}, using default box`)
          geometry = new THREE.BoxGeometry(1, 1, 1)
      }

      return geometry
    } catch (error) {
      console.error('Error creating geometry:', error)
      return new THREE.BoxGeometry(1, 1, 1)
    }
  }

  evaluateDimensions(dimensions) {
    const context = {...this.config.dimensions}
    try {
      return Object.entries(dimensions).reduce((acc, [key, value]) => {
        if (typeof value === 'string') {
          const expression = value.replace(/([a-zA-Z_][a-zA-Z0-9_]*)/g,
            match => context[match] !== undefined ? context[match] : match)
          try {
            acc[key] = new Function(`return ${expression}`)()
          } catch {
            acc[key] = 1 // Default value on evaluation error
          }
        } else {
          acc[key] = value
        }
        return acc
      }, {})
    } catch (error) {
      console.error('Error evaluating dimensions:', error)
      return dimensions
    }
  }

  async createComponents() {
    if (!this.config.components) {
      console.warn('No components defined in scene configuration')
      return
    }

    const processComponent = (component) => {
      console.log('Raw component:', component)

      // If the component has 'components' property, it's a group
      if (component.components) {
        processGroup(component.components)
        return null
      }

      // If the component has a 'cube' or similar property, we need to process that
      const actualComponent = Object.values(component)[0]
      if (!actualComponent) {
        console.warn('No component data found:', component)
        return null
      }

      console.log('Processing actual component:', actualComponent)
      console.log('Geometry config:', actualComponent.geometry)

      try {
        if (!actualComponent.geometry) {
          console.warn('Component missing geometry:', actualComponent)
          return null
        }

        const geometry = this.createGeometry(actualComponent.geometry)
        const material = this.materials.get(actualComponent.material) ||
          new THREE.MeshStandardMaterial({color: 0xcccccc})

        const mesh = new THREE.Mesh(geometry, material)

        if (actualComponent.position) {
          mesh.position.set(
            actualComponent.position.x || 0,
            actualComponent.position.y || 0,
            actualComponent.position.z || 0
          )
        }

        if (actualComponent.rotation) {
          mesh.rotation.set(
            THREE.MathUtils.degToRad(actualComponent.rotation.x || 0),
            THREE.MathUtils.degToRad(actualComponent.rotation.y || 0),
            THREE.MathUtils.degToRad(actualComponent.rotation.z || 0)
          )
        }

        if (actualComponent.scale) {
          mesh.scale.set(
            actualComponent.scale.x || 1,
            actualComponent.scale.y || 1,
            actualComponent.scale.z || 1
          )
        }

        mesh.castShadow = actualComponent.castShadow || false
        mesh.receiveShadow = actualComponent.receiveShadow || false

        return mesh
      } catch (error) {
        console.error('Error processing component:', error)
        return null
      }
    }

    const processGroup = (group) => {
      console.log('Processing group:', group)

      if (!group || typeof group !== 'object') {
        return
      }

      Object.entries(group).forEach(([name, content]) => {
        console.log(`Processing group entry '${name}':`, content)

        if (Array.isArray(content)) {
          content.forEach(item => {
            const mesh = processComponent(item)
            if (mesh) this.scene.add(mesh)
          })
        } else if (typeof content === 'object') {
          const mesh = processComponent(content)
          if (mesh) this.scene.add(mesh)
        }
      })
    }

    try {
      processGroup(this.config.components)
    } catch (error) {
      console.error('Error creating components:', error)
      this.createFallbackScene()
    }
  }

  createFallbackScene() {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({color: 0xff0000})
    const mesh = new THREE.Mesh(geometry, material)
    this.scene.add(mesh)

    const light = new THREE.AmbientLight(0xffffff, 0.5)
    this.scene.add(light)

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1)
    directionalLight.position.set(5, 5, 5)
    this.scene.add(directionalLight)
  }

  dispose() {
    try {
      // Clear all resources
      this.geometries.forEach(geometry => geometry.dispose())
      this.geometries.clear()

      this.materials.forEach(material => {
        if (material.map) material.map.dispose()
        material.dispose()
      })
      this.materials.clear()

      this.textures.forEach(texture => texture.dispose())
      this.textures.clear()

      while (this.scene.children.length > 0) {
        const object = this.scene.children[0]
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          if (object.material.map) object.material.map.dispose()
          object.material.dispose()
        }
        this.scene.remove(object)
      }

      // Call base class dispose
      super.dispose()
    } catch (error) {
      console.error('Error disposing world:', error)
    }
  }
}