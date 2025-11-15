import { BaseWorld } from './BaseWorld'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'

export class CustomWorld extends BaseWorld {
  constructor(canvas, sceneConfig) {
    super(canvas, {
      cameraConfig: sceneConfig.camera || {
        position: new THREE.Vector3(8, 8, 8),
        fov: 75
      },
      rendererConfig: sceneConfig.renderer || {
        shadows: true
      },
      useOrbitControls: true,
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

    // Create a camera positioned to look forward horizontally
    const previewCamera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)

    // Position camera at eye level (y=1.6), looking forward along -Z axis
    previewCamera.position.set(0, 1.6, 8)
    previewCamera.lookAt(0, 1.6, 0)
    previewCamera.updateProjectionMatrix()

    this.setupPreviewState()
    previewRenderer.render(this.scene, previewCamera)
    this.restoreMainState()

    const dataURL = canvas.toDataURL('image/png')
    previewRenderer.dispose()

    return dataURL
  }
}