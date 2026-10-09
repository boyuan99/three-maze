// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/mover_fix/t3_walls.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   34be2c53a7330905d262ab039b1f5f6d545683797a9a4494e7a315d62f0e85fa, last modified 2026-10-07
//   20:38.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: The study's vertical-wall regression suite t3: the adjudication's s1, s1b, s2, s3a-e
//   and s3g on the per-sample movers. Run with TOP=4.15 and the movers adopted and U+RS
//   (mover_fix/run_all.sh), it wrote archive/t3_walls_top415_out.txt, which
//   test/motion/full/t3_walls.test.mjs reproduces.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// t3: vertical-wall regression suite, ported from adjudicator/s1_slide, s1b, s2_thin, s3_seams, s3b, s3c, s3d, s3e,
// s3g_trimesh to the PER-SAMPLE body-less movers (the originals drove the 120 Hz rigid-body prototype). Same geometry
// (common.mjs buildWorld: walls group 2, floor group 1), same displacement sequences, analytic overlap (common.mjs
// worstPen: depth of the r = 0.5 footprint in the wall footprint; overlap = depth > 0.02).
// Movers: adopted composite; fix variant T with epsV 1e-4 and 0.02 (near-vertical contacts keep the KCC's slide);
// fix variant U (allWalls: every non-walkable contact takes the horizontal-wall rule); T and U as in the first attempt
// (no recovery, no steep-floor slide); U+RS = U with both (the final mover). Top from env TOP (default 2.0).
// Each case also reports how many runs are bit-identical to the adopted mover and the largest pose difference.
import { R } from './lib/rapier.mjs' // env RAPIER selects the Rapier build (default: pinned 0.14.0)
import { buildWorld, worstPen, fmt } from './lib/walls.mjs' // copies of adjudicator/common.mjs and s4_obstacles.mjs
import { makeHover } from './lib/hover.mjs'
const MOVERS = (process.env.MOVERS ? JSON.parse(process.env.MOVERS) : [['adopted', { fix: false }], ['T 1e-4', { fix: true, allWalls: false, epsV: 1e-4, recover: false, slideSteep: false }], ['T 0.02', { fix: true, allWalls: false, epsV: 0.02, recover: false, slideSteep: false }], ['U', { fix: true, recover: false, slideSteep: false }], ['U+RS', { fix: true }]])
const TOP = +(process.env.TOP || 2.0)
const regimes = [['120/s v30', 30 / 120, 1 / 120], ['120/s v141', 141 / 120, 1 / 120], ['20/s v100', 100 / 20, 1 / 20]]
const only = process.argv[2] ? process.argv[2].split(',') : null
const want = (k) => !only || only.includes(k)
// run every mover on one world/input sequence; returns per-mover {P (x,z per sample), st, us}
function simulate(mkWorld, x0, z0, inputs, stopFn) {
  const res = []
  for (const [name, mo] of MOVERS) {
    const { w } = mkWorld(); const m = makeHover(R, w, x0, z0, { top: TOP, ...mo })
    const P = new Float64Array(2 * inputs.length); let us = 0, n = 0
    for (let i = 0; i < inputs.length; i++) { const [dx, dz, dt] = inputs[i]; const t0 = process.hrtime.bigint(); m.move(dx, dz, dt); us += Number(process.hrtime.bigint() - t0) / 1e3
      const p = m.pos(); P[2 * i] = p.x; P[2 * i + 1] = p.z; n++; if (stopFn && stopFn(p)) break }
    res.push({ name, P: P.subarray(0, 2 * n), n, st: { ...m.st }, us: us / n }); w.free()
  }
  const ref = res[0]
  for (const r of res) { let same = r.n === ref.n, dmax = 0; for (let i = 0; i < Math.min(r.n, ref.n); i++) { const d = Math.hypot(r.P[2 * i] - ref.P[2 * i], r.P[2 * i + 1] - ref.P[2 * i + 1]); if (d !== 0) same = false; if (d > dmax) dmax = d } r.same = same; r.dmax = dmax }
  return res
}
const ident = {} // per mover: [identical runs, runs, max diff, guard reverts, recoveries, recoveries that came out clear]
const noteIdent = (res) => { for (const r of res) { const a = ident[r.name] || (ident[r.name] = [0, 0, 0, 0, 0, 0]); a[0] += r.same ? 1 : 0; a[1]++; a[2] = Math.max(a[2], r.dmax); a[3] += r.st.reverts; a[4] += r.st.recoveries || 0; a[5] += r.st.recoverOk || 0 } }
const out = []
// ---------------- S1: long walls ----------------
if (want('s1')) {
  out.push('S1 long walls (face x = 10): L 200/400/600, split none/40, angles 1/5/15/30/75 deg, regimes ' + regimes.map((r) => r[0]).join(', '))
  out.push('  cells: worst overlap depth / samples with depth > 0.02 / crossings / min retention % / max lateral range after first touch / us per sample / guard reverts / recoveries / fix contacts')
  for (const L of [200, 400, 600]) for (const split of [0, 40]) {
    const obs = [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: L / 2 }]
    const agg = {}
    for (const [rn, step, dt] of regimes) for (const ang of [1, 5, 15, 30, 75]) {
      const a = (ang * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step
      const N = Math.floor((L - 20) / (step * Math.cos(a))), inputs = Array.from({ length: N }, () => [dx, dz, dt])
      const res = simulate(() => buildWorld(obs, { split, floor: [-20, 30, -L / 2 - 20, L / 2 + 20] }), 8, L / 2 - 10, inputs)
      noteIdent(res)
      for (const r of res) { const A = agg[r.name] || (agg[r.name] = { pen: -1e9, n02: 0, cross: 0, minKeep: 1e9, jit: 0, us: 0, k: 0, rev: 0, rec: 0, incl: 0 })
        let touched = false, lo = 1e9, hi = -1e9, za = 0, zc = 0, zb = L / 2 - 10
        for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1], d = worstPen(obs, x, z); A.pen = Math.max(A.pen, d); if (d > 0.02) A.n02++; if (x > 11) A.cross++
          if (x >= 9.47) touched = true; if (touched) { lo = Math.min(lo, x); hi = Math.max(hi, x); za += zb - z; zc += -dz } zb = z }
        if (touched && zc > 5) { A.minKeep = Math.min(A.minKeep, (100 * za) / zc); A.jit = Math.max(A.jit, hi - lo) }
        A.us += r.us; A.k++; A.rev += r.st.reverts; A.rec += r.st.recoveries || 0; A.incl += r.st.incl }
    }
    for (const [name, A] of Object.entries(agg)) out.push(`  L${L} split ${String(split || '-').padStart(2)} ${name.padEnd(8)} ${fmt(A.pen)} / ${A.n02} / ${A.cross} / ${fmt(A.minKeep, 1)} / ${fmt(A.jit)} / ${fmt(A.us / A.k, 1)} / ${A.rev} / ${A.rec} / ${A.incl}`)
  }
}
// ---------------- S2: thin walls ----------------
if (want('s2')) {
  out.push('', 'S2 thin wall (0.1 thick, faces x = 10 / 10.1): Lw 40/400/1200, split none/40, 141-1000 units/s at 120 and 20 samples/s, incidence 90/20/5 deg, 20 start phases')
  const cases = [['120/s', 141], ['120/s', 300], ['120/s', 1000], ['20/s', 141], ['20/s', 1000]]
  for (const Lw of [40, 400, 1200]) for (const split of Lw > 40 ? [0, 40] : [0]) {
    const agg = {}
    for (const [reg, v] of cases) for (const inc of [90, 20, 5]) {
      const rate = reg === '120/s' ? 120 : 20, step = v / rate, a = (inc * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step
      for (let ph = 0; ph < 20; ph++) {
        const x0 = 9.48 - dx * (1 + ph / 20) - 0.5, K = Math.ceil((11.1 - x0) / dx) + 1
        if (K * Math.abs(dz) > Lw - 4) break
        const obs = [{ t: 'box', cx: 10.05, cz: 0, hx: 0.05, hz: Lw / 2 }]
        const res = simulate(() => buildWorld(obs, { split, floor: [-100, 120, -Lw / 2 - 60, Lw / 2 + 60] }), x0, (K * Math.abs(dz)) / 2, Array.from({ length: K }, () => [dx, dz, 1 / rate]))
        noteIdent(res)
        for (const r of res) { const A = agg[r.name] || (agg[r.name] = { through: 0, worst: -1e9, runs: 0 }); A.runs++
          let px = x0, pz = (K * Math.abs(dz)) / 2
          for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; A.worst = Math.max(A.worst, worstPen(obs, x, z)); const inside = (zz) => Math.abs(zz) < Lw / 2 - 0.5
            if (px < 10.05 && x > 10.05 && inside(pz) && inside(z)) { A.through++; break } px = x; pz = z } }
      }
    }
    for (const [name, A] of Object.entries(agg)) out.push(`  Lw ${String(Lw).padStart(4)} split ${String(split || '-').padStart(2)} ${name.padEnd(8)} runs ${A.runs} tunnels ${A.through} worst overlap ${fmt(A.worst)}`)
  }
}
// ---------------- S3: seams, T-junction, corner, wedges ----------------
if (want('s3')) {
  out.push('', 'S3a coplanar seam (two boxes meet at z = 0, second proud by lip, T stem behind): cells angle: worst overlap / lateral range |z|<20 / min per-sample progress ratio |z|<20')
  for (const lip of [0, 0.001, -0.001]) for (const [rn, step, dt] of regimes) {
    const rows = {}
    for (const ang of [5, 30, 75]) {
      const obs = [{ t: 'box', cx: 10.5, cz: 50, hx: 0.5, hz: 50 }, { t: 'box', cx: 10.5 - lip, cz: -50, hx: 0.5, hz: 50 }, { t: 'box', cx: 26, cz: 0, hx: 15, hz: 0.5 }]
      const a = (ang * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step, N = Math.ceil(140 / (step * Math.cos(a)))
      const res = simulate(() => buildWorld(obs, { floor: [-20, 50, -120, 120] }), 9.3, 70, Array.from({ length: N }, () => [dx, dz, dt]), (p) => p.z < -60)
      noteIdent(res)
      for (const r of res) { let pen = -1e9, lo = 1e9, hi = -1e9, minProg = 1e9, touched = false, zb = 70
        for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; pen = Math.max(pen, worstPen(obs, x, z)); if (x >= 9.45 - lip) touched = true
          if (touched && Math.abs(z) < 20) { lo = Math.min(lo, x); hi = Math.max(hi, x); minProg = Math.min(minProg, (zb - z) / -dz) } zb = z }
        ;(rows[r.name] = rows[r.name] || []).push(`${ang}deg ${fmt(pen)}/${fmt(hi - lo)}/${fmt(minProg, 2)}`) }
    }
    for (const [name, cells] of Object.entries(rows)) out.push(`  lip ${String(lip).padStart(6)} ${rn.padEnd(10)} ${name.padEnd(8)} ${cells.join('  ')}`)
  }
  out.push('', 'S3b T-junction (stem walls x = +-5, far wall z = 10, legs as s3_seams): worst overlap / zero-progress samples / final position')
  for (const split of [0, 40]) for (const [rn, step, dt] of regimes) {
    const obs = [{ t: 'box', cx: 5.5, cz: -50, hx: 0.5, hz: 50 }, { t: 'box', cx: -5.5, cz: -50, hx: 0.5, hz: 50 }, { t: 'box', cx: 0, cz: 10.5, hx: 60, hz: 0.5 },
      { t: 'box', cx: 32.5, cz: -0.5, hx: 27.5, hz: 0.5 }, { t: 'box', cx: -32.5, cz: -0.5, hx: 27.5, hz: 0.5 }, { t: 'box', cx: 60.5, cz: 5, hx: 0.5, hz: 6 }, { t: 'box', cx: -60.5, cz: 5, hx: 0.5, hz: 6 }, { t: 'box', cx: 0, cz: -100.5, hx: 6, hz: 0.5 }]
    const inputs = []
    for (const [ux, uz, dist] of [[0.15, 1, 100], [1, 0.15, 60], [1, -0.1, 40], [-1, 0.2, 120], [0.05, -1, 20]]) { const l = Math.hypot(ux, uz); for (let i = 0; i < Math.ceil(dist / step); i++) inputs.push([(ux / l) * step, (uz / l) * step, dt]) }
    const res = simulate(() => buildWorld(obs, { split, floor: [-70, 70, -110, 20] }), 3, -90, inputs); noteIdent(res)
    for (const r of res) { let pen = -1e9, stuck = 0, lx = 3, lz = -90; for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; pen = Math.max(pen, worstPen(obs, x, z)); if (Math.hypot(x - lx, z - lz) < 1e-6) stuck++; lx = x; lz = z }
      out.push(`  split ${String(split || '-').padStart(2)} ${rn.padEnd(10)} ${r.name.padEnd(8)} worst ${fmt(pen)} zero-progress ${stuck}/${r.n} final (${fmt(lx, 2)}, ${fmt(lz, 2)}) reverts ${r.st.reverts} rec ${r.st.recoveries || 0}`) }
  }
  out.push('', 'S3c inside corner 90 deg (push along the bisector) and wedges 30/60/90 deg (s3b/s3c geometry, push along the axis with 5% sideways): worst overlap / final / jitter over the last 100 samples')
  const wedge = (hdeg) => { const L = 60, h = (hdeg * Math.PI) / 180; return [-1, 1].map((sg) => ({ t: 'box', cx: sg * (Math.sin(h) * L / 2 + Math.cos(h) * 0.5), cz: -50 + Math.cos(h) * L / 2 - Math.sin(h) * 0.5, hx: 0.5, hz: L / 2, yaw: sg * hdeg })) }
  const geos = [['corner90', () => [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: 100 }, { t: 'box', cx: 0, cz: -100.5, hx: 11, hz: 0.5 }], [0, -80], [Math.SQRT1_2, -Math.SQRT1_2]],
    ['wedge30', () => wedge(15), [0.3, -10], [0.05, -1]], ['wedge60', () => wedge(30), [0.3, -10], [0.05, -1]], ['wedge90', () => wedge(45), [0.3, -10], [0.05, -1]]]
  for (const [gname, mk, [x0, z0], dir] of geos) for (const split of [0, 40]) for (const [rn, step, dt] of regimes) {
    const obs = mk(); const N = 300, inputs = Array.from({ length: N }, () => [dir[0] * step, dir[1] * step, dt])
    const res = simulate(() => buildWorld(obs, { split, floor: [-60, 60, -110, 60] }), x0, z0, inputs); noteIdent(res)
    for (const r of res) { let pen = -1e9; const xs = [], zs = []; for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; pen = Math.max(pen, worstPen(obs, x, z)); if (i >= r.n - 100) { xs.push(x); zs.push(z) } }
      out.push(`  ${gname.padEnd(8)} split ${String(split || '-').padStart(2)} ${rn.padEnd(10)} ${r.name.padEnd(8)} worst ${fmt(pen)} final (${fmt(xs.at(-1), 3)}, ${fmt(zs.at(-1), 3)}) jitter x ${fmt(Math.max(...xs) - Math.min(...xs), 4)} z ${fmt(Math.max(...zs) - Math.min(...zs), 4)} reverts ${r.st.reverts} rec ${r.st.recoveries || 0}`) }
  }
  out.push('', 'S3d retention near head-on (one 200-unit box, split 40, split 10), angles 60/80/85/88 deg; regimes + 1000/s v30: retention %')
  for (const [geo, split] of [['one 200-u box', 0], ['split <=40', 40], ['split <=10', 10]]) for (const [rn, step, dt] of [...regimes, ['1000/s v30', 30 / 1000, 1 / 1000]]) {
    const rows = {}
    for (const ang of [60, 80, 85, 88]) {
      const obs = [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: 100 }], a = (ang * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step
      const N = Math.min(40000, Math.ceil(100 / (step * Math.cos(a))))
      const res = simulate(() => buildWorld(obs, { split, floor: [-20, 50, -120, 120] }), 9.3, 70, Array.from({ length: N }, () => [dx, dz, dt]), (p) => p.z < -60); noteIdent(res)
      for (const r of res) { let touched = false, za = 0, zc = 0, pen = -1e9, zb = 70; for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; pen = Math.max(pen, worstPen(obs, x, z)); if (x >= 9.45) touched = true; if (touched) { za += zb - z; zc += -dz } zb = z }
        ;(rows[r.name] = rows[r.name] || []).push(`${ang}deg ${fmt((100 * za) / zc, 1)}%${pen > 0.02 ? ' OVERLAP ' + fmt(pen) : ''}`) }
    }
    for (const [name, cells] of Object.entries(rows)) out.push(`  ${geo.padEnd(14)} ${rn.padEnd(10)} ${name.padEnd(8)} ${cells.join('  ')}`)
  }
  out.push('', 'S3e seam trap test (s3e): seam at z = 0, push at 70-89 deg for 4000 samples at 0.25 (30 units/s, 120/s), second piece 1 or 2 thick: z after 1k/2k/3k/4k samples (free slide reaches the value in brackets)')
  for (const ang of [70, 75, 80, 85, 89]) for (const thickB of [1, 2]) {
    const obs = [{ t: 'box', cx: 10.5, cz: 50, hx: 0.5, hz: 50 }, { t: 'box', cx: 10 + thickB / 2, cz: -50, hx: thickB / 2, hz: 50 }]
    const step = 0.25, a = (ang * Math.PI) / 180, inputs = Array.from({ length: 4000 }, () => [Math.sin(a) * step, -Math.cos(a) * step, 1 / 120])
    const res = simulate(() => buildWorld(obs, { floor: [-20, 50, -120, 120] }), 9.4, 5, inputs); noteIdent(res)
    for (const r of res) out.push(`  ang ${ang} thick ${thickB} ${r.name.padEnd(8)} z ${[999, 1999, 2999, 3999].map((i) => fmt(r.P[2 * i + 1], 3)).join(' ')} (${fmt(5 - 4000 * step * Math.cos(a), 1)}) reverts ${r.st.reverts} rec ${r.st.recoveries || 0}`)
  }
}
// ---------------- S3g: trimesh walls ----------------
if (want('s3g')) {
  out.push('', 'S3g trimesh wall (near face x = 10, L 200, triangles 200/40/10 long, flags none / FIX_INTERNAL_EDGES|MERGE_DUPLICATE_VERTICES): cells regime/incidence: worst overlap, retention %')
  function boxTrimesh(hx, hy, hz, seg, flags) {
    const nz = Math.max(1, Math.round((2 * hz) / seg)), V = [], I = [], zs = Array.from({ length: nz + 1 }, (_, i) => -hz + (2 * hz * i) / nz)
    const idx = (x, y, z) => { V.push(x, y, z); return V.length / 3 - 1 }
    const ring = zs.map((z) => [idx(-hx, -hy, z), idx(hx, -hy, z), idx(hx, hy, z), idx(-hx, hy, z)])
    for (let i = 0; i < nz; i++) { const a = ring[i], b = ring[i + 1]; for (let k = 0; k < 4; k++) { const k2 = (k + 1) % 4; I.push(a[k], a[k2], b[k2], a[k], b[k2], b[k]) } }
    const e0 = ring[0], e1 = ring[nz]; I.push(e0[0], e0[2], e0[1], e0[0], e0[3], e0[2], e1[0], e1[1], e1[2], e1[0], e1[2], e1[3])
    return R.ColliderDesc.trimesh(new Float32Array(V), new Uint32Array(I), flags)
  }
  const L = 200
  for (const seg of [200, 40, 10]) for (const fl of [0, R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES]) {
    const rows = {}
    for (const [rn, step, dt] of regimes) for (const ang of [30, 85]) {
      const obs = [{ t: 'box', cx: 10.5, cz: 0, hx: 0.5, hz: L / 2 }]
      const mk = () => { const w = new R.World({ x: 0, y: -981, z: 0 }); w.timestep = 1 / 120
        w.createCollider(R.ColliderDesc.cuboid(40, 0.5, L / 2 + 30).setTranslation(0, -0.5, 0).setCollisionGroups(((1 << 16) | 0xffff) >>> 0))
        w.createCollider(boxTrimesh(0.5, 5, L / 2, seg, fl).setTranslation(10.5, 5, 0).setCollisionGroups(((2 << 16) | 0xffff) >>> 0)); w.step(); return { w } }
      const a = (ang * Math.PI) / 180, dx = Math.sin(a) * step, dz = -Math.cos(a) * step, N = Math.ceil((L - 50) / (step * Math.cos(a)))
      const res = simulate(mk, 9.3, L / 2 - 20, Array.from({ length: N }, () => [dx, dz, dt])); noteIdent(res)
      for (const r of res) { let touched = false, za = 0, zc = 0, pen = -1e9, zb = L / 2 - 20; for (let i = 0; i < r.n; i++) { const x = r.P[2 * i], z = r.P[2 * i + 1]; pen = Math.max(pen, worstPen(obs, x, z)); if (x >= 9.45) touched = true; if (touched) { za += zb - z; zc += -dz } zb = z }
        ;(rows[r.name] = rows[r.name] || []).push(`${rn}/${ang}: ${fmt(pen)} ${fmt((100 * za) / zc, 1)}%`) }
    }
    for (const [name, cells] of Object.entries(rows)) out.push(`  tri ${String(seg).padStart(3)} ${fl ? 'FIX_INTERNAL_EDGES' : 'no flags          '} ${name.padEnd(8)} ${cells.join(' | ')}`)
  }
}
out.push('', `Over every run above (top ${TOP}): runs bit-identical to the adopted mover / runs, largest pose difference; guard reverts; recoveries (clear)`)
for (const [name, a] of Object.entries(ident)) out.push(`  ${name.padEnd(8)} ${a[0]} / ${a[1]}  max |dpos| ${a[2].toExponential(2)}  guard reverts ${a[3]}  recoveries ${a[4]} (${a[5]})`)
console.log(out.join('\n'))
