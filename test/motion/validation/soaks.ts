// Soak rooms: ADR-0001 Validation 4 (the adjudication's closed 400 x 120 room with cuboid and with
// trimesh walls) and the two inclined soak rooms of Validation 5 (the inclined-face study's room
// and the proxy study's room with a platform, railed ramps and objects near its edge). In every
// room: 4 seeds x 5 min of the study's random running (streams.ts randomRunning) at 20, 120 and
// 250 samples/s, from the study's start.
//
// Rooms and measures as in the study's scripts:
// - cuboid: mover_fix/t4_soak.mjs Part 1 (adjudicator/s4_soak.mjs), walls split into 40-unit
//   pieces; overlap = footprint depth > 0.02 (walls.mjs worstPen), escape = axis outside the room.
// - trimesh: adjudicator/s7_soak_trimesh.mjs, every box a closed FIX_INTERNAL_EDGES |
//   MERGE_DUPLICATE_VERTICES trimesh whose segments along its long side are at most 40 long (s7's
//   cap 40; the cylinders stay cylinders); measured as the cuboid room. The study ran it with the
//   adjudication's rigid-body hover only, so the U+RS mover has no archived run in it.
// - inclined: mover_fix/t4_soak.mjs Part 2: the cuboid room plus the 13 inclined additions of
//   lib/rooms.mjs; overlap = analytic gap < -0.02 (lib/geom.mjs minGapAny: exact for walls, balls
//   and cones, the exact box distance minimised over the cylinder for slabs), eye point distance.
// - proxy: verify/xsoak.mjs (cross-test X9) with rails: the proxy study's 240 x 180 room with 18
//   objects, a platform 2 high and two walkable 20-degree ramps with rails, built with the objects'
//   own colliders (cones as 256-gon hulls) by reference/proxy/scene.mjs; overlap with vertical
//   solids by footprint, with every true shape by its exact distance minimised over the cylinder
//   (reference/proxy/checks.mjs minOverCyl), escapes, falls, landings and hangs as X9 counted them.
// The two Validation 5 rooms also measure the camera (camera.ts: eye point, near plane at 16:9 and
// 32:9; t4 measured the eye point only). The camera looks along the agent's heading; on the
// archived streams, whose heading stays 0, along the direction of motion, as X9 assumed.
import { R } from '../reference/lib/rapier.mjs'
import { buildWorld, fmt, obstacles, refreshQueries, sdObs, RAD } from '../reference/lib/walls.mjs'
import { addObstacle, minGapAny, pointSD } from '../reference/lib/geom.mjs'
import { inclinedAdditions } from '../reference/lib/rooms.mjs'
import { buildScene } from '../reference/proxy/scene.mjs'
import {
  Box, Frustum, LyingCyl, Slab, Sphere, Wedge, qAxis, qMul,
} from '../reference/proxy/geom.mjs'
import { minOverCyl } from '../reference/proxy/checks.mjs'
import { CameraMin, EYE } from './camera.ts'
import type { MotionDriver } from './driver.ts'
import { runCase, tick, withStream } from './run.ts'
import type { Outcome, Stream } from './run.ts'
import { headingOf, randomRunning } from './streams.ts'

export type Room = 'cuboid' | 'trimesh' | 'inclined' | 'proxy'

export const SOAK_RATES = [20, 120, 250]
export const SOAK_SEEDS = [1, 7, 21, 99]

const G1 = ((1 << 16) | 0xffff) >>> 0, G2 = ((2 << 16) | 0xffff) >>> 0
const HX = 200, HZ = 60 // the s4 room's half sizes
const rotY = (d: number) => {
  const t = (d * Math.PI) / 360
  return { x: 0, y: Math.sin(t), z: 0, w: Math.cos(t) }
}

type Sdf = (x: number, y: number, z: number) => number
type Shape = { sdf: Sdf, bc: number[] }

// adjudicator/s7_soak_trimesh.mjs boxTrimesh: a closed box, segments along its long side <= seg
function boxTrimesh(hx: number, hy: number, hz: number, seg: number) {
  const along = hz >= hx ? 'z' : 'x', h = along === 'z' ? hz : hx
  const n = Math.max(1, Math.ceil((2 * h) / seg - 1e-9)), V: number[] = [], I: number[] = []
  const ts = Array.from({ length: n + 1 }, (_, i) => -h + (2 * h * i) / n)
  const idx = (x: number, y: number, z: number) => {
    V.push(x, y, z)
    return V.length / 3 - 1
  }
  const ring = ts.map((t) => (along === 'z'
    ? [idx(-hx, -hy, t), idx(hx, -hy, t), idx(hx, hy, t), idx(-hx, hy, t)]
    : [idx(t, -hy, -hz), idx(t, -hy, hz), idx(t, hy, hz), idx(t, hy, -hz)]))
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[i + 1]
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      I.push(a[k], a[k2], b[k2], a[k], b[k2], b[k])
    }
  }
  const e0 = ring[0], e1 = ring[n]
  I.push(e0[0], e0[2], e0[1], e0[0], e0[3], e0[2], e1[0], e1[1], e1[2], e1[0], e1[2], e1[3])
  return R.ColliderDesc.trimesh(new Float32Array(V), new Uint32Array(I),
    R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES)
}

// ---- the proxy study's room (verify/xsoak.mjs, unchanged but for the eye height constant) ----
const AX = 120, AZ = 90
const tumbleQ = qMul(qAxis(1, 0, 0, (40 * Math.PI) / 180), qAxis(0, 0, 1, (30 * Math.PI) / 180))
const tumbled = (x: number, z: number) => {
  const b0 = Box('t', [0, 0, 0], [4, 4, 4], tumbleQ)
  return Box('tumbled cube 8', [x, -b0.ymin - 0.3, z], [4, 4, 4], tumbleQ)
}
const T20 = Math.tan((20 * Math.PI) / 180), S20 = Math.sin((20 * Math.PI) / 180)
/**
 * A cone as a 256-gon convex hull (ADR-0001 R5.2), measured by the frustum's exact distance, as
 * the cross-tests built it (verify/xsoak.mjs, xdirected.mjs). `o` is a Frustum of
 * reference/proxy/geom.mjs, an untyped JavaScript object; its colliders become the hull.
 */
export const hullCone = (o: any, x0: number, z0: number, yBase: number, yApex: number,
  rb: number) => {
  o.trueColliders = (Rr: typeof R) => {
    const pts: number[] = []
    for (let i = 0; i < 256; i++) {
      const a = (2 * Math.PI * i) / 256
      pts.push(x0 + rb * Math.cos(a), yBase, z0 + rb * Math.sin(a))
    }
    pts.push(x0, yApex, z0)
    return [Rr.ColliderDesc.convexHull(new Float32Array(pts))]
  }
  return o
}
const proxyObjects = () => [
  Sphere('sphere R3', -108, 3, -75, 3), Sphere('sphere R10', -85, 10, -68, 10),
  Sphere('sphere R25', -40, 25, -62, 25),
  hullCone(Frustum('cone up', 10, -72, 0, 10, 20, 0), 10, -72, 0, 20, 10),
  hullCone(Frustum('cone inverted', 40, -72, 0, 0, 20, 10), 40, -72, 20, 0, 10), tumbled(68, -75),
  LyingCyl('cylinder lying', [100, 3, -65], 90, 3, 15),
  Slab('wall 35', [-110, 0, -20], 0, 35, 12, 1, 24),
  Slab('wall 45', [-80, 0, -22], 45, 45, 12, 1, 24),
  Slab('wall 60', [-42, 0, -14], 120, 60, 12, 1, 24),
  Slab('wall 75', [-12, 0, -20], 200, 75, 12, 1, 24),
  Wedge('ramp 35', [-105, 0, 8], 90, 35, 6, 24), Wedge('ramp 45', [-80, 0, 20], 0, 45, 6, 24),
  Wedge('ramp 60', [-40, 0, 30], 270, 60, 6, 24), Wedge('ramp 75', [-12, 0, 20], 160, 75, 6, 24),
  Slab('wall 45 long (80)', [-60, 0, 55], 90, 45, 12, 1, 80),
  Sphere('sphere R3 by the ledge', 55.5, 3, 82, 3),
  Slab('overhang slab 45 on the platform', [62.5, 2, 30], 180, 45, 8, 1, 16),
]
const proxyRamps = () => [
  Slab('walkable ramp 20 south', [90, 0, 20 - 2 / T20], 90, 20, 2 / S20, 1, 40),
  Slab('walkable ramp 20 west', [60 - 2 / T20, 0, 55], 0, 20, 2 / S20, 1, 30),
]
const proxySpec = () => ({
  floor: [-AX - 5, AX + 5, -AZ - 5, AZ + 5],
  boxes: [{ cx: 0, cz: -AZ - 0.5, hx: AX + 1, hz: 0.5, y0: 0, y1: 10 },
    { cx: 0, cz: AZ + 0.5, hx: AX + 1, hz: 0.5, y0: 0, y1: 10 },
    { cx: -AX - 0.5, cz: 0, hx: 0.5, hz: AZ + 1, y0: 0, y1: 10 },
    { cx: AX + 0.5, cz: 0, hx: 0.5, hz: AZ + 1, y0: 0, y1: 10 },
    { cx: 90, cz: 55, hx: 30, hz: 35, y0: -1, y1: 2, floor: true },
    // rails along the ramps' open sides (ADR-0001 R5.3), 2 + eyeHeight + 0.1 high
    { cx: 69.9, cz: 20 - 1 / T20, hx: 0.1, hz: 1 / T20, y0: 0, y1: 2 + EYE + 0.1 },
    { cx: 110.1, cz: 20 - 1 / T20, hx: 0.1, hz: 1 / T20, y0: 0, y1: 2 + EYE + 0.1 },
    { cx: 60 - 1 / T20, cz: 39.9, hx: 1 / T20, hz: 0.1, y0: 0, y1: 2 + EYE + 0.1 },
    { cx: 60 - 1 / T20, cz: 70.1, hx: 1 / T20, hz: 0.1, y0: 0, y1: 2 + EYE + 0.1 }],
  objects: proxyObjects(), walkTrue: proxyRamps(),
  walk: [{ rect: [-AX, AX, -AZ, AZ], y: 0 }, { rect: [60, 120, 20, 90], y: 2 }],
})
// verify/xsoak.mjs sdPolyFast: signed distance to a convex polygon
function sdPolyFast(V: number[][], px: number, pz: number) {
  let dmin = Infinity, inside = true
  for (let i = 0, n = V.length; i < n; i++) {
    const a = V[i], b = V[(i + 1) % n], ex = b[0] - a[0], ez = b[1] - a[1], wx = px - a[0]
    const wz = pz - a[1], ee = ex * ex + ez * ez
    const t = Math.max(0, Math.min(1, (wx * ex + wz * ez) / ee)), dx = wx - ex * t, dz = wz - ez * t
    dmin = Math.min(dmin, dx * dx + dz * dz)
    if (ex * wz - ez * wx < 0) inside = false
  }
  const d = Math.sqrt(dmin)
  return inside ? -d : d
}

export interface SoakRun {
  rate: number
  seed: number
  outcome: Outcome
  /** Footprint (cuboid, trimesh, proxy: vertical solids) or analytic overlap samples, and depth. */
  overlaps: number
  worst: number
  escapes: number
  /** Proxy room: samples with the body inside a true shape, deeper than 0.02, the minimum gap. */
  bodyInside: number
  bodyOverlaps: number
  bodyMin: number
  /** Eye point below 0, 0.1, 0.1857 (t4 Part 2's counts). */
  eyeLt0: number
  eyeLt01: number
  eyeLtC: number
  camera: CameraMin
  falls: number
  lands: number
  hangs: number
  /** Realised over commanded path length. */
  efficiency: number
}

/** Runs one room at one rate for every seed. `minutes` per seed (the Validation: 5). */
export async function soak(driver: MotionDriver, room: Room, stream: Stream, rate: number,
  minutes = 5, seeds = SOAK_SEEDS): Promise<SoakRun[]> {
  const out: SoakRun[] = []
  const walls = obstacles(), incl = room === 'inclined' ? inclinedAdditions() : []
  const all = [...walls, ...incl]
  const spec = room === 'proxy' ? proxySpec() : null
  const checks: Shape[] = spec ? [...spec.objects, ...spec.walkTrue] : []
  const nObjects = spec ? spec.objects.length : 0
  const world = () => {
    if (spec) return buildScene(spec, 'true').w
    if (room === 'trimesh') {
      const w = new R.World({ x: 0, y: -981, z: 0 })
      w.timestep = 1 / 120
      w.createCollider(R.ColliderDesc.cuboid(HX + 5, 0.5, HZ + 5).setTranslation(0, -0.5, 0)
        .setCollisionGroups(G1))
      for (const o of walls) {
        const d = o.t === 'cyl' ? R.ColliderDesc.cylinder(5, o.r as number)
          : boxTrimesh(o.hx as number, 5, o.hz as number, 40)
        d.setTranslation(o.cx, 5, o.cz).setCollisionGroups(G2)
        if (o.yaw) d.setRotation(rotY(o.yaw))
        w.createCollider(d)
      }
      w.step()
      return w
    }
    const { w } = buildWorld(walls, { split: 40, floor: [-HX - 5, HX + 5, -HZ - 5, HZ + 5] })
    for (const o of incl) addObstacle(w, o)
    if (incl.length) refreshQueries(w)
    return w
  }
  // vertical solids of the proxy room for the footprint check (scene.mjs keeps them as prisms)
  const prisms = spec ? buildScene(spec, 'true') : null
  const vert = prisms ? prisms.prisms : []
  if (prisms) prisms.w.free()
  const start = spec ? { x: 25, z: 0 } : { x: 0, z: -45 }

  for (let k = 0; k < seeds.length; k++) {
    const seed = seeds[k]
    const c = withStream({
      name: `${room} room ${rate}/s seed ${seed}`, world, start,
      samples: randomRunning(rate, seed, 60 * minutes),
    }, stream, k)
    const r: Omit<SoakRun, 'outcome'> & { cmd: number, act: number } = {
      rate, seed, overlaps: 0, worst: -1e9, escapes: 0, bodyInside: 0, bodyOverlaps: 0,
      bodyMin: Infinity, eyeLt0: 0, eyeLt01: 0, eyeLtC: 0, camera: new CameraMin(), falls: 0,
      lands: 0, hangs: 0, efficiency: 0, cmd: 0, act: 0,
    }
    let view = 0, airRun = 0, lastFeet = 0
    const outcome = runCase(driver, c, ({ before, after: p, cmd, agent }) => {
      const top = agent.top
      if (stream === 'rotating') view = p.yaw
      else if (cmd[0] !== 0 || cmd[1] !== 0) view = headingOf(cmd[0], cmd[1])
      r.cmd += Math.hypot(cmd[0], cmd[1])
      r.act += Math.hypot(p.x - before.x, p.z - before.z)
      if (spec) {
        // verify/xsoak.mjs
        if (Math.abs(p.x) > AX || Math.abs(p.z) > AZ || p.y < -0.5
          || (p.x > 60.3 && p.z > 20.3 && p.y < 1.5)) r.escapes++
        const dropped = p.y < before.y - 0.3 - 1e-9
        if ((!before.airborne && p.airborne) || (!before.airborne && dropped)) r.falls++
        if ((before.airborne || dropped) && !p.airborne) r.lands++
        if (p.airborne && Math.abs(p.y - lastFeet) < 1e-6) {
          airRun++
          if (airRun === Math.ceil(0.25 * rate)) r.hangs++
        } else airRun = 0
        lastFeet = p.y
        let pen = -Infinity
        const b0 = p.y + 0.3, b1 = p.y + top
        for (const P of vert) {
          if (Math.min(b1, P.yb) - Math.max(b0, P.ya) <= 0) continue
          const q = 0.5 - (P.fp.kind === 'circle'
            ? Math.hypot(p.x - P.fp.cx, p.z - P.fp.cz) - P.fp.r : sdPolyFast(P.fp.V, p.x, p.z))
          if (q > pen) pen = q
        }
        r.worst = Math.max(r.worst, pen)
        if (pen > 0.02) r.overlaps++
        let eye = Infinity
        for (let j = 0; j < checks.length; j++) {
          const o = checks[j], [bx, bz, br] = o.bc
          if (Math.hypot(p.x - bx, p.z - bz) > br + 2) continue
          if (j < nObjects) eye = Math.min(eye, r.camera.add(o.sdf, p.x, p.y, p.z, view).eye)
          const lb = o.sdf(p.x, p.y + (0.3 + top) / 2, p.z) - Math.hypot(0.5, (top - 0.3) / 2)
          if (lb < Math.max(Math.min(r.bodyMin, 0.05), 0)) {
            const b = minOverCyl(o.sdf, p.x, p.z, 0.5, p.y + 0.3, p.y + top, 32, 9)
            r.bodyMin = Math.min(r.bodyMin, b)
            if (b < 0) r.bodyInside++
            if (b < -0.02) r.bodyOverlaps++
          }
        }
        if (eye < 0) r.eyeLt0++
        if (eye < 0.1) r.eyeLt01++
        if (eye < 0.1857) r.eyeLtC++
        return
      }
      if (Math.abs(p.x) > HX || Math.abs(p.z) > HZ) r.escapes++
      if (room !== 'inclined') {
        // t4 Part 1: footprint depth
        let wp = -1e9
        for (const o of walls) wp = Math.max(wp, RAD - sdObs(o, p.x, p.z))
        r.worst = Math.max(r.worst, wp)
        if (wp > 0.02) r.overlaps++
      } else {
        // t4 Part 2: analytic gap of the cylinder, eye point distance
        const g = minGapAny(all, p.x, p.z, p.y + 0.3, p.y + top, 0.5)
        r.worst = Math.max(r.worst, -g)
        if (g < -0.02) r.overlaps++
      }
      // the eye (Validation 5 rooms only): t4 Part 2's eye point measure (its counts), and the
      // near plane against the shapes within reach (camera.ts), the vertical walls included
      if (room !== 'inclined') return
      let eye = Infinity
      const near: Array<(typeof all)[number]> = []
      for (const o of all) {
        const e = pointSD(o, p.x, p.y + EYE, p.z)
        if (e < eye) eye = e
        if (e < 1.5) near.push(o)
      }
      if (eye < 0) r.eyeLt0++
      if (eye < 0.1) r.eyeLt01++
      if (eye < 0.1857) r.eyeLtC++
      const sdf: Sdf = (x, y, z) => {
        let m = Infinity
        for (const o of near) m = Math.min(m, pointSD(o, x, y, z))
        return m
      }
      r.camera.add(near.length ? sdf : () => eye, p.x, p.y, p.z, view)
    })
    out.push({ ...r, outcome, efficiency: r.act / r.cmd })
    await tick()
  }
  return out
}

/** The t4 rows (Part 1 for the cuboid room, Part 2 for the inclined room) of one rate. */
export function t4Row(room: Room, runs: SoakRun[]): string {
  const sum = (f: (s: SoakRun) => number) => runs.reduce((n, s) => n + f(s), 0)
  const st = (k: keyof Outcome['stats']) => sum((s) => s.outcome.stats[k])
  const worst = Math.max(...runs.map((s) => s.worst)), rate = runs[0].rate
  const eff = runs.reduce((a, s) => a + s.efficiency / runs.length, 0)
  if (room === 'cuboid') {
    return `  @${String(rate).padStart(3)}/s split 40 U+RS top4.15 samples `
      + `${sum((s) => s.outcome.samples)} KCC calls ${st('calls')} overlap>0.02 `
      + `${sum((s) => s.overlaps)} worst ${fmt(worst)} escapes `
      + `${sum((s) => s.escapes)} guard reverts ${st('reverts')} recoveries ${st('recoveries')} `
      + `(clear ${st('recoverOk')}) fix contacts ${st('incl')} itCap ${st('itCap')} `
      + `path efficiency ${fmt(100 * eff, 1)}%`
  }
  const eyeMin = Math.min(...runs.map((s) => s.camera.eye))
  return `  ${'U+RS top4.15'.padEnd(14)} @${String(rate).padStart(3)}/s samples `
    + `${sum((s) => s.outcome.samples)} KCC calls ${st('calls')} overlap>0.02 `
    + `${sum((s) => s.overlaps)} worst depth ${fmt(worst, 4)} escapes ${sum((s) => s.escapes)} `
    + `guard reverts ${st('reverts')} `
    + `recoveries ${st('recoveries')} (clear ${st('recoverOk')}) fix contacts ${st('incl')} itCap `
    + `${st('itCap')} airborne-incl ${st('airIncl')} eye min ${fmt(eyeMin, 3)} eye<0 `
    + `${sum((s) => s.eyeLt0)} eye<0.1 ${sum((s) => s.eyeLt01)} eye<0.186 ${sum((s) => s.eyeLtC)} `
    + `path eff ${fmt(100 * eff, 1)}%`
}

/** The archived t4 row for the same cell, without the fields this port leaves out (timing). */
export function archivedT4Row(text: string, room: Room, rate: number): string | undefined {
  const lines = text.split('\n')
  const row = room === 'cuboid'
    ? lines.find((l) => l.startsWith(`  @${String(rate).padStart(3)}/s split 40 U+RS top4.15 `))
    : lines.find((l) => l.startsWith(
      `  ${'U+RS top4.15'.padEnd(14)} @${String(rate).padStart(3)}/s `))
  return row?.replace(/ max\|n_y\| kept by KCC \S+/, '')
    .replace(/% [\d.]+ us\/sample \(max \d+\)$/, '%')
}
