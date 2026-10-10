// instantiate(manifest) (src/motion/instantiate.ts): manifest round trip, ray casts against
// analytic geometry, the collision-group matrix, run-time enabling, rejection of invalid
// manifests, and the same collider set in Node and in a Vite-built worker bundle.
import { readFileSync } from 'node:fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createColliders, GROUPS, instantiate } from '../../../src/motion/instantiate.ts'
import { ManifestError, validateManifest } from '../../../src/motion/manifest.ts'
import type { ColliderManifest, ManifestCollider, Quat, Vec3 } from '../../../src/motion/manifest.ts'
import { GATE_RAY, RAYS, runChecks } from './instantiateChecks.ts'
import type { CheckResults, Hit } from './instantiateChecks.ts'
import { buildWorkerBundle } from './workerBundle.ts'
import type { WorkerBundle } from './workerBundle.ts'

const FIXTURE = readFileSync(new URL('./fixtures/colliders.manifest.json', import.meta.url), 'utf8')
const fixture = (): ColliderManifest => validateManifest(JSON.parse(FIXTURE))
const entry = (id: string) => fixture().colliders.find((c) => c.id === id) as ManifestCollider

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

// Distance along a ray to an oriented box (slab method), or null if it misses
function rayBox(origin: Vec3, dir: Vec3, box: ManifestCollider): number | null {
  if (box.shape.kind !== 'cuboid') throw new Error(`${box.id} is not a cuboid`)
  const [x, y, z, w] = box.rotation, inverse: Quat = [-x, -y, -z, w]
  const o = rotate(inverse, [0, 1, 2].map((i) => origin[i] - box.translation[i]) as Vec3)
  const d = rotate(inverse, dir)
  let near = -Infinity, far = Infinity
  for (let i = 0; i < 3; i++) {
    const h = box.shape.halfExtents[i]
    if (Math.abs(d[i]) < 1e-15) {
      if (Math.abs(o[i]) > h) return null
      continue
    }
    const t1 = (-h - o[i]) / d[i], t2 = (h - o[i]) / d[i]
    near = Math.max(near, Math.min(t1, t2))
    far = Math.min(far, Math.max(t1, t2))
  }
  return far >= Math.max(near, 0) ? Math.max(near, 0) : null
}

// The ramp rises at 20 degrees from y 0 at z 20 to RAMP_RISE at z 30
const RAMP_RISE = 10 * Math.tan((20 * Math.PI) / 180)
const rampY = (z: number) => (RAMP_RISE * (z - 20)) / 10
// The post is a hexagonal prism of circumradius 3 with a face towards +X
const POST_APOTHEM = 3 * Math.cos(Math.PI / 6)

const near = (hit: Hit | null, id: string, toi: number) => {
  expect(hit?.id).toBe(id)
  expect(hit?.toi).toBeCloseTo(toi, 4)
}

// ---- results in Node, and in a worker running the Vite bundle ----

let node: CheckResults
let bundle: WorkerBundle

beforeAll(async () => {
  await RAPIER.init()
  node = runChecks(RAPIER, fixture())
  // The worker bundle: Vite's production build of instantiate.worker.ts with Rapier's ES build
  // inlined, run in a worker thread (workerBundle.ts)
  bundle = await buildWorkerBundle(new URL('./instantiate.worker.ts', import.meta.url))
}, 120_000)

afterAll(() => bundle?.remove())

describe('instantiate', () => {
  it('records the version of the Rapier build that made the colliders', () => {
    expect(node.rapierVersion).toBe(RAPIER.version())
    expect(node.rapierVersion).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('round-trips the manifest: Rapier holds every entry as written, in single precision', () => {
    const m = fixture()
    const f = (values: number[]) => values.map(Math.fround)
    const sortedPoints = (values: number[]) => {
      const points: number[][] = []
      for (let i = 0; i < values.length; i += 3) points.push(values.slice(i, i + 3))
      return points.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    }
    const entries = [...m.colliders, ...m.zones]
    expect(node.colliders.map((c) => c.id)).toEqual(entries.map((e) => e.id))
    node.colliders.forEach((record, i) => {
      const e = entries[i], isZone = 'zone' in e
      expect(record.shape).toBe(e.shape.kind)
      if (e.shape.kind === 'cuboid') expect(record.values).toEqual(f(e.shape.halfExtents))
      if (e.shape.kind === 'trimesh') {
        expect(record.values).toEqual(f(e.shape.vertices))
        expect(record.indices).toEqual(e.shape.indices)
        const flags = e.shape.flags.reduce((all, flag) => all | RAPIER.TriMeshFlags[flag], 0)
        expect(flags).not.toBe(0)
        expect(record.flags).toBe(flags)
      }
      if (e.shape.kind === 'convexHull') {
        expect(sortedPoints(record.values)).toEqual(sortedPoints(f(e.shape.points)))
      }
      expect(record.translation).toEqual(f(e.translation))
      record.rotation.forEach((value, k) => expect(value).toBeCloseTo(e.rotation[k], 7))
      expect(record.groups).toBe(isZone ? GROUPS.zone : GROUPS[(e as ManifestCollider).layer])
      expect(record.sensor).toBe(isZone)
      expect(record.enabled).toBe(e.enabled)
    })
    // and the manifest itself survives JSON unchanged
    expect(validateManifest(JSON.parse(JSON.stringify(m)))).toEqual(m)
  })

  it('finds the analytic first hit of every ray, with the agent groups and EXCLUDE_SENSORS', () => {
    near(node.rays.floor, 'floor', 10)
    for (const key of ['wall30', 'wall30Oblique']) {
      const { origin, dir } = RAYS[key]
      near(node.rays[key], 'wall30', rayBox(origin, dir, entry('wall30')) as number)
    }
    expect(node.rays.wall30?.toi).toBeCloseTo(20 - 0.5 / Math.cos(Math.PI / 6), 4)
    near(node.rays.sideWall, 'sideWall.1', 29.5)
    near(node.rays.ramp, 'ramp', 10 - rampY(25))
    near(node.rays.rampCorner, 'ramp', 10 - rampY(22))
    near(node.rays.post, 'post', 20 - POST_APOTHEM)
  })

  it('enables and disables colliders at run time without a world step', () => {
    const [disabled, enabled, disabledAgain] = node.gate
    expect(disabled).toBeNull()
    near(enabled, 'gate', rayBox(GATE_RAY.origin, GATE_RAY.dir, entry('gate')) as number)
    expect(enabled?.toi).toBeCloseTo(29.75, 4)
    expect(disabledAgain).toBeNull()
    expect(node.voidZone).toEqual([[], ['void']])
  })

  it('finds zones, compound zones included, with the zone probe', () => {
    expect(node.probes).toEqual({ reward: ['reward'], endA: ['end'], endB: ['end'], open: [] })
  })
})

describe('collision groups', () => {
  // Rapier's rule: a and b interact if each belongs to a layer the other accepts
  const interacts = (a: number, b: number) => ((a >>> 16) & b) !== 0 && ((b >>> 16) & a) !== 0

  it('let the agent meet only world colliders and barriers, and the zone probe only zones', () => {
    const names = Object.keys(GROUPS) as Array<keyof typeof GROUPS>
    const partners = (a: keyof typeof GROUPS) => names.filter((b) => interacts(GROUPS[a], GROUPS[b]))
    const matrix = Object.fromEntries(names.map((a) => [a, partners(a)]))
    expect(matrix).toEqual({
      world: ['agent'],
      agentBarrier: ['agent'],
      zone: ['zoneProbe'],
      agent: ['world', 'agentBarrier'],
      zoneProbe: ['zone'],
    })
  })

  it('make the agent ignore zones, its own collider and probe colliders in real queries', () => {
    // A ray down through the reward zone, the agent's cylinder and a probe collider
    near(node.groups.agentRay, 'floor', 10)
    near(node.groups.unfilteredRay, 'zoneReward', 4) // the zone's top face at y 6
    expect(node.groups.pointWithAgentGroups).toEqual([])
    expect(node.groups.pointWithZoneProbe).toEqual(['zoneReward'])
    expect(node.groups.pointUnfiltered).toEqual(['agent', 'probe', 'zoneReward'])
  })
})

describe('instantiate in a worker bundle', () => {
  it('gives the same collider set and the same query results as in Node', async () => {
    expect(bundle.code()).not.toMatch(/from\s*["']@dimforge/) // Rapier is inside the bundle
    expect(await bundle.run<CheckResults>(fixture())).toEqual(node)
  }, 60_000)
})

describe('rejected manifests', () => {
  const broken = (change: (m: Record<string, any>) => void) => {
    const m = JSON.parse(FIXTURE)
    change(m)
    return m
  }
  const rejects = (m: unknown, path: string, message: RegExp) => {
    let error: unknown
    try {
      validateManifest(m)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(ManifestError)
    expect((error as ManifestError).path).toBe(path)
    expect((error as ManifestError).message).toMatch(message)
  }

  // [change to the fixture, path of the error below 'manifest.', message]
  type Case = [(m: Record<string, any>) => void, string, RegExp]
  const each = (cases: Case[]) => {
    for (const [change, path, message] of cases) rejects(broken(change), `manifest.${path}`, message)
  }

  it('rejects unknown shapes, including a trimesh zone', () => each([
    [(m) => { m.colliders[0].shape = { kind: 'ball', radius: 3 } }, 'colliders[0].shape.kind', /unknown shape 'ball'/],
    [(m) => { m.zones[0].shape = m.colliders[4].shape }, 'zones[0].shape.kind', /unknown shape 'trimesh'/],
  ]))

  it('rejects bodies that are not fixed', () => each([
    [(m) => { m.colliders[1].body = 'dynamic' }, 'colliders[1].body', /'dynamic' is not supported/],
    [(m) => { m.colliders[1].body = 'kinematicPositionBased' }, 'colliders[1].body', /not supported/],
  ]))

  it('rejects unknown fields, flags and layers, bad numbers and repeated ids', () => each([
    [(m) => { m.colliders[0].friction = 0.5 }, 'colliders[0]', /unknown field 'friction'/],
    [(m) => { m.colliders[4].shape.flags = ['ORIENTED'] }, 'colliders[4].shape.flags[0]', /unknown flag/],
    [(m) => { m.colliders[0].layer = 'prop' }, 'colliders[0].layer', /unknown layer 'prop'/],
    [(m) => { m.colliders[0].rotation = [0, 0, 0, 2] }, 'colliders[0].rotation', /unit quaternion/],
    [(m) => { m.colliders[0].translation[1] = null }, 'colliders[0].translation[1]', /finite/],
    [(m) => { m.colliders[0].shape.halfExtents[0] = 0 }, 'colliders[0].shape.halfExtents[0]', /greater than 0/],
    [(m) => { m.colliders[4].shape.indices[5] = 4 }, 'colliders[4].shape.indices[5]', /vertex index/],
    [(m) => { m.zones[1].id = 'floor' }, 'zones[1].id', /used twice/],
    [(m) => { m.colliders[0].sources = [] }, 'colliders[0].sources', /at least 1/],
    [(m) => { m.version = 2 }, 'version', /must be 1/],
  ]))

  it('rejects degenerate geometry, which Rapier would take without a clear error', () => each([
    [(m) => { m.colliders[5].shape.points = [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1] }, // flat
      'colliders[5].shape.points', /must span a volume/],
    [(m) => { m.colliders[5].shape.points = [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0] }, // on a line
      'colliders[5].shape.points', /must span a volume/],
    [(m) => { m.colliders[5].shape.points = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }, // one point
      'colliders[5].shape.points', /must span a volume/],
    [(m) => { // a triangle 0.0005 high
      m.colliders[4].shape.vertices = [-10, 0, 20, 10, 0, 20, 0, 0.0005, 20]
      m.colliders[4].shape.indices = [0, 1, 2]
    }, 'colliders[4].shape.indices', /triangle 0 has no area/],
  ]))

  it('adds no collider when the manifest is invalid', () => {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 })
    const dynamic = broken((m) => { m.colliders[6].body = 'dynamic' })
    expect(() => createColliders(RAPIER, world, dynamic as ColliderManifest)).toThrow(ManifestError)
    expect(() => instantiate(RAPIER, dynamic as ColliderManifest)).toThrow(ManifestError)
    let count = 0
    world.forEachCollider(() => { count++ })
    expect(count).toBe(0)
    world.free()
  })
})
