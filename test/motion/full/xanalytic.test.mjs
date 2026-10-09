// Full tier: re-runs X11, the independent check of the analytic distance measures
// (reference/xanalytic.mjs), and compares its output with archive/X11_analytic_out.txt byte for byte.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { runReference } from './runReference.mjs'

const ARCHIVE = new URL('../reference/archive/X11_analytic_out.txt', import.meta.url)

it('X11 (analytic distances against Rapier and a brute-force minimum) reproduces the archived output', async () => {
  expect(RAPIER_VERSION).toBe('0.14.0')
  expect(await runReference('xanalytic.mjs')).toBe(readFileSync(ARCHIVE, 'utf8'))
})
