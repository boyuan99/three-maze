// The display simulation of the motion-core design (three-maze-notes proto/motion_core/harness.cjs
// and harness2.cjs, run_display_sweep.cjs, 2026-10-06), ported for the pose history's tests
// (src/motion/poseHistory.ts, plan item MOT-13): a scripted mouse's device samples, their arrival
// at the host, the display's frame callbacks, and the measures of the design's delay, lag and
// judder table. The generators, the arrival model, the frame schedule and the two measures are the
// prototype's, unchanged but for types and units; the samples go through the motion core
// (src/motion/core.ts) with a mover without collisions, as the prototype's open field did.
import { createFreeMover, createMotionCore } from '../../../src/motion/core.ts'
import type { PoseRecord } from '../../../src/motion/core.ts'
import { createPoseHistory } from '../../../src/motion/poseHistory.ts'
import type { DisplayMode, ShownPose } from '../../../src/motion/poseHistory.ts'

const K_LIN = 0.0349 // units per encoder count (hallway02_experiment.py:81)
const K_ROT = 0.05 // rad per raw theta unit (hallway02_experiment.py:291)

/** The prototype's generator (harness.cjs rng): deterministic numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The scripted mouse's body-frame kinematics: forward and left speed, units/s; yaw rate, rad/s. */
export interface Profile {
  vf: (t: number) => number
  vl: (t: number) => number
  w: (t: number) => number
}

// harness.cjs: running bouts (about 6 s run, 6 s rest), 15-45 units/s while running
const bouts = (t: number) => 0.5 * (1 + Math.tanh(4 * Math.sin(2 * Math.PI * t / 12)))
  * (30 + 15 * Math.sin(2 * Math.PI * 0.7 * t))

export const PROFILES: Record<'open' | 'straight', Profile> = {
  // harness.cjs 'open': the running bouts, turning all the time
  open: {
    vf: bouts,
    vl: (t) => 2 * Math.sin(2 * Math.PI * 0.23 * t),
    w: (t) => 0.6 * Math.sin(2 * Math.PI * 0.11 * t) + 0.4 * Math.sin(2 * Math.PI * 0.37 * t + 1),
  },
  // not in the prototype: the same speeds straight ahead, so that the true path never turns back
  straight: { vf: bouts, vl: () => 0, w: () => 0 },
}

export interface TraceSample {
  seq: number
  /** Device time at the end of the sample, s. */
  tDev: number
  dt: number
  /** [forward, left, dyaw]: whole encoder counts for the lengths, as a device reports them. */
  d: [number, number, number]
}

export interface Trace {
  samples: TraceSample[]
  /** Path length of the true motion at every ms. */
  pathMs: Float64Array
  rate: number
  seconds: number
}

/** harness.cjs makeTrace: the device samples of `seconds` of the profile at `rate` samples/s. */
export function makeTrace(rate: number, seconds: number, profile: Profile): Trace {
  const h = 1e-4, N = Math.round(seconds / h), T = 1 / rate
  let Sf = 0, Sl = 0, Sy = 0, Spath = 0, k = 0, cf0 = 0, cl0 = 0, y0 = 0
  const pathMs = new Float64Array(Math.round(seconds * 1000) + 1)
  const samples: TraceSample[] = []
  for (let i = 1; i <= N; i++) {
    const tm = (i - 0.5) * h
    const vf = profile.vf(tm), vl = profile.vl(tm), w = profile.w(tm)
    Sf += vf * h
    Sl += vl * h
    Sy += w * h
    Spath += Math.hypot(vf, vl) * h
    if (i % 10 === 0) pathMs[i / 10] = Spath
    if (i * h >= (k + 1) * T - 1e-9) {
      k++
      const cf = Math.floor(Sf / K_LIN), cl = Math.floor(Sl / K_LIN)
      const raw = [cl - cl0, cf - cf0, (Sy - y0) / K_ROT]
      samples.push({ seq: k, tDev: k * T, dt: T, d: [raw[1] * K_LIN, raw[0] * K_LIN, Sy - y0] })
      cf0 = cf
      cl0 = cl
      y0 = Sy
    }
  }
  return { samples, pathMs, rate, seconds }
}

/**
 * harness.cjs arrivalsProposed: arrival at the host, s: the device time plus USB (1 ms + up to
 * 0.25 ms), the reader thread's hand-off (0.14 ms) and the WebSocket (0.2 ms + up to 0.2 ms), in
 * order.
 */
export function arrivals(samples: TraceSample[], rnd: () => number): Float64Array {
  const out = new Float64Array(samples.length)
  for (let k = 0; k < samples.length; k++) {
    out[k] = Math.max(k ? out[k - 1] : 0,
      samples[k].tDev + 0.001 + rnd() * 0.00025 + 0.00014 + 0.0002 + rnd() * 0.0002)
  }
  return out
}

/** harness.cjs frameTimes: frame callbacks on a vsync grid of `hz`, s (no long frames). */
export function frameTimes(hz: number, seconds: number, rnd: () => number): Float64Array {
  const P = 1 / hz, out: number[] = []
  let t = rnd() * P
  while (t < seconds) {
    out.push(t)
    t += P
  }
  return Float64Array.from(out)
}

export interface DisplayRun {
  /** Shown pose per frame (null before the first record). */
  shown: Array<ShownPose | null>
  /** Shown x and z per frame (0 before the first record). */
  fx: Float64Array
  fz: Float64Array
  records: PoseRecord[]
  delayUs: number
}

/**
 * harness2.cjs runA2 with the pose history: every sample goes through the motion core when it
 * arrives, its pose record into the history; each frame shows history.at(frame time). A teleport
 * (`teleport`: before the sample with that index, to (x, z)) starts a new epoch.
 */
export function runDisplay(trace: Trace, arrivalS: Float64Array, framesS: Float64Array,
  mode: DisplayMode,
  opts: { delayUs?: number, teleport?: { before: number, x: number, z: number } } = {},
): DisplayRun {
  const periodUs = Math.round(1e6 / trace.rate)
  const core = createMotionCore({ mover: createFreeMover() })
  const history = createPoseHistory({ mode, samplePeriodUs: periodUs, delayUs: opts.delayUs })
  const S = trace.samples, F = framesS.length, records: PoseRecord[] = []
  const shown: Array<ShownPose | null> = new Array(F)
  const fx = new Float64Array(F), fz = new Float64Array(F)
  let k = 0
  const applyOne = (i: number) => {
    if (opts.teleport && opts.teleport.before === i) {
      core.teleport({ x: opts.teleport.x, z: opts.teleport.z })
    }
    const s = S[i]
    const record = core.apply({
      seq: s.seq, seq_source: 'device', t_dev_us: Math.round(s.tDev * 1e6),
      dt_us: Math.round(s.dt * 1e6), d: s.d,
    })
    if (!record) throw new Error(`sample ${s.seq} rejected`)
    records.push(record)
    history.push(record, arrivalS[i] * 1000)
  }
  for (let f = 0; f < F; f++) {
    const tf = framesS[f]
    while (k < S.length && arrivalS[k] <= tf) applyOne(k++)
    const p = history.at(tf * 1000)
    shown[f] = p
    fx[f] = p ? p.x : 0
    fz[f] = p ? p.z : 0
  }
  return { shown, fx, fz, records, delayUs: history.delayUs }
}

/**
 * harness.cjs fitGainLag: effective gain and lag. The displayed path length over a window W
 * (step-hold between frames) is fitted to g [s(t - tau) - s(t - tau - W)] of the true path on a
 * 1 ms grid; returns tau (ms) with the smallest residual, and g.
 */
export function fitGainLag(framesS: Float64Array, fx: Float64Array, fz: Float64Array, trace: Trace,
  { W = 0.1, t0 = 2, tauMaxMs = 250 } = {}): { tau: number, g: number } {
  const cum = new Float64Array(framesS.length)
  for (let i = 1; i < framesS.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(fx[i] - fx[i - 1], fz[i] - fz[i - 1])
  }
  const T1 = Math.floor(Math.min(trace.seconds, framesS[framesS.length - 1]) * 1000) - 1
  let fi = 0
  const svrAt = (tms: number) => {
    const t = tms / 1000
    while (fi + 1 < framesS.length && framesS[fi + 1] <= t) fi++
    return framesS[fi] <= t ? cum[fi] : 0
  }
  const grid: number[] = []
  for (let ms = Math.round(t0 * 1000); ms <= T1; ms++) grid.push(ms)
  const svr = grid.map((ms) => svrAt(ms))
  fi = 0
  const svrW = grid.map((ms) => svrAt(ms - W * 1000))
  const P = trace.pathMs, y = svr.map((v, i) => v - svrW[i])
  let best = { tau: 0, g: 0, res: Infinity }
  for (let tau = 0; tau <= tauMaxMs; tau += 1) {
    let sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < grid.length; i++) {
      const a = grid[i] - tau, b = a - W * 1000
      if (b < 0) continue
      const x = P[a] - P[b]
      sxy += x * y[i]
      sxx += x * x
      syy += y[i] * y[i]
    }
    const g = sxy / sxx, res = syy - g * sxy
    if (res < best.res) best = { tau, g, res }
  }
  return { tau: best.tau, g: best.g }
}

/**
 * harness2.cjs judder: RMS over frames of (shown path increment - true increment g [s(t - tau) -
 * s(t - tau - frame)]), as % of the mean true increment.
 */
export function judder(framesS: Float64Array, fx: Float64Array, fz: Float64Array, trace: Trace,
  g: number, tauMs: number, t0 = 2): number {
  const P = trace.pathMs, T1 = Math.min(trace.seconds, framesS[framesS.length - 1]) - 0.3
  let se = 0, sr = 0, n = 0
  for (let f = 1; f < framesS.length; f++) {
    if (framesS[f] < t0 || framesS[f] > T1) continue
    const a = Math.round(framesS[f - 1] * 1000 - tauMs), b = Math.round(framesS[f] * 1000 - tauMs)
    if (a < 0) continue
    const ref = g * (P[b] - P[a])
    const got = Math.hypot(fx[f] - fx[f - 1], fz[f] - fz[f - 1])
    se += (got - ref) ** 2
    sr += ref
    n++
  }
  return (100 * Math.sqrt(se / n)) / (sr / n)
}
