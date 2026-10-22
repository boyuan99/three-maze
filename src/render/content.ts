// What the render host draws: a scene graph built from a render description, without a camera (the
// host owns the camera and places it from the pose records). The v0 reference loader is the first
// source (./v0Content.ts, plan item TS-28); the experiment-file scene builder (TS-07) is the next.
import * as THREE from 'three'

export interface RenderAsset {
  /** 'texture' (a colour texture) or 'skybox' (an equirectangular sky, also the environment map) */
  kind: string
  url: string
  loaded: boolean
}

export interface RenderContent {
  /** The scene graph. The host owns it from setContent() on and disposes of it with the host. */
  scene: THREE.Scene
  /** The camera's projection: vertical field of view in degrees, near and far planes. */
  projection: { fov: number, near: number, far: number }
  /** Where the agent starts: feet position and heading, as a pose record gives them (ADR-0001 R1). */
  start: { x: number, feetY: number, z: number, yaw: number }
  /** Every asset the build tried to load, and whether it loaded. */
  assets: RenderAsset[]
  /** What the build skipped or replaced, one line each. */
  diagnostics: string[]
  /** The description the content was built from, for reports: 'v0' (a v0 maze JSON) for now. */
  source: string
}

export function checkProjection(projection: RenderContent['projection']): void {
  const { fov, near, far } = projection
  if (!(Number.isFinite(fov) && fov > 0 && fov < 180)) throw new TypeError(`render content: fov must be in (0, 180) degrees (got ${fov})`)
  if (!(Number.isFinite(near) && near > 0 && Number.isFinite(far) && far > near)) {
    throw new TypeError(`render content: need 0 < near < far (got near ${near}, far ${far})`)
  }
}

const TEXTURE_SLOTS = ['map', 'envMap', 'lightMap', 'aoMap', 'emissiveMap', 'bumpMap', 'normalMap',
  'displacementMap', 'roughnessMap', 'metalnessMap', 'alphaMap', 'specularMap', 'specularColorMap',
  'specularIntensityMap', 'sheenColorMap', 'sheenRoughnessMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
  'anisotropyMap', 'gradientMap', 'matcap'] as const

/** Every texture a scene graph uses: material slots, the background and the environment. */
export function sceneTextures(scene: THREE.Scene): THREE.Texture[] {
  const textures = new Set<THREE.Texture>()
  const add = (value: unknown) => {
    if ((value as THREE.Texture | null | undefined)?.isTexture) textures.add(value as THREE.Texture)
  }
  add(scene.background)
  add(scene.environment)
  scene.traverse(object => {
    const material = (object as THREE.Mesh).material
    if (!material) return
    for (const m of Array.isArray(material) ? material : [material]) {
      const slots = m as unknown as Record<string, unknown>
      for (const slot of TEXTURE_SLOTS) add(slots[slot])
    }
  })
  return [...textures]
}

/** Frees the GPU resources of a scene graph's geometries, materials and textures. */
export function disposeContent(content: RenderContent): void {
  for (const texture of sceneTextures(content.scene)) texture.dispose()
  content.scene.traverse(object => {
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    if (!mesh.material) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose()
  })
}
