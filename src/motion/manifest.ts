// Collider manifest: the compiled physics of one world. The scene compiler writes it (MOT-08) and
// instantiate() (./instantiate.ts) is the only code that turns it into Rapier colliders, in the
// motion worker and in Node (ADR-0001 R5: the compiler creates every scene collider, the motion
// core only the agent's; R7: one module for both).
//
// Lengths are scene units (1 unit = 1 cm), +Y is up, rotations are unit quaternions [x, y, z, w].
// Every collider is a parentless fixed collider: its pose is baked in and nothing moves it.
// This file has types and the validator only, so that the compiler can use it without Rapier.

export const MANIFEST_FORMAT = 'three-maze-collider-manifest'
export const MANIFEST_VERSION = 1

export type Vec3 = [number, number, number]
/** Unit quaternion [x, y, z, w]. */
export type Quat = [number, number, number, number]

/** Box with the given half extents along its local axes. */
export interface CuboidShape {
  kind: 'cuboid'
  halfExtents: Vec3
}

/**
 * Rapier TriMeshFlags a manifest may set. ADR-0001 R5.1 flags walkable trimesh regions with both;
 * no other flag has been validated.
 */
export const TRIMESH_FLAGS = ['FIX_INTERNAL_EDGES', 'MERGE_DUPLICATE_VERTICES'] as const
export type TrimeshFlag = (typeof TRIMESH_FLAGS)[number]

/** Triangle mesh: vertex coordinates [x0, y0, z0, x1, ...] and triangles as index triples. */
export interface TrimeshShape {
  kind: 'trimesh'
  vertices: number[]
  indices: number[]
  flags: TrimeshFlag[]
}

/** Convex hull of the points [x0, y0, z0, x1, ...] (cones are built this way, ADR-0001 R5.2). */
export interface ConvexHullShape {
  kind: 'convexHull'
  points: number[]
}

export type SolidShape = CuboidShape | TrimeshShape | ConvexHullShape
/** A zone must enclose a volume for the point query of ADR-0001 R1, so it cannot be a trimesh. */
export type ZoneShape = CuboidShape | ConvexHullShape

/**
 * Layers of solid colliders. Both block only the agent in v1.0 (instantiate.ts GROUPS):
 * `world` holds floors, walls and objects; `agentBarrier` holds invisible volumes such as gates
 * and lids, which may later stay transparent to other layers.
 */
export const SOLID_LAYERS = ['world', 'agentBarrier'] as const
export type SolidLayer = (typeof SOLID_LAYERS)[number]

interface Placed {
  /** Unique among all colliders and zones of the manifest. */
  id: string
  translation: Vec3
  rotation: Quat
  /** State at load time; gates are switched at run time (QueryWorld.setEnabled). */
  enabled: boolean
  /** Ids of the scene objects this entry was compiled from (ADR-0001 R5.5); at least one. */
  sources: string[]
}

export interface ManifestCollider extends Placed {
  /** Only 'fixed' (parentless) colliders exist in v1.0. */
  body: 'fixed'
  layer: SolidLayer
  shape: SolidShape
  /** Why the compiler made this collider, e.g. 'role wall' (MOT-08). */
  why?: string
  /** [i, n]: piece i of the n equal pieces a solid was split into (ADR-0001 R5.2), 1-based. */
  piece?: [number, number]
  notes?: string[]
}

export interface ManifestZone extends Placed {
  /** Zone id that tasks refer to; entries sharing it form one compound zone. */
  zone: string
  tags: string[]
  shape: ZoneShape
}

/** What happens where the agent's ground ray finds no floor (ADR-0001 R4). */
export const FALL_MODES = ['gravity', 'none'] as const
export type FallMode = (typeof FALL_MODES)[number]

/**
 * The scene's motion settings, which the mover takes (ADR-0001 R3, R4). The rig's (the eye
 * height) and the mover's own (radius, skin, controller settings) are not the scene's.
 */
export interface ManifestMotion {
  /** Gravity along +Y, units/s², negative: the scene's value, -981 by default (ADR-0001 R3). */
  gravity: number
  /** 'gravity': the agent falls off open edges; 'none': it stops at them (ADR-0001 R4). */
  fall: FallMode
}

export interface ColliderManifest {
  format: typeof MANIFEST_FORMAT
  version: typeof MANIFEST_VERSION
  /** Name and version of the program that wrote the manifest (MOT-08). */
  builder?: string
  /** RAPIER.version() where the manifest was written (MOT-08); instantiate() reports its own. */
  rapierVersion?: string
  /** The scene's motion settings (MOT-08); the compiler always writes them. */
  motion?: ManifestMotion
  colliders: ManifestCollider[]
  zones: ManifestZone[]
}

/** A manifest that does not follow the types above; `path` locates the offending value. */
export class ManifestError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ManifestError'
    this.path = path
  }
}

type Json = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new ManifestError(path, message)
}

function object(value: unknown, path: string, required: string[], optional: string[] = []): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  const record = value as Json
  for (const key of required) if (!(key in record)) fail(path, `'${key}' is missing`)
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) fail(path, `unknown field '${key}'`)
  }
  return record
}

function oneOf(value: unknown, path: string, allowed: readonly string[], what: string): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(path, `unknown ${what} '${String(value)}' (supported: ${allowed.join(', ')})`)
  }
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '') fail(path, 'must be a non-empty string')
  return value
}

function strings(value: unknown, path: string, minLength = 0): string[] {
  if (!Array.isArray(value) || value.length < minLength) {
    fail(path, `must be an array of ${minLength ? `at least ${minLength} ` : ''}strings`)
  }
  value.forEach((item, i) => string(item, `${path}[${i}]`))
  return value as string[]
}

function numbers(value: unknown, path: string, length?: number): number[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    fail(path, `must be an array of ${length === undefined ? '' : `${length} `}numbers`)
  }
  value.forEach((item, i) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      fail(`${path}[${i}]`, 'must be a finite number')
    }
  })
  return value as number[]
}

function triples(value: unknown, path: string, minimum: number, what: string): number[] {
  const list = numbers(value, path)
  if (list.length % 3 !== 0 || list.length < 3 * minimum) {
    fail(path, `must hold at least ${minimum} ${what} as x, y, z triples`)
  }
  return list
}

// Geometry checks. Rapier 0.14.0 takes degenerate input without a clear error: a flat point set
// gives a convex hull of zero volume, collinear or repeated points make collider creation fail
// inside Rapier (repeated ones with a WebAssembly trap), and triangles without area enter a
// trimesh. A compiler never needs them, so they are rejected here. Tolerance: 0.001 units
// (0.01 mm), far below any scene detail and far above float32 rounding at scene sizes.
const FLAT = 1e-3

type Point = [number, number, number]
const at = (p: number[], i: number): Point => [p[3 * i], p[3 * i + 1], p[3 * i + 2]]
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Point, b: Point): Point =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const length = (a: Point) => Math.hypot(a[0], a[1], a[2])

// Smallest height of a triangle: twice its area over its longest edge
function height(a: Point, b: Point, c: Point): number {
  const longest = Math.max(length(sub(b, a)), length(sub(c, b)), length(sub(a, c)))
  return longest > 0 ? length(cross(sub(b, a), sub(c, a))) / longest : 0
}

// Whether the points span a volume thicker than FLAT: the farthest point from the first, the
// farthest from the line through both, then any point off the plane through the three
function spansVolume(points: number[]): boolean {
  const n = points.length / 3, a = at(points, 0)
  let b = a, c = a
  for (let i = 1; i < n; i++) {
    if (length(sub(at(points, i), a)) > length(sub(b, a))) b = at(points, i)
  }
  if (length(sub(b, a)) <= FLAT) return false
  const offLine = (p: Point) => length(cross(sub(b, a), sub(p, a))) / length(sub(b, a))
  for (let i = 1; i < n; i++) if (offLine(at(points, i)) > offLine(c)) c = at(points, i)
  if (offLine(c) <= FLAT) return false
  const normal = cross(sub(b, a), sub(c, a)), unit = length(normal)
  for (let i = 1; i < n; i++) {
    const d = sub(at(points, i), a)
    if (Math.abs(normal[0] * d[0] + normal[1] * d[1] + normal[2] * d[2]) / unit > FLAT) return true
  }
  return false
}

function shape(value: unknown, path: string, kinds: readonly string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  const kind = oneOf((value as Json).kind, `${path}.kind`, kinds, 'shape')
  if (kind === 'cuboid') {
    const s = object(value, path, ['kind', 'halfExtents'])
    numbers(s.halfExtents, `${path}.halfExtents`, 3).forEach((h, i) => {
      if (h <= 0) fail(`${path}.halfExtents[${i}]`, 'must be greater than 0')
    })
  } else if (kind === 'trimesh') {
    const s = object(value, path, ['kind', 'vertices', 'indices', 'flags'])
    const vertices = triples(s.vertices, `${path}.vertices`, 3, 'vertices')
    const vertexCount = vertices.length / 3
    const indices = numbers(s.indices, `${path}.indices`)
    if (indices.length === 0 || indices.length % 3 !== 0) {
      fail(`${path}.indices`, 'must hold whole triangles (index triples)')
    }
    indices.forEach((index, i) => {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        fail(`${path}.indices[${i}]`, `must be a vertex index from 0 to ${vertexCount - 1}`)
      }
    })
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => at(vertices, indices[t + k]))
      if (height(a, b, c) <= FLAT) fail(`${path}.indices`, `triangle ${t / 3} has no area`)
    }
    const flags = strings(s.flags, `${path}.flags`)
    flags.forEach((flag, i) => {
      oneOf(flag, `${path}.flags[${i}]`, TRIMESH_FLAGS, 'flag')
      if (flags.indexOf(flag) !== i) fail(`${path}.flags[${i}]`, `'${flag}' is repeated`)
    })
  } else {
    const s = object(value, path, ['kind', 'points'])
    const points = triples(s.points, `${path}.points`, 4, 'points')
    if (!spansVolume(points)) fail(`${path}.points`, 'must span a volume, not a plane or a line')
  }
}

function placed(entry: Json, path: string, ids: Set<string>): void {
  const id = string(entry.id, `${path}.id`)
  if (ids.has(id)) fail(`${path}.id`, `'${id}' is used twice`)
  ids.add(id)
  numbers(entry.translation, `${path}.translation`, 3)
  const q = numbers(entry.rotation, `${path}.rotation`, 4)
  if (Math.abs(Math.hypot(...q) - 1) > 1e-6) {
    fail(`${path}.rotation`, 'must be a unit quaternion [x, y, z, w]')
  }
  if (typeof entry.enabled !== 'boolean') fail(`${path}.enabled`, 'must be true or false')
  strings(entry.sources, `${path}.sources`, 1)
}

const PLACED = ['id', 'translation', 'rotation', 'enabled', 'sources']

/**
 * Checks that `value` (for example parsed JSON) is a collider manifest and returns it typed.
 * Throws a ManifestError naming the first problem: a missing or unknown field, an unknown shape,
 * flag, layer or fall mode, a body other than 'fixed', a non-finite number, a rotation that is not
 * a unit quaternion, an id used twice, gravity that is not negative.
 */
export function validateManifest(value: unknown): ColliderManifest {
  const m = object(value, 'manifest', ['format', 'version', 'colliders', 'zones'],
    ['builder', 'rapierVersion', 'motion'])
  if (m.format !== MANIFEST_FORMAT) fail('manifest.format', `must be '${MANIFEST_FORMAT}'`)
  if (m.version !== MANIFEST_VERSION) fail('manifest.version', `must be ${MANIFEST_VERSION}`)
  if (m.builder !== undefined) string(m.builder, 'manifest.builder')
  if (m.rapierVersion !== undefined) string(m.rapierVersion, 'manifest.rapierVersion')
  if (m.motion !== undefined) {
    const motion = object(m.motion, 'manifest.motion', ['gravity', 'fall'])
    const g = motion.gravity
    if (typeof g !== 'number' || !Number.isFinite(g) || g >= 0) {
      fail('manifest.motion.gravity', 'must be a finite negative number')
    }
    oneOf(motion.fall, 'manifest.motion.fall', FALL_MODES, 'fall mode')
  }
  if (!Array.isArray(m.colliders)) fail('manifest.colliders', 'must be an array')
  if (!Array.isArray(m.zones)) fail('manifest.zones', 'must be an array')
  const ids = new Set<string>()
  m.colliders.forEach((item: unknown, i: number) => {
    const path = `manifest.colliders[${i}]`
    const c = object(item, path, [...PLACED, 'body', 'layer', 'shape'], ['why', 'piece', 'notes'])
    placed(c, path, ids)
    // TODO(D11): v1.0 rejects dynamic and kinematic bodies, as owner decision D11 (v) recommends
    // (pending): moving colliders were never validated (ADR-0001 Caveats).
    if (c.body !== 'fixed') {
      fail(`${path}.body`, `'${String(c.body)}' is not supported: v1.0 builds only fixed colliders`)
    }
    oneOf(c.layer, `${path}.layer`, SOLID_LAYERS, 'layer')
    shape(c.shape, `${path}.shape`, ['cuboid', 'trimesh', 'convexHull'])
    if (c.why !== undefined) string(c.why, `${path}.why`)
    if (c.notes !== undefined) strings(c.notes, `${path}.notes`)
    if (c.piece !== undefined) {
      const [k, n] = numbers(c.piece, `${path}.piece`, 2)
      if (!Number.isInteger(k) || !Number.isInteger(n) || k < 1 || k > n) {
        fail(`${path}.piece`, 'must be [i, n] with 1 <= i <= n')
      }
    }
  })
  m.zones.forEach((item: unknown, i: number) => {
    const path = `manifest.zones[${i}]`
    const z = object(item, path, [...PLACED, 'zone', 'tags', 'shape'])
    placed(z, path, ids)
    string(z.zone, `${path}.zone`)
    strings(z.tags, `${path}.tags`)
    shape(z.shape, `${path}.shape`, ['cuboid', 'convexHull'])
  })
  return value as ColliderManifest
}
