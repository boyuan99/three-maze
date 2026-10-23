// The scene compiler's collider partitioner (src/compiler/physics/partition.ts), its manifest and
// hash (manifest.ts) and the v0 bridge (fromV0.ts), plan item MOT-08: ADR-0001's Follow-up counts
// on the shipped mazes, the 40-unit cap and the exemption of walkable floors, merging and where it
// stops, rotated boxes against the meshes v0.3 draws, the union of the solids kept, rejected
// input, and the same manifest hash in every run, in Node, in a Vite worker bundle and in
// Electron's Node.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { V0SceneConfig } from '../../../src/compat/v0/config.ts'
import { v0Physics } from '../../../src/compat/v0/physics.ts'
import {
  eulerXYZToQuaternion, v0Manifest, v0Solids,
} from '../../../src/compiler/physics/fromV0.ts'
import {
  BUILDER, buildManifest, DEFAULT_GRAVITY, manifestHash, manifestJson,
} from '../../../src/compiler/physics/manifest.ts'
import {
  MAX_EXTENT, partition, PartitionError, RISE, SIDE_REACH, WHY,
} from '../../../src/compiler/physics/partition.ts'
import type { BoxSolid, Partition } from '../../../src/compiler/physics/partition.ts'
import { GROUPS, instantiate } from '../../../src/motion/instantiate.ts'
import { ManifestError, validateManifest } from '../../../src/motion/manifest.ts'
import type {
  ColliderManifest, ManifestCollider, ManifestZone, Quat, Vec3,
} from '../../../src/motion/manifest.ts'
import { buildWorkerBundle } from '../motion/workerBundle.ts'
import type { WorkerBundle } from '../motion/workerBundle.ts'
import { readMaze, REPO_ROOT, shippedMazes } from '../v0Reference/harness.ts'
import { buildManifests, ROTATED, TURNED } from './partitionChecks.ts'
import type { ManifestResult, WorkerAnswer } from './partitionChecks.ts'

const RAPIER_VERSION = '0.14.0'
const MOTION = { gravity: DEFAULT_GRAVITY, fall: 'gravity' } as const
const IDENTITY: Quat = [0, 0, 0, 1]

/** A box solid of full size `size` centred at `at`. */
const box = (id: string, size: Vec3, at: Vec3, extra: Partial<BoxSolid> = {}): BoxSolid => ({
  id, halfExtents: size.map((s) => s / 2) as Vec3, translation: at, rotation: IDENTITY, ...extra,
})
/** Rotation by `degrees` about +Y. */
const yaw = (degrees: number): Quat => {
  const t = (degrees * Math.PI) / 180
  return [0, Math.sin(t / 2), 0, Math.cos(t / 2)]
}
const cuboidOf = (c: ManifestCollider) => {
  if (c.shape.kind !== 'cuboid') throw new Error(`${c.id} is not a cuboid`)
  return c.shape.halfExtents
}
const ids = (p: Partition | ColliderManifest) => p.colliders.map((c) => c.id)
/** What `run` throws (undefined if it returns). */
const thrown = (run: () => unknown): unknown => {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

// ---- analytic geometry (double precision) ----

// v rotated by the unit quaternion q = [x, y, z, w]
function rotate([qx, qy, qz, qw]: Quat, [vx, vy, vz]: Vec3): Vec3 {
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ]
}

/** max_i(|local_i| - h_i): negative inside the box, positive outside. */
function margin(p: Vec3, centre: Vec3, q: Quat, h: Vec3): number {
  const local = rotate([-q[0], -q[1], -q[2], q[3]], [0, 1, 2].map((i) => p[i] - centre[i]) as Vec3)
  return Math.max(...local.map((v, i) => Math.abs(v) - h[i]))
}

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Corners of an oriented box, to bound the sampled region. */
const cornersOf = (centre: Vec3, q: Quat, h: Vec3): Vec3[] =>
  [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => [-1, 1].map((sz) => {
    const r = rotate(q, [sx * h[0], sy * h[1], sz * h[2]])
    return [centre[0] + r[0], centre[1] + r[1], centre[2] + r[2]] as Vec3
  })))

/**
 * Samples points around `solids` and checks that each lies in some collider exactly when it lies in
 * some solid (`inSolids`: the reference membership, by default the solids' own boxes). Points
 * within 1e-6 of a face of either are skipped. Returns the number of points compared.
 */
function expectSameUnion(
  solids: BoxSolid[], colliders: ManifestCollider[], count: number, seed: number,
  inSolids = (p: Vec3) => solids.some((s) => margin(p, s.translation, s.rotation, s.halfExtents) < 0),
): number {
  const next = random(seed)
  const boxes = solids.map((s) => cornersOf(s.translation, s.rotation, s.halfExtents))
  const bounds = (corners: Vec3[]) => [0, 1, 2].map((i) => {
    const values = corners.map((c) => c[i])
    return [Math.min(...values) - 1, Math.max(...values) + 1]
  })
  const all = bounds(boxes.flat())
  const near = (p: Vec3, shapes: Array<[Vec3, Quat, Vec3]>) =>
    shapes.some(([c, q, h]) => Math.abs(margin(p, c, q, h)) < 1e-6)
  const solidShapes = solids.map((s): [Vec3, Quat, Vec3] => [s.translation, s.rotation, s.halfExtents])
  const colliderShapes = colliders.map((c): [Vec3, Quat, Vec3] => [c.translation, c.rotation, cuboidOf(c)])
  let compared = 0
  for (let n = 0; n < count; n++) {
    // half the points anywhere, half around one solid, where the faces are
    const region = n % 2 ? all : bounds(boxes[Math.floor(next() * boxes.length)])
    const p = region.map(([lo, hi]) => lo + (hi - lo) * next()) as Vec3
    if (near(p, solidShapes) || near(p, colliderShapes)) continue
    const inColliders = colliderShapes.some(([c, q, h]) => margin(p, c, q, h) < 0)
    if (inColliders !== inSolids(p)) {
      throw new Error(`point ${p.join(', ')}: in colliders ${inColliders}, in solids ${!inColliders}`)
    }
    compared++
  }
  expect(compared).toBeGreaterThan(count * 0.99)
  return compared
}

// ---- the shipped mazes ----

const mazes = shippedMazes()
const built = new Map(mazes.map((m) => [m.name,
  v0Manifest(readMaze(m), { rapierVersion: RAPIER_VERSION })]))
const manifestOf = (name: string) => built.get(name)!.manifest

/** The three floor boxes of each hallway (public/mazes/<name>/<name>.json, objects 0-2). */
const HALLWAY_FLOORS: Record<string, string[]> = {
  Hallway01: ['mainFloor', 'frontBlueFloor', 'backBlueFloor'],
  Hallway02: ['mainFloor', 'frontBlueFloor', 'backBlueFloor'],
  Hallway04: ['mainFloor', 'frontBlueFloor', 'backBlueFloor'],
  HallwaySerialMigrated: ['mainFloor', 'frontBlueSection', 'backBlueSection'],
  Hallway_fog: ['mainFloor', 'frontBlueFloor', 'backBlueFloor'],
}

/**
 * Manifest hashes of the shipped mazes and of the rotated and turned fixtures, for Rapier 0.14.0
 * and BUILDER. They change only with the builder's output: then raise BUILDER's version and
 * update them.
 */
const HASHES: Record<string, string> = {
  Example01: '81cdea6809ff4faa27d5f820bbe54a2aba56c50b0955df74543ffa854d6b1e9e',
  Hallway01: '5cdaf060ceb552907e927ce9dfe1843b4ad31f9b0fa194da54358daca5fea470',
  Hallway02: '50164cefd1990d4f794ede05b6a8f916b7bdabe402abfe9703fa88c489f7ff26',
  Hallway04: '2f94aeaf0b86b3dea43fa91afab09739eaa4cf0d8b3f8623c4d5cf637d83cd2f',
  HallwaySerialMigrated: '42d2494bbb3c9ab09ab273393141871670ec7a7f85796daa55bf8db13c7a2c6c',
  Hallway_fog: '50164cefd1990d4f794ede05b6a8f916b7bdabe402abfe9703fa88c489f7ff26',
  rotated: 'fddce135cfec239f0caafd6ca0ffd898b044ba9af8d7800ba181b3a88b614abd',
  turned: '38c533f1085d05f093d161b2df6ded15af3691bab48afa5f83c5d20f5a5a65ce',
}

describe('the shipped mazes (ADR-0001 Follow-up)', () => {
  it('are the six mazes the Follow-up counts', () => {
    expect(mazes.map((m) => m.name)).toEqual(['Example01', 'Hallway01', 'Hallway02', 'Hallway04',
      'HallwaySerialMigrated', 'Hallway_fog'])
  })

  it('turn the six walls over 40 units into 26 pieces', () => {
    const split: Record<string, Record<string, number>> = {}
    for (const m of mazes) {
      for (const c of manifestOf(m.name).colliders) {
        if (!c.piece) continue
        split[m.name] ??= {}
        split[m.name][c.sources[0]] = c.piece[1]
      }
    }
    expect(split).toEqual({
      Hallway01: { leftWall: 4, rightWall: 4 }, // 140 units: 4 pieces of 35
      Hallway04: { leftWall: 4, rightWall: 4 },
      HallwaySerialMigrated: { leftWall: 5, rightWall: 5 }, // 200 units: 5 pieces of 40
    })
    const pieces = Object.values(split).flatMap((walls) => Object.values(walls))
    expect(pieces).toHaveLength(6)
    expect(pieces.reduce((a, b) => a + b, 0)).toBe(26)
    // every other box over 40 is a hallway floor box
    for (const m of mazes) {
      const long = v0Solids(readMaze(m)).solids
        .filter((s) => s.halfExtents.some((h) => 2 * h > MAX_EXTENT)).map((s) => s.id)
      const walls = Object.keys(split[m.name] ?? {})
      expect(long.filter((id) => !walls.includes(id))).toEqual(
        HALLWAY_FLOORS[m.name] ? ['mainFloor'] : [])
    }
  })

  it("turn each hallway's three floor boxes into one collider", () => {
    for (const [name, floors] of Object.entries(HALLWAY_FLOORS)) {
      const m = manifestOf(name)
      const fromFloors = m.colliders.filter((c) => c.sources.some((s) => floors.includes(s)))
      expect(fromFloors).toHaveLength(1)
      const [merged] = fromFloors
      expect(merged.id).toBe('mainFloor.merged')
      expect(merged.sources).toEqual(floors)
      expect(merged.why).toBe(WHY.mergedFloor)
      // the union of the three boxes: the hallway's whole floor, top at y 0
      const solids = v0Solids(readMaze(mazes.find((x) => x.name === name)!)).solids
        .filter((s) => floors.includes(s.id))
      const extent = (i: number) => Math.max(...solids.map((s) => s.translation[i] + s.halfExtents[i]))
        - Math.min(...solids.map((s) => s.translation[i] - s.halfExtents[i]))
      expect(cuboidOf(merged).map((h) => 2 * h)).toEqual([extent(0), 1, extent(2)])
      expect(merged.translation[1] + cuboidOf(merged)[1]).toBe(0)
    }
  })

  it('list exactly these colliders', () => {
    const walls = (side: string, n: number) => Array.from({ length: n }, (_, k) => `${side}Wall.${k + 1}`)
    const hallway = (n: number) => ['mainFloor.merged', ...walls('left', n), ...walls('right', n),
      'leftFrontBlueWall', 'rightFrontBlueWall', 'leftBackBlueWall', 'rightBackBlueWall',
      'frontWall', 'backWall']
    expect(Object.fromEntries(mazes.map((m) => [m.name, ids(manifestOf(m.name))]))).toEqual({
      Example01: ['floor'],
      Hallway01: hallway(4),
      Hallway02: ['mainFloor.merged'],
      Hallway04: hallway(4),
      HallwaySerialMigrated: hallway(5),
      Hallway_fog: ['mainFloor.merged'],
    })
  })

  it('cap every sweepable collider at 40; only floors not reachable from the side exceed it', () => {
    const over: string[] = []
    for (const m of mazes) {
      for (const c of manifestOf(m.name).colliders) {
        const extents = cuboidOf(c).map((h) => 2 * h)
        if (c.why === WHY.swept || c.why === WHY.piece) {
          expect(Math.max(...extents)).toBeLessThanOrEqual(MAX_EXTENT)
        } else {
          expect([WHY.floor, WHY.mergedFloor]).toContain(c.why)
        }
        if (Math.max(...extents) > MAX_EXTENT) over.push(`${m.name}/${c.id}`)
      }
    }
    // ADR-0001 R5.2 caps sweepable geometry; R5.1 exempts a walkable floor that is not reachable
    // from the side, such as a hallway's floor, which nothing lower borders
    expect(over).toEqual(['Hallway01/mainFloor.merged', 'Hallway02/mainFloor.merged',
      'Hallway04/mainFloor.merged', 'HallwaySerialMigrated/mainFloor.merged',
      'Hallway_fog/mainFloor.merged'])
  })

  it('keep the union of the solids', () => {
    for (const [i, m] of mazes.entries()) {
      const { solids } = v0Solids(readMaze(m))
      expectSameUnion(solids, manifestOf(m.name).colliders, 20_000, 1 + i)
    }
  })

  it("leave out Example01's dynamic sphere and say so (D11 v)", () => {
    const { notes } = built.get('Example01')!
    expect(notes[0]).toMatch(/^objects\[1\] \(sphere\): a dynamic ball, left out: .*\(TS-10\)/)
    expect(ids(manifestOf('Example01'))).toEqual(['floor'])
  })

  it('write the builder, the Rapier version and the motion settings', () => {
    for (const m of mazes) {
      const manifest = manifestOf(m.name)
      expect(manifest.builder).toBe(BUILDER)
      expect(manifest.rapierVersion).toBe(RAPIER_VERSION)
      expect(manifest.motion).toEqual({ gravity: -981, fall: 'gravity' })
      expect(manifest.zones).toEqual([])
      expect(validateManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest)
    }
  })

  it('build in Rapier: rays with the agent groups hit the analytic faces', async () => {
    await RAPIER.init()
    const q = instantiate(RAPIER, manifestOf('Hallway04'))
    const hit = (origin: Vec3, dir: Vec3, id: string, toi: number) => {
      const ray = new RAPIER.Ray({ x: origin[0], y: origin[1], z: origin[2] },
        { x: dir[0], y: dir[1], z: dir[2] })
      const h = q.world.castRay(ray, 1000, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        GROUPS.agent)
      expect(h && q.entries.get(h.collider.handle)!.id).toBe(id)
      expect(h!.timeOfImpact).toBeCloseTo(toi, 5)
    }
    expect(q.colliders.size).toBe(15)
    hit([0, 1, 10], [1, 0, 0], 'rightWall.3', 20)
    hit([0, 1, -60], [-1, 0, 0], 'leftWall.1', 20)
    hit([5, 10, 90], [0, -1, 0], 'mainFloor.merged', 10)
    hit([0, 1, 0], [0, 0, 1], 'frontWall', 100)
    q.world.free()
  })
})

// ---- rotation ----

describe('rotated boxes', () => {
  const result = v0Manifest(ROTATED, { rapierVersion: RAPIER_VERSION })
  const objects = ROTATED.objects!

  // The mesh v0.3 draws for object i (PythonCustomScene.vue:362-372, :430-439)
  const meshOf = (i: number) => {
    const o = objects[i]
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.geometry.width, o.geometry.height,
      o.geometry.depth))
    mesh.position.set(o.position?.x ?? 0, o.position?.y ?? 0, o.position?.z ?? 0)
    mesh.rotation.set(o.rotation?.x ?? 0, o.rotation?.y ?? 0, o.rotation?.z ?? 0)
    mesh.updateMatrixWorld()
    return mesh
  }

  it("keep the rotation v0.3 drops: each collider turned exactly as its object's mesh", () => {
    // v0.3 (and its port) builds the collider without the rotation (quirk 1)
    for (const solid of v0Physics(ROTATED).solids) expect(solid.colliderRotation).toEqual(IDENTITY)
    for (const [i, o] of objects.entries()) {
      const q = meshOf(i).quaternion
      const expected = [q.x, q.y, q.z, q.w]
      const colliders = result.manifest.colliders.filter((c) => c.sources[0] === o.name)
      expect(colliders.length).toBeGreaterThan(0)
      for (const c of colliders) c.rotation.forEach((v, k) => expect(Object.is(v, expected[k])).toBe(true))
    }
    const r = ROTATED.objects![1].rotation!
    expect(eulerXYZToQuaternion([r.x!, r.y!, r.z!])).toEqual([0, Math.sin(Math.PI / 12), 0,
      Math.cos(Math.PI / 12)])
    expect(result.notes).toContain(
      'wallTurned: rotated as its mesh; v0.3 dropped the rotation (PythonCustomScene.vue:464-468)')
  })

  it('split along their own axes, the union equal to the meshes v0.3 draws', () => {
    expect(ids(result.manifest)).toEqual(['floor', 'wallTurned.1', 'wallTurned.2', 'wallTurned.3',
      'beamLying.1', 'beamLying.2', 'slabTilted.1', 'slabTilted.2'])
    const pieceSize = (id: string) => cuboidOf(result.manifest.colliders.find((c) => c.id === id)!)
    expect(pieceSize('wallTurned.1').map((h) => 2 * h)).toEqual([1, 10, 100 / 3])
    expect(pieceSize('beamLying.1').map((h) => 2 * h)).toEqual([2, 25, 4]) // split along its height
    expect(pieceSize('slabTilted.2').map((h) => 2 * h)).toEqual([1, 10, 30])
    // The floor (80 x 80) is not reachable from the side; the wall, the beam (4 high) and the
    // tilted slab are
    expect(result.manifest.colliders.map((c) => c.why)).toEqual([WHY.floor, ...Array(7).fill(WHY.piece)])
    // membership by three.js: the point in a mesh's own frame, inside its box geometry
    const meshes = objects.map((_, i) => meshOf(i))
    const inMeshes = (p: Vec3) => meshes.some((mesh, i) => {
      const local = mesh.worldToLocal(new THREE.Vector3(...p))
      const g = objects[i].geometry
      return Math.abs(local.x) < g.width! / 2 && Math.abs(local.y) < g.height! / 2
        && Math.abs(local.z) < g.depth! / 2
    })
    const { solids } = v0Solids(ROTATED)
    expectSameUnion(solids, result.manifest.colliders, 40_000, 7, inMeshes)
  })

  it('reject a box tilted into a walkable ramp (owner decision D12 a)', () => {
    const ramp = structuredClone(ROTATED)
    ramp.objects![2].rotation = { x: 0.2, y: 0, z: 0 } // the beam stood up, 11.5 degrees off
    const error = thrown(() => v0Manifest(ramp, { rapierVersion: RAPIER_VERSION }))
    expect(error).toBeInstanceOf(PartitionError)
    expect((error as PartitionError).path).toBe('objects[2].rotation')
    expect((error as Error).message).toMatch(/tilted 11\.459 degrees .* walkable ramp; .*D12 a/)
    expect((error as Error).message).not.toMatch(/upright only/) // a hint for tiny tilts only
    // up to 30 degrees a face is walkable; beyond it, a wall
    const about = (degrees: number): Quat => {
      const t = (degrees * Math.PI) / 360
      return [Math.sin(t), 0, 0, Math.cos(t)]
    }
    const tilted = (degrees: number) =>
      partition({ solids: [box('slab', [10, 1, 10], [0, 0, 0], { rotation: about(degrees) })] })
    expect(() => tilted(29.9)).toThrow(/walkable ramp/)
    expect(tilted(30.1).colliders[0].why).toBe(WHY.swept)
    // a quarter turn written to 7 digits lies flat: upright, not a ramp
    const rounded = partition({ solids: [box('beam', [2, 50, 4], [0, 2, 0],
      { rotation: [0.7071068, 0, 0, 0.7071068] })] })
    expect(rounded.colliders[0].why).toBe(WHY.floor)
    // a quarter turn given in radians to 5 digits (1.5708) tilts the beam by 0.00021 degrees:
    // a ramp, and the message shows the tilt and the tolerance
    const approx = structuredClone(ROTATED)
    approx.objects![2].rotation = { x: 1.5708, y: 0, z: 0 }
    expect(() => v0Manifest(approx, { rapierVersion: RAPIER_VERSION })).toThrow(new RegExp(
      'tilted 0\\.000210 degrees from upright, .* walkable ramp; .*; a box counts as upright '
      + 'only if one of its axes is within 0\\.000081 degrees of vertical'))
  })
})

// ---- the rules on small scenes ----

describe('partition', () => {
  const floorAt = (id: string, size: Vec3, x: number, z: number, top = 0) =>
    box(id, size, [x, top - size[1] / 2, z])

  it('merges coplanar floor boxes whose union is a box, overlapping or turned by 90 degrees', () => {
    const solids = [
      floorAt('a', [30, 1, 20], 0, 0),
      floorAt('b', [30, 1, 20], 15, 0), // overlaps a
      // 20 x 40 turned 90 degrees about +Y: 40 along x, 20 along z
      box('c', [20, 1, 40], [50, -0.5, 0], { rotation: yaw(90) }),
    ]
    const p = partition({ solids })
    expect(ids(p)).toEqual(['a.merged'])
    const [merged] = p.colliders
    expect(merged.sources).toEqual(['a', 'b', 'c'])
    expect(cuboidOf(merged)).toEqual([42.5, 0.5, 10]) // x from -15 to 70
    expect(merged.translation).toEqual([27.5, -0.5, 0])
    expect(merged.rotation).toEqual(IDENTITY)
    expect(p.notes).toEqual(['a.merged: 3 coplanar walkable boxes (a, b, c) merged into one cuboid '
      + '85 x 1 x 20, not reachable from the side, so not capped (R5.1)'])
    expectSameUnion(solids, p.colliders, 20_000, 11)
  })

  it('merges floor boxes turned by any angle in their own frame', () => {
    const t = (30 * Math.PI) / 180
    const along = (d: number): Vec3 => [d * Math.cos(t), -0.5, -d * Math.sin(t)] // local +X
    const solids = [0, 20, 40].map((d, i) => box(`t${i}`, [20, 1, 20], along(d), { rotation: yaw(30) }))
    const p = partition({ solids })
    expect(ids(p)).toEqual(['t0.merged'])
    const [merged] = p.colliders
    expect(cuboidOf(merged)[0]).toBeCloseTo(30, 12)
    merged.rotation.forEach((v, k) => expect(v).toBeCloseTo(yaw(30)[k], 15))
    expectSameUnion(solids, p.colliders, 20_000, 12)
  })

  it('keeps floors as boxes where the union is not a box (D12 a: no triangle-mesh floors)', () => {
    const solids = [floorAt('a', [20, 1, 20], 0, 0), floorAt('b', [20, 1, 20], 20, 0),
      floorAt('c', [20, 1, 20], 0, 20)] // an L
    const p = partition({ solids })
    expect(ids(p)).toEqual(['a', 'b', 'c'])
    expect(p.colliders.every((c) => c.why === WHY.floor)).toBe(true)
    expect(p.notes).toEqual(['a, b, c: coplanar walkable boxes whose union is not a box, kept as '
      + 'they are (triangle-mesh floors are phase 2: owner decision D12 a, plan item MOT-09)'])
    // boxes of different thickness, or turned by another angle, never form one box
    const thick = partition({ solids: [floorAt('a', [20, 1, 20], 0, 0), floorAt('b', [20, 2, 20], 20, 0)] })
    expect(ids(thick)).toEqual(['a', 'b'])
    const turned = partition({ solids: [floorAt('a', [20, 1, 20], 0, 0),
      box('b', [20, 1, 20], [24, -0.5, 0], { rotation: yaw(45) })] })
    expect(ids(turned)).toEqual(['a', 'b'])
    // touching at a corner only: not connected, so a and b still merge
    const corner = partition({ solids: [floorAt('a', [20, 1, 20], 0, 0), floorAt('b', [20, 1, 20], 20, 0),
      floorAt('c', [20, 1, 20], 40, 20)] })
    expect(ids(corner)).toEqual(['a.merged', 'c'])
  })

  it('merges only world floors there at load, not a floor enabled later or a barrier', () => {
    // in a row, so that merging all four would give one box
    const solids = [
      floorAt('a', [20, 1, 20], 0, 0),
      floorAt('b', [20, 1, 20], 20, 0),
      { ...floorAt('later', [20, 1, 20], 40, 0), enabled: false },
      { ...floorAt('barrier', [20, 1, 20], 60, 0), layer: 'agentBarrier' as const },
    ]
    const p = partition({ solids })
    expect(ids(p)).toEqual(['a.merged', 'later', 'barrier'])
    expect(p.colliders[0].sources).toEqual(['a', 'b'])
    expect(p.colliders.map((c) => [c.layer, c.enabled])).toEqual([['world', true],
      ['world', false], ['agentBarrier', true]])
    expectSameUnion(solids, p.colliders, 20_000, 15)
  })

  it("takes a box's top and bottom along whichever local axis is vertical", () => {
    // 1 x 20 x 20 turned 90 degrees about +Z: it lies on its side, 20 x 1 x 20, top at y 0
    const side = box('side', [1, 20, 20], [20, -0.5, 0],
      { rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] })
    const solids = [floorAt('a', [20, 1, 20], 0, 0), side]
    const p = partition({ solids })
    expect(ids(p)).toEqual(['a.merged'])
    expect(cuboidOf(p.colliders[0])).toEqual([20, 0.5, 10])
    expect(p.colliders[0].translation).toEqual([10, -0.5, 0])
    expectSameUnion(solids, p.colliders, 20_000, 16)
  })

  it('caps a floor reachable from the side from a region a step lower, and does not merge it', () => {
    const solids = [
      floorAt('upper', [100, 1, 20], 0, 0),
      floorAt('lower', [50, 1, 20], -25, 20, -5), // borders half the upper floor, 5 lower
      floorAt('next', [20, 1, 20], 60, 0), // borders the upper floor at its level, not the lower
    ]
    const p = partition({ solids })
    expect(ids(p)).toEqual(['upper.1', 'upper.2', 'upper.3', 'lower', 'next'])
    expect(p.colliders[0].piece).toEqual([1, 3])
    expect(p.colliders.find((c) => c.id === 'lower')!.why).toBe(WHY.floor)
    expect(p.colliders.find((c) => c.id === 'next')!.why).toBe(WHY.floor)
    expectSameUnion(solids, p.colliders, 20_000, 13)
  })

  it('counts a rise of RISE (0.28) as reachable, and a neighbour within SIDE_REACH (1)', () => {
    expect(RISE).toBeCloseTo(0.28, 12)
    expect(SIDE_REACH).toBe(1)
    const pair = (rise: number, gap: number) => partition({ solids: [
      floorAt('high', [100, 1, 20], 0, 0, rise), floorAt('low', [100, 1, 20], 0, 20 + gap),
    ] })
    expect(ids(pair(0.29, 0))).toEqual(['high.1', 'high.2', 'high.3', 'low'])
    expect(ids(pair(0.28, 0))).toEqual(['high.1', 'high.2', 'high.3', 'low'])
    expect(ids(pair(0.27, 0))).toEqual(['high', 'low'])
    expect(ids(pair(5, 0.99))).toEqual(['high.1', 'high.2', 'high.3', 'low'])
    expect(ids(pair(5, 1.01))).toEqual(['high', 'low'])
  })

  it('splits walls into equal flush pieces along every axis over 40, and keeps gates apart', () => {
    const solids = [
      floorAt('floor', [200, 1, 200], 0, 0),
      box('wall', [81, 50, 1], [0, 25, 0]), // 3 x 2 pieces
      box('gate', [50, 10, 0.5], [0, 5, 50], { layer: 'agentBarrier', enabled: false }),
      box('lid', [30, 0.5, 30], [0, 20, -50], { layer: 'agentBarrier' }),
    ]
    const p = partition({ solids })
    expect(ids(p)).toEqual(['floor', 'wall.1', 'wall.2', 'wall.3', 'wall.4', 'wall.5', 'wall.6',
      'gate.1', 'gate.2', 'lid'])
    const wall = p.colliders.filter((c) => c.sources[0] === 'wall')
    expect(wall.map((c) => c.piece)).toEqual([[1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]])
    expect(cuboidOf(wall[0])).toEqual([13.5, 12.5, 0.5])
    expect(wall.map((c) => c.translation)).toEqual([[-27, 12.5, 0], [0, 12.5, 0], [27, 12.5, 0],
      [-27, 37.5, 0], [0, 37.5, 0], [27, 37.5, 0]])
    const gate = p.colliders.filter((c) => c.sources[0] === 'gate')
    expect(gate.map((c) => [c.layer, c.enabled])).toEqual([['agentBarrier', false], ['agentBarrier', false]])
    expect(p.notes).toContain('wall: sweepable box 81 x 50 x 1 split into 6 equal flush pieces of '
      + '27 x 25 x 1 (R5.2)')
    expectSameUnion(solids, p.colliders, 20_000, 14)
  })

  it('passes zones through unchanged (ADR-0001 R5.4)', () => {
    const zones: ManifestZone[] = [{
      id: 'reward', zone: 'reward', tags: [], shape: { kind: 'cuboid', halfExtents: [100, 5, 15] },
      translation: [0, 5, 85], rotation: IDENTITY, enabled: true, sources: ['reward'],
    }]
    const p = partition({ solids: [floorAt('floor', [20, 1, 20], 0, 0)], zones })
    expect(p.zones).toEqual(zones)
    expect(p.zones[0]).not.toBe(zones[0])
    expect(buildManifest(p, { rapierVersion: RAPIER_VERSION, motion: MOTION }).zones).toEqual(zones)
  })

  it('rejects input it cannot build, naming the value', () => {
    const fails = (solids: unknown[], at: string, message: RegExp) => {
      const error = thrown(() => partition({ solids: solids as BoxSolid[] }))
      expect(error).toBeInstanceOf(PartitionError)
      expect((error as PartitionError).path).toBe(at)
      expect((error as Error).message).toMatch(message)
    }
    const ok = box('a', [1, 1, 1], [0, 0, 0])
    fails([ok, ok], 'solids[1].id', /used twice/)
    fails([{ ...ok, halfExtents: [1, 0, 1] }], 'solids[0].halfExtents[1]', /greater than 0/)
    fails([{ ...ok, translation: [0, NaN, 0] }], 'solids[0].translation', /finite/)
    fails([{ ...ok, rotation: [0, 0, 0, 2] }], 'solids[0].rotation', /unit quaternion/)
    fails([{ ...ok, layer: 'prop' }], 'solids[0].layer', /unknown layer 'prop'/)
    fails([{ ...ok, id: '' }], 'solids[0].id', /non-empty/)
    // a fixed ball or cylinder of a v0 maze: the partitioner and the manifest have boxes only
    const ball: V0SceneConfig = { objects: [{ name: 'ball', geometry: { type: 'sphere', radius: 2 },
      physics: { enabled: true } }] }
    expect(() => v0Solids(ball)).toThrow(
      /objects\[0\]: a fixed ball: the collider partitioner takes boxes only .* no ball shape$/)
  })
})

// ---- manifest and hash ----

describe('manifest', () => {
  it('validates the motion settings', () => {
    const p = partition({ solids: [box('floor', [10, 1, 10], [0, -0.5, 0])] })
    const fails = (motion: unknown, at: string, message: RegExp) => {
      const error = thrown(() => buildManifest(p, {
        rapierVersion: RAPIER_VERSION, motion: motion as typeof MOTION,
      }))
      expect(error).toBeInstanceOf(ManifestError)
      expect((error as ManifestError).path).toBe(at)
      expect((error as Error).message).toMatch(message)
    }
    fails({ gravity: 0, fall: 'gravity' }, 'manifest.motion.gravity', /finite negative number/)
    fails({ gravity: 981, fall: 'gravity' }, 'manifest.motion.gravity', /finite negative number/)
    fails({ gravity: -981, fall: 'float' }, 'manifest.motion.fall', /unknown fall mode 'float'/)
    fails({ gravity: -981 }, 'manifest.motion', /'fall' is missing/)
    // the eye height is the rig's (ADR-0001 R3), never the scene's
    fails({ gravity: -981, fall: 'none', eyeHeight: 3.7 }, 'manifest.motion',
      /unknown field 'eyeHeight'/)
  })

  it('rejects a zone whose id a collider already has', () => {
    const solids = [box('floor', [60, 1, 60], [0, -0.5, 0]), box('wall', [1, 10, 50], [0, 5, 0])]
    const p = partition({ solids, zones: [{
      id: 'wall.2', zone: 'z', tags: [], shape: { kind: 'cuboid', halfExtents: [1, 1, 1] },
      translation: [0, 1, 0], rotation: IDENTITY, enabled: true, sources: ['z'],
    }] })
    expect(() => buildManifest(p, { rapierVersion: RAPIER_VERSION, motion: MOTION }))
      .toThrow(/zones\[0\]\.id: 'wall\.2' is used twice/)
  })
})

describe('manifest hash', () => {
  const configs: Record<string, V0SceneConfig> = Object.fromEntries([
    ...mazes.map((m) => [m.name, readMaze(m)]),
    ['rotated', ROTATED],
    ['turned', TURNED],
  ])
  const job = { rapierVersion: RAPIER_VERSION, configs }
  let node: Record<string, ManifestResult>
  let bundle: WorkerBundle

  beforeAll(async () => {
    node = buildManifests(job)
    bundle = await buildWorkerBundle(new URL('./partition.worker.ts', import.meta.url))
  }, 120_000)

  afterAll(() => bundle?.remove())

  it('is SHA-256 of the canonical JSON, the same in every run (pinned values)', () => {
    expect(Object.fromEntries(Object.entries(node).map(([name, r]) => [name, r.hash]))).toEqual(HASHES)
    // a second build in this process
    expect(buildManifests(job)).toEqual(node)
    for (const result of Object.values(node)) expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores key order and whitespace, and changes with any value', () => {
    const manifest = manifestOf('Hallway04')
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
      }
      return value
    }
    const shuffled = JSON.parse(JSON.stringify(reversed(manifest), null, 2)) as ColliderManifest
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(manifest))
    expect(manifestHash(shuffled)).toBe(HASHES.Hallway04)
    expect(manifestJson(shuffled)).toBe(manifestJson(manifest))
    const moved = structuredClone(manifest)
    moved.colliders[1].translation[0] += 1e-9
    expect(manifestHash(moved)).not.toBe(HASHES.Hallway04)
    const otherRapier = { ...manifest, rapierVersion: '0.21.0' }
    expect(manifestHash(otherRapier)).not.toBe(HASHES.Hallway04)
  })

  it('is the same in a Vite worker bundle', async () => {
    expect(bundle.code()).not.toMatch(/\bimport\s*[{*"'`]|\bfrom\s*["'`]/) // nothing imported
    const worker = await bundle.run<WorkerAnswer>(job)
    expect(worker.manifests).toEqual(node)
    expect(worker.versions?.v8).toBe(process.versions.v8)
  }, 60_000)

  // Electron's own Node runs the V8 the renderer runs (Electron 44.7.0: Node 24.21.0, V8 15.2).
  // The binary is fetched by `npx --no install-electron`, which the javascript CI job does not run.
  const electronDir = path.join(REPO_ROOT, 'node_modules', 'electron')
  const electronFile = existsSync(path.join(electronDir, 'path.txt'))
    ? path.join(electronDir, 'dist', readFileSync(path.join(electronDir, 'path.txt'), 'utf8'))
    : null
  const electron = electronFile && existsSync(electronFile) ? electronFile : null

  it.skipIf(!electron)('is the same in Electron (the bundle in Electron as Node)', () => {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    const worker = bundle.runIn<WorkerAnswer>(electron!, env, job)
    expect(worker.versions?.electron).toBe('44.7.0')
    expect(worker.versions?.v8).not.toBe(process.versions.v8)
    expect(worker.manifests).toEqual(node)
  }, 60_000)
})
