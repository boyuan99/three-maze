// The hover mover (src/motion/mover.ts) through the motion core, on worlds built by instantiate():
// eye height on flat floors, an open-edge fall of 60 s, fall 'none', fall and landing events, the
// guard's recovery and undo events, the contact flag, the Rapier version check, and the same
// results in Node and in a worker bundle. Its bit-for-bit equivalence with the vendored reference
// mover is tested in test/motion/fast/mover.equivalence.test.ts.
import { readFileSync } from 'node:fs'
import RAPIER from '@dimforge/rapier3d-compat'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMotionCore, eyePose } from '../../../src/motion/core.ts'
import type { MotionEvent, PoseRecord } from '../../../src/motion/core.ts'
import { instantiate } from '../../../src/motion/instantiate.ts'
import type { Rapier } from '../../../src/motion/instantiate.ts'
import {
  MANIFEST_FORMAT, MANIFEST_VERSION, validateManifest,
} from '../../../src/motion/manifest.ts'
import type { ColliderManifest, ManifestCollider, Vec3 } from '../../../src/motion/manifest.ts'
import { createHoverMover } from '../../../src/motion/mover.ts'
import type { HoverOptions } from '../../../src/motion/mover.ts'
import { slopeAngles } from '../../../src/motion/rapierCompat.ts'
import { lcg } from './coreScript.ts'
import { runMoverScript } from './moverScript.ts'
import type { MoverScriptResult } from './moverScript.ts'
import { buildWorkerBundle } from './workerBundle.ts'
import type { WorkerBundle } from './workerBundle.ts'

const cuboid = (id: string, halfExtents: Vec3, translation: Vec3): ManifestCollider => ({
  id, body: 'fixed', layer: 'world', shape: { kind: 'cuboid', halfExtents }, translation,
  rotation: [0, 0, 0, 1], enabled: true, sources: [id],
})
const manifest = (...colliders: ManifestCollider[]): ColliderManifest =>
  ({ format: MANIFEST_FORMAT, version: MANIFEST_VERSION, colliders, zones: [] })
/** A square floor of half size `half` whose top is at height `top`. */
const floor = (half: number, top = 0) => cuboid('floor', [half, 0.5, half], [0, top - 0.5, 0])

/** A core with the hover mover in a world built from `m`; samples go in with run(). */
function session(m: ColliderManifest, options: HoverOptions = {}) {
  const q = instantiate(RAPIER, m)
  const mover = createHoverMover(RAPIER, q.world, options)
  const events: MotionEvent[] = []
  const core = createMotionCore({ mover, onEvent: (e) => events.push(e) })
  const records: PoseRecord[] = []
  let seq = 0, t = 0
  /** count samples of [forward, left, dyaw] (a function of the sample index) at `rate`/s. */
  const run = (count: number, rate: number, d: (i: number) => [number, number, number]) => {
    const dt = Math.round(1e6 / rate)
    for (let i = 0; i < count; i++) {
      t += dt
      const r = core.apply({ seq: seq++, seq_source: 'device', t_dev_us: t, dt_us: dt, d: d(i) })
      if (r) records.push(r)
    }
    return records
  }
  return { q, mover, core, events, records, run, free: () => q.world.free() }
}

beforeAll(async () => {
  await RAPIER.init()
})

describe('hover mover', () => {
  it('keeps the feet on a flat floor and the eye exactly eyeHeight above them', () => {
    for (const [top, eyeHeight] of [[0, 3.7], [7.25, 3.7], [0, 2.5]]) {
      for (const rate of [20, 120, 250, 1000]) {
        const s = session(manifest(floor(1000, top)), { feetY: top, eyeHeight })
        const rnd = lcg(rate)
        const records = s.run(rate * 4, rate, () => [(rnd() * 141) / rate, 0, (rnd() - 0.5) * 0.1])
        for (const r of records) {
          // the ground ray works in single precision: the feet are on the floor to within its
          // resolution (measured 2026-10-09: 4.4e-8 at height 0, 2.4e-7 at height 7.25)
          expect(Math.abs(r.feetY - top)).toBeLessThan(1e-6)
          // and the eye is exactly eyeHeight above the feet, with no other offset
          expect(eyePose(r, s.mover.eyeHeight).y).toBe(r.feetY + eyeHeight)
        }
        expect(s.mover.top).toBe(eyeHeight + 0.45)
        expect(records.some((r) => r.airborne || r.contact)).toBe(false)
        s.free()
      }
    }
  })

  it('falls off an open edge and keeps falling for 60 s of device time without NaN', () => {
    for (const rate of [20, 1000]) {
      const s = session(manifest(floor(10)))
      const dt = Math.round(1e6 / rate) / 1e6
      // run off the floor towards -Z at 30 units/s, then keep running and turning for 60 s
      s.run(rate, rate, () => [30 / rate, 0, 0])
      const start = s.records.findIndex((r) => r.airborne)
      expect(start).toBeGreaterThan(0)
      s.run(60 * rate, rate, (i) => [30 / rate, 5 / rate, i % rate < rate / 4 ? 1 / rate : 0])
      const falling = s.records.slice(start)
      expect(falling.length).toBeGreaterThanOrEqual(60 * rate)
      for (const r of falling) {
        expect([r.x, r.feetY, r.z, r.yaw].every(Number.isFinite)).toBe(true)
        expect(r.airborne).toBe(true)
      }
      for (let i = 1; i < falling.length; i++) {
        expect(falling[i].feetY).toBeLessThan(falling[i - 1].feetY)
      }
      // gravity -981 per sample, vy += g dt then a sweep of vy dt (ADR-0001 R4): after n samples
      // the feet are g dt^2 n (n + 1) / 2 below the floor
      const n = falling.length, expected = (-981 * dt * dt * n * (n + 1)) / 2
      expect(Math.abs(falling.at(-1)!.feetY / expected - 1)).toBeLessThan(1e-4)
      expect(Math.hypot(falling.at(-1)!.x, falling.at(-1)!.z)).toBeGreaterThan(100) // input went on
      expect(s.events.filter((e) => e.type === 'fall_start')).toHaveLength(1)
      expect(s.events.filter((e) => e.type === 'land')).toHaveLength(0)
      s.free()
    }
  })

  it("stops at the edge with fall: 'none'", () => {
    const s = session(manifest(floor(10)), { fall: 'none' })
    const records = s.run(240, 120, () => [30 / 120, 0, 0])
    expect(records.some((r) => r.airborne)).toBe(false)
    const last = records.at(-1)!
    expect(last.z).toBeGreaterThanOrEqual(-10) // the agent's axis stays over the floor
    expect(last.z).toBeLessThan(-9.7)
    expect(last.contact).toBe(true)
    expect(s.mover.stats.rayNone).toBeGreaterThan(0)
    expect(s.events).toEqual([])
    // pushed against the edge at 45 degrees it does not slide along it, unlike along a wall
    s.run(60, 120, () => [30 / 120, 30 / 120, 0])
    expect([records.at(-1)!.x, records.at(-1)!.z]).toEqual([last.x, last.z])
    s.free()
  })

  it('teleports onto the floor within 0.3 of the given height', () => {
    const s = session(manifest(floor(50), cuboid('deck', [10, 3.5, 10], [20, 3.5, 0])))
    for (const [feetY, expected] of [[7, 7], [6.75, 7], [7.25, 7], [0, 0.301]]) {
      // at height 0 the ray starts inside the deck, so the feet end inside it (TeleportCommand)
      expect(s.core.teleport({ x: 20, z: 0, feetY }).feetY).toBeCloseTo(expected, 6)
    }
    expect(s.core.teleport({ x: 20, z: 0, feetY: 8 }).feetY).toBe(8) // no floor near 8
    expect(s.mover.airborne).toBe(false)
    s.free()
  })

  it('reports the fall and the landing with the samples that caused them', () => {
    // a 20-unit box on the floor (study t5 b); the agent starts on top and walks off
    const s = session(manifest(floor(600), cuboid('box', [5, 10, 5], [0, 10, 0])))
    s.core.teleport({ x: 0, z: 0, feetY: 20 })
    expect(s.mover.feetY).toBeCloseTo(20, 5)
    const records = s.run(500, 250, () => [30 / 250, 0, 0])
    const fall = s.events.find((e) => e.type === 'fall_start')!
    const land = s.events.find((e) => e.type === 'land')!
    const at = (seq: number) => records.find((r) => r.seq === seq)!
    const stamp = (seq: number) => ({ seq, epoch: 1, t_dev_us: at(seq).t_dev_us })
    expect(fall).toEqual({ type: 'fall_start', ...stamp(fall.seq!) })
    expect(land).toEqual({ type: 'land', ...stamp(land.seq!) })
    expect(at(fall.seq! - 1).airborne).toBe(false)
    expect(at(fall.seq!).airborne).toBe(true)
    expect(at(land.seq!)).toMatchObject({ airborne: false })
    expect(Math.abs(at(land.seq!).feetY)).toBeLessThan(1e-6)
    // free fall over 20 units takes sqrt(40 / 981) = 0.202 s, about 50 samples at 250/s
    expect(Math.abs(land.seq! - fall.seq! - Math.sqrt(40 / 981) * 250)).toBeLessThan(2)
    s.free()
  })

  it('reports guard recoveries and undos with their sample', () => {
    // An uncapped 1,200-unit wall 0.1 thick, hit at 20 degrees with 141 units/s at 120/s: a case
    // of the wall study t3 (S2) outside ADR-0001 R5.2 where the guard redoes and undoes moves
    const step = 141 / 120, a = (20 * Math.PI) / 180, dx = Math.sin(a) * step
    const dz = -Math.cos(a) * step, x = 9.48 - dx * (1 + 5 / 20) - 0.5
    const count = Math.ceil((11.1 - x) / dx) + 1
    const s = session(manifest(cuboid('floor', [110, 0.5, 660], [10, -0.5, 0]),
      cuboid('wall', [0.05, 5, 600], [10.05, 5, 0])), { x, z: (count * Math.abs(dz)) / 2 })
    const records = s.run(count, 120, () => [-dz, -dx, 0])
    const recoveries = s.events.filter((e) => e.type === 'guard_recovery')
    const undos = s.events.filter((e) => e.type === 'guard_undo')
    const st = s.mover.stats
    expect(st.reverts).toBeGreaterThan(0)
    expect(st.recoveries).toBeGreaterThan(0)
    expect(recoveries).toHaveLength(st.recoveries)
    expect(recoveries.filter((e) => e.ok)).toHaveLength(st.recoverOk)
    expect(undos).toHaveLength(st.reverts)
    for (const e of [...recoveries, ...undos]) {
      const r = records.find((rec) => rec.seq === e.seq)!
      expect([e.epoch, e.t_dev_us, r.contact]).toEqual([0, r.t_dev_us, true])
    }
    expect(undos.every((e) => e.kind === 'sub')).toBe(true)
    s.free()
  })

  it('reports contact in the samples that meet a wall, and not in open space', () => {
    const s = session(manifest(floor(60), cuboid('wall', [0.5, 5, 20], [10.5, 5, 0])))
    // sideways to the right (+X) at 30 units/s, at heading 0
    const records = s.run(240, 120, () => [0, -30 / 120, 0])
    const first = records.findIndex((r) => r.contact)
    expect(first).toBeGreaterThan(30) // 9.5 units of free running first, 0.25 per sample
    expect(records.slice(0, first).every((r) => !r.contact)).toBe(true)
    expect(records.slice(first).every((r) => r.contact)).toBe(true)
    // held 0.03 off the face at x = 10: the 0.02 skin and the 0.01 step-off (ADR-0001 R4)
    expect(records.at(-1)!.x).toBeCloseTo(9.47, 4)
    // the flag belongs to each sample: walking away from the wall clears it
    s.run(40, 120, () => [0, 30 / 120, 0])
    expect(records.slice(-40).every((r) => !r.contact)).toBe(true)
    s.free()
  })

  it('undoes airborne sweeps that end in overlap, and keeps their gravity in vy', () => {
    // A lid enabled at run time around the falling agent (outside ADR-0001 R5) makes every sweep
    // end inside it, so the guard undoes it (R6, kind 'air'). R6 lists vy among the values an undo
    // restores; the reference mover keeps the undone sample's gravity in vy, and so does the port
    // (bit-for-bit equal in test/motion/full/mover.rooms.test.ts), so after the lid the fall goes
    // on as if the agent had fallen freely through the undone samples
    const lid = { ...cuboid('lid', [1, 0.5, 1], [6.5, 19, 0]), enabled: false }
    const s = session(manifest(floor(150), cuboid('box', [5, 10, 5], [0, 10, 0]), lid))
    s.core.teleport({ x: 4, z: 0, feetY: 20 })
    s.run(12, 120, (i) => [0, i < 10 ? -0.25 : 0, 0]) // off the box's edge at x = 5 (+X)
    s.q.setEnabled('lid', true)
    s.run(4, 120, () => [0, 0, 0])
    s.q.setEnabled('lid', false)
    const records = s.run(4, 120, () => [0, 0, 0])
    const fall = s.events.find((e) => e.type === 'fall_start')!.seq!
    const undos = s.events.filter((e) => e.type === 'guard_undo' && e.kind === 'air')
    expect(undos.map((e) => [e.seq, e.epoch, e.t_dev_us]))
      .toEqual([12, 13, 14, 15].map((seq) => [seq, 1, records[seq].t_dev_us]))
    expect(s.mover.stats.airReverts).toBe(4)
    for (const seq of [12, 13, 14, 15]) {
      expect(records[seq]).toMatchObject({ feetY: records[11].feetY, airborne: true })
    }
    // vy at sample 16 holds the gravity of every sample since the fall began, undone ones too
    const dt = 8333e-6
    expect(records[15].feetY - records[16].feetY).toBeCloseTo(981 * dt * dt * (16 - fall + 1), 5)
    s.free()
  })

  it('takes its slope angles from rapierCompat and refuses an unvalidated Rapier build', () => {
    expect(slopeAngles('0.14.0')).toEqual({ climb: Math.PI / 6, slide: Math.PI / 6 })
    for (const version of ['0.21.0', '0.14.1', '0.14.0-rc']) {
      expect(() => slopeAngles(version)).toThrow(/MOT-16/)
    }
    const q = instantiate(RAPIER, manifest(floor(10)))
    const other = { ...RAPIER, version: () => '0.21.0' } as Rapier
    expect(() => createHoverMover(other, q.world)).toThrow(/validated on 0.14.0 only/)
    const count = () => {
      let n = 0
      q.world.forEachCollider(() => { n++ })
      return n
    }
    expect(count()).toBe(1) // the refused mover added nothing
    const mover = createHoverMover(RAPIER, q.world)
    expect(count()).toBe(2)
    mover.free()
    expect(count()).toBe(1)
    q.world.free()
  })
})

describe('the hover mover in a worker bundle', () => {
  const FIXTURE = readFileSync(new URL('./fixtures/colliders.manifest.json', import.meta.url),
    'utf8')
  let bundle: WorkerBundle
  beforeAll(async () => {
    bundle = await buildWorkerBundle(new URL('./mover.worker.ts', import.meta.url))
  }, 120_000)
  afterAll(() => bundle?.remove())

  it('gives the same records, events and counters as in Node', async () => {
    const fixture = validateManifest(JSON.parse(FIXTURE))
    const node = runMoverScript(RAPIER, fixture)
    // the session meets walls, takes the wall rule and teleports
    expect(node.records.some((r) => r?.contact)).toBe(true)
    expect(node.stats.incl).toBeGreaterThan(0)
    expect(node.events.map((e) => e.type)).toContain('teleport')
    expect(await bundle.run<MoverScriptResult>(fixture)).toEqual(node)
  }, 60_000)
})
