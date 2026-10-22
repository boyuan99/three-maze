// Full tier: ADR-0001 Validation 5, inclined and curved faces approached at 5-90 degrees, on the
// suite's mover (test/motion/validation/suite.ts DRIVER), on the archived streams and on their
// rotating variants: t1 Part A and B (slabs of 15-150 degrees), t2 (balls and domes of radius 3,
// 10 and 25, 256-gon hull cones) and X1 (the proxy study's shapes with their own colliders,
// balls up to radius 60, a lying cylinder, a tumbled cube, the twisted 50-unit slab), as
// test/motion/validation/inclined.ts runs them. On the archived stream every row must equal the
// study's archived row for U+RS at top 4.15 (reference/archive/), times left out.
//
// Thresholds (ADR-0001 Validation 5): no overlap with the true shapes (deeper than the 0.02
// skin), no guard undo, retention >= 99 % along flat faces, sideways range <= 0.08, eye-point
// clearance >= 0.43 and near-plane clearance > 0 at 16:9 to 32:9; faces up to 30 degrees climbed
// and 31-75 degrees blocked (t1 Part A). The near plane is measured in X1 (camera.ts); in t1 and
// t2, which measured the eye point only, eye clearance >= 0.43 implies it: every point of the
// near-plane rectangle and of the frustum's tip is within 0.30 of the eye at 32:9 (0.2006 at
// 16:9), and distance changes by at most the distance moved.
import { describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { CAM_32_9 } from '../validation/camera.ts'
import { t1PartA, t1PartB, t2Curved, x1Directed } from '../validation/inclined.ts'
import type { Result, X1Row } from '../validation/inclined.ts'
import {
  DRIVER, STREAMS, archive, archivedRows, consoleTable, costLine,
} from '../validation/suite.ts'

const fixed = (v: number | null, d = 4) => (v === null ? '-' : v.toFixed(d))
const summary = (r: Result) => `min gap ${fixed(r.minGap)}, overlaps ${r.overlaps}, undo `
  + `${r.totals.reverts}, recoveries ${r.totals.recoveries} (clear ${r.totals.recoverOk}), `
  + `retention ${fixed(r.minRetention === null ? null : 100 * r.minRetention, 2)} %, `
  + `sideways ${fixed(r.maxSideways)}, eye ${fixed(r.eyeMin, 3)}, deviations resplit `
  + `${r.totals.resplit} airborne ${r.totals.airborne}`
const cameraLine = (r: Result) => `near plane 16:9 rect ${r.camera.rect169.value.toFixed(3)} `
  + `any-yaw ${r.camera.env169.value.toFixed(3)}, 32:9 rect ${r.camera.rect329.value.toFixed(3)} `
  + `any-yaw ${r.camera.env329.value.toFixed(3)}, clips ${r.camera.clips}`

// X1's archived table rows, as compared: the cells this port computes (not the timing, the gap
// medians and the start check, which X1 alone printed)
const X1_KEYS: Array<[keyof X1Row, string]> = [['shape', 'shape'], ['approach', 'approach'],
  ['runs', 'runs'], ['samples', 'samples'], ['calls', 'KCC calls'], ['undo', 'guard undo'],
  ['recoveries', 'recoveries (clear)'], ['slides', 'ray slides'], ['itCap', 'itCap'],
  ['bodyMin', 'body-true min'], ['body', 'samples body<0 / <-0.02'], ['eye', 'eye min'],
  ['rect', 'near-rect min'], ['env', 'any-yaw min'], ['clips', 'clip samples'],
  ['retention', 'retention min']]
const x1Archived = (name: string) => consoleTable(archive(name))
  .filter((row) => row.shape !== undefined && row.runs !== undefined)
  .map((row) => Object.fromEntries(X1_KEYS.map(([, h]) => [h, row[h]])))
const x1Port = (table: X1Row[]) =>
  table.map((row) => Object.fromEntries(X1_KEYS.map(([k, h]) => [h, String(row[k])])))

function thresholds(r: Result) {
  expect({ overlaps: r.overlaps, undo: r.totals.reverts, failures: r.failures })
    .toEqual({ overlaps: 0, undo: 0, failures: [] })
  expect(r.minGap).toBeGreaterThanOrEqual(-0.02)
  expect(r.eyeMin).toBeGreaterThanOrEqual(0.43)
}

describe(`ADR-0001 Validation 5, inclined and curved faces, on ${DRIVER.name}`, () => {
  it('runs on Rapier 0.14.0, the build the archived numbers come from', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
    // eye >= 0.43 keeps the near plane outside every shape up to 32:9 (see the header)
    expect(CAM_32_9.reach).toBeLessThan(0.43)
  })

  describe.each(STREAMS)('%s stream', (stream) => {
    const archived = stream === 'archived'
    // the reference driver gives the motion core's sub-steps (validation/driver.ts): never split
    // again; on the archived stream also no landing between sub-steps
    const deviations = (r: Result) => {
      expect(r.totals.resplit).toBe(0)
      if (archived) expect(r.totals.airborne).toBe(0)
    }
    const log = (group: string, r: Result, t0: number, extra = '') =>
      console.log(costLine(group, stream, r.totals, Date.now() - t0, summary(r) + extra))

    it('t1 Part A: a 20 x 20 slab of 15-90 degrees head-on, to 30 climbed, 31-90 blocked',
      async () => {
        const t0 = Date.now(), r = await t1PartA(DRIVER, stream)
        log('V5 t1 Part A (slabs 15-90 deg)', r, t0)
        const rows = archivedRows('t1_slabs_A_out.txt', /deg U\+RS top4\.15 /)
        if (archived) expect(r.rows).toEqual(rows)
        deviations(r)
        thresholds(r)
      })

    it('t1 Part B: 400-unit slabs of 31-150 degrees at 5-90 degrees, 30 and 141 units/s',
      async () => {
        const t0 = Date.now(), r = await t1PartB(DRIVER, stream)
        log('V5 t1 Part B (slabs 31-150 deg)', r, t0)
        if (archived) {
          expect(r.rows).toEqual(archivedRows('t1_slabs_B_out.txt', /deg U\+RS top4\.15 +runs /,
            / [\d.]+\/\d+ us$/))
        }
        deviations(r)
        thresholds(r)
        expect(r.minRetention).toBeGreaterThanOrEqual(0.99)
        expect(r.maxSideways).toBeLessThanOrEqual(0.08)
      })

    it('t2: balls and domes of radius 3, 10, 25 and hull cones, upright and inverted', async () => {
      const t0 = Date.now(), r = await t2Curved(DRIVER, stream)
      log('V5 t2 (balls, domes, hull cones)', r, t0)
      if (archived) {
        const rows = archivedRows('t2_curved_out.txt', /U\+RS top4\.15 +D /, / \/ [\d.]+ \d+$/)
        expect(r.rows).toEqual(rows.filter((row) => !row.includes('primitive')))
      }
      deviations(r)
      thresholds(r)
    })

    it('X1: balls up to radius 60, hull cones, slabs and wedges, a lying cylinder, a tumbled '
      + 'cube, the twisted slab (1,302 runs)', async () => {
      const t0 = Date.now(), r = await x1Directed(DRIVER, stream)
      log('V5 X1 (proxy study shapes)', r, t0, `; ${cameraLine(r)}`)
      if (archived) {
        expect(x1Port(r.table)).toEqual(x1Archived('X1_directed_B415_out.txt'))
        expect(x1Port(r.table329)).toEqual(x1Archived('X1_directed_B415_aspect32x9_out.txt'))
      }
      deviations(r)
      thresholds(r)
      expect(r.camera.clips).toBe(0)
      for (const l of [r.camera.rect169, r.camera.env169, r.camera.rect329, r.camera.env329]) {
        expect(l.value).toBeGreaterThan(0)
      }
      expect(r.minRetention).toBeGreaterThanOrEqual(0.99)
    })
  })
})
