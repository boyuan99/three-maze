// Collider partitioner, box subset (ADR-0001 R5; plan item MOT-08): turns the scene's boxes, as
// world-space solids, into the colliders of a collider manifest (src/motion/manifest.ts), which
// instantiate() (src/motion/instantiate.ts) builds in Rapier. No Rapier, no DOM and no three.js:
// it runs wherever the compiler runs.
//
// The rules, from ADR-0001 R5 as amended on 2026-10-09 and the owner's decision D12 (a) that
// paper scenes are built from boxes only:
//
// - Each box keeps its full world rotation. v0.3 drops it (src/scenes/serial/
//   PythonCustomScene.vue:464-468, quirk 1 of src/compat/v0/README.md).
// - Sweepable geometry (R5.2): no cuboid extent over 40 units. A box over 40 is split into equal
//   flush pieces along its local axes, ceil(extent / 40) per axis.
// - Walkable floors (R5.1): a box whose top face is horizontal (an upright box) is a walkable
//   surface. It is capped as above only if it is reachable from the side from a walkable region
//   about a step or more below its top (RISE); otherwise it may exceed 40. Floor boxes of this kind
//   with the same top and bottom whose union is itself a box are merged into one cuboid; a union
//   that is not a box stays the boxes it is made of, since triangle-mesh floors are phase 2 (D12 a,
//   plan item MOT-09). On the shipped mazes this gives ADR-0001's Follow-up counts: the six walls
//   over 40 units become 26 pieces and each hallway's three floor boxes one collider.
// - A box tilted so that a face is walkable but not horizontal is a walkable ramp: rejected, as
//   walkable ramps are phase 2 (D12 a, R5.3). A box tilted further has no walkable face, all its
//   faces are walls (R4), so it is sweepable and capped.
// - Zones pass through unchanged (R5.4).
//
// "Reachable from the side" is decided conservatively, without the scene's reachability (a flood
// fill from the spawns is phase 2): a box is reachable if any other upright box whose top lies
// lower by RISE or more is within SIDE_REACH of it horizontally, whether or not the agent can get
// there. Not covered, as in R5.1: an airborne agent moving sideways beside an uncapped floor, for
// example after walking off an open edge (Hallway02, Hallway_fog); the evidence lacks this case
// and plan item MOT-09 (phase 2) adds it.
import type {
  ManifestCollider, ManifestZone, Quat, SolidLayer, Vec3,
} from '../../motion/manifest.ts'
import { SOLID_LAYERS } from '../../motion/manifest.ts'
import { SUB_STEP } from '../../motion/core.ts'
import { RADIUS, SKIN, STEP_HEIGHT } from '../../motion/mover.ts'

/** Largest extent of a sweepable cuboid, units (ADR-0001 R2, R5.2). */
export const MAX_EXTENT = 40

/**
 * How far below a box's top a walkable region must lie for the agent on it to touch the box's
 * side, units. R5.1 says over 0.3, the step height: the agent's cylinder starts 0.3 above its
 * feet. Its skin reaches 0.02 further down, so a box rising more than 0.28 is touched by the
 * controller's sweeps already, and a step of 0.29 blocks (docs/movement-and-collision-limits.md);
 * such a box's side is swept, so it is capped too.
 */
export const RISE = STEP_HEIGHT - SKIN

/**
 * How far beyond the edge of the region it stands on the agent can sweep, units: its radius, its
 * skin and one sub-step with the step-off calls that may follow it (0.5 + 0.02 + 0.25 + 6 x 0.01
 * = 0.83), rounded up.
 */
export const SIDE_REACH = 1
if (RADIUS + SKIN + SUB_STEP + 6 * 0.01 > SIDE_REACH) throw new Error('SIDE_REACH is too small')

/** A face with n_y at or above this is walkable (src/motion/mover.ts cos30; ADR-0001 R3, R4). */
const WALKABLE = Math.cos(Math.PI / 6) - 1e-6

/**
 * Tolerance for comparing coordinates, units: heights of coplanar tops, touching footprints, the
 * corners of a union. Far below any scene detail and the 0.02 skin, far above the rounding of the
 * arithmetic here.
 */
const EPS = 1e-6
/**
 * Tolerance for directions, as 1 - |cos| of the angle: a local axis this close to vertical makes a
 * box upright, and two footprints this close to parallel or perpendicular share a frame. 1e-12 is
 * about 1.4e-6 rad: rounding of exact quarter turns passes, any tilt an author means does not.
 */
const AXIS_EPS = 1e-12
/** The largest tilt from vertical of an upright box's local axis by AXIS_EPS, degrees. */
const UPRIGHT_TILT = (Math.acos(1 - AXIS_EPS) * 180) / Math.PI
/** An extent counts as over MAX_EXTENT only beyond this relative margin (rounding of 40). */
const CAP_EPS = 1e-9

/** A box of the scene in world space, as the compiler resolves a box object. */
export interface BoxSolid {
  /** Id of the scene object, which the manifest's `sources` name; unique among the solids. */
  id: string
  /** Half extents along the box's local axes, units, each greater than 0. */
  halfExtents: Vec3
  /** World position of the box's centre. */
  translation: Vec3
  /** World rotation, a unit quaternion [x, y, z, w]. */
  rotation: Quat
  /** Default 'world'; 'agentBarrier' for an invisible gate. */
  layer?: SolidLayer
  /** Whether the box is there at load time; default true. Gates are switched at run time. */
  enabled?: boolean
}

export interface PartitionInput {
  solids: BoxSolid[]
  /** Zones, passed through unchanged (ADR-0001 R5.4). */
  zones?: ManifestZone[]
}

export interface Partition {
  colliders: ManifestCollider[]
  zones: ManifestZone[]
  /** What the partitioner did: one line per merge, split, uncapped floor over 40, kept group. */
  notes: string[]
}

/** Input the partitioner cannot build; `path` locates the offending value. */
export class PartitionError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'PartitionError'
    this.path = path
  }
}

/** The colliders' `why`. */
export const WHY = {
  floor: 'walkable floor, not reachable from the side: exempt from the 40-unit cap '
    + '(ADR-0001 R5.1)',
  mergedFloor: 'walkable floor merged from coplanar boxes whose union is a box, not reachable '
    + 'from the side: exempt from the 40-unit cap (ADR-0001 R5.1)',
  swept: 'sweepable box (ADR-0001 R5.2)',
  piece: 'sweepable box over 40 units, split into equal flush pieces (ADR-0001 R5.2)',
} as const

type Vec2 = [number, number]

/** The footprint of an upright box: a rectangle in the XZ plane. */
interface Rect {
  /** Centre (x, z). */
  c: Vec2
  /** The two horizontal local axes as unit (x, z) vectors, and the half sizes along them. */
  a: Vec2
  b: Vec2
  ha: number
  hb: number
}

interface Box {
  index: number
  solid: BoxSolid
  layer: SolidLayer
  enabled: boolean
  /** Rotation matrix, row-major: column i is local axis i in world coordinates. */
  m: number[]
  top: number
  bottom: number
  /** The footprint of an upright box; null for a tilted one. */
  foot: Rect | null
  reachable: boolean
}

// Rotation matrix of a quaternion, row-major; s = 2 / |q|^2 makes it orthonormal also for a
// quaternion that is a unit one only to a few digits (rounded in a file)
function matrix([x, y, z, w]: Quat): number[] {
  const s = 2 / (x * x + y * y + z * z + w * w)
  return [
    1 - s * (y * y + z * z), s * (x * y - z * w), s * (x * z + y * w),
    s * (x * y + z * w), 1 - s * (x * x + z * z), s * (y * z - x * w),
    s * (x * z - y * w), s * (y * z + x * w), 1 - s * (x * x + y * y),
  ]
}

const column = (m: number[], i: number): Vec3 => [m[i], m[3 + i], m[6 + i]]

function check(value: unknown, path: string, ids: Set<string>): BoxSolid {
  const fail = (where: string, message: string): never => {
    throw new PartitionError(`${path}${where}`, message)
  }
  if (typeof value !== 'object' || value === null) fail('', 'must be an object')
  const s = value as BoxSolid
  if (typeof s.id !== 'string' || s.id === '') fail('.id', 'must be a non-empty string')
  if (ids.has(s.id)) fail('.id', `'${s.id}' is used twice`)
  ids.add(s.id)
  const numbers = (v: unknown, n: number, where: string) => {
    if (!Array.isArray(v) || v.length !== n
      || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      fail(where, `must be ${n} finite numbers`)
    }
    return v as number[]
  }
  numbers(s.halfExtents, 3, '.halfExtents').forEach((h, i) => {
    if (h <= 0) fail(`.halfExtents[${i}]`, 'must be greater than 0')
  })
  numbers(s.translation, 3, '.translation')
  const q = numbers(s.rotation, 4, '.rotation')
  if (Math.abs(Math.hypot(...q) - 1) > 1e-6) fail('.rotation', 'must be a unit quaternion')
  if (s.layer !== undefined && !SOLID_LAYERS.includes(s.layer)) {
    fail('.layer', `unknown layer '${String(s.layer)}' (supported: ${SOLID_LAYERS.join(', ')})`)
  }
  if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
    fail('.enabled', 'must be true or false')
  }
  return s
}

// Classifies a box: upright (a local axis vertical: horizontal top, vertical sides) with its
// footprint, or tilted
function analyse(solid: BoxSolid, index: number, path: string): Box {
  const m = matrix(solid.rotation)
  const h = solid.halfExtents
  const c = solid.translation
  const up = [m[3], m[4], m[5]] // the y component of each local axis
  const vertical = up.findIndex((y) => Math.abs(y) >= 1 - AXIS_EPS)
  const box: Box = {
    index, solid, layer: solid.layer ?? 'world', enabled: solid.enabled ?? true, m,
    top: 0, bottom: 0, foot: null, reachable: true,
  }
  if (vertical >= 0) {
    const [i, j] = [0, 1, 2].filter((k) => k !== vertical)
    const unit = (v: Vec3): Vec2 => {
      const l = Math.hypot(v[0], v[2])
      return [v[0] / l, v[2] / l]
    }
    box.foot = { c: [c[0], c[2]], a: unit(column(m, i)), b: unit(column(m, j)), ha: h[i], hb: h[j] }
    box.top = c[1] + h[vertical]
    box.bottom = c[1] - h[vertical]
    return box
  }
  // Tilted: its most upward face is a ramp if walkable (n_y >= cos 30), else a wall
  const ny = Math.max(...up.map(Math.abs))
  if (ny >= WALKABLE) {
    const tilt = (Math.acos(Math.min(1, ny)) * 180) / Math.PI
    const shown = tilt < 0.001 ? tilt.toPrecision(3) : tilt.toFixed(3)
    // A tiny tilt is most likely a quarter turn given to a few digits (1.5708 rad): say so
    const hint = tilt < 0.1
      ? `; a box counts as upright only if one of its axes is within ${UPRIGHT_TILT.toPrecision(2)}`
        + ' degrees of vertical, so give quarter turns exactly'
      : ''
    throw new PartitionError(`${path}.rotation`, `tilted ${shown} degrees from upright, so its `
      + 'top face is a walkable ramp; walkable ramps are not supported in v1.0-rc (owner decision '
      + `D12 a; ADR-0001 R5.3, phase 2)${hint}`)
  }
  const half = up.reduce((sum, y, k) => sum + Math.abs(y) * h[k], 0)
  box.top = c[1] + half
  box.bottom = c[1] - half
  return box
}

// ---- footprints ----

const dot = (u: Vec2, v: Vec2) => u[0] * v[0] + u[1] * v[1]

function corners(r: Rect): Vec2[] {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sb]): Vec2 => [
    r.c[0] + sa * r.ha * r.a[0] + sb * r.hb * r.b[0],
    r.c[1] + sa * r.ha * r.a[1] + sb * r.hb * r.b[1],
  ])
}

// Whether two footprints overlap or touch (separating-axis test with tolerance EPS)
function overlap(p: Rect, q: Rect): boolean {
  for (const n of [p.a, p.b, q.a, q.b]) {
    const rp = p.ha * Math.abs(dot(p.a, n)) + p.hb * Math.abs(dot(p.b, n))
    const rq = q.ha * Math.abs(dot(q.a, n)) + q.hb * Math.abs(dot(q.b, n))
    if (Math.abs(dot(p.c, n) - dot(q.c, n)) > rp + rq + EPS) return false
  }
  return true
}

function pointToSegment(p: Vec2, s0: Vec2, s1: Vec2): number {
  const d: Vec2 = [s1[0] - s0[0], s1[1] - s0[1]]
  const l2 = dot(d, d)
  const t = l2 > 0
    ? Math.max(0, Math.min(1, ((p[0] - s0[0]) * d[0] + (p[1] - s0[1]) * d[1]) / l2)) : 0
  return Math.hypot(p[0] - s0[0] - t * d[0], p[1] - s0[1] - t * d[1])
}

/** Horizontal distance between two footprints, 0 if they overlap or touch. */
function distance(p: Rect, q: Rect): number {
  if (overlap(p, q)) return 0
  // Between disjoint convex polygons: from a corner of one to an edge of the other
  let best = Infinity
  for (const [from, to] of [[p, q], [q, p]]) {
    const edge = corners(to)
    for (const v of corners(from)) {
      for (let k = 0; k < 4; k++) {
        best = Math.min(best, pointToSegment(v, edge[k], edge[(k + 1) % 4]))
      }
    }
  }
  return best
}

// ---- merging walkable floors ----

/** A footprint as an interval box [p0, p1] x [q0, q1] in a frame (e1, e2). */
interface Interval {
  p0: number
  p1: number
  q0: number
  q1: number
}

/** e2 of a frame: e1 turned so that (e1, up, e2) are a box's local x, y and z axes. */
const second = (e1: Vec2): Vec2 => [-e1[1], e1[0]]

/** A footprint in the frame (e1, e2), or null if its sides are not along the frame's axes. */
function inFrame(r: Rect, e1: Vec2): Interval | null {
  let hp: number, hq: number
  if (Math.abs(dot(r.a, e1)) >= 1 - AXIS_EPS) [hp, hq] = [r.ha, r.hb]
  else if (Math.abs(dot(r.b, e1)) >= 1 - AXIS_EPS) [hp, hq] = [r.hb, r.ha]
  else return null
  const p = dot(r.c, e1), q = dot(r.c, second(e1))
  return { p0: p - hp, p1: p + hp, q0: q - hq, q1: q + hq }
}

// Overlap, or a shared edge of positive length: touching at a corner only does not connect
function sharesEdge(u: Interval, v: Interval): boolean {
  const op = Math.min(u.p1, v.p1) - Math.max(u.p0, v.p0)
  const oq = Math.min(u.q1, v.q1) - Math.max(u.q0, v.q0)
  return (op > EPS && oq >= -EPS) || (oq > EPS && op >= -EPS)
}

function distinct(values: number[]): number[] {
  const out: number[] = []
  for (const v of [...values].sort((a, b) => a - b)) {
    if (!out.length || v > out[out.length - 1] + EPS) out.push(v)
  }
  return out
}

// Whether the union of the intervals is their bounding box: every cell of the grid their edges
// make is covered
function unionIsBox(parts: Interval[]): boolean {
  const ps = distinct(parts.flatMap((u) => [u.p0, u.p1]))
  const qs = distinct(parts.flatMap((u) => [u.q0, u.q1]))
  const covered = (p: number, q: number) => parts.some((u) =>
    u.p0 - EPS <= p && p <= u.p1 + EPS && u.q0 - EPS <= q && q <= u.q1 + EPS)
  for (let i = 0; i + 1 < ps.length; i++) {
    for (let j = 0; j + 1 < qs.length; j++) {
      if (!covered((ps[i] + ps[i + 1]) / 2, (qs[j] + qs[j + 1]) / 2)) return false
    }
  }
  return true
}

// The rotation about +Y that turns +X into (e1x, 0, e1z), with the yaw t: cos t = e1x,
// sin t = -e1z. Square roots only; + 0 turns -0 into 0.
function yawQuaternion(e1: Vec2): Quat {
  const cos = e1[0], sin = -e1[1]
  if (cos > -0.5) {
    const w = Math.sqrt((1 + cos) / 2)
    return [0, sin / (2 * w) + 0, 0, w]
  }
  const y = Math.sqrt((1 - cos) / 2) * (sin < 0 ? -1 : 1)
  return [0, y, 0, sin / (2 * y) + 0]
}

const size = (h: Vec3) => h.map((v) => +(2 * v).toPrecision(12)).join(' x ')

// The merged collider of coplanar floor boxes whose union is a box, or null
function merge(members: Box[], notes: string[]): ManifestCollider | null {
  const names = members.map((b) => b.solid.id).join(', ')
  const e1 = (members[0].foot as Rect).a
  const parts = members.map((b) => inFrame(b.foot as Rect, e1))
  if (parts.some((u) => u === null) || !unionIsBox(parts as Interval[])) {
    notes.push(`${names}: coplanar walkable boxes whose union is not a box, kept as they are `
      + '(triangle-mesh floors are phase 2: owner decision D12 a, plan item MOT-09)')
    return null
  }
  const all = parts as Interval[]
  const p0 = Math.min(...all.map((u) => u.p0)), p1 = Math.max(...all.map((u) => u.p1))
  const q0 = Math.min(...all.map((u) => u.q0)), q1 = Math.max(...all.map((u) => u.q1))
  const { top, bottom } = members[0]
  const e2 = second(e1)
  const p = (p0 + p1) / 2, q = (q0 + q1) / 2
  const halfExtents: Vec3 = [(p1 - p0) / 2, (top - bottom) / 2, (q1 - q0) / 2]
  const id = `${members[0].solid.id}.merged`
  notes.push(`${id}: ${members.length} coplanar walkable boxes (${names}) merged into one cuboid `
    + `${size(halfExtents)}, not reachable from the side, so not capped (R5.1)`)
  return {
    id,
    body: 'fixed',
    layer: 'world',
    shape: { kind: 'cuboid', halfExtents },
    translation: [p * e1[0] + q * e2[0], (top + bottom) / 2, p * e1[1] + q * e2[1]],
    rotation: yawQuaternion(e1),
    enabled: true,
    sources: members.map((b) => b.solid.id),
    why: WHY.mergedFloor,
  }
}

// A sweepable box: one collider, or equal flush pieces if an extent is over MAX_EXTENT
function cap(b: Box, notes: string[]): ManifestCollider[] {
  const s = b.solid
  const base = {
    body: 'fixed' as const, layer: b.layer, rotation: [...s.rotation] as Quat,
    enabled: b.enabled, sources: [s.id],
  }
  const n = s.halfExtents.map((h) => Math.max(1, Math.ceil((2 * h) / MAX_EXTENT - CAP_EPS)))
  const total = n[0] * n[1] * n[2]
  if (total === 1) {
    return [{
      id: s.id, ...base, shape: { kind: 'cuboid', halfExtents: [...s.halfExtents] },
      translation: [...s.translation], why: WHY.swept,
    }]
  }
  const piece = s.halfExtents.map((h, i) => h / n[i]) as Vec3
  const axes = [column(b.m, 0), column(b.m, 1), column(b.m, 2)]
  const pieces: ManifestCollider[] = []
  for (let iz = 0; iz < n[2]; iz++) {
    for (let iy = 0; iy < n[1]; iy++) {
      for (let ix = 0; ix < n[0]; ix++) {
        const k = pieces.length + 1
        const offset = [ix, iy, iz].map((i, a) => -s.halfExtents[a] + (2 * i + 1) * piece[a])
        const translation = [0, 1, 2].map((d) => s.translation[d]
          + offset[0] * axes[0][d] + offset[1] * axes[1][d] + offset[2] * axes[2][d]) as Vec3
        pieces.push({
          id: `${s.id}.${k}`, ...base, shape: { kind: 'cuboid', halfExtents: [...piece] },
          translation, why: WHY.piece, piece: [k, total],
        })
      }
    }
  }
  notes.push(`${s.id}: sweepable box ${size(s.halfExtents)} split into ${total} equal flush `
    + `pieces of ${size(piece)} (R5.2)`)
  return pieces
}

/**
 * Partitions the solids into manifest colliders by the rules above. The colliders come in the
 * order of the solids: a merged floor where its first box was, the pieces of a split box in piece
 * order (piece k = 1 + ix + nx (iy + ny iz) along the box's local axes), with ids `<id>.merged`
 * and `<id>.<k>` (scene ids contain no '.', ADR-0005 F4). The zones are copied. Throws a
 * PartitionError for input it cannot build.
 */
export function partition(input: PartitionInput): Partition {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.solids)) {
    throw new PartitionError('solids', 'must be an array')
  }
  const ids = new Set<string>()
  const boxes = input.solids.map((solid, i) => {
    const path = `solids[${i}]`
    return analyse(check(solid, path, ids), i, path)
  })
  const notes: string[] = []

  // Reachable from the side (R5.1): another upright box's top RISE or more lower, nearby
  const upright = boxes.filter((b) => b.foot)
  for (const b of upright) {
    b.reachable = upright.some((w) => w !== b && b.top - w.top > RISE - EPS
      && distance(b.foot as Rect, w.foot as Rect) <= SIDE_REACH)
  }

  // Merging (R5.1): floors exempt from the cap, in the world layer and present at load, grouped
  // into connected components of boxes with the same top and bottom
  const floors = upright.filter((b) => !b.reachable && b.layer === 'world' && b.enabled)
  const parent = floors.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  for (let i = 0; i < floors.length; i++) {
    for (let j = i + 1; j < floors.length; j++) {
      const u = floors[i], v = floors[j]
      if (Math.abs(u.top - v.top) > EPS || Math.abs(u.bottom - v.bottom) > EPS) continue
      const ru = u.foot as Rect, rv = v.foot as Rect
      const iu = inFrame(ru, ru.a), iv = inFrame(rv, ru.a)
      // footprints not along one frame never form a box with each other; any contact connects
      // them, so that their component stays boxes
      if (iu && iv ? sharesEdge(iu, iv) : distance(ru, rv) <= EPS) parent[find(j)] = find(i)
    }
  }
  const components = new Map<number, Box[]>()
  floors.forEach((b, i) => {
    const members = components.get(find(i)) ?? []
    members.push(b)
    components.set(find(i), members)
  })
  // merged collider by the index of its first box; the indices of all merged boxes
  const merged = new Map<number, ManifestCollider>()
  const absorbed = new Set<number>()
  for (const members of components.values()) {
    if (members.length < 2) continue
    const collider = merge(members, notes)
    if (!collider) continue
    merged.set(members[0].index, collider)
    for (const b of members) absorbed.add(b.index)
  }

  const colliders: ManifestCollider[] = []
  for (const b of boxes) {
    const s = b.solid
    if (absorbed.has(b.index)) {
      const collider = merged.get(b.index)
      if (collider) colliders.push(collider)
    } else if (b.foot && !b.reachable) {
      colliders.push({
        id: s.id, body: 'fixed', layer: b.layer,
        shape: { kind: 'cuboid', halfExtents: [...s.halfExtents] },
        translation: [...s.translation], rotation: [...s.rotation] as Quat,
        enabled: b.enabled, sources: [s.id], why: WHY.floor,
      })
      if (s.halfExtents.some((h) => 2 * h > MAX_EXTENT * (1 + CAP_EPS))) {
        notes.push(`${s.id}: walkable floor ${size(s.halfExtents)} not reachable from the side, `
          + 'so not capped (R5.1)')
      }
    } else {
      colliders.push(...cap(b, notes))
    }
  }

  const zones = (input.zones ?? []).map((z) => structuredClone(z))
  return { colliders, zones, notes }
}
