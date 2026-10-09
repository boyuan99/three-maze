// instantiate(manifest): the only code that turns a collider manifest (./manifest.ts) into Rapier
// colliders, used by the motion worker and by Node (ADR-0001 R5, R7). The result is a query world:
// parentless fixed colliders and no rigid bodies, so nothing calls world.step(); queries are
// refreshed explicitly after colliders are created, enabled or disabled (ADR-0001 R1).
//
// Rapier is passed in rather than imported, so the same code runs on whichever build the caller
// loaded (the renderer's ES build, Node's CommonJS build, another version under test) and the
// caller owns init().
import type RAPIER from '@dimforge/rapier3d-compat'
import type { Collider, World } from '@dimforge/rapier3d-compat'
import { validateManifest } from './manifest.ts'
import type {
  ColliderManifest, ManifestCollider, ManifestZone, Quat, SolidShape, Vec3,
} from './manifest.ts'

export type Rapier = typeof RAPIER

// Collision layers, one bit each. Rapier's interaction groups hold the layers an object belongs to
// in the high 16 bits and the layers it interacts with in the low 16 bits; two objects interact
// only if each belongs to a layer the other accepts.
const WORLD = 1 << 0
const AGENT_BARRIER = 1 << 1
const ZONE = 1 << 2
const AGENT = 1 << 3
const ZONE_PROBE = 1 << 4
const groups = (memberships: number, filter: number): number => ((memberships << 16) | filter) >>> 0

/**
 * Interaction groups of every collider and query. ADR-0001 R3: every KCC call, ground ray and
 * guard query passes GROUPS.agent (with EXCLUDE_SENSORS); R1: zones are found by a point query
 * with GROUPS.zoneProbe (with EXCLUDE_SOLIDS).
 */
export const GROUPS = {
  /** Floors, walls and objects: block the agent. */
  world: groups(WORLD, AGENT),
  /** Invisible gates and lids: block the agent and nothing else. */
  agentBarrier: groups(AGENT_BARRIER, AGENT),
  /** Zones (sensors): seen only by the zone probe. */
  zone: groups(ZONE, ZONE_PROBE),
  /** The agent's own collider and its queries: meet world colliders and barriers only. */
  agent: groups(AGENT, WORLD | AGENT_BARRIER),
  /** The zone point query (and any probe collider): meets zones only. */
  zoneProbe: groups(ZONE_PROBE, ZONE),
} as const

export type ManifestEntry = ManifestCollider | ManifestZone

export interface QueryWorld {
  world: World
  /** RAPIER.version() of the build that made the colliders, for the session record. */
  rapierVersion: string
  /** The Rapier collider of each manifest entry, by entry id. */
  colliders: Map<string, Collider>
  /** The manifest entry of each collider, by collider handle (for query callbacks). */
  entries: Map<number, ManifestEntry>
  /** Enables or disables an entry (a gate, a zone) and refreshes the scene queries. */
  setEnabled(id: string, enabled: boolean): void
}

/**
 * Makes the scene queries see every change to the colliders. Rapier 0.14.0 has
 * world.updateSceneQueries(); later builds dropped it, and there a step without bodies refreshes
 * the query structures (ADR-0001 R1; Rapier upgrade MOT-16).
 */
export function refreshQueries(world: World): void {
  const w = world as { updateSceneQueries?: () => void, step: () => void }
  if (typeof w.updateSceneQueries === 'function') w.updateSceneQueries()
  else w.step()
}

const vector = ([x, y, z]: Vec3) => ({ x, y, z })
const quaternion = ([x, y, z, w]: Quat) => ({ x, y, z, w })

function solidDesc(R: Rapier, shape: SolidShape, id: string) {
  if (shape.kind === 'cuboid') return R.ColliderDesc.cuboid(...shape.halfExtents)
  if (shape.kind === 'trimesh') {
    let flags = 0
    for (const flag of shape.flags) flags |= R.TriMeshFlags[flag]
    const vertices = new Float32Array(shape.vertices)
    return R.ColliderDesc.trimesh(vertices, new Uint32Array(shape.indices), flags)
  }
  const desc = R.ColliderDesc.convexHull(new Float32Array(shape.points))
  // Rapier returns null when the points span no volume
  if (!desc) throw new Error(`${id}: the convex hull of its points is degenerate`)
  return desc
}

/**
 * Adds the manifest's colliders and zones to `world`, colliders first, each list in manifest
 * order (so collider handles follow the manifest), and returns them by entry id. The caller
 * refreshes the scene queries. Validates the manifest first and adds nothing if it is invalid.
 */
export function createColliders(
  R: Rapier, world: World, manifest: ColliderManifest,
): Map<string, Collider> {
  validateManifest(manifest)
  const made = new Map<string, Collider>()
  for (const c of manifest.colliders) {
    const desc = solidDesc(R, c.shape, c.id)
      .setTranslation(...c.translation)
      .setRotation(quaternion(c.rotation))
      .setCollisionGroups(GROUPS[c.layer])
      .setEnabled(c.enabled)
    made.set(c.id, world.createCollider(desc))
  }
  for (const z of manifest.zones) {
    // A sensor: found by the zone probe's point query, never in the way of the agent
    const desc = solidDesc(R, z.shape, z.id)
      .setTranslation(...z.translation)
      .setRotation(quaternion(z.rotation))
      .setCollisionGroups(GROUPS.zone)
      .setSensor(true)
      .setEnabled(z.enabled)
    made.set(z.id, world.createCollider(desc))
  }
  return made
}

/**
 * Builds a query world from a manifest: a new Rapier world (gravity is the mover's business, so
 * the world's is zero) holding the manifest's colliders, with the scene queries refreshed.
 * `R` must be initialised (await R.init()).
 */
export function instantiate(R: Rapier, manifest: ColliderManifest): QueryWorld {
  const world = new R.World(vector([0, 0, 0]))
  let colliders: Map<string, Collider>
  try {
    colliders = createColliders(R, world, manifest)
  } catch (error) {
    world.free()
    throw error
  }
  refreshQueries(world)
  const byId = new Map<string, ManifestEntry>()
  for (const entry of [...manifest.colliders, ...manifest.zones]) byId.set(entry.id, entry)
  const entries = new Map<number, ManifestEntry>()
  for (const [id, collider] of colliders) {
    entries.set(collider.handle, byId.get(id) as ManifestEntry)
  }
  return {
    world,
    rapierVersion: R.version(),
    colliders,
    entries,
    setEnabled(id, enabled) {
      const collider = colliders.get(id)
      if (!collider) throw new Error(`no collider or zone '${id}' in the manifest`)
      collider.setEnabled(enabled)
      refreshQueries(world)
    },
  }
}

/** One collider as Rapier holds it (single-precision values), for comparing collider sets. */
export interface ColliderRecord {
  id: string
  handle: number
  shape: 'cuboid' | 'trimesh' | 'convexHull'
  /** cuboid: half extents; trimesh and convexHull: vertex coordinates as stored by Rapier */
  values: number[]
  /** trimesh only: triangle indices as stored by Rapier */
  indices?: number[]
  translation: Vec3
  rotation: Quat
  groups: number
  sensor: boolean
  enabled: boolean
}

/**
 * Reads every collider of a query world back from Rapier, in handle order. Two worlds built from
 * the same manifest hold the same collider set exactly when their records are equal.
 */
export function describeColliders(R: Rapier, queryWorld: QueryWorld): ColliderRecord[] {
  const records: ColliderRecord[] = []
  for (const [id, c] of queryWorld.colliders) {
    const t = c.translation()
    const q = c.rotation()
    const type = c.shapeType()
    let shape: ColliderRecord['shape']
    let values: number[]
    let indices: number[] | undefined
    if (type === R.ShapeType.Cuboid) {
      const h = c.halfExtents()
      shape = 'cuboid'
      values = [h.x, h.y, h.z]
    } else if (type === R.ShapeType.TriMesh) {
      shape = 'trimesh'
      values = Array.from(c.vertices())
      indices = Array.from(c.indices() ?? [])
    } else if (type === R.ShapeType.ConvexPolyhedron) {
      shape = 'convexHull'
      values = Array.from(c.vertices())
    } else {
      throw new Error(`${id}: unexpected Rapier shape type ${type}`)
    }
    records.push({
      id,
      handle: c.handle,
      shape,
      values,
      ...(indices ? { indices } : {}),
      translation: [t.x, t.y, t.z],
      rotation: [q.x, q.y, q.z, q.w],
      groups: c.collisionGroups(),
      sensor: c.isSensor(),
      enabled: c.isEnabled(),
    })
  }
  return records.sort((a, b) => a.handle - b.handle)
}
