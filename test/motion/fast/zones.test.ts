// ADR-0001 Validation 6, zones and gates (plan item MOT-04), on Rapier 0.14.0 with the hover mover
// through the motion core, on Hallway04 partitioned by the scene compiler (MOT-08) with zones and
// an invisible gate added: zones never block; enter and exit fire in the sample that carries the
// zone point across a boundary; a gate switched on at run time, with no world.step(), stops the
// agent at its analytic position. Also: teleports re-evaluate the zones (cause 'teleport', the new
// epoch), compound zones, the dispatch order, the stamps, switching zones at run time, the zone
// point's height, a fall into a zone, and why the scene check must warn about thin zones.
//
// With MOT-05b this is ADR-0001's caveat test (owner decision D28 i): no evidence session runs on
// the v1 motion path before both pass.
import { readFileSync } from 'node:fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { beforeAll, describe, expect, it } from 'vitest'
import { v0Solids } from '../../../src/compiler/physics/fromV0.ts'
import { buildManifest } from '../../../src/compiler/physics/manifest.ts'
import { partition } from '../../../src/compiler/physics/partition.ts'
import type { BoxSolid } from '../../../src/compiler/physics/partition.ts'
import { createMotionCore } from '../../../src/motion/core.ts'
import type {
  DeviceSample, MotionEvent, PoseRecord, ZoneEvent,
} from '../../../src/motion/core.ts'
import { instantiate } from '../../../src/motion/instantiate.ts'
import type { ColliderManifest, ManifestZone, Quat, Vec3 } from '../../../src/motion/manifest.ts'
import { createHoverMover, RADIUS, SKIN } from '../../../src/motion/mover.ts'
import { createZones, ZONE_POINT_HEIGHT } from '../../../src/motion/zones.ts'

/** The zone point's height above the feet, as ADR-0001 R1 and R3 give it. */
const POINT = 1.15

const IDENTITY: Quat = [0, 0, 0, 1]
const yaw = (degrees: number): Quat => {
  const t = (degrees * Math.PI) / 180
  return [0, Math.sin(t / 2), 0, Math.cos(t / 2)]
}

/** A box zone of full size `size` centred at `at`. */
const zone = (
  id: string, size: Vec3, at: Vec3, extra: Partial<ManifestZone> = {},
): ManifestZone => ({
  id, zone: id, tags: [], shape: { kind: 'cuboid', halfExtents: size.map((s) => s / 2) as Vec3 },
  translation: at, rotation: IDENTITY, enabled: true, sources: [id], ...extra,
})

/**
 * Hallway04 (public/mazes/Hallway04: floor x -20..20, z -100..100, walls at x = +-20.5 and
 * z = +-100.5) with the zones of ADR-0005's example at both ends and more zones along the way.
 * All but 'sides.c' are at least 8 deep along the hallway, more than one sample's displacement at
 * 141 units/s and 20 samples/s (7.05, ADR-0001 R1), so no run can cross them unseen.
 */
const ZONES: ManifestZone[] = [
  zone('endNorth', [40, 10, 30], [0, 5, 85]),
  zone('endSouth', [40, 10, 30], [0, 5, -85]),
  zone('middle', [40, 10, 10], [0, 5, -20]),
  // one compound zone: two flush boxes, and a third box apart
  { ...zone('sides', [40, 10, 6], [0, 5, -33]), id: 'sides.a' },
  { ...zone('sides', [40, 10, 6], [0, 5, -39]), id: 'sides.b' },
  { ...zone('sides', [40, 10, 4], [0, 5, -50]), id: 'sides.c' },
  // turned 30 degrees about +Y, beside the axis of the hallway
  zone('turned', [12, 10, 8], [5, 5, -60], { rotation: yaw(30) }),
  // only partly at the zone point's height: one ends just below it, one starts just above it,
  // and a thin one holds it
  zone('low', [40, POINT - 0.05, 8], [0, (POINT - 0.05) / 2, 30]),
  zone('high', [40, 2, 8], [0, POINT + 0.05 + 1, 40]),
  zone('point', [40, 0.1, 8], [0, POINT, 50]),
]

function hallway(extra: { solids?: BoxSolid[], zones?: ManifestZone[] } = {}): ColliderManifest {
  const config = JSON.parse(readFileSync(new URL(
    '../../../public/mazes/Hallway04/Hallway04.json', import.meta.url), 'utf8'))
  const { solids, motion } = v0Solids(config)
  const parts = partition({
    solids: [...solids, ...(extra.solids ?? [])], zones: extra.zones ?? ZONES,
  })
  return buildManifest(parts, { rapierVersion: RAPIER.version(), motion })
}

/** A core with the hover mover and the zones of `manifest`. */
function session(manifest: ColliderManifest, start: { x?: number, z?: number, yaw?: number } = {}) {
  const q = instantiate(RAPIER, manifest)
  let steps = 0
  const step = q.world.step.bind(q.world)
  q.world.step = (...args: Parameters<typeof step>) => {
    steps++
    return step(...args)
  }
  const mover = createHoverMover(RAPIER, q.world, {
    x: start.x ?? 0, z: start.z ?? 0,
    gravity: manifest.motion?.gravity, fall: manifest.motion?.fall,
  })
  const zones = createZones(RAPIER, q)
  const events: MotionEvent[] = []
  const core = createMotionCore({
    mover, zones, yaw: start.yaw ?? 0, onEvent: (e) => events.push(e),
  })
  const records: PoseRecord[] = []
  let seq = 0, t = 0
  /** `count` samples of d (a function of the sample's index) at `rate` samples/s. */
  const run = (count: number, rate: number, d: (i: number) => [number, number, number]) => {
    const dt = Math.round(1e6 / rate)
    for (let i = 0; i < count; i++) {
      t += dt
      const sample: DeviceSample = {
        seq: seq++, seq_source: 'device', t_dev_us: t, dt_us: dt, d: d(i),
      }
      records.push(core.apply(sample) as PoseRecord)
    }
    return records
  }
  return {
    q, mover, zones, core, events, records, run,
    steps: () => steps,
    free: () => q.world.free(),
  }
}

const zoneEvents = (events: MotionEvent[]) =>
  events.filter((e): e is ZoneEvent => e.type === 'zone')

// v rotated by the inverse of the unit quaternion q
function unrotate([qx, qy, qz, qw]: Quat, [vx, vy, vz]: Vec3): Vec3 {
  const [x, y, z, w] = [-qx, -qy, -qz, qw]
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/**
 * The zones whose boxes contain the zone point of a pose record, computed analytically, or null if
 * the point lies within 1e-4 of a face (Rapier works in single precision there).
 */
function analyticZones(r: PoseRecord, zones: ManifestZone[]): Set<string> | null {
  const p: Vec3 = [r.x, r.feetY + POINT, r.z]
  const inside = new Set<string>()
  for (const z of zones) {
    if (!z.enabled || z.shape.kind !== 'cuboid') continue
    const h = z.shape.halfExtents
    const local = unrotate(z.rotation, [p[0] - z.translation[0], p[1] - z.translation[1],
      p[2] - z.translation[2]])
    const margin = Math.max(...local.map((v, i) => Math.abs(v) - h[i]))
    if (Math.abs(margin) < 1e-4) return null
    if (margin < 0) inside.add(z.zone)
  }
  return inside
}

/**
 * Checks that the move-caused zone events of every sample are exactly the set difference of the
 * analytic memberships before and after it, exits first, each by id. A sample whose zone point
 * lies within 1e-4 of a face is not checked, and the membership the events give is taken after
 * it. Returns the numbers of samples checked and skipped.
 */
function expectCrossingEvents(s: ReturnType<typeof session>, zones: ManifestZone[]) {
  let before = new Set<string>()
  let checked = 0, skipped = 0
  for (const r of s.records) {
    const got = zoneEvents(s.events).filter((e) => e.seq === r.seq && e.cause === 'move')
      .map((e) => ({ zone: e.zone, edge: e.edge }))
    const after = analyticZones(r, zones)
    if (after === null) {
      skipped++
      before = new Set(before)
      for (const e of got) {
        if (e.edge === 'enter') before.add(e.zone)
        else before.delete(e.zone)
      }
      continue
    }
    const expected = [
      ...[...before].filter((z) => !after.has(z)).sort().map((zone) => ({ zone, edge: 'exit' })),
      ...[...after].filter((z) => !before.has(z)).sort().map((zone) => ({ zone, edge: 'enter' })),
    ]
    expect(got, `seq ${r.seq}`).toEqual(expected)
    before = after
    checked++
  }
  return { checked, skipped }
}

beforeAll(async () => {
  await RAPIER.init()
})

describe('ADR-0001 Validation 6 (zones and gates)', () => {
  it('runs on the pinned Rapier build, with the zone point at feet + 1.15', () => {
    expect(RAPIER.version()).toBe('0.14.0')
    expect(ZONE_POINT_HEIGHT).toBe(POINT)
  })

  it('zones never block: every pose equals the run without zones', () => {
    const withZones = hallway()
    const without = { ...withZones, zones: [] }
    for (const [speed, rate, turn] of [[30, 20, 0], [141, 20, 0.02], [100, 120, -0.01],
      [141, 250, 0.005], [60, 1000, 0]]) {
      const runs = [withZones, without].map((m) => {
        const s = session(m, { z: 95.37 })
        // down the hallway, weaving, and on into the far wall
        s.run(Math.ceil((205 / speed) * rate), rate,
          (i) => [speed / rate, 0, i % 40 < 20 ? turn : -turn])
        s.free()
        return s
      })
      const [a, b] = runs.map((s) => s.records)
      expect(a.length).toBe(b.length)
      a.forEach((r, i) => {
        for (const key of ['x', 'feetY', 'z', 'yaw', 'contact', 'airborne'] as const) {
          expect(Object.is(r[key], b[i][key]), `${speed}/${rate} seq ${r.seq} ${key}`).toBe(true)
        }
      })
      // the run passed through every zone on the way and reached the far end
      const crossed = new Set(zoneEvents(runs[0].events).map((e) => e.zone))
      for (const id of ['endNorth', 'endSouth', 'middle', 'sides', 'point']) {
        expect(crossed.has(id), id).toBe(true)
      }
      expect(a.at(-1)!.z).toBeLessThan(-99)
      expect(runs[0].events.filter((e) => e.type !== 'zone')).toEqual(runs[1].events)
    }
  })

  it('enter and exit fire in the sample that carries the zone point across the boundary', () => {
    const m = hallway()
    let checked = 0, skipped = 0
    const entered = new Set<string>()
    const runs: Array<[number, number]> = [[5, 20], [30, 20], [30, 120], [30, 250], [100, 20],
      [100, 120], [100, 250], [141, 20], [141, 120], [141, 250]]
    for (const [speed, rate] of runs) {
      for (const [phase, weave] of [[0.37, 0], [0.61, 0.3], [0.89, -0.2]]) {
        // down the hallway from the north end, straight or weaving: the heading swings by up to
        // `weave` rad with a period of 4 s, so the path crosses zone faces at changing angles
        const s = session(m, { z: 95 + phase, x: -3.3 })
        const heading = (i: number) => weave * Math.sin((2 * Math.PI * i) / (4 * rate))
        s.run(Math.ceil((200 / speed) * rate), rate, (i) =>
          [speed / rate, 0, heading(i + 1) - heading(i)])
        const counts = expectCrossingEvents(s, m.zones)
        checked += counts.checked
        skipped += counts.skipped
        for (const e of zoneEvents(s.events)) entered.add(e.zone)
        s.free()
      }
    }
    expect(checked).toBeGreaterThan(10_000)
    expect(skipped).toBeLessThan(5)
    // every zone at the zone point's height was crossed by some run, the turned one included
    expect([...entered].sort()).toEqual(['endNorth', 'endSouth', 'middle', 'point', 'sides',
      'turned'])
  })

  it("enters the south end in the sample v0.3's centre test |z| >= 70 first holds", () => {
    // experiments/hallway04_experiment.py:448 ends a trial on |z| >= 70 of the reported pose
    const m = hallway()
    for (const [speed, rate, phase] of [[30, 20, 0.11], [141, 20, 0.31], [100, 120, 0.53]]) {
      const s = session(m, { z: phase })
      s.run(Math.ceil((80 / speed) * rate), rate, () => [speed / rate, 0, 0])
      const first = s.records.find((r) => Math.abs(r.z) >= 70)!
      expect(zoneEvents(s.events).find((e) => e.zone === 'endSouth')).toMatchObject({
        seq: first.seq, edge: 'enter', cause: 'move',
      })
      s.free()
    }
  })

  it('finds a zone only at the zone point, feet + 1.15 on the agent axis', () => {
    const s = session(hallway(), { z: 60.37 })
    s.run(120, 120, () => [0.25, 0, 0]) // 30 units towards -Z, across z 50, 40 and 30
    const zones = new Set(zoneEvents(s.events).map((e) => e.zone))
    expect(zones).toEqual(new Set(['point'])) // 'low' ends 0.05 below the point, 'high' 0.05 above
    s.free()
  })

  it('treats a compound zone as one: no events between its flush boxes', () => {
    const s = session(hallway(), { z: -25.37 })
    s.run(240, 120, () => [0.125, 0, 0]) // z -25.4 to -55.4: boxes a and b, flush, then c
    const sides = zoneEvents(s.events).filter((e) => e.zone === 'sides').map((e) => e.edge)
    expect(sides).toEqual(['enter', 'exit', 'enter', 'exit'])
    expect(s.zones.ids).toEqual(['endNorth', 'endSouth', 'high', 'low', 'middle', 'point', 'sides',
      'turned'])
    s.free()
  })

  // An invisible gate across the hallway at z -50, 0.5 thick, open when the scene loads
  const GATE: BoxSolid = {
    id: 'gate', halfExtents: [20, 5, 0.25], translation: [0, 5, -50], rotation: IDENTITY,
    layer: 'agentBarrier', enabled: false,
  }
  const FACE = -50 + 0.25 // the side facing the agent, which comes from +Z
  // R4: a KCC call stops the cylinder at the skin, then one call of 0.01 steps off the face
  const ANALYTIC = FACE + RADIUS + SKIN + 0.01
  // Rapier's sweep time-of-impact error at 40-80 units (ADR-0001 R3)
  const TOI = 5e-3

  it('a gate switched on at run time stops the agent at its analytic position', () => {
    const m = hallway({ solids: [GATE], zones: [] })
    expect(m.colliders.filter((c) => c.sources[0] === 'gate')).toMatchObject([{ enabled: false }])
    const rests: number[] = []
    for (const speed of [30, 100, 141]) {
      for (const rate of [20, 120, 250]) {
        for (const heading of [0, 30, -45]) {
          const s = session(m, { z: -40.37, yaw: (heading * Math.PI) / 180 })
          const d = (): [number, number, number] => [speed / rate, 0, 0]
          s.run(Math.ceil((5 / speed) * rate), rate, d) // 5 units towards the open gate
          s.zones.setGateEnabled('gate', true)
          s.run(Math.ceil((10 / speed) * rate) + rate, rate, d) // into it, and on for 1 s
          for (const r of s.records) {
            // never deeper than the skin: Rapier's contacts may end within it, by the error of
            // its sweeps (ADR-0001 R3), never beyond the face
            expect(r.z - RADIUS - FACE, `seq ${r.seq}`).toBeGreaterThan(SKIN - TOI)
          }
          const rest = s.records.at(-1)!.z
          rests.push(rest)
          expect(Math.abs(rest - ANALYTIC)).toBeLessThan(TOI)
          // switched off again: the agent goes on to the far wall
          s.zones.setGateEnabled('gate', false)
          s.run(rate * Math.ceil(90 / speed), rate, d)
          expect(s.records.at(-1)!.z).toBeLessThan(-99)
          expect(s.steps()).toBe(0) // no world.step(): a switch refreshes the queries only
          expect(s.events.filter((e) => e.type === 'guard_undo')).toEqual([])
          s.free()
        }
      }
    }
    // the typical run ends exactly one step-off from the skin
    const sorted = [...rests].sort((a, b) => a - b)
    expect(Math.abs(sorted[sorted.length >> 1] - ANALYTIC)).toBeLessThan(1e-3)
  })

  it('a gate lets the agent through while it is off', () => {
    const s = session(hallway({ solids: [GATE], zones: [] }), { z: 0.37 })
    s.run(20, 20, () => [100 / 20, 0, 0]) // 100 units, through the gate's place to the far wall
    expect(s.records.at(-1)!.z).toBeLessThan(-99)
    s.core.teleport({ x: 0, z: 0.37, yaw: 0 })
    s.zones.setGateEnabled('gate', true)
    s.run(20, 20, () => [100 / 20, 0, 0])
    expect(Math.abs(s.records.at(-1)!.z - ANALYTIC)).toBeLessThan(TOI)
    expect(s.steps()).toBe(0)
    s.free()
  })
})

describe('teleports', () => {
  it('re-evaluate the zones: events follow the teleport, with cause teleport and the new epoch', () => {
    const s = session(hallway(), { z: -80.37 })
    s.run(1, 20, () => [0, 0, 0])
    expect(zoneEvents(s.events)).toEqual([{ type: 'zone', seq: 0, epoch: 0, t_dev_us: 50_000,
      zone: 'endSouth', edge: 'enter', cause: 'move' }])
    s.events.length = 0
    // out of the south end into the middle zone
    s.core.teleport({ x: 0, z: -20.37, yaw: Math.PI, cause: 'trial_end' })
    expect(s.events.map((e) => e.type)).toEqual(['teleport', 'zone', 'zone'])
    expect(s.events.slice(1)).toEqual([
      { type: 'zone', seq: 0, epoch: 1, t_dev_us: 50_000, zone: 'endSouth', edge: 'exit',
        cause: 'teleport' },
      { type: 'zone', seq: 0, epoch: 1, t_dev_us: 50_000, zone: 'middle', edge: 'enter',
        cause: 'teleport' },
    ])
    // the next sample does not report them again
    s.events.length = 0
    s.run(1, 20, () => [0.1, 0, 0])
    expect(zoneEvents(s.events)).toEqual([])
    expect(s.zones.inside).toEqual(['middle'])
    s.free()
  })

  it('before the first sample carry no seq and no device time', () => {
    const s = session(hallway(), { z: 0 })
    s.core.teleport({ x: 0, z: 85, epoch: 5 })
    expect(zoneEvents(s.events)).toEqual([{ type: 'zone', seq: null, epoch: 5, t_dev_us: null,
      zone: 'endNorth', edge: 'enter', cause: 'teleport' }])
    s.free()
  })

  it('cannot be started from an event handler while one is dispatched', () => {
    const s = session(hallway(), { z: -80.37 })
    s.run(1, 20, () => [0, 0, 0])
    let error: unknown
    const core = createMotionCore({
      mover: s.mover, zones: s.zones,
      onEvent: (e) => {
        if (e.type !== 'zone') return
        try {
          core.teleport({ x: 0, z: 0 })
        } catch (thrown) {
          error = thrown
        }
      },
    })
    core.teleport({ x: 0, z: 85 }) // exits endSouth, enters endNorth
    expect(String(error)).toMatch(/teleport\(\) called from an event handler during teleport\(\)/)
    s.free()
  })
})

describe('dispatch order and stamps', () => {
  it('exits before entries, each by zone id in character-code order, stamped with the sample', () => {
    // By character code (ADR-0005 F4) upper case comes first: 'Zeta' < 'alpha'. Around the start
    // (z 10.2) and the end (z -10.2) of one long sample, zones listed in no particular order
    const ids = ['m', 'Zeta', 'b1', 'alpha', 'B', 'a_2', 'Gamma', 'a10', 'beta', 'a2']
    const zones = ids.map((id, i) => zone(id, [40, 10, 4 + i / 10], [0, 5, i % 2 ? 10 : -10]))
    const s = session(hallway({ zones }), { z: 10.2 })
    s.run(1, 20, () => [0, 0, 0])
    s.core.setParams({ cmd_id: 7, apply_seq: 1 })
    s.run(1, 20, () => [20.4, 0, 0]) // one sample of 82 sub-steps, from z 10.2 to z -10.2
    const second = s.events.filter((e) => 'seq' in e && e.seq === 1)
    const exits = ids.filter((_, i) => i % 2).sort().map((id) => `exit ${id}`)
    const entries = ids.filter((_, i) => !(i % 2)).sort().map((id) => `enter ${id}`)
    expect(exits).toEqual(['exit Zeta', 'exit a10', 'exit a2', 'exit a_2', 'exit alpha'])
    expect(entries).toEqual(['enter B', 'enter Gamma', 'enter b1', 'enter beta', 'enter m'])
    expect(second.map((e) => (e.type === 'zone' ? `${e.edge} ${e.zone}` : e.type))).toEqual([
      ...exits, ...entries, 'params',
    ])
    for (const e of second) expect(e).toMatchObject({ seq: 1, epoch: 0, t_dev_us: 100_000 })
    s.free()
  })
})

describe('zones switched at run time', () => {
  it('take effect at the next sample, after a query refresh and no world.step()', () => {
    const s = session(hallway(), { z: -20.37 })
    s.run(1, 20, () => [0, 0, 0])
    expect(s.zones.inside).toEqual(['middle'])
    s.zones.setZoneEnabled('middle', false)
    s.run(1, 20, () => [0, 0, 0])
    s.zones.setZoneEnabled('middle', true)
    s.run(1, 20, () => [0, 0, 0])
    expect(zoneEvents(s.events).map((e) => [e.seq, e.edge, e.zone, e.cause])).toEqual([
      [0, 'enter', 'middle', 'move'], [1, 'exit', 'middle', 'move'], [2, 'enter', 'middle', 'move'],
    ])
    // a compound zone is switched as a whole
    s.zones.setZoneEnabled('sides', false)
    expect(['sides.a', 'sides.b', 'sides.c'].map((id) => s.q.colliders.get(id)!.isEnabled()))
      .toEqual([false, false, false])
    expect(s.steps()).toBe(0)
    s.free()
  })

  it('refuse unknown zones and objects, and a box merged with others', () => {
    const s = session(hallway())
    expect(() => s.zones.setZoneEnabled('nowhere', true)).toThrow(/no zone 'nowhere'/)
    expect(() => s.zones.setGateEnabled('nowhere', true)).toThrow(/no collider .* 'nowhere'/)
    expect(() => s.zones.setGateEnabled('frontBlueFloor', false))
      .toThrow(/'frontBlueFloor' is part of collider 'mainFloor.merged' with mainFloor, backBlueFloor/)
    // a wall split into pieces is switched as a whole
    s.zones.setGateEnabled('leftWall', false)
    expect([1, 2, 3, 4].map((k) => s.q.colliders.get(`leftWall.${k}`)!.isEnabled()))
      .toEqual([false, false, false, false])
    s.free()
  })
})

describe('falls', () => {
  it('carry the zone point with the feet: a zone below an open edge catches the fall', () => {
    // Hallway02 has no walls (public/mazes/Hallway02): the agent walks off its side
    const config = JSON.parse(readFileSync(new URL(
      '../../../public/mazes/Hallway02/Hallway02.json', import.meta.url), 'utf8'))
    const { solids, motion } = v0Solids(config)
    const below = zone('below', [200, 20, 300], [0, -30, 0]) // y -40 to -20
    const m = buildManifest(partition({ solids, zones: [below] }), {
      rapierVersion: RAPIER.version(), motion,
    })
    const s = session(m, { x: 15.37, z: 0, yaw: -Math.PI / 2 }) // facing +X, the edge at x 20
    s.run(60, 20, () => [1, 0, 0])
    const fall = s.events.find((e) => e.type === 'fall_start')!
    const enter = zoneEvents(s.events).find((e) => e.zone === 'below')!
    expect(fall).toBeDefined()
    expect(enter).toMatchObject({ edge: 'enter', cause: 'move' })
    expect(enter.seq).toBeGreaterThan(fall.seq)
    const at = s.records.find((r) => r.seq === enter.seq)!
    expect(at.airborne).toBe(true)
    expect(at.feetY + POINT).toBeLessThan(-20)
    const before = s.records.find((r) => r.seq === at.seq - 1)!
    expect(before.feetY + POINT).toBeGreaterThan(-20)
    s.free()
  })
})

describe('thin zones', () => {
  it('can be crossed without a sample inside them, which is why the scene check warns', () => {
    // One sample's displacement at 141 units/s and 20 samples/s is 7.05 (ADR-0001 R1)
    const across = (thickness: number) => {
      let missed = 0
      for (let k = 0; k < 20; k++) {
        const thin = zone('thin', [40, 10, thickness], [0, 5, -50])
        const s = session(hallway({ zones: [thin] }), { z: 0.37 + k * 0.3525 })
        s.run(10, 20, () => [7.05, 0, 0])
        if (!zoneEvents(s.events).length) missed++
        s.free()
      }
      return missed
    }
    expect(across(5)).toBeGreaterThan(0)
    expect(across(7.1)).toBe(0)
  })
})
