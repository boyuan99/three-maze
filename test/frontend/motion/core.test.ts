// The motion core (src/motion/core.ts) with movers that have no collisions: gain, heading, seq
// order, teleports and epochs, gain and freeze at a requested seq, the session maximum speed, the
// zone sensor's place in the event order, no wall clock or randomness in src/motion, and the same
// results in Node and in a worker bundle.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFreeMover, createMotionCore, eyePose, SUB_STEP } from '../../../src/motion/core.ts'
import type {
  DeviceSample, MotionCore, MotionCoreOptions, MotionEvent, Mover, MoverEvent, PoseRecord,
  ZoneChange, ZoneSensor,
} from '../../../src/motion/core.ts'
import { makeStream, runScript, scriptStream } from './coreScript.ts'
import type { ScriptResult } from './coreScript.ts'
import { buildWorkerBundle } from './workerBundle.ts'
import type { WorkerBundle } from './workerBundle.ts'

/** A free mover that also records every sub-step it is given. */
function recordingMover() {
  const free = createFreeMover()
  const steps: Array<{ dx: number, dz: number, n: number }> = []
  const mover: Mover = {
    get x() { return free.x },
    get feetY() { return free.feetY },
    get z() { return free.z },
    airborne: false,
    contact: false,
    subStep(dx, dz, n, emit) {
      steps.push({ dx, dz, n })
      free.subStep(dx, dz, n, emit)
    },
    endSample: () => {},
    place: (x, z, feetY) => free.place(x, z, feetY),
  }
  return { mover, steps }
}

function setup(options: Partial<MotionCoreOptions> = {}) {
  const events: MotionEvent[] = []
  const { mover, steps } = recordingMover()
  const core = createMotionCore({ mover, onEvent: (e) => events.push(e), ...options })
  return { core, events, steps }
}

const sample = (seq: number, d: [number, number, number] = [0.1, 0, 0], t = seq * 4000 + 4000) =>
  ({ seq, seq_source: 'device', t_dev_us: t, dt_us: 4000, d }) as DeviceSample

const applyAll = (core: ReturnType<typeof setup>['core'], samples: DeviceSample[]) =>
  samples.map((s) => core.apply(s))

describe('free-space gain', () => {
  it('is exactly 1: displacements made of binary fractions arrive unchanged', () => {
    // With one sub-step, yaw 0 and exactly representable values nothing is rounded, so the pose
    // moves by exactly the commanded displacement (forward is -Z, left is -X)
    const { core } = setup()
    let previous = core.apply(sample(0, [0, 0, 0]))!
    const moves = [[0.125, 0], [0.25, -0.0625], [-0.1875, 0.03125], [0, 0.25]]
    moves.forEach(([fwd, left], i) => {
      const r = core.apply(sample(i + 1, [fwd, left, 0]))!
      expect(r.x - previous.x).toBe(0 - left)
      expect(r.z - previous.z).toBe(0 - fwd)
      previous = r
    })
  })

  it('is 1 within 1e-12 on contact-free streams, rotating ones included', () => {
    for (const seed of [1, 2, 3]) {
      const samples = makeStream(5000, seed)
      const { core, steps } = setup({ yaw: seed })
      const records = applyAll(core, samples)
      // path length: the sub-steps against the commanded displacement
      let path = 0, commanded = 0
      for (const s of steps) path += Math.hypot(s.dx / s.n, s.dz / s.n)
      for (const s of samples) commanded += Math.hypot(s.d[0], s.d[1])
      expect(Math.abs(path / commanded - 1)).toBeLessThan(1e-12)
      expect(records.every((r) => r !== null)).toBe(true)
    }
  })

  it('is 1 within 1e-12 sample by sample when a sample does not rotate', () => {
    const samples = makeStream(2000, 4).map((s) => ({ ...s, d: [s.d[0], s.d[1], 0] as const }))
    const { core } = setup({ yaw: 0.7 })
    let moved = 0, commanded = 0, previous = { x: 0, z: 0 }
    for (const s of samples) {
      const r = core.apply(s)!
      moved += Math.hypot(r.x - previous.x, r.z - previous.z)
      commanded += Math.hypot(s.d[0], s.d[1])
      previous = r
    }
    expect(Math.abs(moved / commanded - 1)).toBeLessThan(1e-12)
  })

  it('follows the per-axis gain', () => {
    const { core, steps } = setup({ gain: { fwd: 0.5, left: 0.5 } })
    const samples = makeStream(1000, 5)
    applyAll(core, samples)
    let path = 0, commanded = 0
    for (const s of steps) path += Math.hypot(s.dx / s.n, s.dz / s.n)
    for (const s of samples) commanded += Math.hypot(s.d[0], s.d[1])
    expect(Math.abs(path / commanded - 0.5)).toBeLessThan(1e-12)
  })
})

describe('heading', () => {
  it('is yaw0 + sum(gain * dyaw) in sample order, exactly', () => {
    const samples = makeStream(3000, 6)
    const { core } = setup({ yaw: -1.25, gain: { yaw: 1.5 } })
    let expected = -1.25, g = 1.5
    samples.forEach((s, i) => {
      if (i === 1000) core.setParams({ cmd_id: 1, apply_seq: s.seq - 1, gain: { yaw: -0.5 } })
      if (i === 1000) g = -0.5 // applied after the previous sample, so it holds from this one
      const r = core.apply(s)!
      expected = expected + g * s.d[2]
      expect(r.yaw).toBe(expected)
    })
    expect(core.yaw).toBe(expected)
  })

  it('has one owner: the camera takes the motion yaw, which also turned every sub-step', () => {
    // v0.3 integrated the heading twice: the backend for motion (hallway04_experiment.py:288-289)
    // and the renderer, from the messages it kept, for the camera (PythonCustomScene.vue:159).
    // Here the pose record's yaw is the only heading: each sub-step moves along the heading at
    // its midpoint between the yaws of two records, and the camera uses the record's yaw.
    const samples = makeStream(2000, 8).map((s) => ({ ...s, d: [s.d[0], 0, s.d[2] * 20] as const }))
    const { core, steps } = setup({ yaw: 2 })
    const records = applyAll(core, samples) as PoseRecord[]
    let k = 0, yaw0 = 2
    records.forEach((r, i) => {
      const forward = samples[i].d[0], n = steps[k].n
      for (let j = 0; j < n; j++, k++) {
        const h = yaw0 + ((r.yaw - yaw0) * (j + 0.5)) / n
        const { dx, dz } = steps[k]
        // the sub-step runs along heading h: (-sin h, -cos h) times the forward displacement
        expect(Math.abs(dx - -forward * Math.sin(h))).toBeLessThan(1e-12)
        expect(Math.abs(dz - -forward * Math.cos(h))).toBeLessThan(1e-12)
      }
      const eye = eyePose(r, 3.7)
      expect(eye.yaw).toBe(r.yaw)
      expect(eye.y).toBe(r.feetY + 3.7)
      yaw0 = r.yaw
    })
    expect(k).toBe(steps.length)
    expect(core.yaw).toBe(records.at(-1)!.yaw)
  })

  it('points the camera along the motion of a sample without rotation', () => {
    const { core } = setup({ yaw: 0.9 })
    const before = core.apply(sample(0, [0, 0, 0]))!
    const after = core.apply(sample(1, [0.2, 0, 0]))!
    const eye = eyePose(after, 3.7), length = Math.hypot(after.x - before.x, after.z - before.z)
    expect(Math.abs((after.x - before.x) / length - -Math.sin(eye.yaw))).toBeLessThan(1e-12)
    expect(Math.abs((after.z - before.z) / length - -Math.cos(eye.yaw))).toBeLessThan(1e-12)
  })
})

describe('sub-steps', () => {
  it('number max(1, ceil(horizontal displacement / 0.25)) per sample', () => {
    const { core, steps } = setup()
    const lengths = [0, 0.1, 0.25, 0.25 + 1e-9, 0.5, 7.05, 50]
    lengths.forEach((length, i) => core.apply(sample(i, [length, 0, 0.1])))
    const perSample: number[] = []
    for (let j = 0; j < steps.length; j += steps[j].n) perSample.push(steps[j].n)
    expect(perSample).toEqual([1, 1, 1, 2, 2, 29, 200])
    expect(SUB_STEP).toBe(0.25)
    expect(core.stats).toMatchObject({ subSteps: steps.length, maxSubSteps: 200 })
  })
})

describe('seq order', () => {
  it('runs across the wrap at 2^32 without a gap', () => {
    const { core, events } = setup()
    const seqs = [4294967293, 4294967294, 4294967295, 0, 1, 2]
    const records = applyAll(core, seqs.map((s, i) => sample(s, [0.1, 0, 0], 4000 * (i + 1))))
    expect(records.map((r) => r?.seq)).toEqual(seqs)
    expect(events).toEqual([])
    expect(core.stats).toMatchObject({ samples: 6, seqGaps: 0, seqLost: 0, seqRegressions: 0 })
  })

  it('rejects duplicates and older samples without moving the agent', () => {
    const { core, events } = setup()
    core.apply(sample(4294967295))
    const at = core.apply(sample(0, [0.2, 0.1, 0.3], 9000))!
    // 2^31 or more ahead counts as older (device-v1.md rule H3)
    const older = [0, 4294967295, 4294967000, 2147483648, 2147483649]
    for (const seq of older) {
      expect(core.apply(sample(seq, [5, 5, 5], 10_000))).toBeNull()
    }
    expect(events).toEqual(older.map((seq) => ({
      type: 'seq_regression', seq, epoch: 0, t_dev_us: 10_000, last_seq: 0,
    })))
    const next = core.apply(sample(1, [0, 0, 0], 13_000))!
    expect([next.x, next.z, next.yaw]).toEqual([at.x, at.z, at.yaw])
    expect(core.stats).toMatchObject({ samples: 3, seqRegressions: 5 })
    // one less than 2^31 ahead is a gap
    expect(core.apply(sample(2147483648, [0, 0, 0], 14_000))).not.toBeNull()
    expect(events.at(-1)).toMatchObject({ type: 'seq_gap', prev_seq: 1, lost: 2147483646 })
  })

  it('counts and reports gaps, also across the wrap, and applies the sample after the gap', () => {
    const { core, events } = setup()
    for (const seq of [10, 13, 14, 4294967290]) core.apply(sample(seq))
    expect(core.stats).toMatchObject({ samples: 3, seqGaps: 1, seqLost: 2, seqRegressions: 1 })
    const late = setup()
    for (const seq of [4294967294, 2]) late.core.apply(sample(seq))
    expect(late.core.stats).toMatchObject({ samples: 2, seqGaps: 1, seqLost: 3 })
    expect(late.events).toEqual([{
      type: 'seq_gap', seq: 2, epoch: 0, t_dev_us: 12_000, prev_seq: 4294967294, lost: 3,
      seq_source: 'device',
    }])
    expect(events[0]).toMatchObject({ type: 'seq_gap', seq: 13, prev_seq: 10, lost: 2 })
  })

  // With seq_source 'host' the rig runtime numbered the samples, so a gap means samples lost
  // after it, not at the device
  it('reports the seq_source with host-numbered gaps, and refuses a change of source', () => {
    const { core, events } = setup()
    for (const seq of [0, 1, 5]) core.apply({ ...sample(seq), seq_source: 'host' })
    expect(core.stats.seqSource).toBe('host')
    expect(events).toEqual([
      expect.objectContaining({ type: 'seq_gap', lost: 3, seq_source: 'host' }),
    ])
    expect(() => core.apply(sample(6))).toThrow(/seq_source changed from 'host' to 'device'/)
  })

  it('throws on a malformed sample', () => {
    const { core } = setup()
    const bad: Array<Partial<DeviceSample> & Record<string, unknown>> = [
      { seq: 4294967296 }, { seq: -1 }, { seq: 1.5 }, { seq_source: 'adapter' as never },
      { t_dev_us: 1.5 }, { t_dev_us: -1 }, { dt_us: 0 }, { dt_us: 4000.5 },
      { d: [Number.NaN, 0, 0] }, { d: [0, Number.POSITIVE_INFINITY, 0] }, { d: [0, 0] as never },
    ]
    for (const change of bad) {
      expect(() => core.apply({ ...sample(0), ...change } as DeviceSample)).toThrow(TypeError)
    }
    expect(core.stats.samples).toBe(0)
  })
})

describe('teleport', () => {
  it('moves the agent between samples, starts an epoch and records after_seq', () => {
    const { core, events } = setup({ yaw: 1 })
    const first = core.teleport({ x: 3, z: 4, cause: 'start' })
    expect(first).toEqual({
      type: 'teleport', seq: null, epoch: 1, t_dev_us: null, after_seq: null, cmd_id: null,
      cause: 'start', x: 3, feetY: 0, z: 4, yaw: 1,
    })
    core.apply(sample(7))
    core.apply(sample(8))
    const second = core.teleport({
      x: -10, z: 20, feetY: 2.5, yaw: 0, cmd_id: 9, cause: 'trial_end',
    })
    expect(second).toMatchObject({ seq: 8, epoch: 2, t_dev_us: 36_000, after_seq: 8, cmd_id: 9 })
    expect(second).toMatchObject({ x: -10, feetY: 2.5, z: 20, yaw: 0 })
    const r = core.apply(sample(9, [0.1, 0, 0]))!
    expect(r).toMatchObject({ seq: 9, epoch: 2, x: -10, feetY: 2.5, yaw: 0 })
    expect(r.z).toBeCloseTo(19.9, 12)
    expect(events.filter((e) => e.type === 'teleport')).toEqual([first, second])
    expect(core.stats.teleports).toBe(2)
  })

  it('adopts the epoch a code task sends, and refuses one that is not later', () => {
    const { core } = setup({ epoch: 4 })
    expect(core.teleport({ x: 0, z: 0, epoch: 7 }).epoch).toBe(7)
    expect(() => core.teleport({ x: 0, z: 0, epoch: 7 })).toThrow(/not after the current one, 7/)
    expect(() => core.teleport({ x: 0, z: 0, epoch: 6 })).toThrow(TypeError)
    expect(core.teleport({ x: 0, z: 0 }).epoch).toBe(8)
    expect(core.apply(sample(0))!.epoch).toBe(8)
  })

  it('refuses a teleport or a sample from an event handler while a sample is applied', () => {
    // The mover reports fall_start before it commits the sub-step, so a teleport made there would
    // be overwritten by the rest of the sample while the epoch had already moved on
    let reaction: ((core: MotionCore) => void) | null = null
    const free = createFreeMover()
    const mover: Mover = {
      get x() { return free.x },
      get feetY() { return free.feetY },
      get z() { return free.z },
      airborne: false,
      contact: false,
      subStep: free.subStep,
      endSample: (_, emit) => emit({ type: 'fall_start' }),
      place: free.place,
    }
    const core: MotionCore = createMotionCore({
      mover, onEvent: (e) => { if (e.type === 'fall_start') reaction?.(core) },
    })
    reaction = (c) => c.teleport({ x: 5, z: 5 })
    expect(() => core.apply(sample(0))).toThrow(/teleport\(\) called from an event handler/)
    reaction = (c) => c.apply(sample(9))
    expect(() => core.apply(sample(1))).toThrow(/apply\(\) called from an event handler/)
    expect(core.epoch).toBe(0)
    // between samples both work
    reaction = null
    expect(core.teleport({ x: 5, z: 5 }).epoch).toBe(1)
    expect(core.apply(sample(2))).toMatchObject({ seq: 2, epoch: 1, x: 5 })
  })

  it('snaps the feet through the mover', () => {
    const placed: number[][] = []
    const mover: Mover = {
      ...createFreeMover(), place: (x, z, feetY) => placed.push([x, z, feetY]),
    }
    createMotionCore({ mover }).teleport({ x: 1, z: 2, feetY: 3 })
    expect(placed).toEqual([[1, 2, 3]])
  })
})

describe('gain and freeze', () => {
  it('take effect after the requested sample, and are acknowledged with that seq', () => {
    const { core, events } = setup()
    applyAll(core, [1000, 1001].map((s) => sample(s)))
    core.setParams({ cmd_id: 5, apply_seq: 1004, gain: { fwd: 2 } })
    expect(core.pending).toBe(1)
    const records = applyAll(core, [1002, 1003, 1004, 1005, 1006].map((s) => sample(s)))
    const moved = records.map((r, i) => (i ? records[i - 1]!.z - r!.z : 0))
    expect(moved.slice(1).map((m) => Math.round(m * 1e9) / 1e9)).toEqual([0.1, 0.1, 0.2, 0.2])
    expect(events).toEqual([{
      type: 'params', seq: 1004, epoch: 0, t_dev_us: 4_020_000, cmd_id: 5, apply_seq: 1004,
      gain: { fwd: 2, left: 1, yaw: 1 }, freeze: { fwd: false, left: false, yaw: false },
    }])
    expect(core.pending).toBe(0)
  })

  it('apply at once after the last sample when the requested one has passed', () => {
    const { core, events } = setup()
    applyAll(core, [1000, 1001].map((s) => sample(s)))
    core.setParams({ cmd_id: 6, apply_seq: 990, freeze: { yaw: true } })
    expect(core.freeze.yaw).toBe(true)
    expect(events).toEqual([expect.objectContaining({ type: 'params', seq: 1001, apply_seq: 990 })])
  })

  it('wait for the first sample at or past the requested one when it was lost', () => {
    const { core, events } = setup()
    core.setParams({ cmd_id: 7, apply_seq: 4294967295, gain: { left: 3 } }) // before any sample
    applyAll(core, [4294967293, 4294967294, 1].map((s) => sample(s)))
    expect(events.map((e) => [e.type, e.seq])).toEqual([['seq_gap', 1], ['params', 1]])
    expect(core.gain.left).toBe(3)
  })

  it('freeze discards the displacement of the frozen axes only, until unfrozen', () => {
    const { core } = setup()
    const d: [number, number, number] = [0.2, 0.1, 0.05]
    const a = core.apply(sample(0, d))!
    core.setParams({ cmd_id: 1, apply_seq: 0, freeze: { fwd: true, yaw: true } })
    const b = core.apply(sample(1, d))!
    // only the sideways displacement is left: 0.1 to the left at heading a.yaw
    expect(b.yaw).toBe(a.yaw)
    expect(Math.abs(b.x - a.x - -0.1 * Math.cos(a.yaw))).toBeLessThan(1e-12)
    expect(Math.abs(b.z - a.z - 0.1 * Math.sin(a.yaw))).toBeLessThan(1e-12)
    core.setParams({ cmd_id: 2, apply_seq: 1, freeze: { fwd: false, yaw: false } })
    const c = core.apply(sample(2, d))!
    expect(c.yaw).toBe(b.yaw + 0.05)
    expect(Math.hypot(c.x - b.x, c.z - b.z)).toBeCloseTo(Math.hypot(0.2, 0.1), 3)
    expect(core.stats).toMatchObject({ frozenSamples: 1, paramChanges: 2 })
  })

  it('reject invalid values when the command is given', () => {
    const { core } = setup()
    expect(() => core.setParams({ cmd_id: 1, apply_seq: 0, gain: { fwd: Number.NaN } }))
      .toThrow(/gain.fwd/)
    expect(() => core.setParams({ cmd_id: 1, apply_seq: 0, freeze: { yaw: 1 as never } }))
      .toThrow(/freeze.yaw/)
    expect(() => core.setParams({ cmd_id: 1, apply_seq: 2 ** 32 })).toThrow(/apply_seq/)
    expect(() => core.setParams({ cmd_id: 1, apply_seq: 0, gain: { up: 1 } as never }))
      .toThrow(/unknown axis 'up'/)
    expect(core.pending).toBe(0)
  })
})

describe('stats', () => {
  it('record the session maximum speed and do not clamp it (owner decision D10)', () => {
    const { core } = setup()
    core.apply({ ...sample(0, [0.3, 0.4, 0]), dt_us: 50_000 }) // 10 units/s
    const before = core.apply({ ...sample(1, [0, 0, 0]), dt_us: 50_000 })!
    const fast = core.apply({ ...sample(2, [30, -40, 0]), dt_us: 50_000 })! // 1,000 units/s
    core.apply({ ...sample(3, [1, 0, 0]), dt_us: 50_000 })
    expect(fast.z - before.z).toBeCloseTo(-30, 9)
    expect(fast.x - before.x).toBeCloseTo(40, 9)
    expect(core.stats).toMatchObject({ maxSpeed: 1000, maxSpeedSeq: 2, maxDisplacement: 50 })
  })

  it('take the maximum speed from the device displacement, before gain and freeze', () => {
    const { core } = setup({ gain: { fwd: 0.25, left: 0.25 } })
    core.apply({ ...sample(0, [3, 4, 0]), dt_us: 50_000 }) // 100 units/s
    core.setParams({ cmd_id: 1, apply_seq: 0, freeze: { fwd: true, left: true } })
    const frozen = core.apply({ ...sample(1, [6, 8, 0]), dt_us: 50_000 })! // 200 units/s
    // the agent moved by the gained first sample only
    expect(frozen.x).toBeCloseTo(-1, 12)
    expect(frozen.z).toBeCloseTo(-0.75, 12)
    expect(core.stats).toMatchObject({ maxSpeed: 200, maxSpeedSeq: 1, maxDisplacement: 10 })
  })

  it('stamp mover events with their sample', () => {
    const events: MotionEvent[] = []
    const fall: MoverEvent = { type: 'fall_start' }
    const mover: Mover = { ...createFreeMover(), endSample: (_, emit) => emit(fall) }
    const core = createMotionCore({ mover, epoch: 3, onEvent: (e) => events.push(e) })
    core.apply(sample(41))
    expect(events).toEqual([{ type: 'fall_start', seq: 41, epoch: 3, t_dev_us: 168_000 }])
  })
})

describe('zone sensor', () => {
  // A sensor that answers each update with the next scripted list of changes and records the
  // poses it is asked about (src/motion/zones.ts is the real one, test/motion/fast/zones.test.ts)
  function scripted(...answers: ZoneChange[][]) {
    const asked: Array<[number, number, number]> = []
    const sensor: ZoneSensor = {
      update(x, feetY, z) {
        asked.push([x, feetY, z])
        return answers.shift() ?? []
      },
    }
    return { sensor, asked }
  }
  const describeEvent = (e: MotionEvent) =>
    (e.type === 'zone' ? `${e.edge} ${e.zone} ${e.cause}` : e.type)

  it("is asked at the sample's final pose; its changes follow the mover's events", () => {
    const { sensor, asked } = scripted([], [{ zone: 'b', edge: 'exit' }, { zone: 'a', edge: 'enter' }])
    const events: MotionEvent[] = []
    const free = createFreeMover()
    const mover: Mover = {
      get x() { return free.x },
      get feetY() { return free.feetY },
      get z() { return free.z },
      airborne: false,
      contact: false,
      subStep: free.subStep,
      endSample: (_, emit) => emit({ type: 'fall_start' }),
      place: free.place,
    }
    const core = createMotionCore({ mover, zones: sensor, onEvent: (e) => events.push(e) })
    core.apply(sample(0, [0.5, 0, 0]))
    core.setParams({ cmd_id: 3, apply_seq: 2 })
    core.apply(sample(2, [0.5, 0, 0])) // after a gap
    expect(asked).toEqual([[0, 0, -0.5], [0, 0, -1]])
    // ADR-0002, Clock and order: the agent moves, then the zone exits and entries are dispatched
    // in the sensor's order; the parameter change takes effect after the sample
    expect(events.map(describeEvent)).toEqual([
      'fall_start', 'seq_gap', 'fall_start', 'exit b move', 'enter a move', 'params',
    ])
    expect(events.filter((e) => e.type === 'zone')).toEqual([
      { type: 'zone', seq: 2, epoch: 0, t_dev_us: 12_000, zone: 'b', edge: 'exit', cause: 'move' },
      { type: 'zone', seq: 2, epoch: 0, t_dev_us: 12_000, zone: 'a', edge: 'enter', cause: 'move' },
    ])
  })

  it('is asked after a teleport, whose stamp and new epoch its changes carry', () => {
    const { sensor, asked } = scripted(
      [{ zone: 'start', edge: 'enter' }], [], [{ zone: 'start', edge: 'exit' }],
    )
    const { core, events } = setup({ zones: sensor, epoch: 2 })
    core.teleport({ x: 1, z: 2, cause: 'session_start' }) // before the first sample
    core.apply(sample(5, [0, 0, 0]))
    expect(core.apply(sample(5, [0, 0, 0]))).toBeNull() // a duplicate: no motion, no zone update
    core.teleport({ x: 3, z: 4, epoch: 9 })
    expect(asked).toEqual([[1, 0, 2], [1, 0, 2], [3, 0, 4]])
    expect(events.map(describeEvent)).toEqual([
      'teleport', 'enter start teleport', 'seq_regression', 'teleport', 'exit start teleport',
    ])
    expect(events.filter((e) => e.type === 'zone')).toEqual([
      { type: 'zone', seq: null, epoch: 3, t_dev_us: null, zone: 'start', edge: 'enter',
        cause: 'teleport' },
      { type: 'zone', seq: 5, epoch: 9, t_dev_us: 24_000, zone: 'start', edge: 'exit',
        cause: 'teleport' },
    ])
  })

  it('refuses a teleport from an event handler while a teleport is dispatched', () => {
    const { sensor } = scripted([{ zone: 'a', edge: 'enter' }])
    let error: unknown
    const core: MotionCore = createMotionCore({
      mover: createFreeMover(), zones: sensor,
      onEvent: (e) => {
        if (e.type !== 'zone') return
        try {
          core.teleport({ x: 0, z: 0 })
        } catch (thrown) {
          error = thrown
        }
      },
    })
    core.teleport({ x: 5, z: 5 })
    expect(String(error)).toMatch(/teleport\(\) called from an event handler during teleport\(\)/)
    expect(core.epoch).toBe(1)
    expect(core.teleport({ x: 0, z: 0 }).epoch).toBe(2) // and works again afterwards
  })
})

describe('no wall clock or randomness in src/motion', () => {
  const FORBIDDEN = /\bDate\b|\bperformance\b|\bMath\s*\.\s*random\b|\bhrtime\b|\bgetRandomValues\b/
  // Comments may mention these words; code may not
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const scan = (text: string) => FORBIDDEN.exec(code(text))?.[0] ?? null

  it('finds them in code, not in comments', () => {
    expect(scan('const t = Date.now()')).toBe('Date')
    expect(scan('const t = performance.now()')).toBe('performance')
    expect(scan('const r = Math. random()')).toBe('Math. random')
    expect(scan('// Date.now() is not used\n/* nor performance.now() */ const a = 1')).toBeNull()
  })

  it('finds none in any source file', () => {
    const dir = fileURLToPath(new URL('../../../src/motion/', import.meta.url))
    const files = (readdirSync(dir, { recursive: true }) as string[])
      .filter((f) => /\.(ts|mts|js|mjs)$/.test(f))
    expect(files).toContain('core.ts')
    const found = files.map((f) => [f, scan(readFileSync(join(dir, f), 'utf8'))])
      .filter(([, word]) => word !== null)
    expect(found).toEqual([])
  })
})

describe('the motion core in a worker bundle', () => {
  let bundle: WorkerBundle
  beforeAll(async () => {
    bundle = await buildWorkerBundle(new URL('./core.worker.ts', import.meta.url))
  }, 120_000)
  afterAll(() => bundle?.remove())

  it('gives the same records, events and stats as in Node', async () => {
    const samples = scriptStream()
    const node = runScript(samples)
    // the script covers what it should
    expect(node.stats).toMatchObject({
      samples: 400, seqGaps: 1, seqLost: 2, seqRegressions: 1, teleports: 1, paramChanges: 3,
    })
    expect(node.events.map((e) => e.type)).toEqual(
      ['params', 'teleport', 'seq_gap', 'params', 'seq_regression', 'params'])
    expect(await bundle.run<ScriptResult>(samples)).toEqual(node)
  }, 60_000)
})
