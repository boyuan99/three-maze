import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { FixedCam } from '@/utils/FixedCam'
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
      useOrbitControls: false,
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


    this.fixedCam = null
    this.playerBody = null
    this.playerConfig = sceneConfig.player || {
      type: 'sphere',
      radius: 0.5,
      position: { x: 0, y: 1, z: 0 },
      physics: {
        enabled: true,
        type: 'dynamic',
        mass: 1,
        linearDamping: 0.9,
        angularDamping: 0.9,
        restitution: 0,
        friction: 1
      }
    }
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
      }
    }

    // Setup first person controls
    await this.setupFirstPersonControls()
  }

  async setupFirstPersonControls() {
    if (!this.canvas) return

    // Initialize fixed camera
    this.fixedCam = new FixedCam(this.scene, this.camera, this.renderer)
    this.fixedCam.mouseSensitivity = 0.002

    // Reset camera rotation
    this.camera.rotation.set(0, 0, 0)

    // Create player physics object
    await this.createPlayer()

    // Initialize camera position to player position
    const playerPos = this.playerBody.translation()
    this.camera.position.set(playerPos.x, playerPos.y + 1.5, playerPos.z)
  }

  async createPlayer() {
    if (!this.physics) return

    const playerPos = this.playerConfig.position

    // Create player rigid body
    const playerBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(playerPos.x, playerPos.y, playerPos.z)
      .setLinearDamping(this.playerConfig.physics.linearDamping)
      .setAngularDamping(this.playerConfig.physics.angularDamping)

    this.playerBody = this.physics.createRigidBody(playerBodyDesc)

    // Create collider
    let colliderDesc
    if (this.playerConfig.type === 'sphere') {
      colliderDesc = RAPIER.ColliderDesc.ball(this.playerConfig.radius)
    } else {
      // Default to capsule
      colliderDesc = RAPIER.ColliderDesc.capsule(0.5, this.playerConfig.radius)
    }

    colliderDesc
      .setRestitution(this.playerConfig.physics.restitution)
      .setFriction(this.playerConfig.physics.friction)

    this.physics.createCollider(colliderDesc, this.playerBody)

    return this.playerBody
  }

  // Method for responding to serial control
  updateFromSerialData(data) {
    if (!this.playerBody || !this.fixedCam) return

    try {
      // Extract x, y, theta values from serial data
      const vx = parseFloat(data.x) || 0
      const vz = parseFloat(data.y) || 0
      const deltaTheta = parseFloat(data.theta) || 0

      // Update player position
      this.playerBody.setLinvel({
        x: vx,
        y: this.playerBody.linvel().y, // Keep vertical velocity
        z: vz
      }, true)

      // Update player rotation
      const currentRotation = this.playerBody.rotation()
      const newRotationY = currentRotation.y + deltaTheta * 0.05

      this.playerBody.setRotation({
        x: 0,
        y: newRotationY,
        z: 0
      }, true)

      // Update camera position and direction
      const playerPos = this.playerBody.translation()
      this.fixedCam.update({
        position: new THREE.Vector3(
          playerPos.x,
          playerPos.y + 1.5,
          playerPos.z
        ),
        rotation: new THREE.Euler(0, newRotationY, 0)
      })
    } catch (error) {
      console.error('Error updating from serial data:', error)
    }
  }
}