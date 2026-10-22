// Full tier: ADR-0001 Validation 5, floors, drops, steps, ramps, falls and the cast-miss census,
// on the suite's mover (test/motion/validation/suite.ts DRIVER), on the archived streams and on
// their rotating variants, as test/motion/validation/inclined.ts runs them: t5 (floor
// T-junctions, the 20-unit drop, steps, falls onto steep faces), X3 (the proxy study's ledge scene
// with an overhang, and steps under it), X7 (falls toward a ball), walkable 20- and 28-degree ramps
// with rails (X15, X16, X2) and t7 (the census). On the archived stream the rows of t5 (a)-(c), t7
// and X2's 20-degree railed ramp must equal the study's archived rows for U+RS at top 4.15.
//
// Thresholds (ADR-0001 Validation 5): feet range <= 1e-4 over floor T-junctions; a 20-unit drop
// lands within 2 samples of free fall; a 0.28 step climbed and >= 0.29 blocked, also under an
// overhang; 28-degree ramps climbed up onto their platform and descended, head-on and 30 degrees
// off-axis, their railed sides blocked; falls onto steep faces and toward objects land on the
// floor below; no overlap with the true shapes, no guard undo, eye-point clearance >= 0.43 and
// near-plane clearance > 0 where the camera meets a shape; the census without guard undo.
// Not a failure, as ADR-0001 Risks records it: an agent walking off a ledge toward a solid
// 0.53-1.04 beyond it hangs on the edge (X3's ball A, 1 unit from the ledge face).
import { describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { census, falls, ledgeScene, ramps, t5FloorsDrops, t5Steps } from '../validation/inclined.ts'
import type { Result } from '../validation/inclined.ts'
import {
  DRIVER, STREAMS, archive, archivedRows, archivedSection, consoleTable, costLine,
} from '../validation/suite.ts'

const T5 = 't5_floors_falls_out.txt', ROWS = 'U+RS top4.15'
const fixed = (v: number | null, d = 4) => (v === null ? '-' : v.toFixed(d))
const summary = (r: Result) => `min gap ${fixed(r.minGap)}, overlaps ${r.overlaps}, undo `
  + `${r.totals.reverts}, recoveries ${r.totals.recoveries} (clear ${r.totals.recoverOk}), `
  + `deviations resplit ${r.totals.resplit} airborne ${r.totals.airborne}`
const camera = (r: Result) => `eye ${r.camera.eye.toFixed(3)}, near plane 32:9 rect `
  + `${r.camera.rect329.value.toFixed(3)} any-yaw ${r.camera.env329.value.toFixed(3)}, `
  + `clips ${r.camera.clips}`

function common(r: Result) {
  expect({ overlaps: r.overlaps, undo: r.totals.reverts, failures: r.failures })
    .toEqual({ overlaps: 0, undo: 0, failures: [] })
  expect(r.minGap).toBeGreaterThanOrEqual(-0.02)
}
function cameraClear(r: Result) {
  expect(r.camera.clips).toBe(0)
  expect(r.camera.eye).toBeGreaterThanOrEqual(0.43)
  expect(r.camera.rect329.value).toBeGreaterThan(0)
  expect(r.camera.env329.value).toBeGreaterThan(0)
}

describe(`ADR-0001 Validation 5: floors, steps, ramps, falls, census, on ${DRIVER.name}`, () => {
  it('runs on Rapier 0.14.0, the build the archived numbers come from', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
  })

  describe.each(STREAMS)('%s stream', (stream) => {
    const archived = stream === 'archived'
    // the reference driver gives the motion core's sub-steps (validation/driver.ts): never split
    // again; on the archived stream also no landing between sub-steps
    const deviationsZero = (r: Result) => {
      expect(r.totals.resplit).toBe(0)
      if (archived) expect(r.totals.airborne).toBe(0)
    }

    it('t5 (a) floor T-junctions and (b) the 20-unit drop at 20, 120, 250 samples/s', async () => {
      const t0 = Date.now(), r = await t5FloorsDrops(DRIVER, stream)
      console.log(costLine('V5 t5 floors and drops', stream, r.totals, Date.now() - t0,
        `${summary(r)}, feet range ${r.feetRange.toExponential(2)}, drop: worst |samples - free `
        + `fall| ${r.dropWorst.toFixed(2)}, runs without landing ${r.dropNoLanding}`))
      if (archived) {
        expect(r.rows).toEqual([
          ...archivedSection(T5, '(a)', ['(b)'], ROWS),
          ...archivedSection(T5, '(b)', ['(c)'], ROWS),
        ])
      }
      deviationsZero(r)
      common(r)
      expect(r.feetRange).toBeLessThanOrEqual(1e-4)
      expect(r.dropNoLanding).toBe(0)
      expect(r.dropWorst).toBeLessThanOrEqual(2)
    })

    it('t5 (c) steps of 0.1-0.5, head-on and at 45 degrees: 0.28 climbed, 0.29 up blocked',
      async () => {
        const t0 = Date.now(), r = await t5Steps(DRIVER, stream)
        console.log(costLine('V5 t5 steps', stream, r.totals, Date.now() - t0, summary(r)))
        if (archived) expect(r.rows).toEqual(archivedSection(T5, '(c)', ['(d)'], ROWS))
        deviationsZero(r)
        common(r)
        expect(r.outcomes.filter((s) => (s.h <= 0.28 && !s.climbed) || (s.h >= 0.29 && s.climbed)))
          .toEqual([])
      })

    it('X3: the ledge scene (falls next to balls, an overhang) and steps under the overhang',
      async () => {
        const t0 = Date.now(), r = await ledgeScene(DRIVER, stream)
        console.log(costLine('V5 X3 ledge, steps under an overhang', stream, r.totals,
          Date.now() - t0, `${summary(r)}; ${camera(r)}; runs hung on the ledge's rim `
          + `${r.hung.length}`))
        deviationsZero(r)
        common(r)
        cameraClear(r)
        expect(r.onStep035).toBe(0)
        expect(r.steps.filter((s) => s.climbed !== (s.h <= 0.28))).toEqual([])
        // ADR-0001 Risks: the rim hang toward a solid 0.53-1.04 beyond the edge (ball A, 1 unit)
        expect(r.hung.filter((h) => !h.startsWith('fall toward sphere A (gap 1, z 0)'))).toEqual([])
      })

    it('falls onto a 45-degree slab, a ball, a hull cone (t5 d), toward a ball (X7)', async () => {
      const t0 = Date.now(), r = await falls(DRIVER, stream)
      console.log(costLine('V5 falls (t5 d, X7)', stream, r.totals, Date.now() - t0,
        `${summary(r)}; ${camera(r)}; runs not on the floor at the end ${r.notLanded}`))
      deviationsZero(r)
      common(r)
      cameraClear(r)
      expect(r.notLanded).toBe(0)
    })

    it('ramps of 20 and 28 degrees with rails: up, down, off-axis, at their sides', async () => {
      const t0 = Date.now(), r = await ramps(DRIVER, stream)
      console.log(costLine('V5 railed ramps (X15, X16, X2)', stream, r.totals, Date.now() - t0,
        `${summary(r)}; runs that missed ${r.missed.length}, side runs on the ramp `
        + `${r.sideOnRamp}, left by the side ${r.leftBySide}`))
      if (archived) {
        // X2: the 20-degree ramp with rails, the mover B415 (U+RS at top 4.15)
        const x2 = consoleTable(archive('X2_ramp_side_out.txt'))
          .find((row) => row.mover === 'B415' && row.ramp === '20 deg' && row.variant === 'railed')
        expect(r.rows).toContain(`  X2 ramp 20 deg railed: runs ${x2?.runs} samples `
          + `${x2?.samples} KCC calls ${x2?.['KCC calls']} guard undo ${x2?.['guard undo']}`)
      }
      deviationsZero(r)
      common(r)
      expect({ missed: r.missed, sideOnRamp: r.sideOnRamp, leftBySide: r.leftBySide })
        .toEqual({ missed: [], sideOnRamp: 0, leftBySide: 0 })
    })

    it('t7: the cast-miss census, 6,000 adversarial one-sample trials per obstacle', async () => {
      const t0 = Date.now(), r = await census(DRIVER, stream)
      console.log(costLine('V5 t7 census', stream, r.totals, Date.now() - t0, summary(r)))
      if (archived) {
        expect(r.rows).toEqual(archivedRows('t7_census_out.txt', / U\+RS top4\.15 +trials /))
      }
      deviationsZero(r)
      common(r)
    })
  })
})
