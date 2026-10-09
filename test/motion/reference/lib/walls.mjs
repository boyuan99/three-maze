// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: proto/verify/inclined/mover_fix/lib/walls.mjs in the separate three-maze-notes
//   repository (design-review workspace). SHA-256
//   87edc588c941f7a56a7b3a2021d0a04dae1bae0b746ade91bebeb22f68933ffa, last modified 2026-10-07
//   20:11.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: Copies of the adjudication's common.mjs (vertical boxes and cylinders, the analytic
//   penetration worstPen, buildWorld with the 40-unit split of ADR-0001 R5.2) and of its soak room
//   s4_obstacles.mjs.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Copies (unchanged logic) of adjudicator/common.mjs sdObs, worstPen, RAD, pieces, buildWorld, fmt and
// adjudicator/s4_obstacles.mjs obstacles(), so that the scripts can run on any Rapier build (lib/rapier.mjs);
// common.mjs itself always loads the pinned 0.14.0. Obstacles: {t:'box', cx, cz, hx, hz, yaw(deg)} | {t:'cyl', cx, cz, r},
// all 10 high standing on y = 0.
import { R, refreshQueries } from './rapier.mjs'
export const RAD = 0.5
const FLOOR = 1, WALL = 2
const grp = (m, f) => ((m << 16) | f) >>> 0
const rotY = (deg) => { const t = (deg * Math.PI) / 360; return { x: 0, y: Math.sin(t), z: 0, w: Math.cos(t) } }
export function sdObs(o, x, z) { // signed distance from point to footprint (negative inside)
  if (o.t === 'cyl') return Math.hypot(x - o.cx, z - o.cz) - o.r
  const th = ((o.yaw || 0) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
  const dx = x - o.cx, dz = z - o.cz
  const lx = c * dx - s * dz, lz = s * dx + c * dz // R^T * d for a rotation about +Y
  const qx = Math.abs(lx) - o.hx, qz = Math.abs(lz) - o.hz
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
}
export function worstPen(obs, x, z) { let w = -1e9; for (const o of obs) w = Math.max(w, RAD - sdObs(o, x, z)); return w } // >0 = overlap depth
function pieces(o, maxLen) {
  if (o.t !== 'box' || !maxLen) return [o]
  const along = o.hx >= o.hz ? 'x' : 'z', h = along === 'x' ? o.hx : o.hz
  const n = Math.max(1, Math.ceil((2 * h) / maxLen - 1e-9)); if (n === 1) return [o]
  const hp = h / n, th = ((o.yaw || 0) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
  const out = []
  for (let i = 0; i < n; i++) {
    const off = -h + hp * (2 * i + 1)
    const lx = along === 'x' ? off : 0, lz = along === 'z' ? off : 0
    out.push({ ...o, cx: o.cx + c * lx + s * lz, cz: o.cz - s * lx + c * lz, hx: along === 'x' ? hp : o.hx, hz: along === 'z' ? hp : o.hz })
  }
  return out
}
export function buildWorld(obs, { split = 0, floor = [-50, 50, -50, 50] } = {}) {
  const w = new R.World({ x: 0, y: -981, z: 0 }); w.timestep = 1 / 120
  const [x0, x1, z0, z1] = floor
  w.createCollider(R.ColliderDesc.cuboid((x1 - x0) / 2, 0.5, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, -0.5, (z0 + z1) / 2).setCollisionGroups(grp(FLOOR, 0xffff)))
  let n = 0
  for (const o of obs) for (const p of pieces(o, split)) {
    const d = p.t === 'cyl' ? R.ColliderDesc.cylinder(5, p.r) : R.ColliderDesc.cuboid(p.hx, 5, p.hz)
    d.setTranslation(p.cx, 5, p.cz).setCollisionGroups(grp(WALL, 0xffff)); if (p.yaw) d.setRotation(rotY(p.yaw))
    w.createCollider(d); n++
  }
  w.step()
  return { w, nColliders: n }
}
export const fmt = (v, d = 3) => (v === undefined || v === null || Number.isNaN(v) ? '-' : (+v).toFixed(d))
const HX = 200, HZ = 60
export function obstacles() { // adjudicator/s4_obstacles.mjs
  const o = []
  o.push({ t: 'box', cx: 0, cz: -HZ - 0.5, hx: HX + 1, hz: 0.5 }, { t: 'box', cx: 0, cz: HZ + 0.5, hx: HX + 1, hz: 0.5 })
  o.push({ t: 'box', cx: -HX - 0.5, cz: 0, hx: 0.5, hz: HZ + 1 }, { t: 'box', cx: HX + 0.5, cz: 0, hx: 0.5, hz: HZ + 1 })
  o.push({ t: 'box', cx: -75, cz: -30.5, hx: 25, hz: 0.5 }, { t: 'box', cx: -25, cz: -30.5, hx: 25, hz: 0.5 })
  o.push({ t: 'box', cx: 100, cz: 20.5, hx: 50, hz: 0.5 }, { t: 'box', cx: 100, cz: 0, hx: 0.5, hz: 20 })
  o.push({ t: 'box', cx: -105, cz: 30.5, hx: 75, hz: 0.5 }, { t: 'box', cx: -105, cz: 41.5, hx: 75, hz: 0.5 })
  const h = (30 * Math.PI) / 180, L = 30
  for (const sg of [-1, 1]) o.push({ t: 'box', cx: 150 + sg * (Math.sin(h) * L / 2 + Math.cos(h) * 0.5), cz: -50 + Math.cos(h) * L / 2 - Math.sin(h) * 0.5, hx: 0.5, hz: L / 2, yaw: sg * 30 })
  o.push({ t: 'box', cx: 30, cz: -10, hx: 0.05, hz: 30, yaw: 10 })
  o.push({ t: 'box', cx: -25, cz: 0, hx: 4, hz: 1, yaw: 37 }, { t: 'box', cx: 60, cz: 40, hx: 6, hz: 0.5, yaw: -61 }, { t: 'box', cx: -150, cz: -10, hx: 15, hz: 0.5, yaw: 45 })
  o.push({ t: 'cyl', cx: 0, cz: 30, r: 3 }, { t: 'cyl', cx: 160, cz: 30, r: 1.5 })
  return o
}
export { refreshQueries }
