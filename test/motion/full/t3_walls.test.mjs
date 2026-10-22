// Full tier: re-runs the study's vertical-wall suite t3 (reference/t3_walls.mjs, unchanged) with the
// archived settings and compares its whole output with archive/t3_walls_top415_out.txt.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { runReference } from './runReference.mjs'

// The settings of the archived run (proto/verify/inclined/mover_fix/run_all.sh, step 6).
const SETTINGS = { TOP: '4.15', MOVERS: '[["adopted",{"fix":false}],["U+RS",{"fix":true}]]' }
const ARCHIVE = new URL('../reference/archive/t3_walls_top415_out.txt', import.meta.url)

// The S1 rows' sixth field is the mean time per sample, the only value that differs between runs.
function maskTiming(line) {
  if (!/^ {2}L\d+ split /.test(line)) return line
  const fields = line.split(' / ')
  fields[5] = '*'
  return fields.join(' / ')
}
const rows = (text) => text.replace(/\n$/, '').split('\n').map(maskTiming)

it('t3 at cylinder top 4.15 (movers adopted and U+RS) reproduces the archived output on Rapier 0.14.0', async () => {
  expect(RAPIER_VERSION).toBe('0.14.0')
  expect(rows(await runReference('t3_walls.mjs', SETTINGS))).toEqual(rows(readFileSync(ARCHIVE, 'utf8')))
})
