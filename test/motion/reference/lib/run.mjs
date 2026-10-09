// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/mover_fix/lib/run.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   5c53aa5f50c83da33698656e1bfe3b67b1407855e66142fd81a4fa3eb2e7249b, last modified 2026-10-07
//   20:21.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: The study's shared per-sample driver and measures (gap, eye clearance, retention,
//   sideways range, cost).
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Shared driver: feeds one constant displacement per sample to a mover and measures, per sample (final pose),
//   gap      : analytic signed distance of the r = 0.5 agent cylinder (feet+0.3 .. feet+top) to the obstacles
//              (overlap = gap < -0.02, i.e. deeper than the skin; pen = gap < 0)
//   eye      : analytic signed distance of the eye point (feet + eyeH on the axis) to the obstacles
//   retention: after first touch (gap < touch), realised / commanded displacement along `along` (unit 2-vector)
//   wobble   : after first touch, range of the position along `across` (unit 2-vector)
//   cost     : microseconds per sample spent in move()
import { minGap, minPointSD } from './geom.mjs'
export const CORNER_16_9 = 0.1857, CORNER_48_9 = 0.4277 // near-plane corner distance, vertical fov 75, near 0.1
export function drive(m, obs, o) {
  const { dx, dz, N, dt, eyeH = 3.7, gapFn = minGap, touch = 0.03, along = null, across = null, stop = null } = o
  const r = { worstGap: Infinity, n02: 0, n0: 0, eyeMin: Infinity, eyeLt0: 0, eyeLt01: 0, eyeLtC169: 0, eyeLtC489: 0, samples: 0,
    touchedAt: null, cmdAlong: 0, actAlong: 0, lo: Infinity, hi: -Infinity, us: 0, usMax: 0, feetMax: -Infinity, feetMin: Infinity, cmdPath: 0, actPath: 0 }
  for (let i = 0; i < N; i++) {
    const p0 = m.pos(), t0 = process.hrtime.bigint()
    m.move(dx, dz, dt)
    const us = Number(process.hrtime.bigint() - t0) / 1e3; r.us += us; if (us > r.usMax) r.usMax = us
    const p = m.pos(); r.samples++
    const g = gapFn(obs, p.x, p.z, p.y + 0.3, p.y + m.top, 0.5)
    if (g < r.worstGap) r.worstGap = g; if (g < -0.02) r.n02++; if (g < 0) r.n0++
    const e = minPointSD(obs, p.x, p.y + eyeH, p.z)
    if (e < r.eyeMin) r.eyeMin = e; if (e < 0) r.eyeLt0++; if (e < 0.1) r.eyeLt01++; if (e < CORNER_16_9) r.eyeLtC169++; if (e < CORNER_48_9) r.eyeLtC489++
    if (p.y > r.feetMax) r.feetMax = p.y; if (p.y < r.feetMin) r.feetMin = p.y
    if (r.touchedAt === null && g < touch) r.touchedAt = i
    if (r.touchedAt !== null) {
      if (along) { r.cmdAlong += dx * along[0] + dz * along[1]; r.actAlong += (p.x - p0.x) * along[0] + (p.z - p0.z) * along[1] }
      if (across) { const c = p.x * across[0] + p.z * across[1]; if (c < r.lo) r.lo = c; if (c > r.hi) r.hi = c }
      r.cmdPath += Math.hypot(dx, dz); r.actPath += Math.hypot(p.x - p0.x, p.z - p0.z)
    }
    if (stop && stop(p)) break
  }
  r.retention = r.cmdAlong > 1e-9 ? r.actAlong / r.cmdAlong : null
  r.wobble = r.hi >= r.lo ? r.hi - r.lo : null
  r.pathEff = r.cmdPath > 0 ? r.actPath / r.cmdPath : null
  r.usMean = r.us / r.samples
  Object.assign(r, { reverts: m.st.reverts, rec: m.st.recoveries || 0, recOk: m.st.recoverOk || 0, incl: m.st.incl, itCap: m.st.itCap, calls: m.st.calls, sub: m.st.sub, airIncl: m.st.airIncl, final: m.pos() })
  return r
}
// aggregate helper: fold run results into a summary row
export function fold(acc, r) {
  acc.runs = (acc.runs || 0) + 1
  acc.samples = (acc.samples || 0) + r.samples
  acc.n02 = (acc.n02 || 0) + r.n02; acc.n0 = (acc.n0 || 0) + r.n0
  acc.worstGap = Math.min(acc.worstGap ?? Infinity, r.worstGap)
  acc.reverts = (acc.reverts || 0) + r.reverts; acc.rec = (acc.rec || 0) + r.rec; acc.recOk = (acc.recOk || 0) + r.recOk; acc.itCap = (acc.itCap || 0) + r.itCap
  acc.calls = (acc.calls || 0) + r.calls; acc.sub = (acc.sub || 0) + r.sub
  if (r.retention !== null) acc.minRet = Math.min(acc.minRet ?? Infinity, r.retention)
  if (r.wobble !== null) acc.maxWob = Math.max(acc.maxWob ?? -Infinity, r.wobble)
  acc.eyeMin = Math.min(acc.eyeMin ?? Infinity, r.eyeMin); acc.eyeLt0 = (acc.eyeLt0 || 0) + r.eyeLt0; acc.eyeLt01 = (acc.eyeLt01 || 0) + r.eyeLt01
  acc.eyeLtC169 = (acc.eyeLtC169 || 0) + r.eyeLtC169; acc.eyeLtC489 = (acc.eyeLtC489 || 0) + r.eyeLtC489
  acc.us = (acc.us || 0) + r.us; acc.usMax = Math.max(acc.usMax || 0, r.usMax)
  return acc
}
export const f = (v, d = 3) => (v === undefined || v === null || !Number.isFinite(v) ? (v === Infinity ? 'inf' : v === -Infinity ? '-inf' : '-') : (+v).toFixed(d))
