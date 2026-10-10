// Fast tier (runs under `npm test`): the TypeScript hover mover (src/motion/mover.ts), driven
// through the motion core, against the vendored reference mover (reference/lib/hover.mjs, U+RS at
// top 4.15) on Rapier 0.14.0, for samples without rotation: every sample's pose must be identical
// bit for bit, and so must every counter (test/motion/equivalence.ts). Samples with rotation are
// ADR-0001 Validation 1-5's business (plan items MOT-05a and MOT-05b). The full tier repeats this
// on the whole wall study, longer soaks and more directed runs (full/mover.walls.test.ts,
// full/mover.rooms.test.ts).
import { beforeAll, describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import {
  compareAll, inclinedRuns, longWallRuns, seamRuns, soakRuns, thinWallRuns, totals, viaManifest,
} from '../equivalence.ts'
import type { RunResult } from '../equivalence.ts'

const groups: Record<string, RunResult[]> = {}

beforeAll(async () => {
  groups.walls = await compareAll([...longWallRuns(200, 40), ...longWallRuns(400, 0)])
  // Six of these runs change if the mover refreshes the scene queries after adding its own
  // collider (src/motion/mover.ts), which no other group here shows
  groups.thin = await compareAll(
    thinWallRuns([400]).filter((r) => /split 40 141@20 90 deg/.test(r.name)))
  groups.soaks = await compareAll([
    ...soakRuns(false, [20, 120, 250], [1], 10), ...soakRuns(true, [20, 120, 250], [7], 10),
  ])
  groups.inclined = await compareAll(inclinedRuns())
  // the T-junction, and the corner and wedges at 30 units/s (at 20/s an agent wedged into the
  // 30-degree wedge costs about 10 ms per sample: full tier)
  const seams = seamRuns().filter((r) => /^S3b |^S3c .*120\/s v30$/.test(r.name))
  groups.manifest = await compareAll([...longWallRuns(200, 40), ...seams].map(viaManifest))
}, 300_000)

// Runs with any difference, and where it starts
const differences = (results: RunResult[]) => results
  .filter((r) => r.identical !== r.samples || Object.keys(r.counters).length > 0)
  .map((r) => ({ name: r.name, first: r.first, counters: r.counters }))

describe('hover mover against the vendored reference (fast tier)', () => {
  it('runs on Rapier 0.14.0, the build the reference was validated on', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
  })

  it.each([
    ['long walls: t3 S1, 200-unit wall split into 40-unit pieces and a 400-unit wall in one piece',
      'walls'],
    ['thin walls: t3 S2, a 0.1-thick 400-unit wall in 40-unit pieces hit head-on at 7.05 units '
      + 'per sample (141 units/s at 20/s) from 20 start phases', 'thin'],
    ['both soak rooms: vertical walls, and with the inclined additions (10 s per rate)', 'soaks'],
    ['inclined faces, balls, cones, steps, a drop and falls onto steep faces', 'inclined'],
    ['in worlds built by instantiate() from a collider manifest: long walls, a T-junction, a '
      + 'corner and wedges', 'manifest'],
  ])('gives identical poses and counters: %s', (_, group) => {
    expect(groups[group].length).toBeGreaterThan(0)
    expect(differences(groups[group])).toEqual([])
  })

  it('covers the wall rule, recovery, steep-floor slide and falls, with no guard undo', () => {
    const all = Object.values(groups).flat(), t = totals(all)
    // the main branches of the mover were compared at least once. Not reached here: a floor
    // over 0.3 higher under the ray (rayHigh; at a step the controller meets its side first) and
    // the guard undo, which the full tier reaches on the uncapped 1,200-unit thin wall.
    for (const counter of ['incl', 'itCap', 'raySteep', 'raySlides', 'recoveries', 'recoverOk',
      'airIncl', 'airClip', 'fallStarts', 'lands']) {
      expect([counter, t[counter]]).not.toEqual([counter, 0])
    }
    // the six recoveries of the uncapped 400-unit wall (archived S1 row, reference.test.mjs)
    expect(totals(groups.walls).recoveries).toBe(6)
    expect(t.reverts).toBe(0)
    // 163 runs and 61,335 samples on 2026-10-09
    expect(all.reduce((n, r) => n + r.samples, 0)).toBeGreaterThan(60_000)
  })
})
