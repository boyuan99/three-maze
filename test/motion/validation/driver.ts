// The mover interface of ADR-0001's Validation suite (Validation 1-5,
// test/motion/full/validation.*; plan items MOT-05a and MOT-05b). Every case drives an Agent with
// device samples, as the motion core receives them (docs/protocol/device-v1.md section 7.2): a
// body-frame displacement d = [forward, left, dyaw] and its length in whole µs. A MotionDriver
// puts such an agent into a Rapier world. Two drivers:
//
// - referenceDriver: the vendored reference mover (reference/lib/hover.mjs, U+RS at top 4.15, the
//   mover behind ADR-0001's evidence), fed the way the motion core (src/motion/core.ts) feeds its
//   mover. The core turns each sub-step of a sample by the heading at the sub-step's midpoint
//   (ADR-0001 R1); the reference takes one world-frame displacement per call and splits it into
//   sub-steps of equal direction itself. So a sample without rotation goes to the reference as one
//   call with the sample's displacement turned to the current heading, exactly as the study drove
//   it, and a sample with rotation goes as one call per sub-step, each with the world displacement
//   that sub-step gets from the core, dt only on the last call (MOT-05a: "fed to the reference as
//   the per-sub-step world displacements the motion core will produce").
// - coreDriver: the shipped configuration, the TypeScript hover mover (src/motion/mover.ts) through
//   the motion core. MOT-05b runs the suite on it.
//
// The reference driver can depart from the core in two ways, both counted in `deviations`:
// - resplit: the reference computes its own sub-step count from the world-frame displacement, the
//   core from the body-frame one. Turning the displacement can move its length by an ulp across a
//   multiple of 0.25 (for example 30 units/s at 120 samples/s is 0.25 per sample), and the
//   reference then makes two half sub-steps where the core makes one (or the reverse). The
//   rotating streams shorten such samples by 1e-8 of their length (streams.ts), so it does not
//   happen in the suite, and every Validation test asserts that.
// - airborne: every call of the reference ends with the airborne sweep while the agent is
//   airborne, the core sweeps once per sample. The calls before a sample's last sub-step pass
//   dt = 0, so such a sweep moves nothing, but its landing probe can land an agent whose feet are
//   up to 0.301 below a floor it has just moved over; such landings and the guard undos of such
//   sweeps are counted (on rotating streams only: an archived sample is one call). Their KCC calls
//   also count in `calls`.
// Where both counts stay zero, the reference driver gives the motion core's sub-steps exactly, and
// the reference's poses equal those of the TypeScript mover through the core bit for bit
// (test/motion/fast/validation.driver.test.ts).
import type { World } from '@dimforge/rapier3d-compat'
import { R } from '../reference/lib/rapier.mjs'
import { makeHover } from '../reference/lib/hover.mjs'
import { SUB_STEP, createMotionCore } from '../../../src/motion/core.ts'
import { createHoverMover } from '../../../src/motion/mover.ts'

export { R }

/** A device sample's displacement: [forward, left, dyaw] in the body frame (core.ts). */
export type Body = readonly [forward: number, left: number, dyaw: number]

/** The mover's counters that the cases read (named as in the reference's `st`). */
export interface AgentStats {
  /** Horizontal sub-steps and KCC calls (horizontal and airborne). */
  sub: number
  calls: number
  /** Wall-rule contacts, and sub-steps whose remainder was dropped after the sixth call. */
  incl: number
  itCap: number
  /** Steep-floor slides (ADR-0001 R4). */
  raySlides: number
  /** Guard recoveries, those that came out clear, and guard undos (ADR-0001 R6). */
  recoveries: number
  recoverOk: number
  reverts: number
  /** Guard hits with no wall found, and the source of each recovery wall normal (R6). */
  recoverNoWall: number
  recoverByContact: number
  recoverByProjection: number
  recoverByDirection: number
  airReverts: number
  /** Airborne sweeps that met a wall face. */
  airIncl: number
  fallStarts: number
  lands: number
}

/** Where the reference driver did not give the motion core's sub-steps (see the file header). */
export interface Deviations {
  resplit: number
  airborne: number
}

export interface Agent {
  /** Applies one device sample: displacement d, lasting dtUs µs. */
  apply(d: Body, dtUs: number): void
  /** Teleport between samples: feet at (x, z) on the floor near feetY; the heading is kept. */
  place(x: number, z: number, feetY: number): void
  readonly x: number
  readonly feetY: number
  readonly z: number
  /** Heading, rad (yaw 0 looks down -Z; ADR-0001 R1). */
  readonly yaw: number
  readonly airborne: boolean
  /** Top of the agent's cylinder above the feet: eyeHeight + 0.45. */
  readonly top: number
  readonly stats: Readonly<AgentStats>
  readonly deviations: Readonly<Deviations>
  free(): void
}

export interface Start {
  x: number
  z: number
  /** Height near which the floor is looked for (ADR-0001 R4 teleport); default 0. */
  feetY?: number
  /** Heading at the start, rad; default 0. */
  yaw?: number
}

export interface MotionDriver {
  readonly name: string
  /** Adds an agent to `world` (floors in group 1, walls in group 2, as the study's builders). */
  create(world: World, start: Start): Agent
}

/** The eye height of every case (ADR-0001 R3: the only certified eye height). */
export const EYE_HEIGHT = 3.7

const ZERO_DEVIATIONS: Readonly<Deviations> = Object.freeze({ resplit: 0, airborne: 0 })

/**
 * The world-frame displacement of one sub-step, as the motion core computes it: the whole
 * sample's displacement turned to the heading at the sub-step's midpoint (core.ts applySample).
 */
export function subStepDisplacement(yaw0: number, d: Body, i: number, n: number): [number, number] {
  const [f, l, dyaw] = d
  const h = yaw0 + (dyaw * (i + 0.5)) / n
  const sin = Math.sin(h), cos = Math.cos(h)
  return [-f * sin - l * cos, -f * cos + l * sin]
}

/** The motion core's sub-step count of a sample (ADR-0001 R3). */
export const subSteps = (d: Body) => Math.max(1, Math.ceil(Math.hypot(d[0], d[1]) / SUB_STEP))

/**
 * The world-frame displacement the core commands for a sample at heading yaw0: for a sample
 * without rotation the turned displacement itself (what the study's scripts summed), else the sum
 * of its sub-steps' displacements.
 */
export function commanded(yaw0: number, d: Body): [number, number] {
  if (d[2] === 0) return subStepDisplacement(yaw0, d, 0, 1)
  const n = subSteps(d)
  let cx = 0, cz = 0
  for (let i = 0; i < n; i++) {
    const [dx, dz] = subStepDisplacement(yaw0, d, i, n)
    cx += dx / n
    cz += dz / n
  }
  return [cx, cz]
}

/** The adopted mover: U+RS with the cylinder top at eyeHeight + 0.45 (ADR-0001 R3, R4, R6). */
export const REFERENCE_OPTIONS = { fix: true, top: EYE_HEIGHT + 0.45 }

/** The vendored reference mover, driven per sample or per sub-step as the core would. */
export const referenceDriver: MotionDriver = {
  name: 'reference (hover.mjs U+RS, top 4.15)',
  create(world, start) {
    const m = makeHover(R, world, start.x, start.z, REFERENCE_OPTIONS)
    if (start.feetY !== undefined && start.feetY !== 0) m.place(start.x, start.z, start.feetY)
    let yaw = start.yaw ?? 0
    const deviations: Deviations = { resplit: 0, airborne: 0 }
    const st = m.st as AgentStats
    // one call of the reference; `expect` sub-steps, the airborne sweep only if `last`
    const call = (dx: number, dz: number, dt: number, expect: number, last: boolean) => {
      const sub0 = st.sub, lands0 = st.lands, air0 = st.airReverts
      m.move(dx, dz, dt)
      if (st.sub - sub0 !== expect) deviations.resplit++
      if (!last && (st.lands !== lands0 || st.airReverts !== air0)) deviations.airborne++
    }
    return {
      apply(d, dtUs) {
        const n = subSteps(d), dt = dtUs / 1e6
        if (d[2] === 0) {
          // n equal sub-steps: the reference splits the turned displacement itself
          const [dx, dz] = subStepDisplacement(yaw, d, 0, 1)
          call(dx, dz, dt, n, true)
        } else {
          for (let i = 0; i < n; i++) {
            const [dx, dz] = subStepDisplacement(yaw, d, i, n)
            call(dx / n, dz / n, i === n - 1 ? dt : 0, 1, i === n - 1)
          }
        }
        yaw += d[2]
      },
      place(x, z, feetY) { m.place(x, z, feetY) },
      get x() { return m.pos().x },
      get feetY() { return m.feet() },
      get z() { return m.pos().z },
      get yaw() { return yaw },
      get airborne() { return m.airborne },
      top: m.top,
      stats: st,
      deviations,
      free() { world.removeCollider(m.col, false) },
    }
  },
}

/**
 * The shipped configuration: the TypeScript hover mover (eye height 3.7) through the motion core.
 * Device time starts at 0; seq counts from 0.
 */
export const coreDriver: MotionDriver = {
  name: 'TypeScript mover through the motion core (src/motion)',
  create(world, start) {
    const mover = createHoverMover(R, world, {
      x: start.x, z: start.z, feetY: start.feetY ?? 0, eyeHeight: EYE_HEIGHT,
    })
    const core = createMotionCore({ mover, yaw: start.yaw ?? 0 })
    let seq = 0, tUs = 0
    return {
      apply(d, dtUs) {
        tUs += dtUs
        core.apply({ seq: seq++, seq_source: 'device', t_dev_us: tUs, dt_us: dtUs, d })
      },
      place(x, z, feetY) { core.teleport({ x, z, feetY }) },
      get x() { return mover.x },
      get feetY() { return mover.feetY },
      get z() { return mover.z },
      get yaw() { return core.yaw },
      get airborne() { return mover.airborne },
      top: mover.top,
      stats: mover.stats,
      deviations: ZERO_DEVIATIONS,
      free() { mover.free() },
    }
  },
}
