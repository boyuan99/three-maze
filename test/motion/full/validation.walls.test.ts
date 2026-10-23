// Full tier: ADR-0001 Validation 1-3 (docs/adr/0001-player-mover.md, Validation) on the suite's
// mover (test/motion/validation/suite.ts DRIVER: the vendored reference in plan item MOT-05a, the
// TypeScript mover through the motion core from MOT-05b), on the archived streams and on their
// rotating variants (test/motion/validation/streams.ts). The cases are the study's wall suite t3
// (test/motion/validation/walls.ts); on the archived stream every row must equal the U+RS row of
// reference/archive/t3_walls_top415_out.txt, so the cases are the evidence's.
//
// Thresholds (ADR-0001 Validation; R6: expected undo count zero):
//   1 long walls (split into 40-unit pieces, R5.2): no overlap (deeper than the 0.02 skin), no
//     crossing, retention >= 99 %, no guard undo; the sideways range, which Validation 1 only
//     reports, below 0.1 (ADR-0001 When to revisit: above 0.1 on capped walls)
//   2 thin walls: no crossing, in every configuration; within R5.2 also no overlap or guard undo
//     (the uncapped 400- and 1,200-unit walls are reported)
//   3 seams, T-junction, corner, wedges, trimesh walls, raised platform: contained (no overlap, no
//     crossing of any wall: test/motion/validation/measures.ts Crossings), retention >= 99 %, no
//     guard undo, no T-junction sample without progress
import { describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import {
  DRIVER, STREAMS, archivedSection, costLine, deviations, totalsOf,
} from '../validation/suite.ts'
import {
  longWalls, raisedPlatform, seams, thinCapped, thinWalls, trimeshWalls,
} from '../validation/walls.ts'
import type { GroupResult } from '../validation/walls.ts'

const T3 = 't3_walls_top415_out.txt', HEADERS = ['S1 ', 'S2 ', 'S3a ', 'S3g ', 'Over every run']
// t3's rows of the mover U+RS, the S1 rows' time per sample masked
const t3 = (from: string) => archivedSection(T3, from, HEADERS, ' U+RS ').map((l) => {
  if (!/^ {2}L\d+ split /.test(l)) return l
  const fields = l.split(' / ')
  fields[5] = '*'
  return fields.join(' / ')
})
const fixed = (v: number | null, d = 4) => (v === null ? '-' : v.toFixed(d))
const summary = (r: GroupResult) => {
  const d = deviations(r.outcomes)
  return `worst depth ${fixed(r.worst)}, overlaps ${r.overlaps}, crossings ${r.crossings}, `
    + `min retention ${fixed(r.minRetention, 2)} %, sideways ${fixed(r.maxSideways)}, `
    + `deviations resplit ${d.resplit} airborne ${d.airborne}`
}

describe(`ADR-0001 Validation 1-3 on ${DRIVER.name}`, () => {
  it('runs on Rapier 0.14.0, the build the archived numbers come from', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
  })

  describe.each(STREAMS)('%s stream', (stream) => {
    const archived = stream === 'archived'
    const undo = (r: GroupResult) => totalsOf(r.outcomes).reverts
    // the reference driver gives the motion core's sub-steps (validation/driver.ts): never split
    // again; on the archived stream also no landing between sub-steps
    const exact = (outcomes: GroupResult['outcomes']) => {
      const d = deviations(outcomes)
      expect(d.resplit).toBe(0)
      if (archived) expect(d.airborne).toBe(0)
    }
    const log = (group: string, outcomes: GroupResult['outcomes'], t0: number, extra: string) =>
      console.log(costLine(group, stream, totalsOf(outcomes), Date.now() - t0, extra))

    it('Validation 1: long walls of 200-600 units in 40-unit pieces, at 1-75 degrees', async () => {
      const t0 = Date.now(), r = await longWalls(DRIVER, stream)
      log('V1 long walls (t3 S1, split 40)', r.outcomes, t0, summary(r))
      if (archived) {
        expect(r.rows).toEqual(t3('S1 ').filter((l) => l.includes(' split 40 ')))
      }
      exact(r.outcomes)
      expect({ overlaps: r.overlaps, crossings: r.crossings, undo: undo(r) })
        .toEqual({ overlaps: 0, crossings: 0, undo: 0 })
      expect(r.worst).toBeLessThanOrEqual(0.02)
      expect(r.minRetention).toBeGreaterThanOrEqual(99)
      expect(r.maxSideways).toBeLessThan(0.1)
    })

    it('Validation 2: thin walls, 0.1 thick, 141-1,000 units/s, up to 50 units per sample',
      async () => {
        const t0 = Date.now(), all = await thinWalls(DRIVER, stream)
        const outcomes = all.flatMap((r) => r.outcomes)
        log('V2 thin walls (t3 S2)', outcomes, t0, all.map((r) => `Lw ${r.Lw} split `
          + `${r.split || '-'}: crossings ${r.crossings}, worst depth ${r.worst.toFixed(4)}, `
          + `undo ${r.reverts}`).join('; '))
        if (archived) {
          expect(all.flatMap((r) => r.rows)).toEqual(t3('S2 '))
        }
        exact(outcomes)
        for (const r of all) {
          expect([r.Lw, r.split, 'crossings', r.crossings]).toEqual([r.Lw, r.split, 'crossings', 0])
          if (thinCapped(r.Lw, r.split)) {
            expect([r.Lw, r.split, r.overlaps, r.reverts]).toEqual([r.Lw, r.split, 0, 0])
            expect(r.worst).toBeLessThanOrEqual(0.02)
          }
        }
      })

    it('Validation 3: coplanar seams, a T-junction, a corner, wedges (t3 S3a-S3e)', async () => {
      const t0 = Date.now(), r = await seams(DRIVER, stream)
      log('V3 seams, T-junction, corner, wedges', r.outcomes, t0,
        `${summary(r)}, T-junction samples without progress ${r.zeroProgress}`)
      if (archived) {
        expect(r.rows).toEqual(t3('S3a '))
      }
      exact(r.outcomes)
      expect({
        overlaps: r.overlaps, crossings: r.crossings, undo: undo(r), zeroProgress: r.zeroProgress,
      }).toEqual({ overlaps: 0, crossings: 0, undo: 0, zeroProgress: 0 })
      expect(r.worst).toBeLessThanOrEqual(0.02)
      expect(r.minRetention).toBeGreaterThanOrEqual(99)
    })

    it('Validation 3: trimesh walls, triangles 200, 40 and 10 long (t3 S3g)', async () => {
      const t0 = Date.now(), r = await trimeshWalls(DRIVER, stream)
      log('V3 trimesh walls (t3 S3g)', r.outcomes, t0, summary(r))
      if (archived) {
        expect(r.rows).toEqual(t3('S3g '))
      }
      exact(r.outcomes)
      expect({ overlaps: r.overlaps, crossings: r.crossings, undo: undo(r) })
        .toEqual({ overlaps: 0, crossings: 0, undo: 0 })
      expect(r.minRetention).toBeGreaterThanOrEqual(99)
    })

    it('Validation 3: along the side of a 200-unit raised platform, from the floor below',
      async () => {
        const t0 = Date.now(), r = await raisedPlatform(DRIVER, stream)
        log('V3 raised platform (new case)', r.outcomes, t0, summary(r))
        exact(r.outcomes)
        expect({ overlaps: r.overlaps, crossings: r.crossings, undo: undo(r) })
          .toEqual({ overlaps: 0, crossings: 0, undo: 0 })
        expect(r.minRetention).toBeGreaterThanOrEqual(99)
      })
  })
})
