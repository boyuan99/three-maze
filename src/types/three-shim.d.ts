// TEMPORARY type shim for three 0.169.0, which ships no TypeScript declarations
// (node_modules/three/package.json has no "types" field) while tsconfig.json is strict.
// Remove this file when owner decision D3 adds @types/three pinned to 0.169.x; the TypeScript files
// that import three then get real types and may need small fixes.
//
// Every name is `any`, both as a value and as a type, so TypeScript checks nothing about three.js
// usage. Declare only the names the TypeScript files use: an undeclared name is a type error, which
// keeps the list honest.
declare module 'three' {
  export const REVISION: string

  export type Object3D = any
  export const Object3D: any
  export type Scene = any
  export const Scene: any
  export type Mesh = any
  export const Mesh: any
  export type PerspectiveCamera = any
  export const PerspectiveCamera: any
  export type Light = any
  export type AmbientLight = any
  export const AmbientLight: any
  export type DirectionalLight = any
  export const DirectionalLight: any
  export type PointLight = any
  export const PointLight: any

  export type BufferGeometry = any
  export type BoxGeometry = any
  export const BoxGeometry: any
  export type SphereGeometry = any
  export const SphereGeometry: any
  export type CylinderGeometry = any
  export const CylinderGeometry: any

  export type Material = any
  export type MeshStandardMaterial = any
  export const MeshStandardMaterial: any
  export type Texture = any
  export const Texture: any
  export type Color = any
  export type Fog = any
  export type LoadingManager = any
  export const LoadingManager: any

  export type Vector3 = any
  export const Vector3: any
  export type Quaternion = any
  export const Quaternion: any
  export type Box3 = any
  export const Box3: any

  export type WebGLRenderer = any
  export const WebGLRenderer: any

  export const RepeatWrapping: number
  export const ClampToEdgeWrapping: number
  export const EquirectangularReflectionMapping: number
  export const ACESFilmicToneMapping: number
  export const NoToneMapping: number
  export const PCFShadowMap: number
}

declare module 'three/examples/jsm/loaders/EXRLoader.js'
