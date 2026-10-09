// A plain-data description of a three.js scene graph, for golden snapshots and equivalence tests:
// this port against v0.3's own loader now, later the scene builder (TS-07) against this port. It
// runs in Node, a worker or the renderer, and changes nothing but derived data: it updates the world
// matrices as the renderer does before each frame, and Box3.setFromObject caches each geometry's
// bounding box. Values are as three.js holds them: colours in its linear working space plus the
// sRGB hex, angles in radians, and each camera's projection matrix as stored (the renderer does not
// recompute it, so a builder that changes fov or aspect without updateProjectionMatrix() must not
// compare equal). Ids, uuids, user data and version counters are left out.
import * as THREE from 'three'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

export interface ColorDescription {
  hex: string                 // sRGB, as Color.getHexString() gives it
  linear: Vec3                // r, g, b as stored
}

export interface TextureDescription {
  label: string | null        // from DescribeOptions.textureLabel
  class: 'Texture' | 'DataTexture' | 'CompressedTexture' | 'CubeTexture' | 'other'
  mapping: number
  wrapS: number
  wrapT: number
  repeat: [number, number]
  offset: [number, number]
  center: [number, number]
  rotation: number
  flipY: boolean
  colorSpace: string
  generateMipmaps: boolean
  magFilter: number
  minFilter: number
  anisotropy: number
  type: number
  format: number
  premultiplyAlpha: boolean
  unpackAlignment: number
  /** null when the texture has no image (not loaded, or a test stub) */
  image: { width: number | null, height: number | null, data: { class: string, length: number, fnv1a: string } | null } | null
}

export interface MaterialDescription {
  type: string
  [parameter: string]: unknown
}

export interface GeometryDescription {
  type: string
  parameters: Record<string, unknown> | null
  vertexCount: number | null
  indexCount: number | null
  groups: number
}

export interface LightDescription {
  color: ColorDescription
  intensity: number
  distance?: number
  decay?: number
  angle?: number
  penumbra?: number
  groundColor?: ColorDescription
  /** Directional and spot lights: where the target is and whether it is in the scene graph */
  target?: { position: Vec3, inSceneGraph: boolean }
  shadow?: {
    mapSize: [number, number]
    bias: number
    normalBias: number
    radius: number
    blurSamples: number
    camera: Record<string, unknown>
  }
}

export interface NodeDescription {
  type: string
  name: string
  visible: boolean
  castShadow: boolean
  receiveShadow: boolean
  frustumCulled: boolean
  renderOrder: number
  layers: number
  position: Vec3
  rotation: [number, number, number, string]
  scale: Vec3
  matrixWorld: number[]
  geometry?: GeometryDescription
  material?: MaterialDescription | MaterialDescription[]
  /** Axis-aligned box of the mesh in world space (Box3.setFromObject) */
  worldBox?: { min: Vec3, max: Vec3 }
  light?: LightDescription
  camera?: Record<string, unknown>
  children: NodeDescription[]
}

export interface SceneDescription {
  background: TextureDescription | ColorDescription | null
  /** 'background' when the environment is the background texture itself */
  environment: TextureDescription | 'background' | null
  fog: { type: string, color: ColorDescription, near?: number, far?: number, density?: number } | null
  backgroundBlurriness: number
  backgroundIntensity: number
  backgroundRotation: [number, number, number, string]
  environmentIntensity: number
  environmentRotation: [number, number, number, string]
  overrideMaterial: MaterialDescription | null
  children: NodeDescription[]
  /** The camera passed in: its place in the graph (child indices from the scene; null if outside) and world pose */
  camera: { path: number[] | null, worldPosition: Vec3, worldQuaternion: Quat, worldDirection: Vec3 } | null
}

export interface DescribeOptions {
  /** Names a texture, for example by the URL it was loaded from; without it labels are null */
  textureLabel?: (texture: THREE.Texture) => string | null
}

// Material parameters reported when the material has them (MeshStandardMaterial and the others)
const MATERIAL_NUMBERS = ['metalness', 'roughness', 'emissiveIntensity', 'opacity', 'alphaTest', 'side',
  'envMapIntensity', 'reflectivity', 'refractionRatio', 'shininess', 'blending', 'lightMapIntensity',
  'aoMapIntensity', 'bumpScale', 'displacementScale', 'displacementBias'] as const
const MATERIAL_FLAGS = ['transparent', 'depthTest', 'depthWrite', 'fog', 'flatShading', 'wireframe',
  'toneMapped', 'vertexColors', 'visible'] as const
const MATERIAL_COLORS = ['color', 'emissive', 'specular'] as const
const MATERIAL_MAPS = ['map', 'envMap', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap',
  'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'specularMap'] as const

export function describeScene(scene: THREE.Scene, camera: THREE.Object3D | null, options: DescribeOptions = {}): SceneDescription {
  const label = options.textureLabel ?? (() => null)
  scene.updateMatrixWorld(true)

  const background = scene.background
  return {
    background: background?.isTexture ? describeTexture(background, label) : background?.isColor ? describeColor(background) : null,
    environment: scene.environment == null ? null
      : scene.environment === background ? 'background' : describeTexture(scene.environment, label),
    fog: scene.fog ? describeFog(scene.fog) : null,
    backgroundBlurriness: scene.backgroundBlurriness,
    backgroundIntensity: scene.backgroundIntensity,
    backgroundRotation: euler(scene.backgroundRotation),
    environmentIntensity: scene.environmentIntensity,
    environmentRotation: euler(scene.environmentRotation),
    overrideMaterial: scene.overrideMaterial ? describeMaterial(scene.overrideMaterial, label) : null,
    children: scene.children.map((child: THREE.Object3D) => describeNode(child, label)),
    camera: camera ? describeCameraPlacement(scene, camera) : null
  }
}

function describeNode(object: THREE.Object3D, label: TextureLabel): NodeDescription {
  const node: Omit<NodeDescription, 'children'> = {
    type: object.type,
    name: object.name,
    visible: object.visible,
    castShadow: object.castShadow,
    receiveShadow: object.receiveShadow,
    frustumCulled: object.frustumCulled,
    renderOrder: object.renderOrder,
    layers: object.layers.mask,
    position: vec3(object.position),
    rotation: euler(object.rotation),
    scale: vec3(object.scale),
    matrixWorld: [...object.matrixWorld.elements]
  }
  if (object.isMesh) {
    node.geometry = describeGeometry(object.geometry)
    node.material = Array.isArray(object.material)
      ? object.material.map((material: THREE.Material) => describeMaterial(material, label))
      : describeMaterial(object.material, label)
    const box = new THREE.Box3().setFromObject(object)
    node.worldBox = { min: vec3(box.min), max: vec3(box.max) }
  }
  if (object.isLight) node.light = describeLight(object)
  if (object.isCamera) node.camera = describeCamera(object)
  return { ...node, children: object.children.map((child: THREE.Object3D) => describeNode(child, label)) }
}

function describeGeometry(geometry: THREE.BufferGeometry): GeometryDescription {
  return {
    type: geometry.type,
    parameters: geometry.parameters ? { ...geometry.parameters } : null,
    vertexCount: geometry.attributes?.position?.count ?? null,
    indexCount: geometry.index?.count ?? null,
    groups: geometry.groups.length
  }
}

function describeMaterial(material: THREE.Material, label: TextureLabel): MaterialDescription {
  const description: MaterialDescription = { type: material.type }
  for (const key of MATERIAL_COLORS) if (material[key]?.isColor) description[key] = describeColor(material[key])
  for (const key of MATERIAL_NUMBERS) if (typeof material[key] === 'number') description[key] = material[key]
  for (const key of MATERIAL_FLAGS) if (typeof material[key] === 'boolean') description[key] = material[key]
  const maps: Record<string, TextureDescription> = {}
  for (const key of MATERIAL_MAPS) if (material[key]?.isTexture) maps[key] = describeTexture(material[key], label)
  description.maps = maps
  return description
}

function describeTexture(texture: THREE.Texture, label: TextureLabel): TextureDescription {
  const image = texture.image
  return {
    label: label(texture),
    class: texture.isDataTexture ? 'DataTexture' : texture.isCompressedTexture ? 'CompressedTexture'
      : texture.isCubeTexture ? 'CubeTexture' : texture.constructor === THREE.Texture ? 'Texture' : 'other',
    mapping: texture.mapping,
    wrapS: texture.wrapS,
    wrapT: texture.wrapT,
    repeat: [texture.repeat.x, texture.repeat.y],
    offset: [texture.offset.x, texture.offset.y],
    center: [texture.center.x, texture.center.y],
    rotation: texture.rotation,
    flipY: texture.flipY,
    colorSpace: texture.colorSpace,
    generateMipmaps: texture.generateMipmaps,
    magFilter: texture.magFilter,
    minFilter: texture.minFilter,
    anisotropy: texture.anisotropy,
    type: texture.type,
    format: texture.format,
    premultiplyAlpha: texture.premultiplyAlpha,
    unpackAlignment: texture.unpackAlignment,
    image: image == null ? null : {
      width: image.width ?? null,
      height: image.height ?? null,
      data: ArrayBuffer.isView(image.data) ? {
        class: image.data.constructor.name,
        length: image.data.length,
        fnv1a: fnv1a(new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength))
      } : null
    }
  }
}

function describeLight(light: THREE.Light): LightDescription {
  const description: LightDescription = { color: describeColor(light.color), intensity: light.intensity }
  for (const key of ['distance', 'decay', 'angle', 'penumbra'] as const) {
    if (typeof light[key] === 'number') description[key] = light[key]
  }
  if (light.groundColor?.isColor) description.groundColor = describeColor(light.groundColor)
  if (light.target?.isObject3D) {
    description.target = { position: vec3(light.target.position), inSceneGraph: light.target.parent !== null }
  }
  if (light.shadow) {
    const shadow = light.shadow
    description.shadow = {
      mapSize: [shadow.mapSize.x, shadow.mapSize.y],
      bias: shadow.bias,
      normalBias: shadow.normalBias,
      radius: shadow.radius,
      blurSamples: shadow.blurSamples,
      camera: describeCamera(shadow.camera)
    }
  }
  return description
}

function describeCamera(camera: THREE.Object3D): Record<string, unknown> {
  const description: Record<string, unknown> = { type: camera.type }
  for (const key of ['fov', 'aspect', 'near', 'far', 'zoom', 'focus', 'filmGauge', 'filmOffset',
    'left', 'right', 'top', 'bottom'] as const) {
    if (typeof camera[key] === 'number') description[key] = camera[key]
  }
  description.view = camera.view ? { ...camera.view } : null
  description.projectionMatrix = [...camera.projectionMatrix.elements]
  return description
}

function describeCameraPlacement(scene: THREE.Scene, camera: THREE.Object3D): SceneDescription['camera'] {
  const path: number[] = []
  let object = camera
  for (; object !== scene && object.parent; object = object.parent) path.unshift(object.parent.children.indexOf(object))
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const direction = new THREE.Vector3()
  camera.getWorldPosition(position)
  camera.getWorldQuaternion(quaternion)
  camera.getWorldDirection(direction)
  return {
    path: object === scene ? path : null,
    worldPosition: vec3(position),
    worldQuaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    worldDirection: vec3(direction)
  }
}

function describeFog(fog: THREE.Fog): NonNullable<SceneDescription['fog']> {
  return fog.isFogExp2
    ? { type: 'FogExp2', color: describeColor(fog.color), density: fog.density }
    : { type: 'Fog', color: describeColor(fog.color), near: fog.near, far: fog.far }
}

function describeColor(color: THREE.Color): ColorDescription {
  return { hex: `#${color.getHexString()}`, linear: [color.r, color.g, color.b] }
}

type TextureLabel = (texture: THREE.Texture) => string | null

const vec3 = (v: { x: number, y: number, z: number }): Vec3 => [v.x, v.y, v.z]
const euler = (e: { x: number, y: number, z: number, order: string }): [number, number, number, string] => [e.x, e.y, e.z, e.order]

// 32-bit FNV-1a: a cheap fingerprint of decoded pixel data (no crypto API needed in a worker)
function fnv1a(bytes: Uint8Array) {
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
