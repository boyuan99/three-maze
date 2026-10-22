// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: proto/verify/inclined/proxy/lib/checks.mjs in the separate three-maze-notes
//   repository (design-review workspace). SHA-256
//   a9647559d4eed78707dada8496c6c72ad1e82248a4f15dcf37933700455eef60, last modified 2026-10-07
//   20:25. The verification ran its byte-identical copy verify/A_copy/lib/checks.mjs (copied
//   21:42).
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: Analytic measures of approach A. Only minOverCyl is used here, by xanalytic.mjs.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Analytic measurements (no Rapier queries).
//  proxyPen: overlap of the agent's r = 0.5 cylinder (feet+0.3 .. feet+2.0) with vertical prisms (proxies, walls, platform pieces):
//            pen = 0.5 - (2-D signed distance from the agent axis to the prism footprint) when the height ranges overlap.
//            The mover keeps pen <= -0.02 (the skin); "overlap" in ADR-0001 terms is pen > 0.02 (deeper than the skin).
//  minOverCyl: min of a TRUE shape's exact signed distance over a solid vertical cylinder (surface grid + pattern search;
//            the sdf of a convex shape is convex, so this converges to the minimum; accuracy checked in sanity.mjs).
//  cam: eye point (agent axis at feet + eye), near-plane rectangle at the actual yaw, and the yaw envelope (vertical cylinder of
//            radius hypot(near, halfWidth) and half-height halfHeight around the eye, which contains the near-plane rectangle and
//            the frustum tip between eye and near plane for EVERY yaw). Negative = the camera / near plane is inside the true shape.
//  gaps:     body = collision cylinder (r 0.5, feet+0.3..feet+2.0) to the true shape (vertical wall reference: 0.02);
//            col  = the agent column r 0.5 from the feet to the eye (vertical wall reference: 0.02);
//            eye  = eye point to the true shape (vertical wall reference: 0.52).
import { sdFp } from './geom.mjs'

export const CAM = (() => {
  const eye = +(process.env.EYE ?? 3.7), near = 0.1, vfov = 75, aspect = process.env.ASPECT ? process.env.ASPECT.split(/[/:x]/).map(Number).reduce((p, q) => p / q) : 16 / 9 // ASPECT='32/9' etc.
  const hh = near * Math.tan((vfov * Math.PI) / 360), hw = hh * aspect
  return { eye, near, vfov, aspect, hh, hw, rhoN: Math.hypot(near, hw), reach: Math.hypot(near, hw, hh) }
})()

export function proxyPen(pieces, x, feet, z) {
  let pen = -Infinity, idx = -1
  const b0 = feet + 0.3, b1 = feet + 2.0
  for (let i = 0; i < pieces.length; i++) {
    const P = pieces[i]; if (Math.min(b1, P.yb) - Math.max(b0, P.ya) <= 0) continue
    const q = 0.5 - sdFp(P.fp, x, z); if (q > pen) { pen = q; idx = i }
  }
  return { pen, idx }
}

function patternMin(F, p0, lo, hi, step0, iters = 80) {
  let p = p0.slice(), fp = F(p); const step = step0.slice()
  for (let it = 0; it < iters; it++) {
    let improved = false
    for (let d = 0; d < p.length; d++) for (const s of [1, -1]) {
      const q = p.slice(); q[d] = Math.min(hi[d], Math.max(lo[d], q[d] + s * step[d])); const fq = F(q)
      if (fq < fp) { p = q; fp = fq; improved = true }
    }
    if (!improved) { let done = true; for (let d = 0; d < step.length; d++) { step[d] *= 0.5; if (step[d] > 1e-7) done = false } if (done) break }
  }
  return fp
}

export function minOverCyl(f, cx, cz, r, y0, y1, nTh = 48, nY = 9, refine = 4) {
  const side = (th, y) => f(cx + r * Math.cos(th), y, cz + r * Math.sin(th))
  const disc = (y, rr, th) => f(cx + rr * Math.cos(th), y, cz + rr * Math.sin(th))
  const C = []
  for (let i = 0; i < nTh; i++) { const th = (2 * Math.PI * i) / nTh
    for (let j = 0; j < nY; j++) { const y = y0 + ((y1 - y0) * j) / (nY - 1); C.push([side(th, y), 0, th, y]) }
    for (const fr of [0.3, 0.65]) { C.push([disc(y0, fr * r, th), 1, fr * r, th]); C.push([disc(y1, fr * r, th), 2, fr * r, th]) } }
  C.push([disc(y0, 0, 0), 1, 0, 0], [disc(y1, 0, 0), 2, 0, 0], [f(cx, (y0 + y1) / 2, cz), 3, 0, 0])
  C.sort((a, b) => a[0] - b[0])
  let best = C[0][0]
  for (const c of C.slice(0, refine)) {
    if (c[1] === 0) best = Math.min(best, patternMin((q) => side(q[0], q[1]), [c[2], c[3]], [-Infinity, y0], [Infinity, y1], [(2 * Math.PI) / nTh, (y1 - y0) / (nY - 1)]))
    else if (c[1] !== 3) { const yy = c[1] === 1 ? y0 : y1; best = Math.min(best, patternMin((q) => disc(yy, q[0], q[1]), [c[2], c[3]], [0, -Infinity], [r, Infinity], [r / 3, (2 * Math.PI) / nTh])) }
  }
  return best
}

// heading h: forward (-sin h, 0, -cos h), right (cos h, 0, -sin h) (yaw 0 looks down -Z, left is -X).
export function cam(f, x, feet, z, h, exactBelow = 1.0) {
  const ey = feet + CAM.eye, fe = f(x, ey, z)
  if (fe > exactBelow) return { eye: fe, rect: fe - CAM.reach, env: fe - CAM.reach, bound: true }
  const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h)
  const cx = x + CAM.near * fx, cz = z + CAM.near * fz
  const Rf = (u, v) => f(cx + u * rx, ey + v, cz + u * rz)
  let best = Infinity, bp = null
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) { const u = -CAM.hw + (2 * CAM.hw * i) / 8, v = -CAM.hh + (2 * CAM.hh * j) / 4, val = Rf(u, v); if (val < best) { best = val; bp = [u, v] } }
  const rect = Math.min(best, patternMin((q) => Rf(q[0], q[1]), bp, [-CAM.hw, -CAM.hh], [CAM.hw, CAM.hh], [CAM.hw / 8, CAM.hh / 4]))
  const env = Math.min(minOverCyl(f, x, z, CAM.rhoN, ey - CAM.hh, ey + CAM.hh, 32, 3), fe)
  return { eye: fe, rect, env, bound: false }
}

export function gaps(f, x, feet, z, coarse = false) {
  const [nT, nY] = coarse ? [24, 5] : [48, 9]
  return { body: minOverCyl(f, x, z, 0.5, feet + 0.3, feet + 2.0, nT, nY), col: minOverCyl(f, x, z, 0.5, feet, feet + CAM.eye, nT, nY + 4), eye: f(x, feet + CAM.eye, z) }
}

// quick lower bound of the true-shape distance of the body cylinder (1-Lipschitz sdf): f(centre) - bounding radius
export const bodyLB = (f, x, feet, z) => f(x, feet + 1.15, z) - Math.hypot(0.5, 0.85)
export const colLB = (f, x, feet, z) => f(x, feet + CAM.eye / 2, z) - Math.hypot(0.5, CAM.eye / 2)

export const fmt = (v, d = 3) => (v === undefined || v === null || Number.isNaN(v) ? '-' : !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : (+v).toFixed(d))
export function stats(a) { if (!a.length) return { n: 0 }; const s = a.slice().sort((p, q) => p - q); return { n: s.length, min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] } }
