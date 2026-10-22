// Fast tier (runs under `npm test`): the mover interface of the Validation suite
// (test/motion/validation/driver.ts). Its reference driver feeds the vendored reference mover the
// way the motion core feeds its mover: one call per sample without rotation, one call per
// sub-step, with the sub-step's world displacement, for a sample with rotation (plan item MOT-05a).
// Checked here against the core itself: on rotating streams every sample's pose and heading from
// the reference driver equal those of the TypeScript mover through the motion core bit for bit,
// and so do the mover's counters, except the KCC calls of the reference's airborne sweeps of
// length 0 between sub-steps. That includes samples of a whole number of 0.25 sub-steps (30
// units/s at 120 samples/s, 100 units/s at 20), which the rotating streams shorten by 1e-8 of
// their length so that the core and the reference count the same sub-steps
// (test/motion/validation/streams.ts). The full tier runs Validation 1-5 on these drivers
// (test/motion/full/validation.*).
import { describe, expect, it } from 'vitest'
import { R, RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { buildWorld, obstacles } from '../reference/lib/walls.mjs'
import { makeWorld, slab, sphere } from '../reference/lib/geom.mjs'
import { SUB_STEP } from '../../../src/motion/core.ts'
import {
  coreDriver, commanded, referenceDriver, subStepDisplacement, subSteps,
} from '../validation/driver.ts'
import type { AgentStats, Body } from '../validation/driver.ts'
import { runCase, withStream } from '../validation/run.ts'
import type { Case, Pose } from '../validation/run.ts'
import {
  TIE_SHORTENING, bodyFrame, constant, randomRunning, rotating, worldSample,
} from '../validation/streams.ts'

const deg = (d: number) => (d * Math.PI) / 180
const G1 = ((1 << 16) | 0xffff) >>> 0, G2 = ((2 << 16) | 0xffff) >>> 0

// Rotating cases on walls, a slab, a ball, in the soak room and in a fall. The long walls run
// at 141 units/s (120 and 250 samples/s) and at the two speeds whose samples are whole numbers of
// sub-steps: 30 units/s at 120 samples/s (one of 0.25) and 100 units/s at 20 samples/s (twenty).
function cases(): Case[] {
  const out: Case[] = []
  const wall = [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: 100 }]
  const regimes = [[141 / 120, 120], [141 / 250, 250], [30 / 120, 120], [100 / 20, 20]]
  for (const [step, rate] of regimes) {
    for (const ang of [1, 15, 75]) {
      const a = deg(ang), n = Math.floor(180 / (step * Math.cos(a)))
      out.push({
        name: `long wall ${rate}/s step ${step} ${ang} deg`, start: { x: 8, z: 90 },
        world: () => buildWorld(wall, { split: 40, floor: [-20, 30, -120, 120] }).w,
        samples: constant(Math.sin(a) * step, -Math.cos(a) * step, rate, n),
      })
    }
  }
  for (const th of [33, 135]) {
    const o = slab({ th, fz: 0.5, W: 200, L: 20, T: 1 }), step = 141 / 120, a = deg(30)
    out.push({
      name: `slab ${th} deg`, world: () => makeWorld([o], [-250, 250, -60, 60]),
      start: { x: -180, z: 10.5 },
      samples: constant(Math.cos(a) * step, -Math.sin(a) * step, 120, Math.ceil(150 / step)),
    })
  }
  const ball = sphere(0, 10, 0, 10)
  out.push({
    name: 'ball R10', world: () => makeWorld([ball], [-80, 80, -80, 80]), start: { x: 4, z: 20 },
    samples: constant(0, -141 / 120, 120, 40),
  })
  for (const rate of [20, 120, 250]) {
    out.push({
      name: `soak room ${rate}/s`, start: { x: 0, z: -45 },
      world: () => buildWorld(obstacles(), { split: 40, floor: [-205, 205, -65, 65] }).w,
      samples: randomRunning(rate, 21, 15),
    })
  }
  // walking off a 20-unit box at 141 units/s, 120 samples/s: 5 sub-steps per sample while
  // airborne, so the reference makes airborne sweeps of length 0 between them
  out.push({
    name: 'drop from a 20-unit box', start: { x: 0, z: 0, feetY: 20 },
    world: () => {
      const w = new R.World({ x: 0, y: -981, z: 0 })
      w.createCollider(R.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0)
        .setCollisionGroups(G1))
      w.createCollider(R.ColliderDesc.cuboid(5, 10, 5).setTranslation(0, 10, 0)
        .setCollisionGroups(G2))
      w.step()
      return w
    },
    samples: constant(0, -141 / 120, 120, 60),
  })
  return out
}

const COUNTERS: Array<keyof AgentStats> = ['sub', 'incl', 'itCap', 'raySlides', 'recoveries',
  'recoverOk', 'reverts', 'airReverts', 'airIncl', 'fallStarts', 'lands']

describe('Validation suite mover interface (test/motion/validation/driver.ts)', () => {
  it('runs on Rapier 0.14.0', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
  })

  it('archived samples are the study\'s world displacements, exactly', () => {
    for (const [dx, dz] of [[0.25, -0.1], [-1.175, 0], [0, -5], [3e-17, 1]]) {
      const s = worldSample(dx, dz, 8333)
      expect(subStepDisplacement(0, s.d, 0, 1)).toEqual([dx, dz])
      expect(commanded(0, s.d)).toEqual([dx, dz])
    }
  })

  it('rotating samples turn the heading and keep the archived world displacement', () => {
    const archived = constant(Math.sin(deg(15)) * 5, -Math.cos(deg(15)) * 5, 20, 40)
    const { yaw, samples } = rotating(archived, 0.3, 1)
    let h = yaw, turned = 0
    for (let i = 0; i < samples.length; i++) {
      const d: Body = samples[i].d
      const [cx, cz] = commanded(h, d), [ax, az] = [-archived[i].d[1], -archived[i].d[0]]
      // the sub-steps fan out by +-dyaw/2: the sample's net displacement is shortened by at most
      // 1 - sin(dyaw/2) / (dyaw/2) (and by 1e-8 for this length of twenty sub-steps), along the
      // archived direction; the sample keeps the archived number of sub-steps
      expect(Math.abs(cx * az - cz * ax)).toBeLessThan(1e-9)
      expect(Math.hypot(cx, cz)).toBeLessThanOrEqual(Math.hypot(ax, az) * (1 + 1e-12))
      expect(Math.hypot(cx, cz)).toBeGreaterThan(Math.hypot(ax, az) * (1 - d[2] ** 2 / 24 - 2e-8))
      expect(subSteps(d)).toBe(20)
      turned = Math.max(turned, Math.abs(d[2]))
      h += d[2]
    }
    expect(turned).toBeGreaterThan(0.3)
  })

  it('shortens only samples of a whole number of sub-steps, by 1e-8 of their length', () => {
    const lengths = [[0.25, true], [5, true], [50, true], [0.2499, false], [1.175, false],
      [0.03, false], [0, false]] as const
    for (const [len, shortened] of lengths) {
      for (const a of [0, 0.3, 1, 2.5]) {
        const [f, l] = bodyFrame(Math.sin(a) * len, -Math.cos(a) * len, 0.7)
        const scale = shortened ? 1 - TIE_SHORTENING : 1
        expect(Math.abs(Math.hypot(f, l) - len * scale))
          .toBeLessThanOrEqual(1e-15 * Math.max(len, 1))
        if (len > 0) expect(subSteps([f, l, 0])).toBe(Math.max(1, Math.ceil(len / SUB_STEP - 1e-6)))
      }
    }
  })

  it('gives the reference the motion core\'s sub-steps: rotating streams bit for bit', () => {
    const all = cases()
    let compared = 0, zeroSweeps = 0
    for (let k = 0; k < all.length; k++) {
      const c = withStream(all[k], 'rotating', k)
      const poses: Pose[][] = [[], []]
      const [ref, core] = [referenceDriver, coreDriver]
        .map((d, j) => runCase(d, c, ({ after }) => poses[j].push(after)))
      expect([c.name, ref.deviations]).toEqual([c.name, { resplit: 0, airborne: 0 }])
      expect([c.name, poses[0].length]).toEqual([c.name, poses[1].length])
      for (let i = 0; i < poses[0].length; i++) {
        const a = poses[0][i], b = poses[1][i]
        const same = Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z)
          && Object.is(a.yaw, b.yaw) && a.airborne === b.airborne
        if (!same) {
          expect({ case: c.name, sample: i, reference: a })
            .toEqual({ case: c.name, sample: i, reference: b })
        }
      }
      for (const key of COUNTERS) {
        expect([c.name, key, ref.stats[key]]).toEqual([c.name, key, core.stats[key]])
      }
      compared += poses[0].length
      zeroSweeps += ref.stats.calls - core.stats.calls
    }
    expect(compared).toBe(13448)
    // the drop's airborne sub-steps reached the reference's sweeps of length 0 (one KCC call each)
    expect(zeroSweeps).toBeGreaterThan(0)
  })

  it('counts a sub-step that the reference splits again (deviation resplit)', () => {
    // a body-frame sample of exactly one sub-step (length 0.25, the core makes one sub-step) whose
    // turned world displacement comes out longer than 0.25 in its last bit: the reference makes
    // two half sub-steps of it. Rotating streams shorten such samples (see above).
    let d: Body | null = null
    for (let i = 0; i < 10000 && !d; i++) {
      const a = 0.001 * i, f = 0.25 * Math.cos(a), l = 0.25 * Math.sin(a), dyaw = 0.2
      if (subSteps([f, l, dyaw]) !== 1) continue
      const [dx, dz] = subStepDisplacement(0.3, [f, l, dyaw], 0, 1)
      if (Math.ceil(Math.hypot(dx, dz) / SUB_STEP) === 2) d = [f, l, dyaw]
    }
    expect(d).not.toBeNull()
    const c: Case = {
      name: 'one sample', world: () => makeWorld([], [-50, 50, -50, 50]),
      start: { x: 0, z: 0, yaw: 0.3 },
      samples: [{ d: d as Body, dtUs: 8333 }],
    }
    const ref = runCase(referenceDriver, c), core = runCase(coreDriver, c)
    expect(ref.deviations).toEqual({ resplit: 1, airborne: 0 })
    expect([ref.stats.sub, core.stats.sub]).toEqual([2, 1])
  })
})
