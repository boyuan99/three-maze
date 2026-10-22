// Runs v0.3's loader (extractV03.ts) and the port (src/compat/v0) on one scene config in Node and
// turns both results into the same plain-data record: the golden snapshot's format.
//
// Node lacks three things the loaders use, so the test stands in for them:
// - TextureLoader needs an <img> element: NodeTextureLoader returns an empty Texture for files that
//   exist under public/ and fails for others. Image pixels and sizes of JPEG textures are therefore
//   not compared.
// - WebGLRenderer needs a WebGL context: a recording stand-in keeps the constructor parameters, the
//   method calls and the property writes. What the GPU draws is not compared.
// - EXRLoader fetches over HTTP: fetchFromPublic serves public/ to it, so the skybox is decoded for
//   real and its pixels are compared (by fingerprint).
// Rapier runs for real (its WebAssembly build works in Node); its world is read back after setup.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import { buildV0Scene, createV0Renderer, describeScene, v0Physics } from '../../../src/compat/v0/index.ts'
import type { SceneDescription, V0PhysicsBuild, V0SceneConfig, V0Shape, V0Solid } from '../../../src/compat/v0/index.ts'
import { FixedFollowCam } from '../../../src/utils/FixedFollowCam.js'
import { resolveAssetPath } from '../../../src/utils/resolveAssetPath.js'
import { runV03Setup } from './extractV03.ts'

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PUBLIC_DIR = path.join(REPO_ROOT, 'public')
const ORIGIN = 'http://v0-reference.test'
/** Window size the scene is set up for (v0.3 reads window.innerWidth and innerHeight) */
export const WINDOW = { innerWidth: 1920, innerHeight: 1080 }
const SCENE_CANVAS = { canvas: 'the scene canvas' }

export interface Maze {
  name: string
  /** Path from the repository root */
  file: string
  /** What v0.3's scene store sets as _basePath for this file in development (electron/main.js:676-682) */
  basePath: string
}

/** The mazes shipped in public/mazes: top-level JSON files and <Name>/<Name>.json */
export function shippedMazes(): Maze[] {
  const dir = path.join(PUBLIC_DIR, 'mazes')
  const mazes: Maze[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      mazes.push({ name: entry.name.slice(0, -5), file: `public/mazes/${entry.name}`, basePath: 'mazes/' })
    } else if (entry.isDirectory() && existsSync(path.join(dir, entry.name, `${entry.name}.json`))) {
      mazes.push({ name: entry.name, file: `public/mazes/${entry.name}/${entry.name}.json`, basePath: `mazes/${entry.name}/` })
    }
  }
  return mazes.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export function readMaze(maze: Maze): V0SceneConfig {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, maze.file), 'utf8'))
  config._basePath = maze.basePath
  return config
}

// --- Asset loading in Node ---

/** The URL each texture was loaded from: the label textures get in the description */
const textureUrls = new WeakMap<object, string>()
export const textureLabel = (texture: object) => textureUrls.get(texture) ?? null

/** The file under public/ an app URL ('/mazes/...') points at, or null */
function publicFile(url: string) {
  if (!url.startsWith('/')) return null
  const file = path.join(PUBLIC_DIR, decodeURIComponent(url))
  return existsSync(file) ? file : null
}

/** TextureLoader without an <img>: an empty Texture, delivered asynchronously like the real one */
export class NodeTextureLoader {
  load(url: string, onLoad?: (texture: unknown) => void, _onProgress?: unknown, onError?: (error: unknown) => void) {
    const texture = new THREE.Texture()
    setTimeout(() => {
      if (!publicFile(url)) {
        onError?.(new Error(`no file for ${url} under public/`))
        return
      }
      textureUrls.set(texture, url)
      onLoad?.(texture)
    }, 0)
    return texture
  }
}

const servedManager = new THREE.LoadingManager()
servedManager.setURLModifier((url: string) => url.startsWith('/') ? ORIGIN + url : url)

/** The real EXRLoader, fetching from fetchFromPublic */
export class NodeEXRLoader extends EXRLoader {
  constructor() {
    super(servedManager)
  }

  load(url: string, onLoad?: (texture: unknown) => void, onProgress?: unknown, onError?: (error: unknown) => void) {
    return super.load(url, (texture: object) => {
      textureUrls.set(texture, url)
      onLoad?.(texture)
    }, onProgress, onError)
  }
}

/**
 * A fetch that serves public/ at ORIGIN, for three's FileLoader. The response has no body stream,
 * so FileLoader reads it with arrayBuffer() and skips its progress events (Node has no ProgressEvent).
 */
export async function fetchFromPublic(request: Request) {
  const url = new URL(request.url)
  const file = url.origin === ORIGIN ? publicFile(url.pathname) : null
  if (!file) return { status: 404, statusText: 'Not Found', url: request.url }
  const bytes = readFileSync(file)
  return {
    status: 200,
    url: request.url,
    body: undefined,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
}

/** The port's loaders, built on the same stand-ins as v0.3's */
export const nodeLoaders = {
  texture: (url: string) => new Promise<unknown>((resolve, reject) => new NodeTextureLoader().load(url, resolve, undefined, reject)),
  skybox: (url: string) => new Promise<unknown>((resolve, reject) => new NodeEXRLoader().load(url, resolve, undefined, reject))
}

// --- The renderer stand-in ---

export interface RendererRecord {
  canvas: string
  parameters: Record<string, unknown>
  calls: unknown[][]
  writes: Array<[string, unknown]>
}

/** A WebGLRenderer class that records what is done to it, and the records of its instances */
export function rendererRecorder() {
  const records: RendererRecord[] = []
  const RecordingRenderer = function (parameters: Record<string, unknown>) {
    const { canvas, ...rest } = parameters
    const record: RendererRecord = {
      canvas: canvas === SCENE_CANVAS ? SCENE_CANVAS.canvas : 'another canvas',
      parameters: rest,
      calls: [],
      writes: []
    }
    records.push(record)
    const recordWrites = (prefix: string) => ({
      set(target: Record<string, unknown>, key: string | symbol, value: unknown) {
        record.writes.push([prefix + String(key), value])
        target[key as string] = value
        return true
      }
    })
    const renderer = {
      shadowMap: new Proxy({ enabled: false, type: THREE.PCFShadowMap }, recordWrites('shadowMap.')),
      setSize: (width: number, height: number, updateStyle = true) => { record.calls.push(['setSize', width, height, updateStyle]) },
      setPixelRatio: (ratio: number) => { record.calls.push(['setPixelRatio', ratio]) }
    }
    return new Proxy(renderer, recordWrites(''))
  } as unknown as new (parameters: Record<string, unknown>) => unknown
  return { RecordingRenderer, records }
}

// --- Rapier ---

type Vector = { x: number, y: number, z: number }
type Rotation = Vector & { w: number }
const vec = (v: Vector) => [v.x, v.y, v.z]
const quat = (q: Rotation) => [q.x, q.y, q.z, q.w]

export interface PhysicsRecord {
  gravity: number[]
  bodies: Array<{ type: string, translation: number[], rotation: number[], linearDamping: number, angularDamping: number }>
  colliders: Array<{
    body: number
    shape: Record<string, unknown>
    translation: number[]
    rotation: number[]
    friction: number
    restitution: number
    density: number
    sensor: boolean
  }>
}

/** Bodies and colliders of a Rapier world in creation order; a collider names its body by index */
export function describeRapierWorld(world: RAPIER.World): PhysicsRecord {
  const bodyIndex = new Map<number, number>()
  const record: PhysicsRecord = { gravity: vec(world.gravity), bodies: [], colliders: [] }
  world.bodies.forEach(body => {
    bodyIndex.set(body.handle, record.bodies.length)
    record.bodies.push({
      type: RAPIER.RigidBodyType[body.bodyType()],
      translation: vec(body.translation()),
      rotation: quat(body.rotation()),
      linearDamping: body.linearDamping(),
      angularDamping: body.angularDamping()
    })
  })
  world.colliders.forEach(collider => {
    const type = collider.shape.type
    const shape: Record<string, unknown> = { type: RAPIER.ShapeType[type] }
    if (type === RAPIER.ShapeType.Cuboid) shape.halfExtents = vec(collider.halfExtents())
    else if (type === RAPIER.ShapeType.Ball) shape.radius = collider.radius()
    else if (type === RAPIER.ShapeType.Cylinder) Object.assign(shape, { halfHeight: collider.halfHeight(), radius: collider.radius() })
    record.colliders.push({
      body: bodyIndex.get(collider.parent()!.handle)!,
      shape,
      translation: vec(collider.translation()),
      rotation: quat(collider.rotation()),
      friction: collider.friction(),
      restitution: collider.restitution(),
      density: collider.density(),
      sensor: collider.isSensor()
    })
  })
  return record
}

/** What Rapier holds for the port's physics: v0.3 creates bodies in JSON order, then the player */
export function physicsRecordFromPort(physics: V0PhysicsBuild): PhysicsRecord {
  // Rapier stores 32-bit floats; v0.3 leaves damping, density and sensor at Rapier's defaults
  const f32 = (values: number[]) => values.map(Math.fround)
  const DEFAULTS = { linearDamping: 0, angularDamping: 0, density: 1, sensor: false }
  const shape = (s: V0Shape): Record<string, unknown> =>
    s.kind === 'cuboid' ? { type: 'Cuboid', halfExtents: f32(s.halfExtents) }
      : s.kind === 'ball' ? { type: 'Ball', radius: Math.fround(s.radius) }
        : { type: 'Cylinder', halfHeight: Math.fround(s.halfHeight), radius: Math.fround(s.radius) }
  const bodyType = (body: string) => body === 'dynamic' ? 'Dynamic' : 'Fixed'

  const sceneBodies: Array<{ objectIndex: number, body: string, position: number[], solid: V0Solid | null }> = [
    ...physics.solids.map(solid => ({ ...solid, solid })),
    ...physics.bodiesWithoutCollider.map(body => ({ ...body, solid: null }))
  ].sort((a, b) => a.objectIndex - b.objectIndex)
  const record: PhysicsRecord = { gravity: f32(physics.gravity), bodies: [], colliders: [] }
  for (const { body, position, solid } of sceneBodies) {
    const index = record.bodies.push({
      type: bodyType(body),
      translation: f32(position),
      rotation: [0, 0, 0, 1],
      linearDamping: DEFAULTS.linearDamping,
      angularDamping: DEFAULTS.angularDamping
    }) - 1
    if (solid) {
      record.colliders.push({
        body: index,
        shape: shape(solid.shape),
        translation: f32(solid.position),
        rotation: f32(solid.colliderRotation),
        friction: Math.fround(solid.friction),
        restitution: Math.fround(solid.restitution),
        density: DEFAULTS.density,
        sensor: DEFAULTS.sensor
      })
    }
  }
  const player = physics.player
  record.bodies.push({
    type: bodyType(player.body),
    translation: f32(player.position),
    rotation: [0, 0, 0, 1],
    linearDamping: player.linearDamping,
    angularDamping: player.angularDamping
  })
  record.colliders.push({
    body: record.bodies.length - 1,
    shape: shape(player.shape),
    translation: f32(player.position),
    rotation: [0, 0, 0, 1],
    friction: player.friction,
    restitution: player.restitution,
    density: DEFAULTS.density,
    sensor: DEFAULTS.sensor
  })
  return record
}

// --- The golden record ---

export interface LoaderRecord {
  maze: string
  basePath: string
  window: [number, number]
  scene: SceneDescription
  renderer: RendererRecord
  physics: PhysicsRecord
}

const silentConsole = { log: () => {}, warn: () => {}, error: () => {} }

/** v0.3's own loader on one config: the source of the golden snapshots */
export async function recordV03(config: V0SceneConfig, maze: string, logs = silentConsole): Promise<LoaderRecord> {
  const { RecordingRenderer, records } = rendererRecorder()
  const THREEForNode = { ...THREE, TextureLoader: NodeTextureLoader, WebGLRenderer: RecordingRenderer }
  const setup = await runV03Setup(structuredClone(config), {
    THREE: THREEForNode, RAPIER, EXRLoader: NodeEXRLoader, FixedFollowCam, resolveAssetPath,
    canvas: { value: SCENE_CANVAS }, window: WINDOW, console: logs
  })
  try {
    return {
      maze,
      basePath: config._basePath ?? '',
      window: [WINDOW.innerWidth, WINDOW.innerHeight],
      scene: describeScene(setup.scene, setup.camera, { textureLabel }),
      renderer: only(records),
      physics: describeRapierWorld(setup.world)
    }
  } finally {
    setup.world.free()
  }
}

/** The port on the same config, in the same record format */
export async function recordPort(config: V0SceneConfig, maze: string): Promise<LoaderRecord> {
  const { RecordingRenderer, records } = rendererRecorder()
  const build = await buildV0Scene(structuredClone(config), { aspect: WINDOW.innerWidth / WINDOW.innerHeight, loaders: nodeLoaders })
  createV0Renderer({ canvas: SCENE_CANVAS, width: WINDOW.innerWidth, height: WINDOW.innerHeight, WebGLRenderer: RecordingRenderer })
  return {
    maze,
    basePath: config._basePath ?? '',
    window: [WINDOW.innerWidth, WINDOW.innerHeight],
    scene: describeScene(build.scene, build.camera, { textureLabel }),
    renderer: only(records),
    physics: physicsRecordFromPort(v0Physics(config))
  }
}

function only<T>(items: T[]): T {
  if (items.length !== 1) throw new Error(`expected one renderer, found ${items.length}`)
  return items[0]
}

/** JSON as the golden files hold it: two-space indentation, arrays of plain values on one line */
export function formatRecord(record: unknown) {
  return JSON.stringify(record, null, 2)
    .replace(/\[\s+([^[\]{}]*?)\s+\]/g, (_match, items: string) => `[${items.split(/,\s+/).join(', ')}]`) + '\n'
}

/** The record as it reads back from its JSON: -0 becomes 0, NaN and infinities become null */
export const viaJson = <T>(record: T): T => JSON.parse(JSON.stringify(record))
