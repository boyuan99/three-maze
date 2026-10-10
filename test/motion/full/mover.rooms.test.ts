// Full tier: the TypeScript hover mover (src/motion/mover.ts, through the motion core) against the
// vendored reference in both soak rooms, at 20, 120, 250 and 1,000 samples/s, on more directed
// runs at inclined faces, curved obstacles, steps, drops and falls, and on guard undos after
// airborne sweeps, forced on purpose (test/motion/equivalence.ts). Every sample's pose and every
// counter must be identical. It also prints the cost per sample of both movers, measured
// interleaved sample by sample as the study's t6 did; the numbers mean something only when this
// file runs alone (test/motion/README.md, Cost).
import { describe, expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { compareAll, forcedUndoRuns, inclinedRuns, soakRuns, totals } from '../equivalence.ts'
import type { RunResult } from '../equivalence.ts'

const differences = (results: RunResult[]) => results
  .filter((r) => r.identical !== r.samples || Object.keys(r.counters).length > 0)
  .map((r) => ({ name: r.name, first: r.first, counters: r.counters }))

const RATES = [20, 120, 250, 1000], SEEDS = [1, 7, 21, 99], SECONDS = 30
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), m = sorted.length >> 1
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2
}

describe('hover mover against the vendored reference (full tier, rooms)', () => {
  it('both soak rooms, 4 seeds x 30 s per rate: identical; prints the cost', async () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
    const lines = ['Cost per sample, µs: median over seeds of the run means (reference / mover '
      + `through the core, interleaved; ${SEEDS.length} seeds x ${SECONDS} s)`]
    const all: RunResult[] = []
    for (const inclined of [false, true]) {
      for (const rate of RATES) {
        const results = await compareAll(soakRuns(inclined, [rate], SEEDS, SECONDS))
        all.push(...results)
        const ref = median(results.map((r) => r.usReference))
        const mover = median(results.map((r) => r.usMover))
        const room = inclined ? 'inclined room' : 'walls only   '
        lines.push(`  ${room} ${String(rate).padStart(4)}/s `
          + `${ref.toFixed(1).padStart(7)} / ${mover.toFixed(1).padStart(7)} `
          + `(${(100 * (mover / ref - 1)).toFixed(1)} %)`)
      }
    }
    console.log(lines.join('\n'))
    expect(differences(all)).toEqual([])
    expect(totals(all).reverts).toBe(0)
  })

  it('inclined faces, curved obstacles, steps, drops and falls, more angles', async () => {
    const results = await compareAll(inclinedRuns(true))
    expect(differences(results)).toEqual([])
    expect(totals(results).reverts).toBe(0)
  })

  it('undos after airborne sweeps, forced by a lid enabled around a falling agent', async () => {
    // No scene case reaches this path; in both movers the undone samples' gravity stays in vy
    const results = await compareAll(forcedUndoRuns())
    expect(differences(results)).toEqual([])
    expect(totals(results)).toMatchObject({ reverts: 8, airReverts: 4, recoveries: 4 })
  })
})
