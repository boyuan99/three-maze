// ADR-0001 Validation 1-3 (docs/adr/0001-player-mover.md, Validation): long walls, thin walls,
// seams, a T-junction, a corner, wedges, trimesh walls and the side of a raised platform.
//
// The cases are the study's vertical-wall suite t3 (reference/t3_walls.mjs: the adjudication's
// s1, s1b, s2, s3a-e and s3g ported to per-sample movers), with its geometry, inputs and measures:
// overlap is the depth of the agent's r 0.5 footprint in a wall's footprint (walls.mjs worstPen),
// deeper than the 0.02 skin; retention is realised over commanded displacement along the wall
// after the first touch. Each group also formats its rows as t3 printed them, so that the archived
// stream can be compared with reference/archive/t3_walls_top415_out.txt (rows of the mover U+RS).
// Three numbers t3 did not have: retention for every slide (t3 printed it for S3d and S3g only),
// the sideways range against a perfect slide (measures.ts), which rotating streams need, and the
// crossings of every wall of S3a-S3e and S3g (measures.ts), Validation 3's "contained", which t3
// showed only through the positions in its rows.
//
// One case is not from the study: Validation 3's "side of a 200-unit raised platform from below"
// (raisedPlatform below).
import { R } from '../reference/lib/rapier.mjs'
import { buildWorld, fmt, worstPen } from '../reference/lib/walls.mjs'
import type { MotionDriver } from './driver.ts'
import { Crossings, Slide, maxOf, minOf } from './measures.ts'
import { runCase, tick, withStream } from './run.ts'
import type { Case, Outcome, Pose, Step, Stream } from './run.ts'
import { constant, dtUs, worldSample } from './streams.ts'
import type { Sample } from './streams.ts'

type Box = { t: 'box', cx: number, cz: number, hx: number, hz: number, yaw?: number }
const box = (cx: number, cz: number, hx: number, hz: number, yaw?: number): Box =>
  ({ t: 'box', cx, cz, hx, hz, ...(yaw ? { yaw } : {}) })
const deg = (d: number) => (d * Math.PI) / 180
const G1 = ((1 << 16) | 0xffff) >>> 0, G2 = ((2 << 16) | 0xffff) >>> 0 // the study's floor, walls

/** t3's regimes: [name, displacement per sample, samples per second]. */
export const REGIMES: Array<[string, number, number]> = [
  ['120/s v30', 30 / 120, 120], ['120/s v141', 141 / 120, 120], ['20/s v100', 100 / 20, 20],
]

/** The mover's name in t3's rows. */
const NAME = 'U+RS'.padEnd(8)

/** What every group returns: t3-style rows and the numbers the thresholds need. */
export interface GroupResult {
  /** Rows as t3 printed them (the time column, where t3 had one, as '*'). */
  rows: string[]
  outcomes: Outcome[]
  /** Deepest footprint overlap of any sample (> 0.02 is an overlap), and such samples. */
  worst: number
  overlaps: number
  /** Samples that ended beyond a wall the agent was beside before (measures.ts Crossings). */
  crossings: number
  /** Lowest retention of a run, % (null where the group has no slide along a wall). */
  minRetention: number | null
  /**
   * Largest sideways range of a run against a perfect slide (measures.ts Slide; null where the
   * group has no slide). The rows show t3's own range (of the position) instead.
   */
  maxSideways: number | null
}

async function runAll(driver: MotionDriver, cases: Case[], stream: Stream,
  measure: (c: Case, index: number) => ((s: Step) => void) | undefined) {
  const outcomes: Outcome[] = []
  for (let k = 0; k < cases.length; k++) {
    const c = withStream(cases[k], stream, k)
    outcomes.push(runCase(driver, c, measure(c, k)))
    await tick()
  }
  return outcomes
}

/**
 * A slide along a wall face at x = face(z) toward -z, as every t3 slide is: retention along -z
 * and the sideways range against a perfect slide (the axis 0.52 from the face, ADR-0001 R3), both
 * from the first sample that ends with x >= touchX, and only while the agent is beside the wall
 * (z >= zEnd).
 */
function alongWall(start: { x: number, z: number }, touchX: number,
  face: (z: number) => number = () => 10, zEnd = -Infinity) {
  const slide = new Slide([-1, 0], (_x, z) => -(face(z) - 0.52), start.x, start.z)
  const m = {
    touched: false, za: 0, zc: 0,
    visit({ before, after, sample, cmd }: Step) {
      slide.step(before.yaw, sample.d)
      if (after.x >= touchX) m.touched = true
      if (m.touched && after.z >= zEnd) {
        m.za += before.z - after.z
        m.zc += -cmd[1]
        slide.record(after.x, after.z)
      }
    },
    /** Retention, %, of a run that touched and was commanded more than 5 units along it. */
    get retention(): number | null { return m.touched && m.zc > 5 ? (100 * m.za) / m.zc : null },
    get sideways(): number | null { return m.touched ? slide.range : null },
  }
  return m
}

// ---- Validation 1: long walls (t3 S1) ----

/**
 * Long walls of 200, 400 and 600 units split into 40-unit pieces (ADR-0001 R5.2), at 1-75
 * degrees, in t3's three regimes (30 and 141 units/s at 120 samples/s, 100 at 20): 45 runs.
 */
export async function longWalls(driver: MotionDriver, stream: Stream): Promise<GroupResult> {
  const rows: string[] = [], outcomes: Outcome[] = []
  let worst = -1e9, overlaps = 0, crossings = 0
  let minRet: number | null = null, maxSide: number | null = null
  for (const L of [200, 400, 600]) {
    const split = 40, obs = [box(10.5, 0, 0.5, L / 2)]
    const A = { pen: -1e9, n02: 0, cross: 0, minKeep: 1e9, jit: 0, rev: 0, rec: 0, incl: 0 }
    const cases: Case[] = []
    for (const [, step, rate] of REGIMES) {
      for (const ang of [1, 5, 15, 30, 75]) {
        const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
        cases.push({
          name: `L${L} ${rate}/s ${step} ${ang} deg`, start: { x: 8, z: L / 2 - 10 },
          world: () => buildWorld(obs, { split, floor: [-20, 30, -L / 2 - 20, L / 2 + 20] }).w,
          samples: constant(dx, dz, rate, Math.floor((L - 20) / (step * Math.cos(a)))),
        })
      }
    }
    const per: Array<{ lo: number, hi: number, wall: ReturnType<typeof alongWall> }> = []
    const res = await runAll(driver, cases, stream, (c, k) => {
      const m = per[k] = { lo: 1e9, hi: -1e9, wall: alongWall(c.start, 9.47) }
      return (s) => {
        const d = worstPen(obs, s.after.x, s.after.z)
        A.pen = Math.max(A.pen, d)
        if (d > 0.02) A.n02++
        if (s.after.x > 11) A.cross++
        m.wall.visit(s)
        if (m.wall.touched) {
          m.lo = Math.min(m.lo, s.after.x)
          m.hi = Math.max(m.hi, s.after.x)
        }
      }
    })
    for (let k = 0; k < res.length; k++) {
      const m = per[k], o = res[k], ret = m.wall.retention
      if (ret !== null) {
        A.minKeep = Math.min(A.minKeep, ret)
        A.jit = Math.max(A.jit, m.hi - m.lo)
        minRet = minOf(minRet, ret)
        maxSide = maxOf(maxSide, m.wall.sideways)
      }
      A.rev += o.stats.reverts
      A.rec += o.stats.recoveries
      A.incl += o.stats.incl
    }
    rows.push(`  L${L} split ${String(split).padStart(2)} ${NAME} ${fmt(A.pen)} / ${A.n02} / `
      + `${A.cross} / ${fmt(A.minKeep, 1)} / ${fmt(A.jit)} / * / ${A.rev} / ${A.rec} / ${A.incl}`)
    outcomes.push(...res)
    worst = Math.max(worst, A.pen)
    overlaps += A.n02
    crossings += A.cross
  }
  return { rows, outcomes, worst, overlaps, crossings, minRetention: minRet, maxSideways: maxSide }
}

// ---- Validation 2: thin walls (t3 S2) ----

/** A thin-wall configuration: [wall length, split (0: one piece)]. */
export const THIN_CONFIGS: Array<[number, number]> =
  [[40, 0], [400, 0], [400, 40], [1200, 0], [1200, 40]]

/** Within ADR-0001 R5.2: no cuboid extent over 40. */
export const thinCapped = (Lw: number, split: number) => Lw <= 40 || split === 40

export interface ThinResult extends GroupResult {
  Lw: number
  split: number
  reverts: number
}

/**
 * A 0.1-thick wall of 40, 400 and 1,200 units (one piece and split into 40-unit pieces), hit at
 * 141-1,000 units/s (up to 50 units per sample) at 90, 20 and 5 degrees from up to 20 start
 * phases. One result per configuration.
 */
export async function thinWalls(driver: MotionDriver, stream: Stream): Promise<ThinResult[]> {
  const out: ThinResult[] = []
  const regimes: Array<[number, number]> =
    [[120, 141], [120, 300], [120, 1000], [20, 141], [20, 1000]]
  for (const [Lw, split] of THIN_CONFIGS) {
    const obs = [box(10.05, 0, 0.05, Lw / 2)], floor = [-100, 120, -Lw / 2 - 60, Lw / 2 + 60]
    const cases: Case[] = []
    for (const [rate, v] of regimes) {
      for (const inc of [90, 20, 5]) {
        const step = v / rate, a = deg(inc), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
        for (let ph = 0; ph < 20; ph++) {
          const x0 = 9.48 - dx * (1 + ph / 20) - 0.5, K = Math.ceil((11.1 - x0) / dx) + 1
          if (K * Math.abs(dz) > Lw - 4) break
          cases.push({
            name: `Lw ${Lw} split ${split} ${v}@${rate} ${inc} deg phase ${ph}`,
            world: () => buildWorld(obs, { split, floor }).w,
            start: { x: x0, z: (K * Math.abs(dz)) / 2 }, samples: constant(dx, dz, rate, K),
          })
        }
      }
    }
    let through = 0, worst = -1e9, overlaps = 0
    const inside = (zz: number) => Math.abs(zz) < Lw / 2 - 0.5
    const res = await runAll(driver, cases, stream, (c) => {
      let px = c.start.x, pz = c.start.z, crossed = false
      return ({ after }) => {
        // t3 counts a run's first crossing and looks no further into that run
        if (crossed) return
        const d = worstPen(obs, after.x, after.z)
        worst = Math.max(worst, d)
        if (d > 0.02) overlaps++
        if (px < 10.05 && after.x > 10.05 && inside(pz) && inside(after.z)) {
          through++
          crossed = true
        }
        px = after.x
        pz = after.z
      }
    })
    out.push({
      Lw, split, reverts: res.reduce((n, o) => n + o.stats.reverts, 0), outcomes: res, worst,
      overlaps, crossings: through, minRetention: null, maxSideways: null,
      rows: [`  Lw ${String(Lw).padStart(4)} split ${String(split || '-').padStart(2)} ${NAME} `
        + `runs ${res.length} tunnels ${through} worst overlap ${fmt(worst)}`],
    })
  }
  return out
}

// ---- Validation 3: seams, T-junction, corner, wedges, trimesh walls, raised platform ----

export interface SeamResult extends GroupResult {
  /** Samples of the T-junction runs that did not move at all (t3: 'zero-progress'). */
  zeroProgress: number
}

/**
 * t3 S3a-S3e: coplanar seams (a second piece proud by +-0.001, a T stem behind), the T-junction,
 * the 90-degree corner and 30/60/90-degree wedges, retention near head-on on one 200-unit box and
 * on pieces of 40 and 10, and the seam trap (4,000 samples at 70-89 degrees). Every run also
 * counts its crossings of the walls (Validation 3: contained), which t3 printed no column for.
 */
export async function seams(driver: MotionDriver, stream: Stream): Promise<SeamResult> {
  const rows: string[] = [], outcomes: Outcome[] = []
  let worst = -1e9, overlaps = 0, zeroProgress = 0
  let minRet: number | null = null, maxSide: number | null = null
  const pen = (obs: Box[], p: Pose) => {
    const d = worstPen(obs, p.x, p.z)
    worst = Math.max(worst, d)
    if (d > 0.02) overlaps++
    return d
  }
  // one per run, from the run's start (measures.ts)
  const crossed: Crossings[] = []
  const contained = (obs: Box[], start: { x: number, z: number }) => {
    const c = new Crossings(obs, start.x, start.z)
    crossed.push(c)
    return c
  }
  const keep = (wall: ReturnType<typeof alongWall>) => {
    minRet = minOf(minRet, wall.retention)
    maxSide = maxOf(maxSide, wall.sideways)
  }

  // S3a coplanar seam at z = 0 (second piece proud by lip, T stem behind)
  for (const lip of [0, 0.001, -0.001]) {
    for (const [rn, step, rate] of REGIMES) {
      const cases: Case[] = []
      const obs = [box(10.5, 50, 0.5, 50), box(10.5 - lip, -50, 0.5, 50), box(26, 0, 15, 0.5)]
      for (const ang of [5, 30, 75]) {
        const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
        cases.push({
          name: `S3a lip ${lip} ${rn} ${ang} deg`, start: { x: 9.3, z: 70 },
          world: () => buildWorld(obs, { floor: [-20, 50, -120, 120] }).w,
          samples: constant(dx, dz, rate, Math.ceil(140 / (step * Math.cos(a)))),
          stop: (p) => p.z < -60,
        })
      }
      const per: Array<{ pen: number, lo: number, hi: number, minProg: number,
        wall: ReturnType<typeof alongWall> }> = []
      const res = await runAll(driver, cases, stream, (c, k) => {
        const m = per[k] = {
          pen: -1e9, lo: 1e9, hi: -1e9, minProg: 1e9,
          wall: alongWall(c.start, 9.45 - lip, (z) => (z >= 0 ? 10 : 10 - lip)),
        }
        const cross = contained(obs, c.start)
        return (s) => {
          m.pen = Math.max(m.pen, pen(obs, s.after))
          cross.visit(s.after.x, s.after.z)
          m.wall.visit(s)
          if (m.wall.touched && Math.abs(s.after.z) < 20) {
            m.lo = Math.min(m.lo, s.after.x)
            m.hi = Math.max(m.hi, s.after.x)
            m.minProg = Math.min(m.minProg, (s.before.z - s.after.z) / -s.cmd[1])
          }
        }
      })
      const cells = res.map((_, k) => {
        const m = per[k]
        keep(m.wall)
        return `${[5, 30, 75][k]}deg ${fmt(m.pen)}/${fmt(m.hi - m.lo)}/${fmt(m.minProg, 2)}`
      })
      outcomes.push(...res)
      rows.push(`  lip ${String(lip).padStart(6)} ${rn.padEnd(10)} ${NAME} ${cells.join('  ')}`)
    }
  }

  // S3b T-junction: stem walls at x = +-5, the far wall at z = 10, legs as s3_seams
  for (const split of [0, 40]) {
    for (const [rn, step, rate] of REGIMES) {
      const obs = [box(5.5, -50, 0.5, 50), box(-5.5, -50, 0.5, 50), box(0, 10.5, 60, 0.5),
        box(32.5, -0.5, 27.5, 0.5), box(-32.5, -0.5, 27.5, 0.5), box(60.5, 5, 0.5, 6),
        box(-60.5, 5, 0.5, 6), box(0, -100.5, 6, 0.5)]
      const samples: Sample[] = []
      for (const [ux, uz, dist] of [[0.15, 1, 100], [1, 0.15, 60], [1, -0.1, 40], [-1, 0.2, 120],
        [0.05, -1, 20]]) {
        const l = Math.hypot(ux, uz)
        for (let i = 0; i < Math.ceil(dist / step); i++) {
          samples.push(worldSample((ux / l) * step, (uz / l) * step, dtUs(rate)))
        }
      }
      let p = -1e9, stuck = 0, lx = 3, lz = -90
      const start = { x: 3, z: -90 }, cross = contained(obs, start)
      const [o] = await runAll(driver, [{
        name: `S3b split ${split} ${rn}`, start, samples,
        world: () => buildWorld(obs, { split, floor: [-70, 70, -110, 20] }).w,
      }], stream, () => ({ after }) => {
        p = Math.max(p, pen(obs, after))
        cross.visit(after.x, after.z)
        if (Math.hypot(after.x - lx, after.z - lz) < 1e-6) stuck++
        lx = after.x
        lz = after.z
      })
      zeroProgress += stuck
      outcomes.push(o)
      rows.push(`  split ${String(split || '-').padStart(2)} ${rn.padEnd(10)} ${NAME} `
        + `worst ${fmt(p)} zero-progress ${stuck}/${o.samples} final (${fmt(lx, 2)}, `
        + `${fmt(lz, 2)}) reverts `
        + `${o.stats.reverts} rec ${o.stats.recoveries}`)
    }
  }

  // S3c inside corner (pushed along the bisector) and wedges (along the axis, 5% sideways)
  const wedge = (hdeg: number) => {
    const L = 60, h = deg(hdeg)
    return [-1, 1].map((sg) => box(sg * (Math.sin(h) * L / 2 + Math.cos(h) * 0.5),
      -50 + Math.cos(h) * L / 2 - Math.sin(h) * 0.5, 0.5, L / 2, sg * hdeg))
  }
  const geos: Array<[string, () => Box[], [number, number], [number, number]]> = [
    ['corner90', () => [box(10.5, 0, 0.5, 100), box(0, -100.5, 11, 0.5)], [0, -80],
      [Math.SQRT1_2, -Math.SQRT1_2]],
    ['wedge30', () => wedge(15), [0.3, -10], [0.05, -1]],
    ['wedge60', () => wedge(30), [0.3, -10], [0.05, -1]],
    ['wedge90', () => wedge(45), [0.3, -10], [0.05, -1]],
  ]
  for (const [gname, mk, [x0, z0], dir] of geos) {
    for (const split of [0, 40]) {
      for (const [rn, step, rate] of REGIMES) {
        const obs = mk(), xs: number[] = [], zs: number[] = [], N = 300
        const start = { x: x0, z: z0 }, cross = contained(obs, start)
        let p = -1e9
        const [o] = await runAll(driver, [{
          name: `S3c ${gname} split ${split} ${rn}`, start,
          world: () => buildWorld(obs, { split, floor: [-60, 60, -110, 60] }).w,
          samples: constant(dir[0] * step, dir[1] * step, rate, N),
        }], stream, () => ({ i, after }) => {
          p = Math.max(p, pen(obs, after))
          cross.visit(after.x, after.z)
          if (i >= N - 100) {
            xs.push(after.x)
            zs.push(after.z)
          }
        })
        outcomes.push(o)
        rows.push(`  ${gname.padEnd(8)} split ${String(split || '-').padStart(2)} ${rn.padEnd(10)} `
          + `${NAME} worst ${fmt(p)} final (${fmt(xs.at(-1), 3)}, ${fmt(zs.at(-1), 3)}) jitter x `
          + `${fmt(Math.max(...xs) - Math.min(...xs), 4)} `
          + `z ${fmt(Math.max(...zs) - Math.min(...zs), 4)} `
          + `reverts ${o.stats.reverts} rec ${o.stats.recoveries}`)
      }
    }
  }

  // S3d retention near head-on (one 200-unit box, split 40, split 10), also at 1,000 samples/s
  const regimesD: Array<[string, number, number]> = [...REGIMES, ['1000/s v30', 30 / 1000, 1000]]
  const geosD = [['one 200-u box', 0], ['split <=40', 40], ['split <=10', 10]] as const
  for (const [geo, split] of geosD) {
    for (const [rn, step, rate] of regimesD) {
      const obs = [box(10.5, 0, 0.5, 100)], cases: Case[] = []
      for (const ang of [60, 80, 85, 88]) {
        const a = deg(ang)
        cases.push({
          name: `S3d ${geo} ${rn} ${ang} deg`, start: { x: 9.3, z: 70 },
          world: () => buildWorld(obs, { split, floor: [-20, 50, -120, 120] }).w,
          samples: constant(Math.sin(a) * step, -Math.cos(a) * step, rate,
            Math.min(40000, Math.ceil(100 / (step * Math.cos(a))))),
          stop: (p) => p.z < -60,
        })
      }
      const per: Array<{ pen: number, wall: ReturnType<typeof alongWall> }> = []
      const res = await runAll(driver, cases, stream, (c, k) => {
        const m = per[k] = { pen: -1e9, wall: alongWall(c.start, 9.45) }
        const cross = contained(obs, c.start)
        return (s) => {
          m.pen = Math.max(m.pen, pen(obs, s.after))
          cross.visit(s.after.x, s.after.z)
          m.wall.visit(s)
        }
      })
      const cells = res.map((_, k) => {
        const m = per[k]
        keep(m.wall)
        return `${[60, 80, 85, 88][k]}deg ${fmt((100 * m.wall.za) / m.wall.zc, 1)}%`
          + `${m.pen > 0.02 ? ' OVERLAP ' + fmt(m.pen) : ''}`
      })
      outcomes.push(...res)
      rows.push(`  ${geo.padEnd(14)} ${rn.padEnd(10)} ${NAME} ${cells.join('  ')}`)
    }
  }

  // S3e seam trap: seam at z = 0, 4,000 samples of 0.25 (30 units/s at 120/s) at 70-89 degrees.
  // The walls end at z = -100 and the floor at z = -120, so at 70-85 degrees the agent slides
  // past the wall's end and falls off the floor, as in t3 (which printed positions only):
  // retention and the sideways range count until z = -95.
  for (const ang of [70, 75, 80, 85, 89]) {
    for (const thickB of [1, 2]) {
      const obs = [box(10.5, 50, 0.5, 50), box(10 + thickB / 2, -50, thickB / 2, 50)], a = deg(ang)
      const zAt: number[] = [], start = { x: 9.4, z: 5 }
      const wall = alongWall(start, 9.4, undefined, -95), cross = contained(obs, start)
      const [o] = await runAll(driver, [{
        name: `S3e ${ang} deg thick ${thickB}`, start,
        world: () => buildWorld(obs, { floor: [-20, 50, -120, 120] }).w,
        samples: constant(Math.sin(a) * 0.25, -Math.cos(a) * 0.25, 120, 4000),
      }], stream, () => (s) => {
        pen(obs, s.after)
        cross.visit(s.after.x, s.after.z)
        if (s.i % 1000 === 999) zAt.push(s.after.z)
        wall.visit(s)
      })
      keep(wall)
      outcomes.push(o)
      rows.push(`  ang ${ang} thick ${thickB} ${NAME} z ${zAt.map((z) => fmt(z, 3)).join(' ')} `
        + `(${fmt(5 - 4000 * 0.25 * Math.cos(a), 1)}) reverts ${o.stats.reverts} `
        + `rec ${o.stats.recoveries}`)
    }
  }
  return {
    rows, outcomes, worst, overlaps, crossings: crossed.reduce((n, c) => n + c.count, 0),
    minRetention: minRet, maxSideways: maxSide, zeroProgress,
  }
}

// A closed box as a trimesh, triangles at most `seg` long along z (t3 section S3g)
function boxTrimesh(hx: number, hy: number, hz: number, seg: number, flags: number) {
  const nz = Math.max(1, Math.round((2 * hz) / seg)), V: number[] = [], I: number[] = []
  const zs = Array.from({ length: nz + 1 }, (_, i) => -hz + (2 * hz * i) / nz)
  const idx = (x: number, y: number, z: number) => {
    V.push(x, y, z)
    return V.length / 3 - 1
  }
  const ring = zs.map((z) => [idx(-hx, -hy, z), idx(hx, -hy, z), idx(hx, hy, z), idx(-hx, hy, z)])
  for (let i = 0; i < nz; i++) {
    const a = ring[i], b = ring[i + 1]
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      I.push(a[k], a[k2], b[k2], a[k], b[k2], b[k])
    }
  }
  const e0 = ring[0], e1 = ring[nz]
  I.push(e0[0], e0[2], e0[1], e0[0], e0[3], e0[2], e1[0], e1[1], e1[2], e1[0], e1[2], e1[3])
  return R.ColliderDesc.trimesh(new Float32Array(V), new Uint32Array(I), flags)
}

/**
 * t3 S3g: a 200-unit wall as a closed trimesh with triangles 200, 40 and 10 long, without and with
 * FIX_INTERNAL_EDGES | MERGE_DUPLICATE_VERTICES, at 30 and 85 degrees in t3's regimes, and the
 * crossings of the wall (Validation 3: contained).
 */
export async function trimeshWalls(driver: MotionDriver, stream: Stream): Promise<GroupResult> {
  const L = 200, rows: string[] = [], outcomes: Outcome[] = []
  const fixFlags = R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES
  const obs = [box(10.5, 0, 0.5, L / 2)]
  let worst = -1e9, overlaps = 0, crossings = 0
  let minRet: number | null = null, maxSide: number | null = null
  for (const seg of [200, 40, 10]) {
    for (const flags of [0, fixFlags]) {
      const cells: string[] = []
      for (const [rn, step, rate] of REGIMES) {
        for (const ang of [30, 85]) {
          const world = () => {
            const w = new R.World({ x: 0, y: -981, z: 0 })
            w.timestep = 1 / 120
            w.createCollider(R.ColliderDesc.cuboid(40, 0.5, L / 2 + 30).setTranslation(0, -0.5, 0)
              .setCollisionGroups(G1))
            w.createCollider(boxTrimesh(0.5, 5, L / 2, seg, flags).setTranslation(10.5, 5, 0)
              .setCollisionGroups(G2))
            w.step()
            return w
          }
          const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
          const start = { x: 9.3, z: L / 2 - 20 }, wall = alongWall(start, 9.45)
          const cross = new Crossings(obs, start.x, start.z)
          let p = -1e9
          const [o] = await runAll(driver, [{
            name: `S3g tri ${seg} ${flags ? 'FIX' : 'none'} ${rn} ${ang} deg`, world, start,
            samples: constant(dx, dz, rate, Math.ceil((L - 50) / (step * Math.cos(a)))),
          }], stream, () => (s) => {
            const d = worstPen(obs, s.after.x, s.after.z)
            p = Math.max(p, d)
            if (d > 0.02) overlaps++
            cross.visit(s.after.x, s.after.z)
            wall.visit(s)
          })
          crossings += cross.count
          worst = Math.max(worst, p)
          minRet = minOf(minRet, wall.retention)
          maxSide = maxOf(maxSide, wall.sideways)
          outcomes.push(o)
          cells.push(`${rn}/${ang}: ${fmt(p)} ${fmt((100 * wall.za) / wall.zc, 1)}%`)
        }
      }
      const flagsName = flags ? 'FIX_INTERNAL_EDGES' : 'no flags          '
      rows.push(`  tri ${String(seg).padStart(3)} ${flagsName} ${NAME} ${cells.join(' | ')}`)
    }
  }
  return { rows, outcomes, worst, overlaps, crossings, minRetention: minRet, maxSideways: maxSide }
}

/**
 * Validation 3's "side of a 200-unit raised platform from below", which the study has no script
 * for. A walkable platform 200 long, 40 wide and 2 high (its top a floor, collision group 1) stands
 * on the floor; ADR-0001 R5.1 caps a walkable surface reachable from the side from a floor more
 * than 0.3 lower, so it is five 40 x 40 pieces. The agent runs along its side on the floor below,
 * as along Validation 1's long walls (from (8, 90), 1-75 degrees, t3's three regimes; the side
 * face at x = 10), and is measured the same way.
 */
export async function raisedPlatform(driver: MotionDriver, stream: Stream): Promise<GroupResult> {
  const L = 200, H = 2, rows: string[] = [], outcomes: Outcome[] = []
  // the platform's footprint: the agent's body (0.3-4.15 above the floor) spans the platform's
  // height, so the footprint depth is the overlap
  const obs = [box(30, 0, 20, L / 2)]
  let worst = -1e9, overlaps = 0, crossings = 0
  let minRet: number | null = null, maxSide: number | null = null
  const world = () => {
    const w = new R.World({ x: 0, y: -981, z: 0 })
    w.createCollider(R.ColliderDesc.cuboid(40, 0.5, L / 2 + 30).setTranslation(10, -0.5, 0)
      .setCollisionGroups(G1))
    for (let i = 0; i < 5; i++) {
      w.createCollider(R.ColliderDesc.cuboid(20, (H + 1) / 2, 20)
        .setTranslation(30, (H - 1) / 2, -L / 2 + 20 + 40 * i).setCollisionGroups(G1))
    }
    w.step()
    return w
  }
  for (const [rn, step, rate] of REGIMES) {
    const cells: string[] = []
    for (const ang of [1, 5, 15, 30, 75]) {
      const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
      const start = { x: 8, z: L / 2 - 10 }, wall = alongWall(start, 9.47)
      let p = -1e9, lo = 1e9, hi = -1e9, feetMax = 0
      const [o] = await runAll(driver, [{
        name: `platform ${rn} ${ang} deg`, world, start,
        samples: constant(dx, dz, rate, Math.floor((L - 20) / (step * Math.cos(a)))),
      }], stream, () => (s) => {
        const d = worstPen(obs, s.after.x, s.after.z)
        p = Math.max(p, d)
        if (d > 0.02) overlaps++
        if (s.after.x > 11) crossings++
        feetMax = Math.max(feetMax, s.after.y)
        wall.visit(s)
        if (wall.touched) {
          lo = Math.min(lo, s.after.x)
          hi = Math.max(hi, s.after.x)
        }
      })
      worst = Math.max(worst, p)
      minRet = minOf(minRet, wall.retention)
      maxSide = maxOf(maxSide, wall.sideways)
      outcomes.push(o)
      cells.push(`${ang}deg ${fmt(p)}/${fmt(wall.retention, 1)}%/${fmt(hi - lo)}/feet `
        + `${fmt(feetMax)}`)
    }
    rows.push(`  platform side ${rn.padEnd(10)} ${cells.join('  ')}`)
  }
  return { rows, outcomes, worst, overlaps, crossings, minRetention: minRet, maxSideways: maxSide }
}
