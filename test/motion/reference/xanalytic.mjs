// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/verify/xanalytic.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   c1f2f8af39658f244b9527d1e527ebb815fc8a09a463c8fa163f220c07b12d18, last modified 2026-10-07
//   21:56.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: X11 of the independent verification of the study: checks the analytic distance
//   measures of lib/geom.mjs and of approach A (proxy/) against Rapier's projectPoint and against a
//   brute-force minimum over the agent cylinder. Its run wrote archive/X11_analytic_out.txt, which
//   test/motion/full/xanalytic.test.mjs reproduces.
// Changes from the source: The four import paths. Rapier comes from ./lib/rapier.mjs instead of
//   approach A's scene.mjs (both load the pinned 0.14.0 CommonJS build and call init()); the other
//   modules are the copies in this folder.
// -------------------------------------------------------------------------------------------------
// X11: independent cross-check of the analytic penetration measures used by approaches A and B (and the ones this verification
// borrows from A). For the same geometry, compares
//   (1) point SDFs: A's lib/geom.mjs (Sphere, Box, Frustum) vs B's lib/geom.mjs pointSD (sphere, slab pieces, cone) vs Rapier's
//       projectPoint (distance outside only), at random points;
//   (2) cylinder-to-shape gaps (vertical agent cylinder r 0.5, feet + 0.3 .. feet + top, top 2.0 and 4.15): A's minOverCyl (grid +
//       pattern search), B's agentGap (closed forms: ball; face half-space; cone 2-D section) and B's cylMinSDF, against a brute-force
//       minimum of the exact SDF over 720 x 241 side points + 3 x 360 x 60 cap points written here (dense sampling of the cylinder
//       boundary; for separated convex shapes the minimum over the solid cylinder is on its boundary).
// Poses: random, within 0.3 of contact on the open side (gap -0.05 .. 0.3 by B's closed form), 300 per shape and top.
import { R } from './lib/rapier.mjs'
import { Sphere, Box, Frustum } from './proxy/geom.mjs'
import { minOverCyl } from './proxy/checks.mjs'
import { slab, sphere, cone, agentGap, pointSD, cylMinSDF } from './lib/geom.mjs'
let s = 12345; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
const fmtE = (v) => v.toExponential(2)
function brute(sdf, ax, az, ya, yb, r) {
  let m = Infinity
  for (let i = 0; i < 720; i++) { const t = (2 * Math.PI * i) / 720, x = ax + r * Math.cos(t), z = az + r * Math.sin(t)
    for (let j = 0; j <= 240; j++) { const v = sdf(x, ya + ((yb - ya) * j) / 240, z); if (v < m) m = v } }
  for (const y of [ya, yb]) for (let i = 0; i < 360; i++) { const t = (2 * Math.PI * i) / 360; for (let j = 1; j <= 60; j++) { const rr = (r * j) / 60, v = sdf(ax + rr * Math.cos(t), y, az + rr * Math.sin(t)); if (v < m) m = v } }
  return m
}
const out = []
// geometry: B objects and the equivalent A objects
const cases = []
for (const th of [35, 60, 120, 145]) { const o = slab({ th, fx: 0, fz: 0, hyaw: 0, W: 10, L: 12, T: 1 })
  const A = o.pieces.map((pc) => Box('slab piece', pc.c, pc.half, o.rot)), sdfA = (x, y, z) => Math.min(...A.map((b) => b.sdf(x, y, z)))
  cases.push({ name: `slab ${th} deg`, B: o, sdfA, sdfB: (x, y, z) => pointSD(o, x, y, z), open: (x, y, z) => o.n[0] * x + o.n[1] * y + o.n[2] * z > 0, colliders: (w) => o.pieces.map((pc) => w.createCollider(R.ColliderDesc.cuboid(pc.half[0], pc.half[1], pc.half[2]).setTranslation(pc.c[0], pc.c[1], pc.c[2]).setRotation(o.rot))) }) }
for (const Rr of [3, 25]) { const o = sphere(0, Rr, 0, Rr), A = Sphere('s', 0, Rr, 0, Rr)
  cases.push({ name: `ball R${Rr}`, B: o, sdfA: A.sdf, sdfB: (x, y, z) => pointSD(o, x, y, z), open: () => true, colliders: (w) => [w.createCollider(R.ColliderDesc.ball(Rr).setTranslation(0, Rr, 0))] }) }
for (const inv of [false, true]) { const o = cone(0, 0, 10, 20, inv, 0), A = inv ? Frustum('c', 0, 0, 0, 0, 20, 10) : Frustum('c', 0, 0, 0, 10, 20, 0)
  cases.push({ name: `cone ${inv ? 'inverted' : 'upright'}`, B: o, sdfA: A.sdf, sdfB: (x, y, z) => pointSD(o, x, y, z), open: () => true, colliders: null }) }
out.push('(1) point SDF: max |A - B| and max |A - Rapier projectPoint distance| (points outside, 4,000 random points within 3 units of the surface)')
for (const c of cases) {
  let dAB = 0, dAR = 0, nR = 0
  const w = new R.World({ x: 0, y: -981, z: 0 }); const cols = c.colliders ? c.colliders(w) : []; w.step()
  for (let i = 0; i < 4000; i++) { const x = -15 + 30 * rnd(), y = -1 + 30 * rnd(), z = -12 + 24 * rnd(), a = c.sdfA(x, y, z), b = c.sdfB(x, y, z)
    if (Math.abs(a) > 3) { i--; continue } dAB = Math.max(dAB, Math.abs(a - b))
    if (cols.length && a > 0) { let best = Infinity; for (const col of cols) { const pr = col.projectPoint({ x, y, z }, false); if (pr && !pr.isInside) best = Math.min(best, Math.hypot(pr.point.x - x, pr.point.y - y, pr.point.z - z)) } if (best < Infinity) { dAR = Math.max(dAR, Math.abs(best - a)); nR++ } } }
  out.push(`  ${c.name.padEnd(15)} |A-B| max ${fmtE(dAB)}   |A-Rapier| max ${nR ? fmtE(dAR) + ' (' + nR + ' points)' : '-'}`)
  w.free()
}
out.push('(2) cylinder gap: max |method - brute force| over 300 random near-contact poses per shape and top (A minOverCyl; B closed form agentGap; B cylMinSDF)')
for (const c of cases) for (const top of [2.0, 4.15]) {
  let eA = 0, eB = 0, eC = 0, n = 0, gmin = Infinity, gmax = -Infinity, tries = 0
  while (n < 300 && tries < 200000) { tries++
    const ax = -16 + 32 * rnd(), az = -9 + 18 * rnd(), feet = 0
    const g = agentGap(c.B, ax, az, feet + 0.3, feet + top, 0.5); if (!(g > -0.05 && g < 0.3)) continue
    if (c.B.t === 'slab') { // the closed form is the face half-space: only valid while the closest point is on the face interior
      const u = c.B.u, along = ax * u[0] + az * u[2]; if (Math.abs(along) > 8) continue }
    const bf = brute(c.sdfA, ax, az, feet + 0.3, feet + top, 0.5)
    const a = minOverCyl(c.sdfA, ax, az, 0.5, feet + 0.3, feet + top), cm = cylMinSDF(c.sdfB, ax, az, feet + 0.3, feet + top, 0.5)
    eA = Math.max(eA, Math.abs(a - bf)); eB = Math.max(eB, Math.abs(g - bf)); eC = Math.max(eC, Math.abs(cm - bf)); n++; gmin = Math.min(gmin, bf); gmax = Math.max(gmax, bf) }
  out.push(`  ${c.name.padEnd(15)} top ${top}: poses ${n} (brute-force gap ${gmin.toFixed(3)}..${gmax.toFixed(3)})  |A minOverCyl - brute| max ${fmtE(eA)}  |B closed form - brute| max ${fmtE(eB)}  |B cylMinSDF - brute| max ${fmtE(eC)}`)
}
out.push('Brute-force resolution: side 0.5-degree x (top - 0.3) / 240 in height, caps 1 degree x r / 60: it over-estimates the true minimum by at most ~ r (1 - cos 0.25 deg) + slope x half-step, ~1e-3 on tilted faces;')
out.push('so differences of order 1e-3 mean agreement within the brute force resolution, and a method BELOW the brute force by more than that would indicate brute-force undersampling, not method error.')
console.log(out.join('\n'))
