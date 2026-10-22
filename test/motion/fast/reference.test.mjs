// Fast tier of the motion suite (runs under `npm test`): the vendored reference mover reproduces two
// rows of the archived t3 wall study number for number on Rapier 0.14.0 (test/motion/README.md).
// The full tier re-runs the whole study script instead (test/motion/full/).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { R, RAPIER_VERSION } from '../reference/lib/rapier.mjs'
import { buildWorld, fmt, worstPen } from '../reference/lib/walls.mjs'
import { makeHover } from '../reference/lib/hover.mjs'

const ARCHIVE = new URL('../reference/archive/t3_walls_top415_out.txt', import.meta.url)
// The adopted mover: variant U+RS with the cylinder top at eyeHeight + 0.45 (ADR-0001 R3).
const U_RS = ['U+RS', { fix: true, top: 4.15 }]

// One row of section S1 (long walls) of reference/t3_walls.mjs: its code for one wall length L, one
// split and one mover, over the same 15 runs (3 regimes x 5 angles). The row's sixth field, the
// mean time per sample, is not reproducible and is written as '*'.
function s1Row(L, split, [name, options]) {
  const regimes = [[30 / 120, 1 / 120], [141 / 120, 1 / 120], [100 / 20, 1 / 20]]
  const obs = [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: L / 2 }]
  const A = { pen: -1e9, n02: 0, cross: 0, minKeep: 1e9, jit: 0, rev: 0, rec: 0, incl: 0 }
  for (const [step, dt] of regimes) for (const ang of [1, 5, 15, 30, 75]) {
    const a = (ang * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step
    const N = Math.floor((L - 20) / (step * Math.cos(a)))
    const { w } = buildWorld(obs, { split, floor: [-20, 30, -L / 2 - 20, L / 2 + 20] })
    const m = makeHover(R, w, 8, L / 2 - 10, options)
    let touched = false, lo = 1e9, hi = -1e9, za = 0, zc = 0, zb = L / 2 - 10
    for (let i = 0; i < N; i++) {
      m.move(dx, dz, dt)
      const { x, z } = m.pos(), d = worstPen(obs, x, z)
      A.pen = Math.max(A.pen, d); if (d > 0.02) A.n02++; if (x > 11) A.cross++
      if (x >= 9.47) touched = true
      if (touched) { lo = Math.min(lo, x); hi = Math.max(hi, x); za += zb - z; zc += -dz }
      zb = z
    }
    if (touched && zc > 5) { A.minKeep = Math.min(A.minKeep, (100 * za) / zc); A.jit = Math.max(A.jit, hi - lo) }
    A.rev += m.st.reverts; A.rec += m.st.recoveries || 0; A.incl += m.st.incl
    w.free()
  }
  return `  L${L} split ${String(split || '-').padStart(2)} ${name.padEnd(8)} ${fmt(A.pen)} / ${A.n02} / ${A.cross} / ` +
    `${fmt(A.minKeep, 1)} / ${fmt(A.jit)} / * / ${A.rev} / ${A.rec} / ${A.incl}`
}

// The archived row for the same cell, its time per sample replaced by '*'.
function archivedRow(L, split, name) {
  const prefix = `  L${L} split ${String(split || '-').padStart(2)} ${name.padEnd(8)} `
  const row = readFileSync(ARCHIVE, 'utf8').split('\n').find((line) => line.startsWith(prefix))
  if (!row) throw new Error(`no archived row starts with '${prefix}'`)
  const fields = row.split(' / ')
  fields[5] = '*'
  return fields.join(' / ')
}

describe('vendored reference mover (fast tier)', () => {
  it('runs on the pinned Rapier 0.14.0, the build the archived numbers come from', () => {
    expect(RAPIER_VERSION).toBe('0.14.0')
  })

  // Columns: worst depth / samples deeper than the skin / crossings / min retention % / sideways range
  // / time per sample / guard reverts / recoveries / KCC wall contacts. A cylinder top of 4.0
  // instead of 4.15 already changes both rows.
  it.each([
    ['200-unit wall split into 40-unit pieces (ADR-0001 R5.2)', 200, 40],
    ['400-unit wall in one piece (outside R5.2; exercises the recovery R6)', 400, 0],
  ])('reproduces the archived S1 row: %s', (_, L, split) => {
    expect(s1Row(L, split, U_RS)).toBe(archivedRow(L, split, U_RS[0]))
  })
})
