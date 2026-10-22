// Runs one Validation case on a MotionDriver and keeps the numbers every case reports: samples,
// time per sample, the mover's counters and the reference driver's deviations (./driver.ts).
import type { World } from '@dimforge/rapier3d-compat'
import { commanded } from './driver.ts'
import type { Agent, AgentStats, Deviations, MotionDriver, Start } from './driver.ts'
import { headingOf, rotating, swingPhase } from './streams.ts'
import type { Sample } from './streams.ts'

/** The agent's state after a sample. y is the height of the feet. */
export interface Pose {
  x: number
  y: number
  z: number
  yaw: number
  airborne: boolean
}

export interface Case {
  name: string
  /** Builds a fresh world for the case (floors in group 1, walls in group 2). */
  world: () => World
  start: Start
  samples: Sample[]
  /** Stops after the first sample whose pose satisfies it. */
  stop?: (p: Pose) => boolean
  /** Called before sample i, for example to teleport the agent. */
  before?: (i: number, agent: Agent) => void
}

export type Stream = 'archived' | 'rotating'

/**
 * A case's stream: the archived one as built, or its rotating variant (streams.ts) starting at
 * the heading of the case's first displacement. `index` sets the swing's phase.
 */
export function withStream(c: Case, stream: Stream, index: number): Case {
  if (stream === 'archived') return c
  const first = c.samples.find((s) => s.d[0] !== 0 || s.d[1] !== 0)
  const yaw0 = (c.start.yaw ?? 0) + (first ? headingOf(-first.d[1], -first.d[0]) : 0)
  const r = rotating(c.samples, yaw0, swingPhase(index))
  return { ...c, start: { ...c.start, yaw: r.yaw }, samples: r.samples }
}

/** What a measure sees after every sample. */
export interface Step {
  /** Sample number from 0. */
  i: number
  before: Pose
  after: Pose
  /** The sample, and the world-frame displacement the core commanded for it (driver.ts). */
  sample: Sample
  cmd: [number, number]
  agent: Agent
}

export interface Outcome {
  name: string
  samples: number
  final: Pose
  stats: AgentStats
  deviations: Deviations
  /** Time in the mover's apply(), µs. */
  us: number
  usMax: number
}

const pose = (a: Agent): Pose => ({ x: a.x, y: a.feetY, z: a.z, yaw: a.yaw, airborne: a.airborne })

/** Runs one case: a fresh world, one agent, every sample; `visit` measures after each one. */
export function runCase(driver: MotionDriver, c: Case, visit?: (step: Step) => void): Outcome {
  const world = c.world()
  const agent = driver.create(world, c.start)
  let us = 0n, usMax = 0n, n = 0, p = pose(agent)
  for (let i = 0; i < c.samples.length; i++) {
    if (c.before) c.before(i, agent)
    const before = c.before ? pose(agent) : p
    const s = c.samples[i]
    const cmd = commanded(agent.yaw, s.d)
    const t0 = process.hrtime.bigint()
    agent.apply(s.d, s.dtUs)
    const t = process.hrtime.bigint() - t0
    us += t
    if (t > usMax) usMax = t
    p = pose(agent)
    n++
    if (visit) visit({ i, before, after: p, sample: s, cmd, agent })
    if (c.stop && c.stop(p)) break
  }
  const out: Outcome = {
    name: c.name, samples: n, final: p, stats: { ...agent.stats },
    deviations: { ...agent.deviations },
    us: Number(us) / 1e3, usMax: Number(usMax) / 1e3,
  }
  agent.free()
  world.free()
  return out
}

/** Sums of the counters every group reports. */
export interface Totals {
  runs: number
  samples: number
  calls: number
  sub: number
  reverts: number
  airReverts: number
  recoveries: number
  recoverOk: number
  raySlides: number
  itCap: number
  resplit: number
  airborne: number
  us: number
  usMax: number
}

export const emptyTotals = (): Totals => ({
  runs: 0, samples: 0, calls: 0, sub: 0, reverts: 0, airReverts: 0, recoveries: 0, recoverOk: 0,
  raySlides: 0, itCap: 0, resplit: 0, airborne: 0, us: 0, usMax: 0,
})

export function addOutcome(t: Totals, o: Outcome): Totals {
  t.runs++
  t.samples += o.samples
  t.calls += o.stats.calls
  t.sub += o.stats.sub
  t.reverts += o.stats.reverts
  t.airReverts += o.stats.airReverts
  t.recoveries += o.stats.recoveries
  t.recoverOk += o.stats.recoverOk
  t.raySlides += o.stats.raySlides
  t.itCap += o.stats.itCap
  t.resplit += o.deviations.resplit
  t.airborne += o.deviations.airborne
  t.us += o.us
  t.usMax = Math.max(t.usMax, o.usMax)
  return t
}

/** Formats like the study's scripts (reference/lib/run.mjs f, lib/walls.mjs fmt). */
export const fmt = (v: number | null | undefined, d = 3): string => {
  if (v === undefined || v === null || Number.isNaN(v)) return '-'
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf'
  return (+v).toFixed(d)
}

/** Lets the test runner's worker breathe between runs of minutes of synchronous Rapier calls. */
export const tick = () => new Promise((resolve) => setImmediate(resolve))
