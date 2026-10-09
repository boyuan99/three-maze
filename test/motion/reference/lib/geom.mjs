// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/mover_fix/lib/geom.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   7d424383bbfc01130a5f548f47e1650d43a7cb9990e55b27387fe990765f54be, last modified 2026-10-07
//   21:19.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: Test geometry beyond vertical walls (inclined slabs, balls, cones) and the analytic
//   signed distances the study uses to measure overlap and eye clearance without asking Rapier.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Test geometry beyond common.mjs's vertical boxes/cylinders, with ANALYTIC distances (no Rapier queries):
//   slab   : a flat inclined slab (cuboid) whose open face makes angle `th` with the floor, measured on the open side
//            (th < 90: upward-facing ramp face; 90: vertical; th > 90: face leaning over the agent).
//   sphere : ball of radius R centred at (cx, cy, cz).
//   cone   : vertical cone, base radius Rb, height H, base on the floor (apex up) or inverted (apex on the floor).
// Distances:
//   agentGap(o, ax, az, ya, yb, r) = signed distance between the agent's solid vertical cylinder (axis (ax, az),
//            y in [ya, yb], radius r) and obstacle o (negative = penetration depth).
//   pointSD(o, x, y, z)            = signed distance from a point (the eye) to obstacle o.
import { R } from './rapier.mjs'
import { sdObs } from './walls.mjs'
export { R }
const WALL = ((2 << 16) | 0xffff) >>> 0, FLOOR = ((1 << 16) | 0xffff) >>> 0

function quatFromBasis(ex, ey, ez) { // columns of a rotation matrix -> quaternion
  const m00 = ex[0], m10 = ex[1], m20 = ex[2], m01 = ey[0], m11 = ey[1], m21 = ey[2], m02 = ez[0], m12 = ez[1], m22 = ez[2]
  const tr = m00 + m11 + m22; let qw, qx, qy, qz
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s }
  return { x: qx, y: qy, z: qz, w: qw }
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

// Slab: face bottom-edge midpoint (fx, 0, fz) on the floor; hyaw = direction of the face's horizontal outward normal
// h = (sin hyaw, 0, cos hyaw) (towards the open side); th in degrees; half-width W along the strike; length L along
// the face; thickness T. Pieces: the strike is split into ceil(2W / cap) flush cuboids (cap 40 by default).
export function slab({ fx = 0, fz = 0, hyaw = 0, th, W = 10, L = 20, T = 1, cap = 40 }) {
  const t = (th * Math.PI) / 180, hy = (hyaw * Math.PI) / 180
  const h = [Math.sin(hy), 0, Math.cos(hy)]
  const n = [h[0] * Math.sin(t), Math.cos(t), h[2] * Math.sin(t)]           // outward face normal
  const v = [-h[0] * Math.cos(t), Math.sin(t), -h[2] * Math.cos(t)]        // up the face, from the bottom edge
  const u = cross(n, v)                                                    // along the strike (horizontal)
  const nP = Math.max(1, Math.ceil((2 * W) / cap - 1e-9)), wP = W / nP
  const pieces = []
  for (let i = 0; i < nP; i++) {
    const off = -W + wP * (2 * i + 1)
    const c = [fx + u[0] * off + v[0] * L / 2 - n[0] * T / 2, v[1] * L / 2 - n[1] * T / 2, fz + u[2] * off + v[2] * L / 2 - n[2] * T / 2]
    pieces.push({ c, half: [wP, T / 2, L / 2] })
  }
  // local axes: x = u (width), y = n (thickness), z = u x n
  const ez = cross(u, n)
  return { t: 'slab', th, n, u, v, ez, P0: [fx, 0, fz], W, L, T, pieces, rot: quatFromBasis(u, n, ez) }
}
export const sphere = (cx, cy, cz, Rr) => ({ t: 'sphere', c: [cx, cy, cz], R: Rr })
// cone: Rapier primitive (hull 0) or the convex hull of an inscribed hull-gon base and the apex (analytic = true cone;
// the 256-gon is inside the true cone by at most Rb (1 - cos(pi/256)) = 7.5e-4 for Rb 10)
export const cone = (cx, cz, Rb, H, inverted = false, hull = 0) => ({ t: 'cone', cx, cz, Rb, H, inverted, hull, tri: inverted ? [[-Rb, H], [0, 0], [Rb, H]] : [[-Rb, 0], [Rb, 0], [0, H]] })

export function addObstacle(w, o) {
  if (o.t === 'slab') return o.pieces.map((p) => w.createCollider(R.ColliderDesc.cuboid(p.half[0], p.half[1], p.half[2]).setTranslation(p.c[0], p.c[1], p.c[2]).setRotation(o.rot).setCollisionGroups(WALL)))
  if (o.t === 'sphere') return [w.createCollider(R.ColliderDesc.ball(o.R).setTranslation(o.c[0], o.c[1], o.c[2]).setCollisionGroups(WALL))]
  if (o.t === 'cone' && o.hull) { const pts = []
    for (let i = 0; i < o.hull; i++) { const a = (2 * Math.PI * i) / o.hull; pts.push(o.Rb * Math.cos(a), o.inverted ? o.H : 0, o.Rb * Math.sin(a)) }
    pts.push(0, o.inverted ? 0 : o.H, 0)
    return [w.createCollider(R.ColliderDesc.convexHull(new Float32Array(pts)).setTranslation(o.cx, 0, o.cz).setCollisionGroups(WALL))] }
  if (o.t === 'cone') { const d = R.ColliderDesc.cone(o.H / 2, o.Rb).setTranslation(o.cx, o.H / 2, o.cz).setCollisionGroups(WALL)
    if (o.inverted) d.setRotation({ x: 1, y: 0, z: 0, w: 0 }); return [w.createCollider(d)] }
  if (o.t === 'box') { const d = R.ColliderDesc.cuboid(o.hx, 5, o.hz).setTranslation(o.cx, 5, o.cz).setCollisionGroups(WALL)
    if (o.yaw) { const tt = (o.yaw * Math.PI) / 360; d.setRotation({ x: 0, y: Math.sin(tt), z: 0, w: Math.cos(tt) }) } return [w.createCollider(d)] }
  if (o.t === 'cyl') return [w.createCollider(R.ColliderDesc.cylinder(5, o.r).setTranslation(o.cx, 5, o.cz).setCollisionGroups(WALL))]
  throw new Error(o.t)
}
export function makeWorld(obs, floor = [-100, 100, -100, 100]) {
  const w = new R.World({ x: 0, y: -981, z: 0 })
  // test hook (second attempt): env KCCDEG forces both KCC slope angles of every controller made in this world to that
  // many degrees, overriding the mover's own setting (ADR R3: 30). Unset (the default), nothing changes.
  if (process.env.KCCDEG) { const deg = (+process.env.KCCDEG * Math.PI) / 180, make = w.createCharacterController.bind(w)
    w.createCharacterController = (s) => { const k = make(s); const a = k.setMaxSlopeClimbAngle.bind(k), b = k.setMinSlopeSlideAngle.bind(k)
      k.setMaxSlopeClimbAngle = () => a(deg); k.setMinSlopeSlideAngle = () => b(deg); return k } }
  const [x0, x1, z0, z1] = floor
  w.createCollider(R.ColliderDesc.cuboid((x1 - x0) / 2, 0.5, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, -0.5, (z0 + z1) / 2).setCollisionGroups(FLOOR))
  for (const o of obs) addObstacle(w, o)
  w.step()
  return w
}

// ---- 2-D convex polygon helpers (cone axial section) ----
function axesOf(P) { const out = []; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; const nx = b[1] - a[1], ny = a[0] - b[0], l = Math.hypot(nx, ny); out.push([nx / l, ny / l]) } return out }
function proj(P, a) { let lo = Infinity, hi = -Infinity; for (const q of P) { const d = q[0] * a[0] + q[1] * a[1]; if (d < lo) lo = d; if (d > hi) hi = d } return [lo, hi] }
function ptSeg(p, a, b) { const abx = b[0] - a[0], aby = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby))); return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * aby) }
function segSeg(a, b, c, d) { return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b)) } // disjoint segments
export function polySD(A, B) {
  let minOv = Infinity
  for (const ax of [...axesOf(A), ...axesOf(B)]) { const [a0, a1] = proj(A, ax), [b0, b1] = proj(B, ax); const ov = Math.min(a1 - b0, b1 - a0); if (ov <= 0) { minOv = null; break } if (ov < minOv) minOv = ov }
  if (minOv !== null) return -minOv
  let d = Infinity
  for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) d = Math.min(d, segSeg(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length]))
  return d
}
function pointPolySD(p, P) { // convex polygon, either winding
  let inside = true, d = Infinity
  for (const ax of axesOf(P)) { const [lo, hi] = proj(P, ax), s = p[0] * ax[0] + p[1] * ax[1]; if (s < lo || s > hi) inside = false }
  for (let i = 0; i < P.length; i++) d = Math.min(d, ptSeg(p, P[i], P[(i + 1) % P.length]))
  return inside ? -d : d
}

// ---- analytic signed distances ----
export function agentGap(o, ax, az, ya, yb, r) {
  if (o.t === 'box' || o.t === 'cyl') return sdObs(o, ax, az) - r // vertical prisms 0..10 high: 2-D is exact
  if (o.t === 'slab') { // half-space of the face plane (valid while the agent faces the slab's interior)
    const n = o.n, P = o.P0, nh = Math.hypot(n[0], n[2])
    return n[0] * (ax - P[0]) + n[2] * (az - P[2]) - r * nh + Math.min(n[1] * (ya - P[1]), n[1] * (yb - P[1]))
  }
  if (o.t === 'sphere') { // closest point of the solid cylinder to the centre (centre outside the cylinder)
    const [cx, cy, cz] = o.c, dh = Math.hypot(cx - ax, cz - az), s = dh > r ? r / dh : 1
    const qx = ax + (cx - ax) * s, qz = az + (cz - az) * s, qy = Math.min(Math.max(cy, ya), yb)
    if (dh <= r && cy >= ya && cy <= yb) return -Infinity
    return Math.hypot(cx - qx, cy - qy, cz - qz) - o.R
  }
  if (o.t === 'cone') { const D = Math.hypot(ax - o.cx, az - o.cz); return polySD([[D - r, ya], [D + r, ya], [D + r, yb], [D - r, yb]], o.tri) }
  throw new Error(o.t)
}
export function pointSD(o, x, y, z) {
  if (o.t === 'box' || o.t === 'cyl') return y >= 0 && y <= 10 ? sdObs(o, x, z) : Math.min(Math.abs(y), Math.abs(y - 10)) // eye is always inside 0..10 here
  if (o.t === 'slab') { // exact oriented-box SDF, min over pieces
    let best = Infinity
    for (const pc of o.pieces) {
      const dx = x - pc.c[0], dy = y - pc.c[1], dz = z - pc.c[2]
      const lx = dx * o.u[0] + dy * o.u[1] + dz * o.u[2], ly = dx * o.n[0] + dy * o.n[1] + dz * o.n[2], lz = dx * o.ez[0] + dy * o.ez[1] + dz * o.ez[2]
      const qx = Math.abs(lx) - pc.half[0], qy = Math.abs(ly) - pc.half[1], qz = Math.abs(lz) - pc.half[2]
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0)
      if (sd < best) best = sd
    }
    return best
  }
  if (o.t === 'sphere') return Math.hypot(x - o.c[0], y - o.c[1], z - o.c[2]) - o.R
  if (o.t === 'cone') return pointPolySD([Math.hypot(x - o.cx, z - o.cz), y], o.tri)
  throw new Error(o.t)
}
// ---- generic slab gap (soak rooms, where any side of a slab can be reached) ----
// min over the agent cylinder of the exact oriented-box SDF: dense boundary sampling (2-degree, 13 heights, cap rings)
// then a pattern search around the best side point and the best cap point. Exact SDF, independent of Rapier; the
// boundary minimum is the gap when separated and minus the depth of the deepest boundary point when overlapping.
function boxSD(pc, o, x, y, z) {
  const dx = x - pc.c[0], dy = y - pc.c[1], dz = z - pc.c[2]
  const qx = Math.abs(dx * o.u[0] + dy * o.u[1] + dz * o.u[2]) - pc.half[0], qy = Math.abs(dx * o.n[0] + dy * o.n[1] + dz * o.n[2]) - pc.half[1], qz = Math.abs(dx * o.ez[0] + dy * o.ez[1] + dz * o.ez[2]) - pc.half[2]
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0)
}
// minimum of a point SDF over the boundary of the agent cylinder (sampling + pattern search)
export function cylMinSDF(sdf, ax, az, ya, yb, r) {
  const side = (ph, y) => sdf(ax + r * Math.cos(ph), Math.min(Math.max(y, ya), yb), az + r * Math.sin(ph))
  const cap = (ph, rho, y) => { const rr = Math.min(Math.max(rho, 0), r); return sdf(ax + rr * Math.cos(ph), y, az + rr * Math.sin(ph)) }
  let bs = { f: Infinity }, bc = { f: Infinity }
  for (let i = 0; i < 180; i++) { const ph = (2 * Math.PI * i) / 180
    for (let j = 0; j <= 12; j++) { const y = ya + ((yb - ya) * j) / 12, f = side(ph, y); if (f < bs.f) bs = { f, a: ph, b: y } }
    for (const y of [ya, yb]) for (const rho of [0, r / 3, (2 * r) / 3]) { const f = cap(ph, rho, y); if (f < bc.f) bc = { f, a: ph, b: rho, y } } }
  const refine = (s, fn, da, db) => { let { f, a, b } = s
    while (da > 1e-9 || db > 1e-9) { let imp = false
      for (const [ea, eb] of [[da, 0], [-da, 0], [0, db], [0, -db], [da, db], [-da, -db], [da, -db], [-da, db]]) { const g = fn(a + ea, b + eb); if (g < f - 1e-15) { f = g; a += ea; b += eb; imp = true; break } }
      if (!imp) { da /= 2; db /= 2 } }
    return f }
  return Math.min(refine(bs, side, (2 * Math.PI) / 180, (yb - ya) / 12), refine(bc, (a, b) => cap(a, b, bc.y), (2 * Math.PI) / 180, r / 3))
}
export function slabGapGeneric(o, ax, az, ya, yb, r, cull = 0.6) {
  let best = Infinity
  const ym = (ya + yb) / 2, halfDiag = Math.hypot(r, (yb - ya) / 2)
  for (const pc of o.pieces) {
    if (boxSD(pc, o, ax, ym, az) > halfDiag + cull) continue // far: gap > cull
    best = Math.min(best, cylMinSDF((x, y, z) => boxSD(pc, o, x, y, z), ax, az, ya, yb, r))
  }
  return best
}
// agent gap for soak rooms: slabs use the generic routine, everything else the exact formulas above
export function agentGapAny(o, ax, az, ya, yb, r) { return o.t === 'slab' ? slabGapGeneric(o, ax, az, ya, yb, r) : agentGap(o, ax, az, ya, yb, r) }
export const minGapAny = (obs, ax, az, ya, yb, r) => { let m = Infinity; for (const o of obs) { const d = agentGapAny(o, ax, az, ya, yb, r); if (d < m) m = d } return m }
export const minGap = (obs, ax, az, ya, yb, r) => { let m = Infinity; for (const o of obs) { const d = agentGap(o, ax, az, ya, yb, r); if (d < m) m = d } return m }
export const minPointSD = (obs, x, y, z) => { let m = Infinity; for (const o of obs) { const d = pointSD(o, x, y, z); if (d < m) m = d } return m }
// near-plane geometry of the v0.3 camera (vertical fov 75 deg, near 0.1): distance from the eye to a near-plane corner
export const nearCorner = (aspect) => { const hh = 0.1 * Math.tan((37.5 * Math.PI) / 180), hw = hh * aspect; return Math.hypot(0.1, hh, hw) }
