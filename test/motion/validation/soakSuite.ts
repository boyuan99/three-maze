// The soak test files (test/motion/full/validation.soak-*.test.ts): one room and one stream per
// file, so that the test runner spreads the rooms over its workers. See ./soaks.ts.
import { describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { SOAK_RATES, SOAK_SEEDS, archivedT4Row, soak, t4Row } from './soaks.ts'
import type { Room, SoakRun } from './soaks.ts'
import type { Stream } from './run.ts'
import { DRIVER, archive, costLine, totalsOf } from './suite.ts'

const TITLES: Record<Room, string> = {
  cuboid: 'Validation 4: the closed 400 x 120 room, cuboid walls in 40-unit pieces (t4 Part 1)',
  trimesh: 'Validation 4: the closed 400 x 120 room, trimesh walls with segments up to 40 (s7)',
  inclined: 'Validation 5: the inclined soak room, 13 inclined obstacles added (t4 Part 2)',
  proxy: 'Validation 5: the proxy study\'s room, platform, railed ramps, 18 objects (X9)',
}

/**
 * Thresholds (ADR-0001 Validation 4 and 5): no overlap, escape or guard undo in every room; in
 * the Validation 5 rooms also eye-point clearance >= 0.43 and near-plane clearance > 0 at 16:9 to
 * 32:9; in the proxy study's room no overlap with any true shape, every fall lands, no hang. On the
 * archived stream the cuboid and inclined rooms' rows equal t4's archived rows.
 */
export function soakTests(room: Room, stream: Stream) {
  describe(`ADR-0001 ${TITLES[room]}, ${stream} stream, on ${DRIVER.name}`, () => {
    it('runs on Rapier 0.14.0, the build the archived numbers come from', () => {
      expect(RAPIER_VERSION).toBe('0.14.0')
    })

    const title = `%i samples/s, ${SOAK_SEEDS.length} seeds x 5 min of random running`
    it.each(SOAK_RATES)(title, async (rate) => {
      const t0 = Date.now(), runs = await soak(DRIVER, room, stream, rate)
      const sum = (f: (s: SoakRun) => number) => runs.reduce((n, s) => n + f(s), 0)
      const t = totalsOf(runs.map((s) => s.outcome))
      const cam = runs[0].camera
      for (const s of runs.slice(1)) cam.merge(s.camera)
      const r = {
        overlaps: sum((s) => s.overlaps), escapes: sum((s) => s.escapes), undo: t.reverts,
        bodyOverlaps: sum((s) => s.bodyOverlaps), hangs: sum((s) => s.hangs),
      }
      const worst = Math.max(...runs.map((s) => s.worst))
      const resplit = sum((s) => s.outcome.deviations.resplit)
      const airborne = sum((s) => s.outcome.deviations.airborne)
      const efficiency = (100 * sum((s) => s.efficiency)) / runs.length
      const bodyMin = Math.min(...runs.map((s) => s.bodyMin))
      console.log(costLine(`soak ${room} ${rate}/s`, stream, t, Date.now() - t0,
        `overlaps ${r.overlaps} (worst depth ${worst.toFixed(4)}), escapes ${r.escapes}, `
        + `undo ${r.undo}, recoveries ${t.recoveries}, path efficiency ${efficiency.toFixed(1)} %`
        + (room === 'inclined' || room === 'proxy'
          ? `, eye ${cam.eye.toFixed(3)}, near plane 32:9 rect ${cam.rect329.value.toFixed(3)} `
            + `any-yaw ${cam.env329.value.toFixed(3)}, clips ${cam.clips}`
          : '')
        + (room === 'proxy'
          ? `, body min ${bodyMin.toFixed(4)}, falls ${sum((s) => s.falls)}, landings `
            + `${sum((s) => s.lands)}, hangs ${r.hangs}`
          : '')
        + `, deviations resplit ${resplit} airborne ${airborne}`))
      // the reference driver gives the motion core's sub-steps (driver.ts): never split again; on
      // the archived stream also no landing between sub-steps
      expect(resplit).toBe(0)
      if (stream === 'archived') {
        expect(airborne).toBe(0)
        if (room === 'cuboid' || room === 'inclined') {
          const file = room === 'cuboid' ? 't4_soak_part1_out.txt' : 't4_soak_part2_out.txt'
          expect(t4Row(room, runs)).toBe(archivedT4Row(archive(file), room, rate))
        }
      }
      expect(r).toEqual({ overlaps: 0, escapes: 0, undo: 0, bodyOverlaps: 0, hangs: 0 })
      expect(worst).toBeLessThanOrEqual(0.02)
      if (room === 'inclined' || room === 'proxy') {
        expect(cam.clips).toBe(0)
        expect(cam.eye).toBeGreaterThanOrEqual(0.43)
        expect(cam.rect329.value).toBeGreaterThan(0)
        expect(cam.env329.value).toBeGreaterThan(0)
      }
      if (room === 'proxy') {
        expect(bodyMin).toBeGreaterThanOrEqual(-0.02)
        expect(sum((s) => s.lands)).toBe(sum((s) => s.falls))
      }
    })
  })
}
