// Full tier: the TypeScript hover mover (src/motion/mover.ts, through the motion core) against the
// vendored reference on the inputs of the whole vertical-wall study t3 (reference/t3_walls.mjs:
// 1,661 runs of long walls, thin walls, seams, a T-junction, a corner, wedges and trimesh walls),
// built by test/motion/equivalence.ts. Every sample's pose and every counter must be identical.
// The thin walls include the uncapped 1,200-unit wall, where the guard undoes moves, so this
// compares the undo path too, which the fast tier never reaches.
import { expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import {
  compareAll, longWallRuns, seamRuns, thinWallRuns, totals, trimeshWallRuns,
} from '../equivalence.ts'
import type { RunResult } from '../equivalence.ts'

const differences = (results: RunResult[]) => results
  .filter((r) => r.identical !== r.samples || Object.keys(r.counters).length > 0)
  .map((r) => ({ name: r.name, first: r.first, counters: r.counters }))

it('t3, all sections: identical poses and counters, and the archived undo totals', async () => {
  expect(RAPIER_VERSION).toBe('0.14.0')
  const results = await compareAll([
    ...[200, 400, 600].flatMap((L) => [0, 40].flatMap((split) => longWallRuns(L, split))),
    ...thinWallRuns(), ...seamRuns(), ...trimeshWallRuns(),
  ])
  expect(differences(results)).toEqual([])
  // archive/t3_walls_top415_out.txt, last line: "U+RS 2 / 1661 ... guard reverts 7187
  // recoveries 3352 (383)". No t3 run leaves the floor, so the whole-µs dt changes nothing.
  const t = totals(results)
  expect([results.length, t.reverts, t.recoveries, t.recoverOk]).toEqual([1661, 7187, 3352, 383])
})
