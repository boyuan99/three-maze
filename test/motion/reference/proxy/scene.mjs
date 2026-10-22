// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: proto/verify/inclined/proxy/lib/scene.mjs in the separate three-maze-notes
//   repository (design-review workspace). SHA-256
//   6ef5b9830e8f7a3eca02a4de03de4c4ac6b169741073d61d92031bf1d008d26f, last modified 2026-10-07
//   20:23. The verification ran its byte-identical copy verify/A_copy/lib/scene.mjs (copied 21:42).
// Copied: 2026-10-22 (roadmap phase 1, MOT-05a).
// What it is: Approach A's scene builder. In mode 'true' (and in mode 'proxy' for scenes without
//   inclined objects) it builds the worlds of the cross-tests the verification ran with the
//   adopted mover (verify/xdirected.mjs, xsoak.mjs, xscenes.mjs, xramp_side.mjs: approach A's
//   scenes with the objects' own colliders), which ADR-0001 Validation 5 takes from the Evidence.
// Changes from the source: Rapier comes from ../lib/rapier.mjs (the build installed in this
//   repository, the pinned 0.14.0, initialised there) instead of an absolute path to
//   rapier.cjs.js in the development PC's checkout plus R.init() here. Both are the same build.
// -------------------------------------------------------------------------------------------------
// World construction for proxy-mode (the compiler rule) and true-mode (no proxies: the shapes' own colliders, the baseline).
import { proxyPieces, distFpRect, qYaw, polyArea, sdFp } from './geom.mjs'
import { CAM } from './checks.mjs'
import { R } from '../lib/rapier.mjs'
export { R }

const grp = (m, f) => ((m << 16) | f) >>> 0
export const G_FLOOR = grp(1, 0xffff), G_WALL = grp(2, 0xffff) // agent = grp(4, 1 | 2) inside the mover

// Named rule variants (second attempt). 'final' is the proposed ADR rule; the others are kept for comparison.
//  final      : ONE prism over [lo, hi + eye + 0.1] (the task's starting rule), walkable levels within fall reach, round footprints
//               as circumscribed 32-gon hull prisms, other hull pieces <= 20 across, rectangles as cuboids <= 40
//  ladder     : prisms eye + 0.2 tall every 2.1 from lo (tighter gaps at the lower level, but its upper prisms overhang the lower
//               level: a step-up under them is a guard revert, ledge.mjs), fall reach, 32-gons
//  perlevel   : one prism per adjacent level (+ fill-in levels <= 1.9 apart), fall reach, 32-gons
//  single-cyl : the first attempt's 'proxy single' (no fall reach, round footprints as Rapier cylinders)
//  ladder-cyl : the first attempt's 'proxy ladder' (no fall reach, Rapier cylinders)
//  hull40     : the first attempt's 'hull' (single band, every piece a convex-hull prism up to 40 across, no 20 cap)
//  true       : no proxies: every object keeps its own exact collider (the baseline that creeps)
export const VARIANTS = {
  final: ['proxy', { bandOpt: { fallReach: true }, proxyOpt: { circleAs: 'ngon' } }],
  ladder: ['proxy', { bandOpt: { ladder: true, fallReach: true }, proxyOpt: { circleAs: 'ngon' } }],
  perlevel: ['proxy', { bandOpt: { perLevel: true, fallReach: true }, proxyOpt: { circleAs: 'ngon' } }],
  'single-cyl': ['proxy', { bandOpt: {}, proxyOpt: { circleAs: 'cylinder' } }],
  'ladder-cyl': ['proxy', { bandOpt: { ladder: true }, proxyOpt: { circleAs: 'cylinder' } }],
  hull40: ['proxy', { bandOpt: {}, proxyOpt: { allHull: true } }],
  true: ['true', {}],
}
export const buildVariant = (spec, name) => { const v = VARIANTS[name]; if (!v) throw new Error('unknown variant ' + name); return buildScene(spec, v[0], v[1]) }

// The band rule. walk: walkable regions [{ rect: [x0, x1, z0, z1], y }] (tops of floors, platforms, steps).
// Adjacent levels: regions whose rectangle comes within dAdj of the object's FULL footprint (projection of the whole object).
export function band(obj, walk, { eye = CAM.eye, margin = 0.1, dAdj = 1, fallReach = false, vmax = 141, g = 981 } = {}) {
  const full = obj.footprint(obj.ymin - 1, obj.ymax + 1)
  let levels = [...new Set(walk.filter((wk) => distFpRect(full, wk.rect) <= dAdj).map((wk) => wk.y))].sort((a, b) => a - b)
  // fallReach: a higher walkable region also counts when an agent walking off it can drift to within dAdj of the object while it falls
  // to the lowest adjacent level: horizontal reach dAdj + vmax * sqrt(2 (h - lo) / g)
  if (fallReach && levels.length) { const lo = levels[0]
    levels = [...new Set([...levels, ...walk.filter((wk) => wk.y > lo && distFpRect(full, wk.rect) <= dAdj + vmax * Math.sqrt((2 * (wk.y - lo)) / g)).map((wk) => wk.y)])].sort((a, b) => a - b) }
  if (!levels.length) throw new Error(`no walkable level near ${obj.name}`)
  const lo = levels[0], hi = levels[levels.length - 1]
  return { ya: lo, yb: hi + eye + margin, lo, hi, levels }
}
// Variant 'perlevel': one prism per adjacent level h over F(h, h + eye + margin) spanning [h, h + eye + margin], plus virtual levels
// so that consecutive levels are at most `maxGap` apart (a falling agent's body, top 2.0 above its feet, must keep touching a prism
// that covers its camera: needs a level in [f - (margin - nearHalfHeight), f + 2.0) for every feet height f of a fall).
// Variant 'ladder': prisms over F(a_k, a_k + eye + 0.2) spanning [a_k, a_k + eye + 0.2], a_k = lo + 2.1 k, until a_k >= hi - 0.12.
// Coverage: an agent with feet f needs a prism whose range contains its camera band [f + eye - 0.077, f + eye + 0.077] and overlaps its
// body [f + 0.3, f + 2.0]: a_k in [f - 0.123, f + 2.0), an interval of 2.123 > 2.1. Non-blocking: the prism above an agent standing on
// a level starts >= 0.1 above its body top (> the 0.02 KCC offset), so a lower-level agent only meets the prism built for its own band.
export function ladderBands(bd, { eye = CAM.eye, step = 2.1, extra = 0.2 } = {}) {
  const out = []
  for (let a = bd.lo; ; a += step) { out.push({ ya: a, yb: a + eye + extra }); if (a >= bd.hi - 0.12) break }
  return out
}
export function perLevelBands(bd, { eye = CAM.eye, margin = 0.1, maxGap = 1.9 } = {}) {
  const hs = []
  for (let i = 0; i < bd.levels.length; i++) { const h = bd.levels[i]; hs.push(h)
    const nxt = bd.levels[i + 1]; if (nxt !== undefined) { const k = Math.ceil((nxt - h) / maxGap - 1e-9); for (let j = 1; j < k; j++) hs.push(h + ((nxt - h) * j) / k) } }
  return hs.map((h) => ({ ya: h, yb: h + eye + margin }))
}

// runtime check of the compiler output: random points of (shape ∩ band) must lie inside the union of the proxy footprints
let seed = 1
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
export function assertContains(o, ya, yb, pcs, n = 20000) {
  const [bx, bz, br] = o.bc, y0 = Math.max(ya, o.ymin), y1 = Math.min(yb, o.ymax); if (y0 >= y1) return
  let inside = 0
  for (let i = 0; i < n; i++) { const x = bx + (2 * rnd() - 1) * br, z = bz + (2 * rnd() - 1) * br, y = y0 + rnd() * (y1 - y0)
    if (o.sdf(x, y, z) >= 0) continue; inside++
    let best = Infinity; for (const P of pcs) best = Math.min(best, sdFp(P.fp, x, z))
    if (best > 1e-7) throw new Error(`proxy of ${o.name} misses a point of the shape: (${x}, ${y}, ${z}) is ${best} outside`) }
  if (inside < 50) throw new Error(`containment check of ${o.name}: only ${inside} interior samples`)
}
const rectPoly = (cx, cz, hx, hz, phi = 0) => { const c = Math.cos(phi), s = Math.sin(phi)
  const V = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]].map(([u, v]) => [cx + u * c - v * s, cz + u * s + v * c]); return polyArea(V) > 0 ? V : V.reverse() }

// boxes: axis-aligned-in-yaw vertical cuboids {cx, cz, hx, hz, phi, y0, y1, floor?}; split along their long axis to <= 40 (R5.2)
export function splitBox(b, cap = 40) { // equal flush pieces, every extent <= cap (both horizontal axes)
  const nx = Math.max(1, Math.ceil((2 * b.hx) / cap - 1e-9)), nz = Math.max(1, Math.ceil((2 * b.hz) / cap - 1e-9))
  const out = [], c = Math.cos(b.phi || 0), s = Math.sin(b.phi || 0), hx = b.hx / nx, hz = b.hz / nz
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) { const lx = -b.hx + hx * (2 * i + 1), lz = -b.hz + hz * (2 * j + 1)
    out.push({ ...b, cx: b.cx + lx * c - lz * s, cz: b.cz + lx * s + lz * c, hx, hz }) }
  return out
}

// spec: { floor: [x0, x1, z0, z1] (top at y = 0, not capped: nothing is lower), boxes: [...] (walls, platforms, steps: capped),
//         objects: [true shapes] (inclined: proxied in 'proxy' mode), walkTrue: [true shapes kept as colliders (walkable ramps)],
//         walk: walkable regions for the band rule }
export function buildScene(spec, mode = 'proxy', { proxyOpt = {}, bandOpt = {} } = {}) {
  const w = new R.World({ x: 0, y: -981, z: 0 }); w.timestep = 1 / 120
  const [x0, x1, z0, z1] = spec.floor
  w.createCollider(R.ColliderDesc.cuboid((x1 - x0) / 2, 0.5, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, -0.5, (z0 + z1) / 2).setCollisionGroups(G_FLOOR))
  const prisms = [] // analytic vertical prisms for the overlap check: {fp, ya, yb, kind, obj?}
  for (const b0 of spec.boxes || []) for (const b of splitBox(b0)) {
    w.createCollider(R.ColliderDesc.cuboid(b.hx, (b.y1 - b.y0) / 2, b.hz).setTranslation(b.cx, (b.y0 + b.y1) / 2, b.cz).setRotation(qYaw(b.phi || 0)).setCollisionGroups(b.floor ? G_FLOOR : G_WALL))
    prisms.push({ fp: { kind: 'poly', V: rectPoly(b.cx, b.cz, b.hx, b.hz, b.phi || 0) }, ya: b.y0, yb: b.y1, kind: b.floor ? 'platform' : 'wall' })
  }
  const objs = spec.objects || [], bands = []
  for (let oi = 0; oi < objs.length; oi++) {
    const o = objs[oi]
    if (mode === 'proxy') {
      const bd = band(o, spec.walk, bandOpt), slabs = bandOpt.ladder ? ladderBands(bd) : bandOpt.perLevel ? perLevelBands(bd, bandOpt) : [{ ya: bd.ya, yb: bd.yb }]
      bands.push({ ...bd, slabs: slabs.map((q) => ({ ...q, fp: o.footprint(q.ya, q.yb) })) })
      for (const q of slabs) { const pcs = proxyPieces(o.footprint(q.ya, q.yb), q.ya, q.yb, proxyOpt)
        assertContains(o, q.ya, q.yb, pcs)
        for (const P of pcs) { const d = P.desc(R); if (!d) throw new Error('convex hull failed for ' + o.name)
          w.createCollider(d.setCollisionGroups(G_WALL)); prisms.push({ ...P, kind: 'proxy', obj: oi }) } }
    } else { bands.push(null); for (const d of o.trueColliders(R)) w.createCollider(d.setCollisionGroups(G_WALL)) }
  }
  for (const o of spec.walkTrue || []) for (const d of o.trueColliders(R)) w.createCollider(d.setCollisionGroups(G_FLOOR))
  w.step()
  return { w, prisms, bands, objs, walkTrue: spec.walkTrue || [] }
}
