// The v0 scene JSON (public/mazes/*) as v0.3's experiment scene reads it
// (src/scenes/serial/PythonCustomScene.vue). Only the keys that scene reads are typed; v0 has no
// schema, and keys it does not read (camera.position, renderer, fog, player, controls, ...) are
// accepted and ignored, as in v0.3 (README.md, "Keys v0.3 ignores").

export interface V0Vector {
  x?: number
  y?: number
  z?: number
}

export interface V0Geometry {
  type: string                // 'box' | 'sphere' | 'cylinder'; other types are skipped
  width?: number
  height?: number
  depth?: number
  radius?: number
  segments?: number
  radiusTop?: number
  radiusBottom?: number
}

export interface V0Material {
  color?: number              // 0xRRGGBB as an integer
  metalness?: number
  roughness?: number
  map?: string                // texture path, resolved with resolveAssetPath
  repeat?: { x: number, y: number }
}

export interface V0Physics {
  enabled?: boolean
  type?: string               // 'dynamic'; anything else gives a fixed body
  friction?: number
  restitution?: number
}

export interface V0Object {
  name?: string
  geometry: V0Geometry
  material?: V0Material
  position?: V0Vector
  rotation?: V0Vector         // Euler XYZ, radians
  castShadow?: boolean
  receiveShadow?: boolean
  physics?: V0Physics
}

export interface V0LightConfig {
  type: string                // 'ambient' | 'directional' | 'point'; other types are skipped
  color?: number
  intensity?: number
  position?: { x: number, y: number, z: number }
  castShadow?: boolean
}

export interface V0SceneConfig {
  name?: string
  description?: string
  camera?: { fov?: number }
  skybox?: string             // EXR path, resolved with resolveAssetPath
  lights?: V0LightConfig[]
  objects?: V0Object[]
  /**
   * Folder the asset paths are relative to, without a leading slash ('mazes/Hallway04/').
   * v0.3's scene store adds it when a maze is loaded (src/stores/scenes.js:274), from the path the
   * Electron file dialog returns (electron/main.js:676-682).
   */
  _basePath?: string
}
