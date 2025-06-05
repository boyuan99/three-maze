import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import RAPIER from '@dimforge/rapier3d-compat'

export class SerialCustomWorld extends BaseWorld {
  constructor(canvas, sceneConfig) {
    super(canvas, {
      cameraConfig: sceneConfig.camera || {
        position: new THREE.Vector3(8, 8, 8),
        fov: 75
      },
      rendererConfig: sceneConfig.renderer || {
        shadows: true
      },
      useOrbitControls: false, // Disable orbit controls for physics control
      lights: sceneConfig.lights || [
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
    this.sceneConfig = sceneConfig
    this.textureCache = new Map()

    // Physics and player control properties
    this.world = null
    this.playerBody = null
    this.playerPosition = new THREE.Vector3(0, 0.5, 0)
    this.playerRotation = 0
    this.isPhysicsEnabled = false

    // Camera follow properties
    this.cameraOffset = new THREE.Vector3(0, 2, 0)
  }

  async init() {
    // Initialize physics first
    await this.initPhysics()

    // Then call parent init
    await super.init()

    // Set up camera to follow player
    this.setupPlayerCamera()
  }

  async initPhysics() {
    try {
      await RAPIER.init()
      this.world = new RAPIER.World({ x: 0, y: -9.81 * 50, z: 0 }) // Stronger gravity
      this.isPhysicsEnabled = true
      console.log('Physics world initialized for SerialCustomWorld')
    } catch (error) {
      console.error('Failed to initialize physics:', error)
      this.isPhysicsEnabled = false
    }
  }

  setupPlayerCamera() {
    if (this.camera) {
      // Set camera to follow player position
      this.camera.position.copy(this.playerPosition).add(this.cameraOffset)
      this.camera.lookAt(
        this.playerPosition.x,
        this.playerPosition.y,
        this.playerPosition.z - 10
      )
    }
  }

  createPlayer(config = {}) {
    if (!this.isPhysicsEnabled || !this.world) {
      console.warn('Physics not available, cannot create player')
      return null
    }

    const playerConfig = this.sceneConfig.player || config
    const radius = playerConfig.radius || 0.5
    const startPos = playerConfig.position || { x: 0, y: 0.5, z: 0 }

    // Create player physics body
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startPos.x, startPos.y, startPos.z)
      .setLinearDamping(0)
      .setAngularDamping(0)

    this.playerBody = this.world.createRigidBody(playerBodyDesc)

    const colliderDesc = RAPIER.ColliderDesc.ball(radius)
      .setRestitution(0)
      .setFriction(0)

    this.world.createCollider(colliderDesc, this.playerBody)

    // Create visual representation (optional)
    if (playerConfig.visual !== false) {
      const geometry = new THREE.SphereGeometry(radius, 16, 16)
      const material = new THREE.MeshStandardMaterial({
        color: 0xff0000,
        transparent: true,
        opacity: 0.5
      })
      const playerMesh = new THREE.Mesh(geometry, material)
      this.scene.add(playerMesh)

      // Store reference for updates
      this.playerMesh = playerMesh
    }

    this.updatePlayerPosition()
    console.log('Player created at:', startPos)
    return this.playerBody
  }

  updatePlayerPosition() {
    if (this.playerBody) {
      const pos = this.playerBody.translation()
      this.playerPosition.set(pos.x, pos.y, pos.z)

      // Update visual mesh if it exists
      if (this.playerMesh) {
        this.playerMesh.position.copy(this.playerPosition)
      }

      // Update camera to follow player
      this.updateCamera()
    }
  }

  updateCamera() {
    if (this.camera) {
      // Calculate camera position based on player position and rotation
      const cameraPos = new THREE.Vector3()
        .copy(this.playerPosition)
        .add(this.cameraOffset)

      this.camera.position.copy(cameraPos)

      // Look ahead in the direction the player is facing
      const lookTarget = new THREE.Vector3(
        this.playerPosition.x + Math.sin(this.playerRotation) * 10,
        this.playerPosition.y,
        this.playerPosition.z - Math.cos(this.playerRotation) * 10
      )

      this.camera.lookAt(lookTarget)
    }
  }

  setPlayerVelocity(velocity) {
    if (this.playerBody && this.isPhysicsEnabled) {
      this.playerBody.setLinvel(velocity, true)
    }
  }

  setPlayerPosition(position) {
    if (this.playerBody && this.isPhysicsEnabled) {
      this.playerBody.setTranslation(position, true)
      this.updatePlayerPosition()
    }
  }

  setPlayerRotation(rotation) {
    this.playerRotation = rotation
    if (this.playerBody && this.isPhysicsEnabled) {
      this.playerBody.setRotation({ x: 0, y: rotation, z: 0 }, true)
    }
  }

  getPlayerPosition() {
    if (this.playerBody) {
      const pos = this.playerBody.translation()
      return { x: pos.x, y: pos.y, z: pos.z }
    }
    return { x: 0, y: 0, z: 0 }
  }

  getPlayerVelocity() {
    if (this.playerBody) {
      const vel = this.playerBody.linvel()
      return { x: vel.x, y: vel.y, z: vel.z }
    }
    return { x: 0, y: 0, z: 0 }
  }

  async loadTexture(path) {
    if (this.textureCache.has(path)) {
      return this.textureCache.get(path).clone()
    }

    const textureLoader = new THREE.TextureLoader()
    const texture = await new Promise((resolve, reject) => {
      textureLoader.load(
        path.replace('@/', '/'),
        resolve,
        undefined,
        reject
      )
    })

    this.textureCache.set(path, texture)
    return texture.clone()
  }

  async loadSkybox(path) {
    if (!path) return

    try {
      const fileName = path.split('/').pop()
      const assetUrl = `/src/assets/${fileName}`

      const exrLoader = new EXRLoader()
      const texture = await new Promise((resolve) =>
        exrLoader.load(assetUrl, resolve)
      )

      texture.mapping = THREE.EquirectangularReflectionMapping
      this.scene.background = texture
      this.scene.environment = texture
    } catch (error) {
      console.warn(`Failed to load skybox: ${path}`, error)
    }
  }

  createPhysicsObject(objectConfig) {
    if (!this.isPhysicsEnabled || !this.world) {
      console.warn('Physics not available for object:', objectConfig.name)
      return null
    }

    const physics = objectConfig.physics
    if (!physics || !physics.enabled) return null

    const position = objectConfig.position || { x: 0, y: 0, z: 0 }

    // Create rigid body
    let bodyDesc
    if (physics.type === 'static') {
      bodyDesc = RAPIER.RigidBodyDesc.fixed()
    } else {
      bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    }

    bodyDesc.setTranslation(position.x, position.y, position.z)

    if (physics.mass) bodyDesc.setMass(physics.mass)
    if (physics.linearDamping !== undefined) bodyDesc.setLinearDamping(physics.linearDamping)
    if (physics.angularDamping !== undefined) bodyDesc.setAngularDamping(physics.angularDamping)

    const rigidBody = this.world.createRigidBody(bodyDesc)

    // Create collider based on geometry
    let colliderDesc
    const geom = objectConfig.geometry

    switch (geom.type) {
      case 'box':
        colliderDesc = RAPIER.ColliderDesc.cuboid(
          (geom.width || 1) / 2,
          (geom.height || 1) / 2,
          (geom.depth || 1) / 2
        )
        break
      case 'sphere':
        colliderDesc = RAPIER.ColliderDesc.ball(geom.radius || 1)
        break
      case 'cylinder':
        colliderDesc = RAPIER.ColliderDesc.cylinder(
          (geom.height || 1) / 2,
          geom.radiusTop || geom.radius || 1
        )
        break
      default:
        console.warn(`Unsupported physics geometry: ${geom.type}`)
        return null
    }

    if (physics.restitution !== undefined) colliderDesc.setRestitution(physics.restitution)
    if (physics.friction !== undefined) colliderDesc.setFriction(physics.friction)

    this.world.createCollider(colliderDesc, rigidBody)
    return rigidBody
  }

  async setupScene() {
    // Load skybox if specified
    if (this.sceneConfig.skybox) {
      await this.loadSkybox(this.sceneConfig.skybox)
    }

    if (this.sceneConfig.lights) {
      for (const lightConfig of this.sceneConfig.lights) {
        let light
        switch (lightConfig.type) {
          case 'point':
            light = new THREE.PointLight(
              lightConfig.color,
              lightConfig.intensity,
              lightConfig.distance,
              lightConfig.decay
            )
            light.position.copy(new THREE.Vector3(
              lightConfig.position.x,
              lightConfig.position.y,
              lightConfig.position.z
            ))
            light.castShadow = lightConfig.castShadow
            this.scene.add(light)
            break
          case 'ambient':
            const ambientLight = new THREE.AmbientLight(lightConfig.color, lightConfig.intensity)
            this.scene.add(ambientLight)
            break
          case 'directional':
            const directionalLight = new THREE.DirectionalLight(lightConfig.color, lightConfig.intensity)
            directionalLight.position.copy(lightConfig.position)
            directionalLight.castShadow = lightConfig.castShadow
            this.scene.add(directionalLight)
            break
          default:
            console.warn(`Unsupported light type: ${lightConfig.type}`)
        }
      }
    }

    if (this.sceneConfig.objects) {
      for (const objConfig of this.sceneConfig.objects) {
        let geometry
        switch (objConfig.geometry.type) {
          case 'box':
            geometry = new THREE.BoxGeometry(
              objConfig.geometry.width || 1,
              objConfig.geometry.height || 1,
              objConfig.geometry.depth || 1
            )
            break
          case 'sphere':
            geometry = new THREE.SphereGeometry(
              objConfig.geometry.radius || 1,
              objConfig.geometry.segments || 32
            )
            break
          case 'cylinder':
            geometry = new THREE.CylinderGeometry(
              objConfig.geometry.radiusTop || 1,
              objConfig.geometry.radiusBottom || 1,
              objConfig.geometry.height || 1
            )
            break
          default:
            console.warn(`Unsupported geometry type: ${objConfig.geometry.type}`)
            continue
        }

        const material = new THREE.MeshStandardMaterial({
          color: objConfig.material?.color || 0xffffff,
          metalness: objConfig.material?.metalness || 0,
          roughness: objConfig.material?.roughness || 1
        })

        if (objConfig.material?.map) {
          try {
            const texture = await this.loadTexture(objConfig.material.map)

            if (objConfig.material.repeat) {
              texture.wrapS = THREE.RepeatWrapping
              texture.wrapT = THREE.RepeatWrapping
              texture.repeat.set(
                objConfig.material.repeat.x,
                objConfig.material.repeat.y
              )
            }

            material.map = texture
            material.needsUpdate = true
          } catch (error) {
            console.warn(`Failed to load texture: ${objConfig.material.map}`, error)
          }
        }

        this.createObject({
          geometry,
          material,
          position: new THREE.Vector3(
            objConfig.position?.x || 0,
            objConfig.position?.y || 0,
            objConfig.position?.z || 0
          ),
          rotation: new THREE.Euler(
            objConfig.rotation?.x || 0,
            objConfig.rotation?.y || 0,
            objConfig.rotation?.z || 0
          ),
          physics: objConfig.physics?.enabled || false,
          physicsOptions: objConfig.physics,
          castShadow: objConfig.castShadow || false,
          receiveShadow: objConfig.receiveShadow || false,
          name: objConfig.name || `object_${this.objects.size}`
        })

        // Create physics body for this object
        this.createPhysicsObject(objConfig)
      }
    }

    // Create player if specified in config
    if (this.sceneConfig.player) {
      this.createPlayer(this.sceneConfig.player)
    }
  }

  animate() {
    // Step physics world
    if (this.world && this.isPhysicsEnabled) {
      this.world.step()
      this.updatePlayerPosition()
    }

    // Call parent animate
    super.animate()
  }

  dispose() {
    // Clean up physics world
    if (this.world) {
      this.world.free()
      this.world = null
    }

    // Clean up texture cache
    this.textureCache.forEach(texture => texture.dispose())
    this.textureCache.clear()

    // Call parent dispose
    super.dispose()
  }
}