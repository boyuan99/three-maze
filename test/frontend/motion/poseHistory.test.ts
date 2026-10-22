// The pose history and its two display modes (src/motion/poseHistory.ts, plan item MOT-13): the
// latest record, or the records interpolated at device time = local time - devToLocal - D, never
// across an epoch and never backward. The first groups check the rules on hand-made records; the
// last runs the motion-core design's display simulation (./displaySim.ts) through the motion core
// and the history: synthetic 20, 250 and 1,000 Hz streams against 60 and 144 Hz frame clocks.
// Its lag and judder must stay within the ranges the design's simulation gave
// (three-maze-notes design/motion_core.json, 'Display from pose history'): regression bounds from
// simulation, not measurements.
import { describe, expect, it } from 'vitest'
import { createPoseHistory } from '../../../src/motion/poseHistory.ts'
import type {
  DisplayMode, HistoryPose, PoseHistoryOptions, ShownPose,
} from '../../../src/motion/poseHistory.ts'
import {
  arrivals, fitGainLag, frameTimes, judder, makeTrace, PROFILES, rng, runDisplay,
} from './displaySim.ts'
import type { Trace } from './displaySim.ts'

const T20 = 50_000 // µs: one sample period at 20 samples/s

/** A record of a straight run along -z at 1 unit per sample, sample k at device time k * T20. */
const rec = (seq: number, epoch = 0, over: Partial<HistoryPose> = {}): HistoryPose => ({
  seq, epoch, t_dev_us: seq * T20, x: 0, feetY: 0, z: -seq, yaw: 0, ...over,
})

const smooth = (options: Partial<PoseHistoryOptions> = {}) =>
  createPoseHistory({ mode: 'smooth', samplePeriodUs: T20, ...options })

describe('options and records', () => {
  it('takes D = T + 1 ms unless D is given, and reports the D in force for the session', () => {
    expect(smooth().delayUs).toBe(51_000)
    expect(createPoseHistory({ mode: 'smooth', samplePeriodUs: 4000 }).delayUs).toBe(5000)
    expect(smooth({ delayUs: 30_000 }).delayUs).toBe(30_000)
    expect(smooth({ delayUs: 0 }).delayUs).toBe(0)
    const latest = createPoseHistory({ mode: 'latest', samplePeriodUs: 1000 })
    expect([latest.mode, latest.samplePeriodUs, latest.delayUs]).toEqual(['latest', 1000, 2000])
  })

  it('has no default mode: the caller names one (paper data: the owner\'s decision D17)', () => {
    expect(() => createPoseHistory({ samplePeriodUs: T20 } as PoseHistoryOptions)).toThrow(/mode/)
    expect(() => createPoseHistory({ mode: 'auto' as DisplayMode, samplePeriodUs: T20 }))
      .toThrow(/mode/)
  })

  it('rejects options it cannot use', () => {
    for (const samplePeriodUs of [0, -1, 2.5, NaN, Infinity]) {
      expect(() => smooth({ samplePeriodUs })).toThrow(/samplePeriodUs/)
    }
    for (const delayUs of [-1, 0.5, NaN]) expect(() => smooth({ delayUs })).toThrow(/delayUs/)
    for (const capacity of [0, 1, 2.5]) expect(() => smooth({ capacity })).toThrow(/capacity/)
    for (const envelopeLeakPerS of [-0.1, NaN]) {
      expect(() => smooth({ envelopeLeakPerS })).toThrow(/envelopeLeakPerS/)
    }
  })

  it('rejects records out of order and values that are not finite', () => {
    const h = smooth()
    h.push(rec(2), 100)
    expect(() => h.push(rec(1), 101)).toThrow(/before the last one/)
    expect(() => h.push(rec(3, -1), 101)).toThrow(/epoch/)
    h.push(rec(3, 1), 150)
    expect(() => h.push(rec(4, 0), 200)).toThrow(/epoch/)
    expect(() => h.push(rec(5, 1, { x: NaN }), 250)).toThrow(/not finite/)
    expect(() => h.push(rec(5, 1), Infinity)).toThrow(/not finite/)
    expect(() => h.at(NaN)).toThrow(/finite/)
    // a record at the same device time as the last one is accepted (a teleport's pose)
    h.push(rec(3, 2, { x: 50 }), 160)
    expect(h.size).toBe(3)
  })

  it('shows nothing before the first record', () => {
    for (const mode of ['latest', 'smooth'] as const) {
      const h = createPoseHistory({ mode, samplePeriodUs: T20 })
      expect(h.at(0)).toBeNull()
      expect(h.devToLocalMs).toBeNull()
    }
  })
})

describe("mode 'latest'", () => {
  it('shows the newest record exactly, whatever the frame time', () => {
    const h = createPoseHistory({ mode: 'latest', samplePeriodUs: T20 })
    for (let k = 1; k <= 20; k++) {
      h.push(rec(k), k * 50 + 3)
      for (const frame of [k * 50 + 3, k * 50 + 20, k * 50 + 45]) {
        expect(h.at(frame)).toEqual({
          x: 0, feetY: 0, z: -k, yaw: 0, epoch: 0, t_dev_us: k * T20, seq_shown: k, seq_before: k,
          seq_after: null, alpha: 0,
        })
      }
    }
  })
})

describe("mode 'smooth'", () => {
  // records arrive 3 ms after their device time (local ms = device µs / 1000 + 3)
  const filled = (n: number, options: Partial<PoseHistoryOptions> = {}) => {
    const h = smooth(options)
    for (let k = 1; k <= n; k++) h.push(rec(k), k * 50 + 3)
    return h
  }

  it('interpolates at device time = local time - devToLocal - D', () => {
    const h = filled(10)
    expect(h.devToLocalMs).toBe(3)
    // local 333: device time 333 - 3 - 51 = 279 ms, 58 % of the way from record 5 to record 6
    const p = h.at(333) as ShownPose
    expect(p.t_dev_us).toBe(279_000)
    expect(p.alpha).toBeCloseTo(0.58, 12)
    expect(p.z).toBeCloseTo(-5.58, 12)
    expect([p.seq_shown, p.seq_before, p.seq_after, p.epoch]).toEqual([5, 5, 6, 0])
    // exactly at a record: that record, with weight 0 for the next
    expect(filled(10).at(304))
      .toMatchObject({ t_dev_us: 250_000, z: -5, seq_shown: 5, seq_after: 6, alpha: 0 })
  })

  it('uses the D it is given', () => {
    const h = filled(10, { delayUs: 30_000 })
    expect(h.at(333)).toMatchObject({ t_dev_us: 300_000, z: -6, seq_shown: 6, alpha: 0 })
  })

  it('never extrapolates: past the newest record it holds that record', () => {
    const h = filled(4)
    for (const frame of [254, 260, 400, 1e6]) {
      expect(h.at(frame))
        .toMatchObject({ z: -4, t_dev_us: 4 * T20, seq_shown: 4, seq_after: null, alpha: 0 })
    }
  })

  it('shows the oldest record it holds until the shown time reaches it', () => {
    const h = filled(4)
    expect(h.at(60)).toMatchObject({ z: -1, seq_shown: 1, alpha: 0 })
  })

  it('never shows an earlier device time than in the frame before', () => {
    const h = filled(10)
    const first = h.at(333) as ShownPose
    // a repeated or earlier frame time, or devToLocal rising, cannot move the view back
    for (const frame of [333, 320, 200]) expect(h.at(frame)).toEqual(first)
    const later = h.at(334) as ShownPose
    expect(later.t_dev_us).toBe(280_000)
  })

  it('never interpolates across an epoch: holds the old epoch, then jumps exactly', () => {
    const h = smooth()
    for (let k = 1; k <= 5; k++) h.push(rec(k), k * 50 + 3)
    // teleport after record 5: the new epoch starts at x = 100 with record 6
    for (let k = 6; k <= 9; k++) h.push(rec(k, 1, { x: 100 }), k * 50 + 3)
    // device time 260 ms is between record 5 (old epoch) and record 6 (new): record 5 held
    expect(h.at(314))
      .toMatchObject({ x: 0, z: -5, epoch: 0, seq_shown: 5, seq_after: null, alpha: 0 })
    expect(h.at(353)).toMatchObject({ x: 0, z: -5, epoch: 0, alpha: 0 })
    // device time 300 ms reached: record 6 exactly, then interpolation inside the new epoch
    expect(h.at(354))
      .toMatchObject({ x: 100, z: -6, epoch: 1, seq_shown: 6, seq_after: 7, alpha: 0 })
    expect(h.at(379)).toMatchObject({ x: 100, z: -6.5, epoch: 1, seq_shown: 6, seq_after: 7 })
  })

  it('jumps at the device time of a teleport record pushed between two samples', () => {
    // the render host may push the teleport's own pose at the device time of the last sample
    const h = smooth()
    for (let k = 1; k <= 5; k++) h.push(rec(k), k * 50 + 3)
    h.push(rec(5, 1, { x: 100, z: 0 }), 260)
    for (let k = 6; k <= 9; k++) h.push(rec(k, 1, { x: 100, z: -(k - 5) }), k * 50 + 3)
    expect(h.at(303)).toMatchObject({ x: 0, z: -4.98, epoch: 0 })
    expect(h.at(304))
      .toMatchObject({ x: 100, z: 0, epoch: 1, seq_shown: 5, seq_after: 6, alpha: 0 })
  })
})

describe('devToLocal, the lower envelope of local minus device time', () => {
  it('is the fastest delivery: transport jitter only adds to an offset', () => {
    const h = smooth()
    const delays = [7, 3.2, 9, 3.05, 4, 12, 3.4]
    delays.forEach((d, k) => h.push(rec(k + 1), (k + 1) * 50 + d))
    expect(h.devToLocalMs).toBeCloseTo(3.05 + 0.2 * (6 * 50 - 3 * 50 + 3.4 - 3.05) / 1000, 9)
    const pure = smooth({ envelopeLeakPerS: 0 })
    delays.forEach((d, k) => pure.push(rec(k + 1), (k + 1) * 50 + d))
    expect(pure.devToLocalMs).toBeCloseTo(3.05, 12)
  })

  it('follows a device clock 100 ppm slower than the local one, and a faster one at once', () => {
    for (const ppm of [100, -100]) {
      const h = smooth(), r = rng(11)
      let worst = 0
      for (let k = 1; k <= 20 * 600; k++) { // 10 min at 20 samples/s
        const tDevMs = k * 50, local = tDevMs * (1 + ppm * 1e-6) + 3 + r() * 0.5
        h.push(rec(k), local)
        // the true fastest offset now: 3 ms plus the drift so far
        const truth = 3 + tDevMs * ppm * 1e-6
        worst = Math.max(worst, Math.abs((h.devToLocalMs as number) - truth))
      }
      // within the jitter (0.5 ms) of the true offset all the time, never drifting away
      expect(worst).toBeLessThan(0.5)
    }
  })
})

describe('ring buffer', () => {
  // what a brute-force search over the newest `kept` records pushed shows at device time t
  function expected(all: HistoryPose[], kept: number, t: number) {
    const held = all.slice(-kept)
    const as = (r: HistoryPose) => ({ seq_shown: r.seq, t_dev_us: r.t_dev_us, alpha: 0, z: r.z })
    if (held[0].t_dev_us > t) return as(held[0])
    let ia = 0
    while (ia + 1 < held.length && held[ia + 1].t_dev_us <= t) ia++
    const a = held[ia], b = held[ia + 1]
    if (!b || b.epoch !== a.epoch) return as(a)
    const alpha = (t - a.t_dev_us) / (b.t_dev_us - a.t_dev_us)
    return { seq_shown: a.seq, t_dev_us: t, alpha, z: a.z + alpha * (b.z - a.z) }
  }

  it('keeps the newest records and finds the bracketing pair among them', () => {
    const r = rng(3), capacity = 64, all: HistoryPose[] = []
    const h = smooth({ capacity, delayUs: 0, envelopeLeakPerS: 0 })
    let t = 0, epoch = 0, seq = 0, shownT = -Infinity
    for (let i = 0; i < 1000; i++) {
      // irregular device times (some equal), epochs now and then, positions at random
      t += Math.floor(r() * 3) * 7000
      if (r() < 0.03) epoch++
      const p = rec(seq++, epoch, { t_dev_us: t, z: r() * 100 })
      all.push(p)
      h.push(p, t / 1000) // no transport delay and D = 0: the shown device time is the frame time
      const kept = Math.min(all.length, capacity)
      expect(h.size).toBe(kept)
      // a frame up to 3.5 ms behind the newest record; the shown time never decreases
      const q = t - Math.floor(r() * 2) * 3500
      shownT = Math.max(shownT, q)
      const s = h.at(q / 1000) as ShownPose, e = expected(all, kept, shownT)
      expect([s.seq_shown, s.t_dev_us]).toEqual([e.seq_shown, e.t_dev_us])
      expect(s.alpha).toBeCloseTo(e.alpha, 12)
      expect(s.z).toBeCloseTo(e.z, 9)
    }
    // the oldest records were overwritten
    expect(all.length).toBeGreaterThan(capacity)
  })
})

// ---- the design's display simulation ----

interface SimCell {
  rate: number
  hz: number
  mode: DisplayMode
  /** Whole ms (lag) and whole % (judder), as the design gave them; null: not given. */
  lag: [number, number] | null
  judder: [number, number] | null
}

// The design's statements (motion_core.json, modification 'Display from pose history', and
// direct answer 'Should the sensor stay at 20 Hz?'), smooth at D = T + 1 ms:
// - 20 Hz smooth: 56-61 ms, judder 5-6 %; 20 Hz latest: judder 198-341 %
// - 250 Hz smooth: 13-15 ms on a 60 Hz display, 8-10 ms on a 144 Hz display
// - 1,000 Hz latest: 5-12 ms with judder 6-15 %
const CELLS: SimCell[] = [
  { rate: 20, hz: 60, mode: 'smooth', lag: [56, 61], judder: [5, 6] },
  { rate: 20, hz: 144, mode: 'smooth', lag: [56, 61], judder: [5, 6] },
  { rate: 20, hz: 60, mode: 'latest', lag: null, judder: [198, 341] },
  { rate: 20, hz: 144, mode: 'latest', lag: null, judder: [198, 341] },
  { rate: 250, hz: 60, mode: 'smooth', lag: [13, 15], judder: null },
  { rate: 250, hz: 144, mode: 'smooth', lag: [8, 10], judder: null },
  { rate: 250, hz: 60, mode: 'latest', lag: null, judder: null },
  { rate: 250, hz: 144, mode: 'latest', lag: null, judder: null },
  { rate: 1000, hz: 60, mode: 'latest', lag: [5, 12], judder: [6, 15] },
  { rate: 1000, hz: 144, mode: 'latest', lag: [5, 12], judder: [6, 15] },
  { rate: 1000, hz: 60, mode: 'smooth', lag: null, judder: null },
  { rate: 1000, hz: 144, mode: 'smooth', lag: null, judder: null },
]

describe('the design\'s display simulation: 40 s of a scripted mouse, through the core', () => {
  const traces = new Map<number, { trace: Trace, arrivalS: Float64Array }>()
  const sim = (rate: number) => {
    let s = traces.get(rate)
    if (!s) {
      // the design's sweep: profile 'open', seeds 5 (arrivals) and 9 (frames)
      const trace = makeTrace(rate, 40, PROFILES.open)
      s = { trace, arrivalS: arrivals(trace.samples, rng(5)) }
      traces.set(rate, s)
    }
    return s
  }
  const measured = new Map<SimCell, { lag: number, judder: number, gain: number }>()
  const measure = (c: SimCell) => {
    let m = measured.get(c)
    if (!m) {
      const { trace, arrivalS } = sim(c.rate)
      const frames = frameTimes(c.hz, 40, rng(9))
      const run = runDisplay(trace, arrivalS, frames, c.mode)
      const fit = fitGainLag(frames, run.fx, run.fz, trace)
      const j = judder(frames, run.fx, run.fz, trace, fit.g, fit.tau)
      m = { lag: fit.tau, judder: j, gain: fit.g }
      measured.set(c, m)
    }
    return m
  }
  const label = (c: SimCell) => `${c.rate} Hz samples, ${c.hz} Hz frames, ${c.mode}`

  const cells = CELLS.map((c) => [label(c), c] as const)
  it.each(cells)('%s: lag and judder in the design\'s range', (_, c) => {
    const m = measure(c)
    if (c.lag) {
      expect(m.lag).toBeGreaterThanOrEqual(c.lag[0])
      expect(m.lag).toBeLessThanOrEqual(c.lag[1])
    }
    if (c.judder) {
      expect(Math.round(m.judder)).toBeGreaterThanOrEqual(c.judder[0])
      expect(Math.round(m.judder)).toBeLessThanOrEqual(c.judder[1])
    }
    // the shown path keeps the gain of 1 that the motion core gives the records
    expect(Math.abs(m.gain - 1)).toBeLessThan(0.005)
  })

  it('smooth judders less than latest at every rate and frame rate', () => {
    for (const rate of [20, 250, 1000]) {
      for (const hz of [60, 144]) {
        const cell = (mode: DisplayMode) =>
          CELLS.find((c) => c.rate === rate && c.hz === hz && c.mode === mode) as SimCell
        const s = cell('smooth'), l = cell('latest')
        expect(measure(s).judder).toBeLessThan(measure(l).judder)
      }
    }
  })

  it('never moves backward in mode smooth (the design\'s back-jump measure)', () => {
    for (const rate of [20, 250, 1000]) {
      for (const hz of [60, 144]) {
        const { trace, arrivalS } = sim(rate)
        const frames = frameTimes(hz, 40, rng(9))
        const { fx, fz, shown } = runDisplay(trace, arrivalS, frames, 'smooth')
        let back = 0, compared = 0
        for (let f = 2; f < frames.length; f++) {
          // component of this frame's step along the previous frame's step (run_extrap2.cjs)
          const px = fx[f - 1] - fx[f - 2], pz = fz[f - 1] - fz[f - 2], pl = Math.hypot(px, pz)
          if (pl < 1e-6) continue
          compared++
          if (((fx[f] - fx[f - 1]) * px + (fz[f] - fz[f - 1]) * pz) / pl < -1e-3) back++
          const [p0, p1] = [shown[f - 1], shown[f]] as ShownPose[]
          expect(p1.t_dev_us).toBeGreaterThanOrEqual(p0.t_dev_us)
        }
        expect(compared).toBeGreaterThan(1000)
        expect([rate, hz, back]).toEqual([rate, hz, 0])
      }
    }
  })

  it('moves monotonically along a straight run with jittered arrivals and irregular frames', () => {
    const trace = makeTrace(20, 20, PROFILES.straight), r = rng(21)
    // arrivals 1-30 ms late (in order), frames at 60 Hz with misses and a 250 ms stall
    const arrivalS = new Float64Array(trace.samples.length)
    trace.samples.forEach((s, k) => {
      const late = r() < 0.1 ? 0.03 * r() : 0.002 * r()
      arrivalS[k] = Math.max(k ? arrivalS[k - 1] : 0, s.tDev + 0.001 + late)
    })
    const frames: number[] = []
    for (let t = 0; t < 20;) {
      frames.push(t)
      t += r() < 0.02 ? 0.25 : (1 + Math.floor(r() * 1.2)) / 60
    }
    const { shown } = runDisplay(trace, arrivalS, Float64Array.from(frames), 'smooth')
    let prev: ShownPose | null = null
    for (const p of shown) {
      if (!p) continue
      if (prev) {
        expect(p.z).toBeLessThanOrEqual(prev.z + 1e-9) // forward is -z: never back
        expect(p.t_dev_us).toBeGreaterThanOrEqual(prev.t_dev_us)
        expect(p.seq_shown).toBeGreaterThanOrEqual(prev.seq_shown)
      }
      prev = p
    }
  })

  it('jumps exactly at a teleport: no frame shows a pose between the two epochs', () => {
    for (const mode of ['smooth', 'latest'] as const) {
      const { trace, arrivalS } = sim(20)
      const frames = frameTimes(60, 40, rng(9))
      // a teleport before the 400th sample (device time 20 s) to x = 5000: a new epoch. The run
      // covers a few hundred units, so every pose shown is plainly on one side of the jump
      const teleport = { before: 399, x: 5000, z: 0 }
      const run = runDisplay(trace, arrivalS, frames, mode, { teleport })
      const first = run.records.find((rr) => rr.epoch === 1) as HistoryPose
      const last = run.records.filter((rr) => rr.epoch === 0).at(-1) as HistoryPose
      let jumps = 0, prevEpoch = 0, held = 0
      for (const p of run.shown) {
        if (!p) continue
        expect(p.epoch === 0 ? Math.abs(p.x) < 2500 : p.x > 2500).toBe(true)
        if (p.epoch !== prevEpoch) {
          jumps++
          // the first pose of the new epoch is its first record, or on that record's segment
          expect(p.seq_before).toBe(first.seq)
          expect(p.t_dev_us).toBeGreaterThanOrEqual(first.t_dev_us)
          prevEpoch = p.epoch
        } else if (p.epoch === 0 && p.seq_shown === last.seq) {
          // the old epoch's last record is held as it is: never moved toward the new epoch
          held++
          expect([p.x, p.z, p.alpha, p.seq_after]).toEqual([last.x, last.z, 0, null])
        }
      }
      expect([mode, jumps]).toEqual([mode, 1])
      expect(held).toBeGreaterThan(0)
    }
  })
})
