// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/proxy/lib/geom.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   fbc3efc617a2e9227fc3448e44b8b09416f3fd8a6e82010f1974696bf4060d0a, last modified 2026-10-07
//   21:42. The verification ran its byte-identical copy verify/A_copy/lib/geom.mjs.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: Geometry of approach A (compiler-side proxies, not adopted) with exact signed
//   distances. Only Sphere, Box and Frustum are used here, by xanalytic.mjs, as a second,
//   independently written distance function.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Geometry for the compiler-side proxy prototype (approach A).
//  - 2-D helpers on the horizontal (x, z) plane: convex hull, exact signed distance, half-plane clipping, 40-unit splitting.
//  - TRUE (rendered) shapes with an EXACT 3-D signed distance function (sdf), their band footprint
//    F(ya, yb) = projection onto xz of (shape ∩ {ya <= y <= yb}) (exact), and a Rapier collider for the no-proxy baseline.
//  - proxyPieces(): the compiler rule: a vertical prism over F spanning [ya, yb]; circle -> Rapier cylinder, rectangle ->
//    yawed cuboid, other polygon -> convex hull prism; anything wider than `cap` is split into <= cap x cap pieces.
// Units: scene units (1 unit = 1 cm). Polygons: arrays of [x, z] with positive signed area (interior on the left of edges).

// ---------- quaternions ----------
export const qAxis = (ax, ay, az, ang) => { const l = Math.hypot(ax, ay, az), s = Math.sin(ang / 2) / l; return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(ang / 2) } }
export const qMul = (a, b) => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w })
export function qRot(q, v) { // rotate vector v = [x, y, z] by unit quaternion q
  const { x: qx, y: qy, z: qz, w: qw } = q, [vx, vy, vz] = v
  const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx)
  return [vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx)]
}
export const qInv = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w })
export const qYaw = (phi) => qAxis(0, 1, 0, -phi) // maps local +X to the horizontal direction (cos phi, 0, sin phi)

// ---------- 2-D (x, z) helpers ----------
export function polyArea(V) { let a = 0; for (let i = 0; i < V.length; i++) { const p = V[i], q = V[(i + 1) % V.length]; a += p[0] * q[1] - q[0] * p[1] } return a / 2 }
export function hull2(P) { // Andrew's monotone chain; positive area
  // Snap to a 1e-9 grid first: x-coordinates equal to ~1e-14 otherwise sort by noise and the chain skipped a true vertex (found in the
  // soak: an 80-unit slab got a trapezoid footprint). Duplicates are merged; a vertex within 1e-8 units of the line through its
  // neighbours is dropped (also across the chain junctions), so the hull may shrink by at most 1e-8.
  const snap = (v) => Math.round(v * 1e9) / 1e9, seen = new Set(), U = []
  for (const p of P) { const q = [snap(p[0]), snap(p[1])], k = q[0] + ',' + q[1]; if (!seen.has(k)) { seen.add(k); U.push(q) } }
  U.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const off = (o, a, b) => { const bx = b[0] - o[0], bz = b[1] - o[1]; return ((a[0] - o[0]) * bz - (a[1] - o[1]) * bx) / Math.hypot(bx, bz) } // >0: o->a->b turns CCW
  const lower = [], upper = []
  for (const p of U) { while (lower.length >= 2 && !(off(lower[lower.length - 2], lower[lower.length - 1], p) > 1e-8)) lower.pop(); lower.push(p) }
  for (let i = U.length - 1; i >= 0; i--) { const p = U[i]; while (upper.length >= 2 && !(off(upper[upper.length - 2], upper[upper.length - 1], p) > 1e-8)) upper.pop(); upper.push(p) }
  upper.pop(); lower.pop(); const H = lower.concat(upper)
  for (let changed = true; changed && H.length > 3; ) { changed = false
    for (let i = 0; i < H.length; i++) { const o = H[(i + H.length - 1) % H.length], a = H[i], b = H[(i + 1) % H.length]; if (!(off(o, a, b) > 1e-8)) { H.splice(i, 1); changed = true; break } } }
  return H
}
export function sdPoly2(px, pz, V) { // exact signed distance to a convex polygon with positive area (negative inside)
  let dmin = Infinity, inside = true
  for (let i = 0, n = V.length; i < n; i++) {
    const a = V[i], b = V[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], wx = px - a[0], wz = pz - a[1], ee = ex * ex + ez * ez
    if (ee < 1e-24) continue
    const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / ee)), dx = wx - ex * t, dz = wz - ez * t
    dmin = Math.min(dmin, dx * dx + dz * dz); if (ex * wz - ez * wx < 0) inside = false
  }
  const d = Math.sqrt(dmin); return inside ? -d : d
}
export function clipHalf(V, nx, nz, c) { // keep { x*nx + z*nz <= c } (Sutherland-Hodgman, convex input)
  const out = [], f = (p) => p[0] * nx + p[1] * nz - c
  for (let i = 0; i < V.length; i++) {
    const a = V[i], b = V[(i + 1) % V.length], fa = f(a), fb = f(b)
    if (fa <= 0) out.push(a)
    if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) { const t = fa / (fa - fb); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]) }
  }
  return out
}
export function edges2(V) { // per edge: a, b, mid, unit tangent t (a -> b), outward normal n, length
  return V.map((a, i) => { const b = V[(i + 1) % V.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]), t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]
    return { a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], t, n: [t[1], -t[0]], L } })
}
export function asRect(V) { // a rectangle -> {cx, cz, hx, hz, phi} (local X along edge 0), else null
  if (V.length !== 4) return null
  const E = edges2(V)
  for (let i = 0; i < 4; i++) { const e = E[i], f = E[(i + 1) % 4]; if (Math.abs(e.t[0] * f.t[0] + e.t[1] * f.t[1]) > 1e-9) return null }
  const cx = (V[0][0] + V[2][0]) / 2, cz = (V[0][1] + V[2][1]) / 2
  return { cx, cz, hx: E[0].L / 2, hz: E[1].L / 2, phi: Math.atan2(E[0].t[1], E[0].t[0]) }
}
export function splitPoly(V, cap) { // convex pieces, each inside a cell <= cap x cap of the minimum-area bounding rectangle
  let best = null
  for (const e of edges2(V)) { const [ux, uz] = e.t; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
    for (const [x, z] of V) { const u = x * ux + z * uz, v = -x * uz + z * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v) }
    const area = (u1 - u0) * (v1 - v0); if (!best || area < best.area - 1e-9) best = { ux, uz, u0, u1, v0, v1, area } }
  const { ux, uz, u0, u1, v0, v1 } = best
  const nu = Math.max(1, Math.ceil((u1 - u0) / cap - 1e-9)), nv = Math.max(1, Math.ceil((v1 - v0) / cap - 1e-9))
  if (nu === 1 && nv === 1) return [V]
  const out = []
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const ua = u0 + ((u1 - u0) * i) / nu, ub = u0 + ((u1 - u0) * (i + 1)) / nu, va = v0 + ((v1 - v0) * j) / nv, vb = v0 + ((v1 - v0) * (j + 1)) / nv
    let P = V
    if (i < nu - 1) P = clipHalf(P, ux, uz, ub); if (i > 0) P = clipHalf(P, -ux, -uz, -ua)
    if (j < nv - 1) P = clipHalf(P, -uz, ux, vb); if (j > 0) P = clipHalf(P, uz, -ux, -va)
    if (P.length >= 3 && polyArea(P) > 1e-9) out.push(hull2(P))
  }
  return out
}
export const circlePoly = (cx, cz, r, N = 32) => // circumscribed regular N-gon (contains the circle)
  Array.from({ length: N }, (_, k) => { const a = ((k + 0.5) * 2 * Math.PI) / N, R = r / Math.cos(Math.PI / N); return [cx + R * Math.cos(a), cz + R * Math.sin(a)] })

// exact 2-D signed distance in a vertical plane (a, y) to a convex polygon given CCW in (a, y)
const sd2 = (a, y, V) => sdPoly2(a, y, V)

// ---------- polytope band footprint ----------
function slabFootprint(verts, edges, ya, yb) {
  const pts = []
  for (const v of verts) if (v[1] >= ya - 1e-12 && v[1] <= yb + 1e-12) pts.push([v[0], v[2]])
  for (const [i, j] of edges) { const a = verts[i], b = verts[j]
    for (const yc of [ya, yb]) if ((a[1] - yc) * (b[1] - yc) < 0) { const t = (yc - a[1]) / (b[1] - a[1]); pts.push([a[0] + t * (b[0] - a[0]), a[2] + t * (b[2] - a[2])]) } }
  if (pts.length < 3) return null
  const H = hull2(pts); return H.length >= 3 && polyArea(H) > 1e-12 ? { kind: 'poly', V: H } : null
}

// ---------- TRUE shapes ----------
// Every shape: { name, kind, sdf(x,y,z), ymin, ymax, bc: [cx, cz, r] (horizontal bounding circle), footprint(ya, yb), trueColliders(R) }
export function Sphere(name, cx, cy, cz, Rad) {
  return { name, kind: 'sphere', ymin: cy - Rad, ymax: cy + Rad, bc: [cx, cz, Rad],
    sdf: (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - Rad,
    footprint(ya, yb) { if (yb < cy - Rad || ya > cy + Rad) return null; const ys = Math.min(yb, Math.max(ya, cy)); return { kind: 'circle', cx, cz, r: Math.sqrt(Math.max(0, Rad * Rad - (ys - cy) ** 2)) } },
    trueColliders: (R) => [R.ColliderDesc.ball(Rad).setTranslation(cx, cy, cz)] }
}
// Upright frustum / cone (axis vertical): radius r0 at y0, r1 at y1 (y0 < y1). Cone: r1 = 0. Inverted cone: r0 = 0.
export function Frustum(name, cx, cz, y0, r0, y1, r1) {
  const V = [[-r0, y0], [r0, y0], [r1, y1], [-r1, y1]].filter((p, i, A) => i === 0 || Math.hypot(p[0] - A[i - 1][0], p[1] - A[i - 1][1]) > 1e-12)
  const rAt = (y) => r0 + ((r1 - r0) * (y - y0)) / (y1 - y0)
  return { name, kind: 'frustum', ymin: y0, ymax: y1, bc: [cx, cz, Math.max(r0, r1)],
    sdf: (x, y, z) => sd2(Math.hypot(x - cx, z - cz), y, V),
    footprint(ya, yb) { const a = Math.max(ya, y0), b = Math.min(yb, y1); if (a > b) return null; return { kind: 'circle', cx, cz, r: Math.max(rAt(a), rAt(b)) } },
    trueColliders(R) { // exact for cones (Rapier cone: apex at +half-height)
      if (r1 === 0) return [R.ColliderDesc.cone((y1 - y0) / 2, r0).setTranslation(cx, (y0 + y1) / 2, cz)]
      if (r0 === 0) return [R.ColliderDesc.cone((y1 - y0) / 2, r1).setTranslation(cx, (y0 + y1) / 2, cz).setRotation(qAxis(1, 0, 0, Math.PI))]
      throw new Error('frustum collider not needed') } }
}
// Rotated cuboid (tilted wall, tumbled cube). half = [hx, hy, hz] in local axes, q = local -> world. split: list of local-Z cut counts.
export function Box(name, c, half, q, { splitZ = 1 } = {}) {
  const qi = qInv(q), [hx, hy, hz] = half
  const verts = [], edges = []
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) { const v = qRot(q, [sx * hx, sy * hy, sz * hz]); verts.push([c[0] + v[0], c[1] + v[1], c[2] + v[2]]) }
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) { const d = i ^ j; if (d === 1 || d === 2 || d === 4) edges.push([i, j]) }
  let bcR = 0; const bx = verts.reduce((s, v) => s + v[0], 0) / 8, bz = verts.reduce((s, v) => s + v[2], 0) / 8
  for (const v of verts) bcR = Math.max(bcR, Math.hypot(v[0] - bx, v[2] - bz))
  return { name, kind: 'box', verts, ymin: Math.min(...verts.map((v) => v[1])), ymax: Math.max(...verts.map((v) => v[1])), bc: [bx, bz, bcR],
    sdf(x, y, z) { const [lx, ly, lz] = qRot(qi, [x - c[0], y - c[1], z - c[2]]); const dx = Math.abs(lx) - hx, dy = Math.abs(ly) - hy, dz = Math.abs(lz) - hz
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0) },
    footprint: (ya, yb) => slabFootprint(verts, edges, ya, yb),
    trueColliders(R) { const out = [] // R5.2: split along local Z into equal flush pieces
      for (let i = 0; i < splitZ; i++) { const off = -hz + (hz / splitZ) * (2 * i + 1), o = qRot(q, [0, 0, off])
        out.push(R.ColliderDesc.cuboid(hx, hy, hz / splitZ).setTranslation(c[0] + o[0], c[1] + o[1], c[2] + o[2]).setRotation(q)) }
      return out } }
}
// Tilted slab ("tilted wall"): thickness t, slant length Ls, length Lz along the horizontal direction (cos phi, 0, sin phi) ... see slab().
// The slab rises at angle alpha (deg, from horizontal) toward the horizontal unit direction u = (cos psi, 0, sin psi); its long axis is
// horizontal and perpendicular to u. Its upper face (normal pointing up and against u) meets y = 0 along a line through `foot`.
export function Slab(name, foot, psiDeg, alphaDeg, Ls, t, Lz, opt = {}) {
  const a = (alphaDeg * Math.PI) / 180, psi = (psiDeg * Math.PI) / 180
  const u = [Math.cos(psi), 0, Math.sin(psi)], w = [-Math.sin(psi), 0, Math.cos(psi)] // u: rise direction, w: long axis
  const eL = [u[0] * Math.cos(a), Math.sin(a), u[2] * Math.cos(a)], eT = [-u[0] * Math.sin(a), Math.cos(a), -u[2] * Math.sin(a)]
  // local X = eL (slant), local Y = eT (thickness), local Z = w (long axis): right-handed? eL x eT should equal w
  const cr = [eL[1] * eT[2] - eL[2] * eT[1], eL[2] * eT[0] - eL[0] * eT[2], eL[0] * eT[1] - eL[1] * eT[0]]
  const sgn = Math.sign(cr[0] * w[0] + cr[1] * w[1] + cr[2] * w[2]), W = w.map((v) => v * sgn)
  const q = quatFromAxes(eL, eT, W)
  const c = [foot[0] + (Ls / 2) * eL[0] - (t / 2) * eT[0], (Ls / 2) * Math.sin(a) - (t / 2) * Math.cos(a) + (foot[1] || 0), foot[2] + (Ls / 2) * eL[2] - (t / 2) * eT[2]]
  // check: upper face (+eT) lower edge = c - Ls/2 eL + t/2 eT -> y = foot y
  const s = Box(name, c, [Ls / 2, t / 2, Lz / 2], q, { splitZ: Math.max(1, Math.ceil(Lz / 40 - 1e-9)) })
  return Object.assign(s, { kind: 'slab', alphaDeg, psiDeg, rise: u, axis: W, ...opt })
}
export function quatFromAxes(X, Y, Z) { // rotation matrix columns X, Y, Z (orthonormal, right-handed) -> quaternion
  const m00 = X[0], m10 = X[1], m20 = X[2], m01 = Y[0], m11 = Y[1], m21 = Y[2], m02 = Z[0], m12 = Z[1], m22 = Z[2]
  const tr = m00 + m11 + m22; let x, y, z, w
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = 0.25 * S; x = (m21 - m12) / S; y = (m02 - m20) / S; z = (m10 - m01) / S }
  else if (m00 > m11 && m00 > m22) { const S = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / S; x = 0.25 * S; y = (m01 + m10) / S; z = (m02 + m20) / S }
  else if (m11 > m22) { const S = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / S; x = (m01 + m10) / S; y = 0.25 * S; z = (m12 + m21) / S }
  else { const S = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / S; x = (m02 + m20) / S; y = (m12 + m21) / S; z = 0.25 * S }
  const l = Math.hypot(x, y, z, w); return { x: x / l, y: y / l, z: z / l, w: w / l }
}
// Wedge (solid steep ramp): cross-section triangle (0,0), (b,0), (b,H) with b = H / tan(alpha) in (s, y), s along the horizontal rise
// direction u = (cos psi, 0, sin psi) from the foot line through `foot`; extruded +-Lz/2 along the horizontal axis w. Vertical back face.
export function Wedge(name, foot, psiDeg, alphaDeg, H, Lz) {
  const a = (alphaDeg * Math.PI) / 180, psi = (psiDeg * Math.PI) / 180, b = H / Math.tan(a)
  const u = [Math.cos(psi), Math.sin(psi)], w = [-Math.sin(psi), Math.cos(psi)]
  const tri = [[0, 0], [b, 0], [b, H]] // CCW in (s, y)
  const P = (s, y, l) => [foot[0] + s * u[0] + l * w[0], y, foot[2] + s * u[1] + l * w[1]]
  const verts = [], edges = [[0, 1], [1, 2], [2, 0], [3, 4], [4, 5], [5, 3], [0, 3], [1, 4], [2, 5]]
  for (const l of [-Lz / 2, Lz / 2]) for (const [s, y] of tri) verts.push(P(s, y, l))
  const pieces = Math.max(1, Math.ceil(Lz / 40 - 1e-9))
  return { name, kind: 'wedge', alphaDeg, psiDeg, rise: [u[0], 0, u[1]], axis: [w[0], 0, w[1]], verts, ymin: 0, ymax: H,
    bc: [foot[0] + (b / 2) * u[0], foot[2] + (b / 2) * u[1], Math.hypot(b / 2, Lz / 2)],
    sdf(x, y, z) { const dx = x - foot[0], dz = z - foot[2], s = dx * u[0] + dz * u[1], l = dx * w[0] + dz * w[1]
      const d2 = sd2(s, y, tri), dl = Math.abs(l) - Lz / 2
      return Math.hypot(Math.max(d2, 0), Math.max(dl, 0)) + Math.min(Math.max(d2, dl), 0) },
    footprint: (ya, yb) => slabFootprint(verts, edges, ya, yb),
    trueColliders(R) { const out = []
      for (let i = 0; i < pieces; i++) { const l0 = -Lz / 2 + (Lz / pieces) * i, l1 = l0 + Lz / pieces, pts = []
        for (const l of [l0, l1]) for (const [s, y] of tri) pts.push(...P(s, y, l))
        out.push(R.ColliderDesc.convexHull(new Float32Array(pts))) }
      return out } }
}
// Cylinder lying on its side: axis horizontal along (cos psi, 0, sin psi), radius rho, half-length L, centre c.
export function LyingCyl(name, c, psiDeg, rho, L) {
  const psi = (psiDeg * Math.PI) / 180, a = [Math.cos(psi), Math.sin(psi)], nrm = [-Math.sin(psi), Math.cos(psi)]
  const pieces = Math.max(1, Math.ceil((2 * L) / 40 - 1e-9))
  return { name, kind: 'lyingcyl', psiDeg, axis: [a[0], 0, a[1]], ymin: c[1] - rho, ymax: c[1] + rho, bc: [c[0], c[2], Math.hypot(L, rho)],
    sdf(x, y, z) { const dx = x - c[0], dy = y - c[1], dz = z - c[2], u = dx * a[0] + dz * a[1], rx = dx - u * a[0], rz = dz - u * a[1]
      const dr = Math.hypot(rx, dy, rz) - rho, du = Math.abs(u) - L
      return Math.hypot(Math.max(dr, 0), Math.max(du, 0)) + Math.min(Math.max(dr, du), 0) },
    footprint(ya, yb) { if (yb < c[1] - rho || ya > c[1] + rho) return null
      const ys = Math.min(yb, Math.max(ya, c[1])), hw = Math.sqrt(Math.max(0, rho * rho - (ys - c[1]) ** 2))
      const V = [[-L, -hw], [L, -hw], [L, hw], [-L, hw]].map(([p, q]) => [c[0] + p * a[0] + q * nrm[0], c[2] + p * a[1] + q * nrm[1]])
      return { kind: 'poly', V: polyArea(V) > 0 ? V : V.reverse() } },
    trueColliders(R) { const out = [], qq = quatFromAxes([nrm[0], 0, nrm[1]], [a[0], 0, a[1]], [0, 1, 0]) // Rapier cylinder axis = local Y -> a
      for (let i = 0; i < pieces; i++) { const off = -L + (L / pieces) * (2 * i + 1)
        out.push(R.ColliderDesc.cylinder(L / pieces, rho).setTranslation(c[0] + off * a[0], c[1], c[2] + off * a[1]).setRotation(qq)) }
      return out } }
}

// ---------- the compiler rule (proxy pieces) ----------
// fp: {kind:'circle', cx, cz, r} | {kind:'poly', V}. Returns [{ fp, ya, yb, rapier: 'cylinder'|'cuboid'|'hull', desc(R) }].
// hullCap: convex-hull pieces are split further so no piece spans more than 20 units (hull_len.mjs: sweeps missed 1-40 per 100,000 casts on
// hull prisms 25-40 long, none on 5-20; cuboids never). allHull (test variant): every piece a hull, 40 cap.
// circleAs: 'ngon' (default since the second attempt: the circumscribed regular circleN-gon as hull prisms) or 'cylinder' (a Rapier
// cylinder when 2r <= cap: the first attempt's rule; headon_stress.mjs found near-head-on cast misses against Rapier cylinders).
export function proxyPieces(fp, ya, yb, { cap = 40, hullCap = 20, allHull = false, circleN = 32, circleAs = 'ngon' } = {}) {
  if (!fp) return []
  const hy = (yb - ya) / 2, ym = (ya + yb) / 2, out = []
  if (fp.kind === 'circle' && 2 * fp.r <= cap && !allHull && circleAs === 'cylinder') {
    out.push({ fp, ya, yb, rapier: 'cylinder', desc: (R) => R.ColliderDesc.cylinder(hy, fp.r).setTranslation(fp.cx, ym, fp.cz) })
    return out
  }
  const V = fp.kind === 'circle' ? circlePoly(fp.cx, fp.cz, fp.r, circleN) : fp.V
  for (const P of splitPoly(V, cap)) {
    const rect = allHull ? null : asRect(P)
    if (rect) out.push({ fp: { kind: 'poly', V: P }, ya, yb, rapier: 'cuboid', desc: (R) => R.ColliderDesc.cuboid(rect.hx, hy, rect.hz).setTranslation(rect.cx, ym, rect.cz).setRotation(qYaw(rect.phi)) })
    else for (const Q of allHull ? [P] : splitPoly(P, hullCap)) out.push({ fp: { kind: 'poly', V: Q }, ya, yb, rapier: 'hull', desc(R) { const pts = []; for (const [x, z] of Q) pts.push(x, ya, z, x, yb, z); return R.ColliderDesc.convexHull(new Float32Array(pts)) } })
  }
  return out
}
export const sdFp = (fp, x, z) => (fp.kind === 'circle' ? Math.hypot(x - fp.cx, z - fp.cz) - fp.r : sdPoly2(x, z, fp.V))
// exact distance between a footprint (circle or convex polygon) and an axis-aligned rectangle [x0, x1, z0, z1]; 0 if they meet
export function distFpRect(fp, [x0, x1, z0, z1]) {
  const Q = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]
  if (fp.kind === 'circle') return Math.max(0, sdPoly2(fp.cx, fp.cz, Q) - fp.r)
  return distPolyPoly(fp.V, Q)
}
export function distPolyPoly(P, Q) { // convex polygons (positive area): 0 if they intersect (separating-axis test), else exact distance
  for (const [A, B] of [[P, Q], [Q, P]]) for (const e of edges2(A)) {
    let minB = Infinity, maxA = -Infinity
    for (const p of A) maxA = Math.max(maxA, p[0] * e.n[0] + p[1] * e.n[1])
    for (const q of B) minB = Math.min(minB, q[0] * e.n[0] + q[1] * e.n[1])
    if (minB > maxA + 1e-12) { let d = Infinity
      for (const p of P) d = Math.min(d, sdPoly2(p[0], p[1], Q)); for (const q of Q) d = Math.min(d, sdPoly2(q[0], q[1], P)); return d }
  }
  return 0
}
