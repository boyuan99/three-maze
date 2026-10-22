// DOM-free port of v0.3's experiment-scene construction (src/scenes/serial/PythonCustomScene.vue):
// the skybox, camera and lights of onMounted (:544-617), the meshes of createSceneFromConfig
// (:349-450) and the camera rig (:642-667, src/utils/FixedCam.js:4-12, FixedFollowCam.js:4-9).
// It builds the same three.js objects in the same order, quirks included (README.md). The caller
// passes the asset loaders, because three's TextureLoader needs an <img> element; the one deliberate
// difference is that a skybox that fails to load does not hang the build (README.md, deviation 1).
import * as THREE from 'three'
import { resolveAssetPath } from '../../utils/resolveAssetPath.js'
import type { V0LightConfig, V0Object, V0SceneConfig } from './config.ts'
import { V0_PLAYER } from './physics.ts'

/** Height v0.3 adds to the player body's centre to place the camera rig (:235, :663) */
export const V0_RIG_HEIGHT = 1.6
/** Height of the camera inside the rig (:574); it adds to V0_RIG_HEIGHT (README.md, quirk 7) */
export const V0_CAMERA_HEIGHT_IN_RIG = 1.6
/** Camera settings v0.3 fixes (:567-572); only `fov` comes from the JSON */
export const V0_CAMERA = { defaultFov: 75, near: 0.1, far: 1000 }
/** Range and decay of every point light, whatever the JSON says (:609) */
export const V0_POINT_LIGHT = { distance: 50, decay: 2 }

/** Lights v0.3 adds when the JSON has no `lights` key (:588-591) */
export const V0_DEFAULT_LIGHTS: readonly V0LightConfig[] = [
  { type: 'ambient', color: 0xffffff, intensity: 0.5 },
  { type: 'directional', color: 0xffffff, intensity: 1, position: { x: 5, y: 5, z: 5 }, castShadow: true }
]

export interface V0AssetLoaders {
  /** Loads a colour texture, a new Texture per call (v0.3: TextureLoader, :401-408); rejects on failure */
  texture(url: string): Promise<THREE.Texture>
  /** Loads the equirectangular sky (v0.3: EXRLoader, :549-555); rejects on failure */
  skybox(url: string): Promise<THREE.Texture>
}

export interface V0BuildOptions {
  /** Camera aspect ratio; v0.3 uses window.innerWidth / window.innerHeight (:569) */
  aspect: number
  loaders: V0AssetLoaders
}

/** The camera's parents: v0.3's FixedFollowCam turns `yaw` and never moves `pitch` */
export interface V0CameraRig {
  yaw: THREE.Object3D
  pitch: THREE.Object3D
}

export interface V0Asset {
  kind: 'texture' | 'skybox'
  url: string
  /** Index in the JSON's `objects`; null for the skybox */
  objectIndex: number | null
  loaded: boolean
}

export interface V0SceneBuild {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  rig: V0CameraRig
  /** One mesh per object with a supported geometry, in JSON order (as they were added to the scene) */
  meshes: Array<{ objectIndex: number, name: string | null, mesh: THREE.Mesh }>
  lights: THREE.Light[]
  assets: V0Asset[]
  /** What v0.3 skipped or replaced, one line each (v0.3 logs some of it to the console) */
  diagnostics: string[]
}

export async function buildV0Scene(config: V0SceneConfig, options: V0BuildOptions): Promise<V0SceneBuild> {
  const { aspect, loaders } = options
  const assets: V0Asset[] = []
  const diagnostics: string[] = []
  const scene = new THREE.Scene()

  // Skybox: the EXR is both the background and the environment map (:546-564)
  if (config.skybox) {
    let url: string | null = null
    try {
      url = resolveAssetPath(config.skybox, config._basePath) as string
      const texture = await loaders.skybox(url)
      texture.mapping = THREE.EquirectangularReflectionMapping
      scene.background = texture
      scene.environment = texture
      assets.push({ kind: 'skybox', url, objectIndex: null, loaded: true })
    } catch (error) {
      // v0.3 would wait forever here: its promise has no error callback (:553-555)
      assets.push({ kind: 'skybox', url: url ?? String(config.skybox), objectIndex: null, loaded: false })
      diagnostics.push(`skybox ${config.skybox} failed to load, no background (v0.3 hangs): ${errorText(error)}`)
    }
  }

  // Camera (:567-574); the JSON's camera.position, near and far are ignored
  const camera = new THREE.PerspectiveCamera(config.camera?.fov || V0_CAMERA.defaultFov, aspect, V0_CAMERA.near, V0_CAMERA.far)
  camera.position.set(0, V0_CAMERA_HEIGHT_IN_RIG, 0)

  // Lights, before the meshes (:587-617); an empty list stays empty
  const lights: THREE.Light[] = []
  for (const lightConfig of config.lights || V0_DEFAULT_LIGHTS) {
    const light = createLight(lightConfig)
    if (light) {
      scene.add(light)
      lights.push(light)
    } else {
      diagnostics.push(`light type '${lightConfig.type}' is not supported, skipped`)
    }
  }

  // Meshes in JSON order, each texture awaited in turn (:354-447)
  const meshes: V0SceneBuild['meshes'] = []
  if (config.objects) {
    for (const [objectIndex, objConfig] of config.objects.entries()) {
      const name = objConfig.name ?? null
      const label = `object ${objectIndex} (${name ?? 'unnamed'})`
      if (!objConfig.geometry) throw new TypeError(`${label} has no geometry (v0.3 fails here too, :357)`)
      const geometry = createGeometry(objConfig)
      if (!geometry) {
        diagnostics.push(`${label}: geometry type '${objConfig.geometry.type}' is not supported, skipped`)
        continue
      }

      // `||` defaults: colour 0 becomes white, roughness 0 becomes 1 (:388-392)
      const material = new THREE.MeshStandardMaterial({
        color: objConfig.material?.color || 0xffffff,
        metalness: objConfig.material?.metalness || 0,
        roughness: objConfig.material?.roughness || 1
      })

      // A texture that fails to load leaves the flat colour (:394-426)
      if (objConfig.material?.map) {
        let url: string | null = null
        try {
          url = resolveAssetPath(objConfig.material.map, config._basePath) as string
          const texture = await loaders.texture(url)
          if (objConfig.material.repeat) {
            texture.wrapS = THREE.RepeatWrapping
            texture.wrapT = THREE.RepeatWrapping
            texture.repeat.set(objConfig.material.repeat.x, objConfig.material.repeat.y)
          }
          material.map = texture
          material.needsUpdate = true
          assets.push({ kind: 'texture', url, objectIndex, loaded: true })
        } catch (error) {
          assets.push({ kind: 'texture', url: url ?? String(objConfig.material.map), objectIndex, loaded: false })
          diagnostics.push(`${label}: texture ${objConfig.material.map} failed to load, flat colour used: ${errorText(error)}`)
        }
      }

      const mesh = new THREE.Mesh(geometry, material)
      mesh.position.set(objConfig.position?.x || 0, objConfig.position?.y || 0, objConfig.position?.z || 0)
      mesh.rotation.set(objConfig.rotation?.x || 0, objConfig.rotation?.y || 0, objConfig.rotation?.z || 0)
      mesh.castShadow = objConfig.castShadow || false
      mesh.receiveShadow = objConfig.receiveShadow || false
      scene.add(mesh)
      meshes.push({ objectIndex, name, mesh })
    }
  }

  // Camera rig, added last (FixedCam.js:4-12): scene > yaw > pitch > camera; then the first
  // placement at the player's starting position, facing -z (:658-667)
  const rig: V0CameraRig = { yaw: new THREE.Object3D(), pitch: new THREE.Object3D() }
  rig.yaw.add(rig.pitch)
  rig.pitch.add(camera)
  scene.add(rig.yaw)
  placeV0Camera(rig, { x: V0_PLAYER.position[0], y: V0_PLAYER.position[1], z: V0_PLAYER.position[2] }, 0)

  return { scene, camera, rig, meshes, lights, assets, diagnostics }
}

/**
 * Places the rig as v0.3 does every frame (:231-240, FixedCam.js:45-47, FixedFollowCam.js:4-9):
 * at the player body's centre plus V0_RIG_HEIGHT, turned by the heading theta (radians, about +y).
 * The camera sits V0_CAMERA_HEIGHT_IN_RIG higher inside the rig.
 */
export function placeV0Camera(rig: V0CameraRig, body: { x: number, y: number, z: number }, theta: number) {
  rig.yaw.position.set(body.x, body.y + V0_RIG_HEIGHT, body.z)
  rig.yaw.rotation.y = theta || 0
}

function createGeometry(objConfig: V0Object): THREE.BufferGeometry | null {
  const geometry = objConfig.geometry
  switch (geometry.type) {
    case 'box':
      return new THREE.BoxGeometry(geometry.width || 1, geometry.height || 1, geometry.depth || 1)
    case 'sphere':
      return new THREE.SphereGeometry(geometry.radius || 1, geometry.segments || 32)
    case 'cylinder':
      return new THREE.CylinderGeometry(geometry.radiusTop || 1, geometry.radiusBottom || 1, geometry.height || 1)
    default:
      return null
  }
}

function createLight(lightConfig: V0LightConfig): THREE.Light | null {
  let light: THREE.Light
  switch (lightConfig.type) {
    case 'ambient':
      return new THREE.AmbientLight(lightConfig.color, lightConfig.intensity)
    case 'directional':
      // The target stays at the origin and is not added to the scene
      light = new THREE.DirectionalLight(lightConfig.color, lightConfig.intensity)
      break
    case 'point':
      light = new THREE.PointLight(lightConfig.color, lightConfig.intensity, V0_POINT_LIGHT.distance, V0_POINT_LIGHT.decay)
      break
    default:
      return null
  }
  if (lightConfig.position) {
    light.position.set(lightConfig.position.x, lightConfig.position.y, lightConfig.position.z)
  }
  light.castShadow = lightConfig.castShadow || false
  return light
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
