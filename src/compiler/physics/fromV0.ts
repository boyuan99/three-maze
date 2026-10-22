// Bridge from the v0 reference loader to the partitioner (plan item MOT-08): the world-space
// solids v0.3 builds from a v0 maze (src/compat/v0/physics.ts, plan item TS-28) as boxes for
// partition(), until compileScene (TS-04) resolves v1 scenes. It is the gate's fallback scene
// input (TS-28) and the reference for the migrator's tests (TS-10), not a path for paper data.
//
// It fixes v0.3's rotation drop: v0.3 gives each collider its object's position only
// (src/scenes/serial/PythonCustomScene.vue:464-468) while the mesh is rotated (:435-439); here the
// box gets the mesh's rotation. No shipped maze rotates an object, so their colliders do not move.
import type { V0SceneConfig } from '../../compat/v0/config.ts'
import { v0Physics } from '../../compat/v0/physics.ts'
import type {
  ColliderManifest, FallMode, ManifestMotion, Quat, Vec3,
} from '../../motion/manifest.ts'
import { buildManifest, DEFAULT_GRAVITY, manifestHash } from './manifest.ts'
import { partition, PartitionError } from './partition.ts'
import type { BoxSolid, Partition } from './partition.ts'

/** Ids of v1 scene files (ADR-0005 F4); a v0 name that does not match is replaced. */
const ID = /^[A-Za-z][A-Za-z0-9_]*$/
/** The replacement ids, object<index>; a v0 name of this form is replaced too, so none collide. */
const INDEX_ID = /^object[0-9]+$/

/**
 * Quaternion [x, y, z, w] of an Euler rotation in three.js's default order XYZ (radians), with the
 * operations of three's Quaternion.setFromEuler (node_modules/three/src/math/Quaternion.js:201),
 * so that a collider is rotated exactly as v0.3 rotates the mesh.
 */
export function eulerXYZToQuaternion([x, y, z]: Vec3): Quat {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2)
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

export interface V0BridgeOptions {
  /**
   * Default 'gravity', as in v0.3, whose ball fell off open edges (Hallway02 and Hallway_fog;
   * experiments/hallway02_experiment.py:447-475). A v1 scene must name its own (ADR-0005).
   */
  fall?: FallMode
  /**
   * Default -981, ADR-0001 R3's default; v0 scenes set none (v0.3's -500,
   * PythonCustomScene.vue:623, was its dynamic ball's).
   */
  gravity?: number
}

export interface V0Solids {
  /** The maze's box colliders as world-space boxes, in the order v0.3 creates them. */
  solids: BoxSolid[]
  /** The index in the JSON's `objects` of each solid. */
  objectIndex: number[]
  motion: ManifestMotion
  /** What the bridge changed or left out, one line each. */
  notes: string[]
}

/**
 * The boxes of a v0 maze for partition(). Each box's id is its object's name where that is a
 * valid v1 id used by no other object, else object<index>. Dynamic bodies are left out and noted
 * (v1.0 has no moving colliders, ADR-0001 amendment of 2026-10-09 item 5; the maze migrator,
 * TS-10, makes them fixed), as is any object v0.3 gives no collider. A fixed sphere or cylinder
 * throws a PartitionError: the partitioner takes boxes only (plan item MOT-08, the box subset) and
 * the collider manifest has no ball or cylinder shape. That is this bridge's limit, not a rule:
 * ADR-0001 R5.2 allows balls up to radius 60 and cylinders up to 40 units. No shipped maze has a
 * fixed one.
 */
export function v0Solids(config: V0SceneConfig, options: V0BridgeOptions = {}): V0Solids {
  const physics = v0Physics(config)
  const notes: string[] = []
  const names = (config.objects ?? []).map((o) => o.name)
  const idOf = (index: number, name: string | null) => {
    const usable = name !== null && ID.test(name) && !INDEX_ID.test(name)
      && names.indexOf(name) === names.lastIndexOf(name)
    return usable ? name : `object${index}`
  }
  const solids: BoxSolid[] = []
  const objectIndex: number[] = []
  for (const s of physics.solids) {
    const label = `objects[${s.objectIndex}] (${s.name ?? 'unnamed'})`
    if (s.body === 'dynamic') {
      notes.push(`${label}: a dynamic ${s.shape.kind}, left out: v1.0 builds fixed colliders only `
        + '(ADR-0001, amendment of 2026-10-09, item 5); the maze migrator (TS-10) makes it fixed')
      continue
    }
    if (s.shape.kind !== 'cuboid') {
      throw new PartitionError(`objects[${s.objectIndex}]`, `a fixed ${s.shape.kind}: the `
        + 'collider partitioner takes boxes only (plan item MOT-08), and the collider manifest '
        + `has no ${s.shape.kind} shape`)
    }
    const id = idOf(s.objectIndex, s.name)
    if (id !== s.name) notes.push(`${label}: id ${id}`)
    const rotation = eulerXYZToQuaternion(s.meshRotation)
    if (s.meshRotation.some((angle) => angle !== 0)) {
      notes.push(`${id}: rotated as its mesh; v0.3 dropped the rotation `
        + '(PythonCustomScene.vue:464-468)')
    }
    solids.push({
      id,
      halfExtents: [...s.shape.halfExtents],
      translation: [...s.position],
      rotation,
    })
    objectIndex.push(s.objectIndex)
  }
  for (const b of physics.bodiesWithoutCollider) {
    notes.push(`objects[${b.objectIndex}] (${b.name ?? 'unnamed'}): no collider, as in v0.3 `
      + '(a geometry type v0.3 does not collide)')
  }
  const gravity = options.gravity ?? DEFAULT_GRAVITY
  const fall = options.fall ?? 'gravity'
  if (options.gravity === undefined) {
    notes.push(`gravity ${DEFAULT_GRAVITY}, ADR-0001 R3's default; v0.3's ball fell under `
      + `${physics.gravity[1]} (PythonCustomScene.vue:623)`)
  }
  if (options.fall === undefined) {
    notes.push("fall 'gravity': the agent falls off open edges, as v0.3's ball did")
  }
  return { solids, objectIndex, motion: { gravity, fall }, notes }
}

export interface V0Manifest {
  manifest: ColliderManifest
  /** manifestHash(manifest) */
  hash: string
  /** The bridge's notes, then the partitioner's. */
  notes: string[]
}

/**
 * The collider manifest of a v0 maze: v0Solids(), partition() and buildManifest() in turn. A
 * PartitionError names the object in the JSON (`objects[i]`).
 */
export function v0Manifest(
  config: V0SceneConfig, options: V0BridgeOptions & { rapierVersion: string },
): V0Manifest {
  const input = v0Solids(config, options)
  let parts: Partition
  try {
    parts = partition({ solids: input.solids })
  } catch (error) {
    const match = error instanceof PartitionError && /^solids\[(\d+)\](.*)$/.exec(error.path)
    if (!match) throw error
    const path = `objects[${input.objectIndex[Number(match[1])]}]${match[2]}`
    throw new PartitionError(path, error.message.slice(error.path.length + 2))
  }
  const manifest = buildManifest(parts, {
    rapierVersion: options.rapierVersion, motion: input.motion,
  })
  return { manifest, hash: manifestHash(manifest), notes: [...input.notes, ...parts.notes] }
}
