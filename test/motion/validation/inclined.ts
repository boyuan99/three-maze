// ADR-0001 Validation 5 (docs/adr/0001-player-mover.md): floors, drops, steps, ramps, inclined
// faces, curved obstacles and falls, run case by case as the study's scripts ran them:
//
// - t1 Part A and B (mover_fix/t1_slabs.mjs): a 20 x 20 slab rising at 15-90 degrees, head-on;
//   400-unit slabs (ten 40-unit pieces) of 31-150 degrees at 5-90 degrees of incidence.
// - t2 (mover_fix/t2_curved.mjs): balls of radius 3, 10 and 25 on the floor and as domes, and
//   256-gon hull cones upright and inverted (Rapier's cone primitive, which t2 also ran, is not
//   allowed: ADR-0001 R5.2).
// - X1 (verify/xdirected.mjs): the proxy study's directed shapes with their own colliders:
//   balls up to radius 60, hull cones, slabs and wedges of 35-75 degrees, a lying cylinder, a
//   tumbled cube and the twisted 50-unit slab ("split slab").
// - t5 (mover_fix/t5_floors_falls.mjs): floor T-junctions, the 20-unit drop, steps, falls onto
//   steep faces; X7 (verify/xscenes.mjs fallreach): falls toward a ball.
// - walkable ramps of 28 degrees with rails (verify/xscenes.mjs ramp30 and rampexit, verify/
//   xramp_side.mjs: X15, X16, X2).
// - t7 (mover_fix/t7_census.mjs): the adversarial cast-miss census.
// Two cases are not from the study: steps under an overhang (Validation 5: "a 0.28 step climbed
// and >= 0.29 blocked, also under an overhang"), and ramps descended 30 degrees off-axis.
//
// The measures are the scripts' own (reference/lib/run.mjs drive(), reference/proxy/checks.mjs),
// and each group formats the rows its script printed for the mover U+RS at top 4.15, so that the
// archived stream can be compared with the archived outputs. Added for every inclined case: the
// near plane at 16:9 and 32:9 (camera.ts), and the sideways range against a perfect slide
// (measures.ts) next to the study's.
import type { World } from '@dimforge/rapier3d-compat'
import { R } from '../reference/lib/rapier.mjs'
import {
  addObstacle, agentGap, cone, makeWorld, minGap, minGapAny, minPointSD, pointSD, slab,
  slabGapGeneric, sphere,
} from '../reference/lib/geom.mjs'
import { f } from '../reference/lib/run.mjs'
import { sdObs } from '../reference/lib/walls.mjs'
import { buildScene } from '../reference/proxy/scene.mjs'
import {
  Box, Frustum, LyingCyl, Slab, Sphere, Wedge, edges2, qAxis, qMul,
} from '../reference/proxy/geom.mjs'
import { minOverCyl } from '../reference/proxy/checks.mjs'
import { CameraMin, EYE } from './camera.ts'
import type { Agent, MotionDriver } from './driver.ts'
import { Slide } from './measures.ts'
import { addOutcome, emptyTotals, runCase, tick, withStream } from './run.ts'
import type { Case, Outcome, Step, Stream, Totals } from './run.ts'
import { bodyFrame, constant, dtUs, swingPhase, worldSample } from './streams.ts'
import type { Sample } from './streams.ts'
import { hullCone } from './soaks.ts'

const deg = (d: number) => (d * Math.PI) / 180
const G1 = ((1 << 16) | 0xffff) >>> 0, G2 = ((2 << 16) | 0xffff) >>> 0
const NAME = 'U+RS top4.15'
/** A cuboid collider as the study's scripts made them: half extents, centre, collision groups. */
const cuboid = (w: World, half: [number, number, number], at: [number, number, number],
  groups: number) => w.createCollider(R.ColliderDesc.cuboid(...half)
  .setTranslation(...at).setCollisionGroups(groups))
const TOP = EYE + 0.45
/** A shape of the study's geometry libraries (reference/lib/geom.mjs, reference/proxy/geom.mjs),
 *  untyped JavaScript objects. */
type Obstacle = any

/** One group's result: rows as its script printed them, totals, and its thresholds' numbers. */
export interface Result {
  rows: string[]
  totals: Totals
  /** Samples deeper than the skin into a true shape, and the smallest gap of any sample. */
  overlaps: number
  minGap: number
  /**
   * Smallest distance of the eye point (feet + 3.7 on the axis) from a shape, over the runs that
   * measure it (Infinity where none does).
   */
  eyeMin: number
  camera: CameraMin
  /** Lowest retention along a flat face (fraction), largest sideways range against a slide. */
  minRetention: number | null
  maxSideways: number | null
  /** Group-specific failures, in words (empty when every check of the group passed). */
  failures: string[]
}

const result = (): Result => ({
  rows: [], totals: emptyTotals(), overlaps: 0, minGap: Infinity, eyeMin: Infinity,
  camera: new CameraMin(), minRetention: null, maxSideways: null, failures: [],
})
const keepMin = (a: number | null, b: number | null) =>
  (b === null ? a : a === null ? b : Math.min(a, b))
const keepMax = (a: number | null, b: number | null) =>
  (b === null ? a : a === null ? b : Math.max(a, b))

/**
 * reference/lib/run.mjs drive(), per sample of a case run through a driver: the analytic gap of
 * the cylinder (gapFn), the eye point, retention along `along` and the range across `across`
 * after the first touch (gap < touch), and, added, the camera's near plane and the sideways
 * range against a perfect slide along `across`.
 */
interface Drive {
  worstGap: number
  n02: number
  n0: number
  eyeMin: number
  eyeLt0: number
  eyeLt01: number
  eyeLtC169: number
  feetMax: number
  touched: boolean
  cmdAlong: number
  actAlong: number
  lo: number
  hi: number
  retention: number | null
  wobble: number | null
  sideways: number | null
  outcome: Outcome
}

interface DriveOptions {
  obs: Obstacle[]
  gapFn: (obs: Obstacle[], ax: number, az: number, ya: number, yb: number, r: number) => number
  touch?: number
  along?: [number, number]
  across?: [number, number]
  /** across . axis at contact, for the perfect slide (with across). */
  contact?: number
  camera?: CameraMin
  /** Heading of the camera on archived streams (their heading stays 0): the motion's. */
  view?: number
}

function drive(driver: MotionDriver, c: Case, stream: Stream, o: DriveOptions): Drive {
  const r = {
    worstGap: Infinity, n02: 0, n0: 0, eyeMin: Infinity, eyeLt0: 0, eyeLt01: 0, eyeLtC169: 0,
    feetMax: -Infinity, touched: false, cmdAlong: 0, actAlong: 0, lo: Infinity, hi: -Infinity,
  }
  const touch = o.touch ?? 0.03
  const slide = o.across && o.contact !== undefined
    ? new Slide(o.across, () => o.contact as number, c.start.x, c.start.z) : null
  const outcome = runCase(driver, c, ({ before, after: p, sample, cmd, agent }: Step) => {
    const g = o.gapFn(o.obs, p.x, p.z, p.y + 0.3, p.y + agent.top, 0.5)
    if (g < r.worstGap) r.worstGap = g
    if (g < -0.02) r.n02++
    if (g < 0) r.n0++
    const e = minPointSD(o.obs, p.x, p.y + EYE, p.z)
    if (e < r.eyeMin) r.eyeMin = e
    if (e < 0) r.eyeLt0++
    if (e < 0.1) r.eyeLt01++
    if (e < 0.1857) r.eyeLtC169++
    if (o.camera) {
      const near = o.obs.filter((ob) => pointSD(ob, p.x, p.y + EYE, p.z) < 1.5)
      if (near.length) {
        const h = stream === 'rotating' ? p.yaw : o.view ?? 0
        o.camera.add((x, y, z) => minPointSD(near, x, y, z), p.x, p.y, p.z, h)
      }
    }
    if (p.y > r.feetMax) r.feetMax = p.y
    if (slide) slide.step(before.yaw, sample.d)
    if (!r.touched && g < touch) r.touched = true
    if (r.touched) {
      if (o.along) {
        r.cmdAlong += cmd[0] * o.along[0] + cmd[1] * o.along[1]
        r.actAlong += (p.x - before.x) * o.along[0] + (p.z - before.z) * o.along[1]
      }
      if (o.across) {
        const a = p.x * o.across[0] + p.z * o.across[1]
        if (a < r.lo) r.lo = a
        if (a > r.hi) r.hi = a
        if (slide) slide.record(p.x, p.z)
      }
    }
  })
  return {
    ...r, outcome, retention: r.cmdAlong > 1e-9 ? r.actAlong / r.cmdAlong : null,
    wobble: r.hi >= r.lo ? r.hi - r.lo : null, sideways: slide ? slide.range : null,
  }
}

/** fold() of reference/lib/run.mjs, for the rows. */
interface Fold {
  runs: number
  samples: number
  n02: number
  n0: number
  worstGap: number
  reverts: number
  rec: number
  itCap: number
  calls: number
  sub: number
  minRet: number | null
  maxWob: number | null
  eyeMin: number
  eyeLt0: number
  eyeLt01: number
  eyeLtC169: number
}
const emptyFold = (): Fold => ({
  runs: 0, samples: 0, n02: 0, n0: 0, worstGap: Infinity, reverts: 0, rec: 0, itCap: 0, calls: 0,
  sub: 0, minRet: null, maxWob: null, eyeMin: Infinity, eyeLt0: 0, eyeLt01: 0, eyeLtC169: 0,
})
function fold(a: Fold, d: Drive): void {
  a.runs++
  a.samples += d.outcome.samples
  a.n02 += d.n02
  a.n0 += d.n0
  a.worstGap = Math.min(a.worstGap, d.worstGap)
  a.reverts += d.outcome.stats.reverts
  a.rec += d.outcome.stats.recoveries
  a.itCap += d.outcome.stats.itCap
  a.calls += d.outcome.stats.calls
  a.sub += d.outcome.stats.sub
  a.minRet = keepMin(a.minRet, d.retention)
  a.maxWob = keepMax(a.maxWob, d.wobble)
  a.eyeMin = Math.min(a.eyeMin, d.eyeMin)
  a.eyeLt0 += d.eyeLt0
  a.eyeLt01 += d.eyeLt01
  a.eyeLtC169 += d.eyeLtC169
}

function keep(res: Result, d: Drive, flat = false): void {
  addOutcome(res.totals, d.outcome)
  res.overlaps += d.n02
  res.minGap = Math.min(res.minGap, d.worstGap)
  res.eyeMin = Math.min(res.eyeMin, d.eyeMin)
  if (flat) {
    res.minRetention = keepMin(res.minRetention, d.retention)
    res.maxSideways = keepMax(res.maxSideways, d.sideways)
  }
}

// ---- t1: inclined flat faces ----

/**
 * t1 Part A: the ramp geometry of the adjudication (a 20 x 20 x 1 slab rising at the given angle,
 * approached head-on from 10 units at 30 units/s for 5 s at 120, 20 and 250 samples/s). Faces
 * up to 30 degrees are climbed, 31-90 degrees blocked (feet never above 2).
 */
export async function t1PartA(driver: MotionDriver, stream: Stream): Promise<Result> {
  const res = result()
  let k = 0
  for (const th of [15, 25, 30, 31, 35, 40, 45, 50, 60, 75, 90]) {
    const cells: string[] = []
    for (const rate of [120, 20, 250]) {
      const o = slab({ th, fz: 0.5 * Math.sin(deg(th)), W: 10, L: 20, T: 1 }), step = 30 / rate
      const c = withStream({
        name: `t1A ${th} deg ${rate}/s`, world: () => makeWorld([o], [-50, 50, -100, 100]),
        start: { x: 0, z: 10 }, samples: constant(0, -step, rate, Math.round(rate * 5)),
      }, stream, k++)
      const d = drive(driver, c, stream, { obs: [o], gapFn: minGapAny })
      keep(res, d)
      const climbed = d.feetMax > 2
      if (climbed !== (th <= 30)) {
        res.failures.push(`t1A ${th} deg ${rate}/s: ${climbed ? 'climbed' : 'blocked'}`)
      }
      const rec = d.outcome.stats.recoveries
      cells.push(`${rate}/s:${climbed ? 'climb' : 'block'}/${d.n02}/${d.outcome.stats.reverts}/`
        + `${f(d.worstGap, 4)}${rec ? '/rec' + rec : ''}`)
      await tick()
    }
    res.rows.push(`  ${String(th).padStart(2)} deg ${NAME.padEnd(15)} ${cells.join('  ')}`)
  }
  return res
}

/**
 * t1 Part B: 400-unit slabs (ten flush 40-unit pieces) at 31-150 degrees, approached at 5-90
 * degrees of incidence from the strike line, 30 and 141 units/s at 20, 120 and 250 samples/s,
 * 150 units of path: 588 runs. Retention along the strike (incidence < 90), sideways across it.
 */
export async function t1PartB(driver: MotionDriver, stream: Stream): Promise<Result> {
  const res = result()
  const regimes = [[30, 20], [30, 120], [30, 250], [141, 20], [141, 120], [141, 250]]
  let k = 0
  for (const th of [31, 33, 35, 40, 45, 50, 60, 75, 90, 100, 110, 120, 135, 150]) {
    const acc = emptyFold()
    for (const ang of [5, 15, 30, 45, 60, 75, 90]) {
      for (const [v, rate] of regimes) {
        const o = slab({ th, fz: 0.5, W: 200, L: 20, T: 1 })
        const a = deg(ang), step = v / rate, dx = Math.cos(a) * step, dz = -Math.sin(a) * step
        // the axis's z when the face-plane gap is the 0.02 skin (the slab's face normal n,
        // horizontal part along +z; the rim that touches is the bottom one below 90 degrees)
        const n = o.n, contact = o.P0[2] + (0.02 + 0.5 * Math.hypot(n[0], n[2])
          - Math.min(n[1] * 0.3, n[1] * TOP)) / n[2]
        const c = withStream({
          name: `t1B ${th} deg incidence ${ang} ${v}@${rate}`,
          world: () => makeWorld([o], [-250, 250, -60, 60]), start: { x: -180, z: 10.5 },
          samples: constant(dx, dz, rate, Math.ceil(150 / step)),
        }, stream, k++)
        const d = drive(driver, c, stream,
          { obs: [o], gapFn: minGap, along: [1, 0], across: [0, 1], contact })
        fold(acc, d)
        keep(res, d, true)
        await tick()
      }
    }
    res.rows.push(`  ${String(th).padStart(3)} deg ${NAME.padEnd(15)} runs ${acc.runs} samples `
      + `${acc.samples} overlaps ${acc.n02} gap<0 ${acc.n0} worst ${f(acc.worstGap, 4)} reverts `
      + `${acc.reverts} recoveries ${acc.rec} itCap ${acc.itCap} `
      + `minRet ${f(100 * (acc.minRet ?? NaN), 1)}% maxWob ${f(acc.maxWob, 4)} `
      + `eye min ${f(acc.eyeMin, 3)} <0 ${acc.eyeLt0} <0.1 ${acc.eyeLt01} `
      + `<0.186 ${acc.eyeLtC169} calls/sub ${f(acc.calls / acc.sub, 2)}`)
  }
  return res
}

// ---- t2: balls, domes, hull cones ----

/** The axis distance at which the agent's analytic gap to `o` is the 0.02 skin (t2 contactD). */
const contactD = (o: Obstacle, top: number) => {
  let lo = 0, hi = 60
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (agentGap(o, mid, 0, 0.3, top, 0.5) > 0.02) hi = mid
    else lo = mid
  }
  return hi
}

/**
 * t2: balls of radius 3, 10, 25 resting on the floor and as domes, 256-gon hull cones (base radius
 * 10, height 20) upright and inverted; first contact at 5-90 degrees of incidence, 30 and 141
 * units/s at 20, 120 and 250 samples/s, past the obstacle: 42 runs each.
 */
export async function t2Curved(driver: MotionDriver, stream: Stream): Promise<Result> {
  const res = result()
  const obstacles: Array<[string, () => Obstacle]> = [
    ...[3, 10, 25].map((Rr): [string, () => Obstacle] =>
      [`sphere R${Rr} on floor`, () => sphere(0, Rr, 0, Rr)]),
    ...[3, 10, 25].map((Rr): [string, () => Obstacle] =>
      [`sphere R${Rr} dome`, () => sphere(0, 0, 0, Rr)]),
    ['cone upright hull256', () => cone(0, 0, 10, 20, false, 256)],
    ['cone inverted hull256', () => cone(0, 0, 10, 20, true, 256)],
  ]
  const regimes = [[30, 20], [30, 120], [30, 250], [141, 20], [141, 120], [141, 250]]
  let k = 0
  for (const [oname, mk] of obstacles) {
    const acc = emptyFold(), D = contactD(mk(), TOP)
    let passed = 0
    for (const ang of [5, 15, 30, 45, 60, 75, 90]) {
      for (const [v, rate] of regimes) {
        const o = mk(), step = v / rate
        const c = withStream({
          name: `t2 ${oname} incidence ${ang} ${v}@${rate}`,
          world: () => makeWorld([o], [-80, 80, -80, 80]),
          start: { x: D * Math.cos(deg(ang)), z: D + 10 },
          samples: constant(0, -step, rate, Math.ceil((2 * D + 20) / step)),
        }, stream, k++)
        const d = drive(driver, c, stream, { obs: [o], gapFn: minGap })
        if (d.outcome.final.z < -D) passed++
        fold(acc, d)
        keep(res, d)
        await tick()
      }
    }
    res.rows.push(`  ${oname.padEnd(24)} ${NAME.padEnd(15)} D ${f(D, 2)}: ${acc.n02} / ${acc.n0} / `
      + `${f(acc.worstGap, 4)} / ${acc.reverts} / ${acc.rec} / ${acc.itCap} / `
      + `passed ${passed}/${acc.runs} / eye ${f(acc.eyeMin, 3)} ${acc.eyeLt0} ${acc.eyeLt01} `
      + `${acc.eyeLtC169} / ${f(acc.calls / acc.sub, 2)}`)
  }
  return res
}

// ---- X1: the proxy study's directed shapes, own colliders ----

const tumbleQ = qMul(qAxis(1, 0, 0, (40 * Math.PI) / 180), qAxis(0, 0, 1, (30 * Math.PI) / 180))
/** A shape of X1, how to make it, and its approaches: [kind, direction of the edge to take]. */
type X1Shape = [string, () => Obstacle, Array<[string, [number, number]?]>]
const X1_SHAPES: X1Shape[] = [
  ['sphere R3', () => Sphere('sphere R3', 0, 3, 0, 3), [['radial']]],
  ['sphere R10', () => Sphere('sphere R10', 0, 10, 0, 10), [['radial']]],
  ['sphere R25', () => Sphere('sphere R25', 0, 25, 0, 25), [['radial']]],
  ['cone up', () => hullCone(Frustum('cone up', 0, 0, 0, 10, 20, 0), 0, 0, 0, 20, 10),
    [['radial']]],
  ['cone inverted', () => hullCone(Frustum('cone inverted', 0, 0, 0, 0, 20, 10), 0, 0, 20, 0, 10),
    [['radial']]],
  ...[35, 45, 60, 75].map((a): X1Shape => [`wall ${a}`,
    () => Slab(`wall ${a}`, [0, 0, 0], 0, a, 12, 1, 120), [['away', [-1, 0]], ['toward', [1, 0]]]]),
  ...[35, 45, 60, 75].map((a): X1Shape => [`ramp ${a}`,
    () => Wedge(`ramp ${a}`, [0, 0, 0], 0, a, 6, 120), [['slope', [-1, 0]]]]),
  ['cylinder lying', () => LyingCyl('cylinder lying', [0, 3, 0], 90, 3, 60),
    [['side', [-1, 0]], ['end', [0, 1]]]],
  ['tumbled cube', () => {
    const b0 = Box('t', [0, 0, 0], [4, 4, 4], tumbleQ)
    return Box('tumbled cube 8', [0, -b0.ymin - 0.3, 0], [4, 4, 4], tumbleQ)
  }, [['all edges']]],
  ['sphere R60 (split circle)', () => Sphere('sphere R60', 0, 60, 0, 60), [['radial']]],
  ['twisted slab 50 (split hull)', () => {
    const q = qMul(qAxis(0, 0, 1, (3 * Math.PI) / 180), qAxis(1, 0, 0, (35 * Math.PI) / 180))
    const b0 = Box('t', [0, 0, 0], [25, 3, 0.5], q)
    return Box('twisted slab 50', [0, -b0.ymin - 0.3, 0], [25, 3, 0.5], q)
  }, [['all edges']]],
]

interface Approach {
  label: string
  make: (ang: number) => {
    p0: [number, number], d: [number, number], D: number, circle?: [number, number],
    ret?: { t: [number, number], mid: [number, number], lim: number } | null
  }
}

// verify/xdirected.mjs approaches(): approach A's layout, unchanged
function approaches(F: Obstacle, kind: [string, [number, number]?]): Approach[] {
  const DELTA = 1.0
  if (kind[0] === 'radial') {
    const rc = F.r + 0.52
    return [{
      label: 'radial',
      make: (ang) => {
        const b = rc * Math.cos((ang * Math.PI) / 180), sx = F.cx - (rc + DELTA + 1)
        return { p0: [sx, F.cz - b], d: [1, 0], D: 2 * (rc + DELTA + 1), circle: [F.cx, F.cz] }
      },
    }]
  }
  const E = edges2(F.V)
  const dir = kind[1]
  const pick = dir
    ? [E.reduce((best: Obstacle, e: Obstacle) => (e.n[0] * dir[0] + e.n[1] * dir[1]
      > best.n[0] * dir[0] + best.n[1] * dir[1] ? e : best))]
    : E
  return pick.map((e: Obstacle, i: number) => ({
    label: dir ? kind[0] : `edge ${i} (L ${f(e.L, 1)})`,
    make: (ang: number) => {
      const a = (ang * Math.PI) / 180, long = e.L >= 20
      const sc = long ? e.L / 4 : 0, sl = long ? e.L / 2 : 10
      const along = ang < 90 ? sc + DELTA / Math.tan(a) : sc
      const p0: [number, number] = [e.mid[0] + e.t[0] * along + e.n[0] * (0.52 + DELTA),
        e.mid[1] + e.t[1] * along + e.n[1] * (0.52 + DELTA)]
      const d: [number, number] = [-e.n[0] * Math.sin(a) - e.t[0] * Math.cos(a),
        -e.n[1] * Math.sin(a) - e.t[1] * Math.cos(a)]
      const D = ang < 90 ? Math.min(200, DELTA / Math.sin(a) + sl / Math.cos(a)) : DELTA + 10
      return {
        p0, d, D,
        ret: long && ang < 90
          ? { t: [-e.t[0], -e.t[1]] as [number, number], mid: e.mid, lim: e.L / 4 + 1 }
          : null,
      }
    },
  }))
}

/** One X1 group (shape, approach) as the archived table printed it, for the comparison. */
export interface X1Row {
  shape: string
  approach: string
  runs: number
  samples: number
  calls: number
  undo: number
  recoveries: string
  slides: number
  itCap: number
  bodyMin: string
  body: string
  eye: string
  rect: string
  env: string
  clips: number
  retention: string
}

/** X1's runs per approach, in the cross-test's order: angle, then speed, then rate. */
const X1_RUNS = [5, 15, 30, 45, 60, 75, 90].flatMap((ang) => [30, 141]
  .flatMap((v) => [20, 120, 250].map((rate) => [ang, v, rate] as const)))

/**
 * X1: the proxy study's directed shapes with their own colliders (cones as 256-gon hulls), 7
 * angles x 30 and 141 units/s x 20, 120 and 250 samples/s per approach: 1,302 runs. Body: the
 * true shape's exact distance minimised over the cylinder (checks.mjs minOverCyl); camera at the
 * direction of motion (archived) or the heading (rotating), 16:9 and 32:9.
 */
export async function x1Directed(driver: MotionDriver, stream: Stream):
  Promise<Result & { table: X1Row[], table329: X1Row[] }> {
  const res = result(), table: X1Row[] = [], table329: X1Row[] = []
  const LAYOUT_TOP = Math.max(EYE + 0.2, TOP + 0.1)
  const bodyAt = (fn: Obstacle, x: number, y: number, z: number) =>
    minOverCyl(fn, x, z, 0.5, y + 0.3, y + TOP, 48, 17)
  let k = 0
  for (const [sname, mk, kinds] of X1_SHAPES) {
    const o0 = mk(), F = o0.footprint(0, LAYOUT_TOP)
    for (const ap of kinds.flatMap((kind) => approaches(F, kind))) {
      const agg = {
        runs: 0, samples: 0, calls: 0, undo: 0, rec: 0, recOk: 0, slides: 0, itCap: 0,
        bodyMin: Infinity, b0: 0, b02: 0, retMin: Infinity, retN: 0, passN: 0, passed: 0,
      }
      const cam = new CameraMin()
      for (const [ang, v, rate] of X1_RUNS) {
        const o = mk(), run = ap.make(ang), step = v / rate, N = Math.ceil(run.D / step)
        const h = Math.atan2(-run.d[0], -run.d[1]), fn = o.sdf
        const c = withStream({
          name: `X1 ${sname} ${ap.label} ${ang} ${v}@${rate}`,
          world: () => buildScene({ floor: [-200, 200, -200, 200], objects: [o],
            walk: [{ rect: [-200, 200, -200, 200], y: 0 }] }, 'true').w,
          start: { x: run.p0[0], z: run.p0[1] },
          samples: constant(run.d[0] * step, run.d[1] * step, rate, N),
        }, stream, k++)
        let rc = 0, rr = 0
        const outcome = runCase(driver, c, ({ before, after: p, cmd }) => {
          const view = stream === 'rotating' ? p.yaw : h
          cam.add(fn, p.x, p.y, p.z, view, 1.0)
          const lb = fn(p.x, p.y + (0.3 + TOP) / 2, p.z) - Math.hypot(0.5, (TOP - 0.3) / 2)
          let bodyNow = Infinity
          if (lb < 0.1) {
            bodyNow = bodyAt(fn, p.x, p.y, p.z)
            agg.bodyMin = Math.min(agg.bodyMin, bodyNow)
            if (bodyNow < 0) agg.b0++
            if (bodyNow < -0.02) agg.b02++
          }
          if (bodyNow < 0.05 && run.ret) {
            const { t, mid } = run.ret
            const s0 = (before.x - mid[0]) * -t[0] + (before.z - mid[1]) * -t[1]
            if (Math.abs(s0) <= run.ret.lim) {
              rc += cmd[0] * t[0] + cmd[1] * t[1]
              rr += (p.x - before.x) * t[0] + (p.z - before.z) * t[1]
            }
          }
        })
        const ret = rc > 1 ? rr / rc : null
        const passed = run.circle && ang < 90 ? outcome.final.x > run.circle[0] : null
        if (passed !== null) {
          agg.passN++
          if (passed) agg.passed++
        }
        if (ret !== null) {
          agg.retMin = Math.min(agg.retMin, ret)
          agg.retN++
          res.minRetention = keepMin(res.minRetention, ret)
        }
        agg.runs++
        agg.samples += outcome.samples
        agg.calls += outcome.stats.calls
        agg.undo += outcome.stats.reverts
        agg.rec += outcome.stats.recoveries
        agg.recOk += outcome.stats.recoverOk
        agg.slides += outcome.stats.raySlides
        agg.itCap += outcome.stats.itCap
        addOutcome(res.totals, outcome)
        await tick()
      }
      res.overlaps += agg.b02
      res.minGap = Math.min(res.minGap, agg.bodyMin)
      res.eyeMin = Math.min(res.eyeMin, cam.eye)
      res.camera.merge(cam)
      const retention = agg.retN ? f(100 * agg.retMin, 2) + '%'
        : agg.passN ? `got past ${agg.passed}/${agg.passN}` : '-'
      const common = {
        shape: sname, approach: ap.label, runs: agg.runs, samples: agg.samples, calls: agg.calls,
        undo: agg.undo, recoveries: `${agg.rec} (${agg.recOk})`, slides: agg.slides,
        itCap: agg.itCap, bodyMin: f(agg.bodyMin, 4), body: `${agg.b0} / ${agg.b02}`,
        eye: f(cam.eye), retention,
      }
      const shown = (l: { value: number, bound: boolean }) => (l.bound ? '>=' : '') + f(l.value)
      table.push({ ...common, rect: shown(cam.rect169), env: shown(cam.env169),
        clips: cam.clips169 })
      table329.push({ ...common, rect: shown(cam.rect329), env: shown(cam.env329),
        clips: cam.clips })
    }
  }
  return { ...res, table, table329 }
}

// ---- t5: floors, drops, steps, falls; X7 ----

export interface FloorsResult extends Result {
  /** (a) largest feet range over floor T-junctions. */
  feetRange: number
  /** (b) largest |samples from fall_start to landing - free fall|, and runs that never landed. */
  dropWorst: number
  dropNoLanding: number
}

/**
 * t5 (a) floor T-junctions: tiles 30 and 40 wide meeting in T-junctions, 5-141 units/s from 5
 * starts and angles, 20/120/250 samples/s: the feet's range. (b) 20-unit drop: walking off a
 * 10 x 20 x 10 box at 30 units/s onto three floors (a 2-triangle and a 10-unit-triangle trimesh, a
 * cuboid) from 4 positions: samples from fall_start to landing against free fall.
 */
export async function t5FloorsDrops(driver: MotionDriver, stream: Stream): Promise<FloorsResult> {
  const res: FloorsResult = { ...result(), feetRange: 0, dropWorst: 0, dropNoLanding: 0 }
  const FL = R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES
  let k = 0
  // (a)
  const cellsA: string[] = []
  for (const rate of [20, 120, 250]) {
    let worst = 0, rev = 0
    for (const v of [5, 30, 100, 141]) {
      for (const [x0, ang] of [[0, 0], [-20, 0], [-25, 30], [-40, 60], [-30, 45]]) {
        const world = () => {
          const w = new R.World({ x: 0, y: -981, z: 0 })
          const tile = (a0: number, a1: number, z0: number, z1: number) =>
            cuboid(w, [(a1 - a0) / 2, 0.5, (z1 - z0) / 2], [(a0 + a1) / 2, -0.5, (z0 + z1) / 2], G1)
          for (let x = -60; x < 60; x += 30) tile(x, x + 30, -60, 0)
          for (let x = -60; x < 60; x += 40) tile(x, x + 40, 0, 140)
          w.step()
          return w
        }
        const a = deg(ang)
        let lo = 1e9, hi = -1e9
        const c = withStream({
          name: `t5a ${v}@${rate} from ${x0} at ${ang}`, world, start: { x: x0, z: 25 },
          samples: constant((Math.sin(a) * v) / rate, (-Math.cos(a) * v) / rate, rate,
            Math.ceil(50 / (v / rate))),
        }, stream, k++)
        const o = runCase(driver, c, ({ after }) => {
          lo = Math.min(lo, after.y)
          hi = Math.max(hi, after.y)
        })
        worst = Math.max(worst, hi - lo)
        rev += o.stats.reverts + o.stats.recoveries
        addOutcome(res.totals, o)
        await tick()
      }
    }
    res.feetRange = Math.max(res.feetRange, worst)
    cellsA.push(`${rate}/s range ${worst.toExponential(2)} reverts+recoveries ${rev}`)
  }
  res.rows.push(`  ${NAME.padEnd(13)} ${cellsA.join(' | ')}`)
  // (b)
  const floors: Array<[string, number, number]> = [['2-triangle 1200 trimesh', 600, 1],
    ['10-unit-triangle 200 trimesh', 100, 20], ['1200 cuboid', 600, 0]]
  for (const rate of [20, 120, 250]) {
    const cells: string[] = []
    let rev = 0, worstDiff = 0
    for (const [, half, n] of floors) {
      for (const [cx, cz] of [[0, 0], [23.4, -17.7], [-60, 50], [37, 41]]) {
        const world = () => {
          const w = new R.World({ x: 0, y: -981, z: 0 })
          if (n) {
            const V: number[] = [], I: number[] = []
            for (let i = 0; i <= n; i++) {
              for (let j = 0; j <= n; j++) {
                V.push(-half + (2 * half * i) / n, 0, -half + (2 * half * j) / n)
              }
            }
            for (let i = 0; i < n; i++) {
              for (let j = 0; j < n; j++) {
                const a = i * (n + 1) + j, b = a + 1, c2 = a + n + 1, d = c2 + 1
                I.push(a, b, d, a, d, c2)
              }
            }
            w.createCollider(R.ColliderDesc.trimesh(new Float32Array(V), new Uint32Array(I), FL)
              .setCollisionGroups(G1))
          } else {
            w.createCollider(R.ColliderDesc.cuboid(half, 0.5, half).setTranslation(0, -0.5, 0)
              .setCollisionGroups(G1))
          }
          cuboid(w, [5, 10, 5], [cx, 10, cz], G2)
          w.step()
          return w
        }
        let t0: number | null = null, t1: number | null = null
        const c = withStream({
          name: `t5b drop from (${cx}, ${cz}) ${rate}/s`, world, start: { x: cx, z: cz, feetY: 20 },
          samples: constant(0, -30 / rate, rate, 6 * rate), stop: () => t1 !== null,
        }, stream, k++)
        const o = runCase(driver, c, ({ i, after }) => {
          if (t0 === null && after.airborne) t0 = i
          if (t0 !== null && t1 === null && !after.airborne) t1 = i
        })
        const ff = Math.sqrt(40 / 981) * rate
        if (t1 === null || t0 === null) res.dropNoLanding++
        else worstDiff = Math.max(worstDiff, Math.abs(t1 - t0 - ff))
        cells.push(`${t1 === null || t0 === null ? 'no landing' : t1 - t0}`)
        rev += o.stats.reverts + o.stats.recoveries
        addOutcome(res.totals, o)
        await tick()
      }
    }
    res.dropWorst = Math.max(res.dropWorst, worstDiff)
    res.rows.push(`  ${NAME.padEnd(13)} ${String(rate).padStart(3)}/s free-fall `
      + `${f(Math.sqrt(40 / 981) * rate, 1)} samples; fall-to-land samples per (floor x start) `
      + `${cells.join(' ')}; worst |diff| ${f(worstDiff, 1)}; guard reverts + recoveries ${rev}`)
  }
  return res
}

export interface StepsResult extends Result {
  /** Every step run: height, approach angle, whether the feet reached the step's top. */
  outcomes: Array<{ h: number, ang: number, climbed: boolean }>
}

/**
 * t5 (c) steps: a 20 x 20 platform of height h ahead (z 0 to -20), the agent from z = 5 at 30
 * units/s and 120 samples/s for 60 samples, head-on and at 45 degrees: climbed if the feet reach
 * h. Steps up to 0.28 are climbed, 0.29 and higher blocked (0.282 and 0.284 depend on the approach:
 * the study's threshold 0.3 - 0.02 cos 30 = 0.2827).
 */
export async function t5Steps(driver: MotionDriver, stream: Stream): Promise<StepsResult> {
  const res: StepsResult = { ...result(), outcomes: [] }
  const cells: string[] = []
  let k = 0
  for (const h of [0.1, 0.2, 0.25, 0.27, 0.28, 0.282, 0.284, 0.29, 0.3, 0.31, 0.35, 0.5]) {
    for (const ang of [0, 45]) {
      const world = () => {
        const w = new R.World({ x: 0, y: -981, z: 0 })
        cuboid(w, [50, 0.5, 50], [0, -0.5, 0], G1)
        cuboid(w, [10, h / 2, 10], [0, h / 2, -10], G2)
        w.step()
        return w
      }
      const a = deg(ang)
      let maxFeet = 0
      const c = withStream({
        name: `t5c step ${h} ${ang} deg`, world, start: { x: ang ? 5 : 0, z: 5 },
        samples: constant((-Math.sin(a) * 30) / 120, (-Math.cos(a) * 30) / 120, 120, 60),
      }, stream, k++)
      const o = runCase(driver, c, ({ after }) => { maxFeet = Math.max(maxFeet, after.y) })
      const climbed = maxFeet >= h - 1e-6
      res.outcomes.push({ h, ang, climbed })
      addOutcome(res.totals, o)
      const p = o.final
      const what = climbed ? 'climb'
        : maxFeet < 1e-6 ? 'block z ' + f(p.z, 3) : 'feet ' + f(maxFeet, 3)
      const { reverts, recoveries } = o.stats
      cells.push(`h${h}/${ang}:${what}${reverts ? ' rev ' + reverts : ''}`
        + `${recoveries ? ' rec ' + recoveries : ''}`)
      await tick()
    }
  }
  res.rows.push(`  ${NAME.padEnd(13)} ${cells.join(' ')}`)
  return res
}

export interface LedgeResult extends Result {
  /** Runs that ended airborne (hung on the ledge's rim, ADR-0001 Risks), by trajectory. */
  hung: string[]
  /** Samples on the 0.35 step (never climbed). */
  onStep035: number
  /** Steps under the overhang: height, approach, whether the feet reached its top. */
  steps: Array<{ h: number, label: string, climbed: boolean }>
}

type Trajectory =
  [label: string, x: number, z: number, feet: number, heading: number, distance: number]

/**
 * X3 (verify/xscenes.mjs ledge, approach A's ledge.mjs scene with the objects' own colliders): a
 * 2-unit ledge (platform top y = 2 over x < 0), a 0.2 and a 0.35 step on the floor, two balls of
 * radius 3 one and two units from the ledge face, and a 45-degree slab standing on the platform's
 * edge and leaning out over the floor (an overhang) with a 0.2 step under it; 20 trajectories
 * (falls off the ledge toward and past the balls and under the slab, walks under the overhang
 * and onto the steps), 30 and 141 units/s at 20, 120 and 250 samples/s: 120 runs. Camera against
 * the true shapes at the direction of motion (archived) or the heading (rotating).
 *
 * Added for Validation 5's "a 0.28 step climbed and >= 0.29 blocked, also under an overhang": the
 * step under the overhang at heights 0.2, 0.28, 0.29 and 0.31, with X3's two trajectories onto it
 * (head-on and at 45 degrees). A climbed step puts the agent's top against the leaning slab.
 */
export async function ledgeScene(driver: MotionDriver, stream: Stream): Promise<LedgeResult> {
  const res: LedgeResult = { ...result(), hung: [], onStep035: 0, steps: [] }
  const mkSpec = (h: number) => ({
    floor: [-60, 60, -60, 60],
    boxes: [{ cx: -30, cz: 0, hx: 30, hz: 60, y0: -1, y1: 2, floor: true },
      { cx: 13, cz: 0, hx: 5, hz: 4, y0: -1, y1: 0.2, floor: true },
      { cx: 13, cz: 12, hx: 5, hz: 4, y0: -1, y1: 0.35, floor: true },
      { cx: 1.25, cz: 30, hx: 1.25, hz: 6, y0: -1, y1: h, floor: true }],
    objects: [Sphere('sphere A (gap 1)', 4, 3, 0, 3), Sphere('sphere B (gap 2)', 5, 3, -25, 3),
      Slab('overhang slab 45', [-2.5, 2, 30], 0, 45, 8, 1, 20)],
    walk: [],
  })
  const truth = mkSpec(0.2).objects
  const TR: Trajectory[] = [
    ['fall, far from objects (z -50)', -5, -50, 2, 0, 25],
    ['fall toward sphere A (gap 1, z 0)', -5, 0, 2, 0, 25],
    ['fall grazing sphere A (z 3.4)', -5, 3.4, 2, 0, 25],
    ['fall beside sphere A (z 6)', -5, 6, 2, 0, 25],
    ['fall at 60 deg past sphere A (z -6)', -5, -6, 2, 60, 25],
    ['fall toward sphere B (gap 2, z -25)', -5, -25, 2, 0, 25],
    ['fall grazing sphere B (z -21.6)', -5, -21.6, 2, 0, 25],
    ['fall beside the slab, then under it (z 18, 30 deg)', -5, 18, 2, 30, 25],
    ['fall along the slab end (z 19.4)', -5, 19.4, 2, 0, 25],
    ['floor: under the overhang, head-on (z 30)', 12, 30, 0, 180, 20],
    ['floor: under the overhang at 45 deg (z 30)', 12, 22, 0, 135, 25],
    ['floor: along the ledge under the overhang', 0.6, 50, 0, 270, 40],
    ['floor: onto the 0.2 step under the overhang (z 30)', 8, 30, 0, 180, 10],
    ['floor: onto the 0.2 step under the overhang at 45 deg', 8, 26, 0, 150, 10],
    ['floor: past sphere A beside the 0.2 step (x 7.7, never on it)', 7.7, -12, 0, 90, 20],
    ['floor: to the 0.2 step at 30 deg', 2, -10, 0, 30, 20],
    ['floor: to the 0.35 step head-on', 13, 4.6, 0, 90, 12],
    ['floor: to the 0.35 step at 30 deg', 6, 4.6, 0, 30, 15],
    ['platform: to the slab head-on (z 30)', -12, 30, 2, 0, 15],
    ['platform: along the ledge past the slab', -0.6, 0, 2, 90, 50],
  ]
  let k = 0
  const one = async (h: number, tr: Trajectory, v: number, rate: number) => {
    const [label, x0, z0, f0, hd, dist] = tr
    const spec = mkSpec(h)
    const a = deg(hd), step = v / rate, dx = Math.cos(a) * step, dz = Math.sin(a) * step
    const view0 = Math.atan2(-dx, -dz)
    let maxFeet = -Infinity, step035 = 0
    const c = withStream({
      name: `X3 ${label} ${v}@${rate}${h !== 0.2 ? ' step ' + h : ''}`,
      world: () => buildScene(spec, 'true').w,
      start: { x: x0, z: z0, feetY: f0 }, samples: constant(dx, dz, rate, Math.ceil(dist / step)),
    }, stream, k++)
    const o = runCase(driver, c, ({ after: p }) => {
      maxFeet = Math.max(maxFeet, p.y)
      if (p.x > 8.5 && p.x < 17.5 && p.z > 8.5 && p.z < 15.5 && p.y > 0.3) step035++
      for (const ob of truth) {
        res.camera.add(ob.sdf, p.x, p.y, p.z, stream === 'rotating' ? p.yaw : view0, 1.0)
        if (ob.sdf(p.x, p.y + (0.3 + TOP) / 2, p.z) < Math.hypot(0.5, (TOP - 0.3) / 2) + 0.2) {
          const b = minOverCyl(ob.sdf, p.x, p.z, 0.5, p.y + 0.3, p.y + TOP, 32, 9)
          res.minGap = Math.min(res.minGap, b)
          if (b < -0.02) res.overlaps++
        }
      }
    })
    addOutcome(res.totals, o)
    await tick()
    return { o, maxFeet, step035 }
  }
  let undo = 0, runs = 0
  for (const v of [30, 141]) {
    for (const rate of [20, 120, 250]) {
      for (const tr of TR) {
        const { o, step035 } = await one(0.2, tr, v, rate)
        runs++
        undo += o.stats.reverts
        res.onStep035 += step035
        if (o.final.airborne) res.hung.push(`${tr[0]} ${v}@${rate}`)
      }
    }
  }
  res.rows.push(`  X3 ledge scene: runs ${runs} guard undo ${undo} samples on the 0.35 step `
    + `${res.onStep035} runs ending airborne ${res.hung.length}`)
  const onto = TR.filter((tr) => tr[0].startsWith('floor: onto the 0.2 step under the overhang'))
  for (const h of [0.2, 0.28, 0.29, 0.31]) {
    const cells: string[] = []
    for (const tr of onto) {
      const name = tr[0].includes('45') ? '45 deg' : 'head-on'
      let climbed = 0
      for (const v of [30, 141]) {
        for (const rate of [20, 120, 250]) {
          const { maxFeet } = await one(h, tr, v, rate)
          const ok = maxFeet >= h - 1e-6
          if (ok) climbed++
          res.steps.push({ h, label: `${name} ${v}@${rate}`, climbed: ok })
        }
      }
      cells.push(`${name} climbed ${climbed}/6`)
    }
    res.rows.push(`  step ${h} under the overhang: ${cells.join(', ')}`)
  }
  return res
}

export interface FallsResult extends Result {
  /** Runs that ended airborne, or with the feet not on the floor (above 0.01). */
  notLanded: number
}

/**
 * t5 (d) falls onto a steep face: walking off a 10-high ledge onto a 45-degree slab, a ball of
 * radius 4 or a 256-gon hull cone below, then continuing, stopping or pushing back (120
 * samples/s). X7: walking off a platform 2 or 6 high toward a ball of radius 10 whose side is
 * 1.5-10 beyond the edge, 30 and 141 units/s at 20, 120 and 250 samples/s, 3 lateral offsets.
 * Every run must end on the floor below; overlap and the camera against the true shapes.
 */
export async function falls(driver: MotionDriver, stream: Stream): Promise<FallsResult> {
  const res: FallsResult = { ...result(), notLanded: 0 }
  let k = 0
  // t5 (d)
  const ledge = { t: 'box', cx: 0, cz: 0, hx: 5, hz: 5 }
  const below: Array<[string, Obstacle]> = [
    ['45-deg slab',
      slab({ th: 45, fx: 0, fz: -12.5, hyaw: 180, W: 10, L: 7 / Math.sin(Math.PI / 4), T: 1 })],
    ['R4 ball', sphere(0, 4, -12, 4)], ['cone 4/8 hull', cone(0, -11, 4, 8, false, 256)],
  ]
  for (const [bn, bo] of below) {
    const cells: string[] = []
    for (const [inName, vz] of [['continue -z', -30], ['stop', 0], ['push +z', 30]] as const) {
      const world = () => {
        const w = new R.World({ x: 0, y: -981, z: 0 })
        cuboid(w, [150, 0.5, 150], [0, -0.5, 0], G1)
        addObstacle(w, ledge)
        addObstacle(w, bo)
        w.step()
        return w
      }
      const samples: Sample[] = []
      for (let i = 0; i < 420; i++) {
        samples.push(worldSample(0, (i < 60 ? -30 : vz) / 120, dtUs(120)))
      }
      let worst = Infinity, zStop = 0
      const c = withStream({
        name: `t5d onto ${bn}, ${inName}`, world, start: { x: 0, z: 0, feetY: 10 }, samples,
      }, stream, k++)
      const o = runCase(driver, c, ({ i, after: p }) => {
        if (i === 59) zStop = p.z
        const gs = bo.t === 'slab' ? slabGapGeneric(bo, p.x, p.z, p.y + 0.3, p.y + TOP, 0.5)
          : agentGap(bo, p.x, p.z, p.y + 0.3, p.y + TOP, 0.5)
        const gl = p.y + 0.3 < 10 ? sdObs(ledge, p.x, p.z) - 0.5 : Infinity
        worst = Math.min(worst, gs, gl)
        if (Math.min(gs, gl) < -0.02) res.overlaps++
        const near = pointSD(bo, p.x, p.y + EYE, p.z) < 1.5
        if (near) res.camera.add((x, y, z) => pointSD(bo, x, y, z), p.x, p.y, p.z, p.yaw)
      })
      const p = o.final
      if (o.final.airborne || Math.abs(p.y) > 0.01) res.notLanded++
      res.minGap = Math.min(res.minGap, worst)
      addOutcome(res.totals, o)
      cells.push(`${inName}: feet ${f(p.y, 2)} z ${f(p.z, 2)} `
        + `${p.airborne ? 'AIRBORNE' : 'grounded'} rev ${o.stats.reverts} `
        + `rec ${o.stats.recoveries} gap ${f(worst, 4)} wallSweeps ${o.stats.airIncl}`
        + `${vz === 0 ? ' drift ' + f(p.z - zStop, 2) : ''}`)
      await tick()
    }
    res.rows.push(`  ${bn.padEnd(13)} ${NAME.padEnd(13)} ${cells.join(' | ')}`)
  }
  // X7
  for (const Hp of [2, 6]) {
    for (const D of [1.5, 3, 6, 10]) {
      const sph = Sphere('sphere R10', 0, 10, 0, 10), xe = -10 - D
      const spec = {
        floor: [-80, 80, -60, 60],
        boxes: [
          { cx: (-80 + xe) / 2, cz: 0, hx: (xe + 80) / 2, hz: 60, y0: -1, y1: Hp, floor: true },
        ],
        objects: [sph], walk: [],
      }
      let runs = 0, hung = 0, bodyMin = Infinity
      // the cross-test's order: speed, then rate, then lateral offset
      const X7_RUNS = [30, 141].flatMap((v) => [20, 120, 250]
        .flatMap((rate) => [0, 5, 8].map((z0) => [v, rate, z0] as const)))
      for (const [v, rate, z0] of X7_RUNS) {
        const step = v / rate, N = Math.ceil((D + 25) / step)
        const c = withStream({
          name: `X7 platform ${Hp} edge ${D} ${v}@${rate} z ${z0}`,
          world: () => buildScene(spec, 'true').w, start: { x: xe - 3, z: z0, feetY: Hp },
          samples: constant(step, 0, rate, N),
        }, stream, k++)
        const o = runCase(driver, c, ({ after: p }) => {
          res.camera.add(sph.sdf, p.x, p.y, p.z, stream === 'rotating' ? p.yaw : -Math.PI / 2)
          if (sph.sdf(p.x, p.y + (0.3 + TOP) / 2, p.z) < Math.hypot(0.5, (TOP - 0.3) / 2) + 0.2) {
            const b = minOverCyl(sph.sdf, p.x, p.z, 0.5, p.y + 0.3, p.y + TOP, 32, 9)
            bodyMin = Math.min(bodyMin, b)
            if (b < -0.02) res.overlaps++
          }
        })
        runs++
        if (o.final.airborne && o.final.y > 0.1) hung++
        if (o.final.airborne || Math.abs(o.final.y) > 0.01) res.notLanded++
        addOutcome(res.totals, o)
        await tick()
      }
      res.minGap = Math.min(res.minGap, bodyMin)
      res.rows.push(`  X7 platform ${Hp} edge to sphere ${D}: runs ${runs} hung ${hung} body to `
        + `sphere min ${f(bodyMin, 4)}`)
    }
  }
  return res
}

// ---- walkable ramps with rails (X15, X16, X2) ----

export interface RampsResult extends Result {
  /** Runs that should have reached the platform (up) or the floor (down) and did not. */
  missed: string[]
  /** Side runs that ended on the ramp, and on-ramp runs that left it by its side (X2). */
  sideOnRamp: number
  leftBySide: number
}

/**
 * Walkable ramps of 28 degrees (ADR-0001 R5.3), rotated cuboid slabs 20 wide rising 2 to a
 * platform, railed on both sides: X15's cases (up head-on, up 30 degrees off-axis, down head-on,
 * at the side at 45 degrees; 30 and 141 units/s at 20, 120 and 250 samples/s) plus down 30
 * degrees off-axis (not in the study), X16's climb onto the platform (head-on and off-axis), and
 * X2's side approaches (at 5-90 degrees to the side face at 5 points along it, and walking on the
 * ramp toward its side). Also at 20 degrees, the ramps of the proxy soak room.
 */
export async function ramps(driver: MotionDriver, stream: Stream): Promise<RampsResult> {
  const res: RampsResult = { ...result(), missed: [], sideOnRamp: 0, leftBySide: 0 }
  let k = 0
  for (const alpha of [20, 28]) {
    const a = (alpha * Math.PI) / 180, run = 2 / Math.tan(a), toe = 20 - run
    const ramp = Slab(`ramp ${alpha}`, [0, 0, toe], 90, alpha, 2 / Math.sin(a), 1, 20)
    const boxes: Obstacle[] = [{ cx: 0, cz: 40, hx: 40, hz: 20, y0: -1, y1: 2, floor: true }]
    for (const sx of [-1, 1]) {
      boxes.push({
        cx: sx * 10.1, cz: toe + run / 2, hx: 0.1, hz: run / 2, y0: 0, y1: 2 + EYE + 0.1,
      })
    }
    const scene = { floor: [-60, 60, -60, 60], boxes, walkTrue: [ramp], walk: [] }
    const world = () => buildScene(scene, 'proxy').w
    const reach = Math.hypot(0.5, (TOP - 0.3) / 2) + 0.1
    const body = (p: { x: number, y: number, z: number }) => {
      if (ramp.sdf(p.x, p.y + (0.3 + TOP) / 2, p.z) >= reach) return
      const b = minOverCyl(ramp.sdf, p.x, p.z, 0.5, p.y + 0.3, p.y + TOP, 32, 9)
      res.minGap = Math.min(res.minGap, b)
      if (b < -0.02) res.overlaps++
    }
    const kinds = new Map<string, { undo: number, runs: number, reached: number }>()
    // X15 kinds (+ down off-axis), X16's runs are X15's 'up' runs from 3 before the toe
    const cases: Array<[string, number, number, number, number, number, number, string | null]> = [
      ['head-on up', 0, toe - 3, 0, 0, 1, run + 6, 'top'],
      ['up at 30 deg off-axis', -4, toe - 2, 0, 0.5, 0.866, run + 5, 'top'],
      ['down head-on', 0, 25, 2, 0, -1, run + 8, 'floor'],
      ['down at 30 deg off-axis', 4, 25, 2, -0.5, -0.866, run + 8, 'floor'],
      ['side at 45 deg', 12.48, toe + 0.2 * run, 0, -0.7071, 0.7071, 6, null],
      ['X16 head-on', 0, toe - 3, 0, 0, 1, run + 8, 'top'],
      ['X16 30 deg off-axis', -4, toe - 3, 0, 0.5, 0.866, run + 8, 'top'],
    ]
    for (const v of [30, 141]) {
      for (const rate of [20, 120, 250]) {
        for (const [kind, x0, z0, f0, ux, uz, dist, goal] of cases) {
          const step = v / rate
          const c = withStream({
            name: `ramp ${alpha} ${kind} ${v}@${rate}`, world, start: { x: x0, z: z0, feetY: f0 },
            samples: constant(ux * step, uz * step, rate, Math.ceil(dist / step)),
          }, stream, k++)
          const o = runCase(driver, c, ({ after }) => body(after))
          const p = o.final
          const ok = goal === 'top' ? p.y > 1.99 : goal === 'floor' ? p.y < 0.01 && p.z < toe : true
          const K = kinds.get(kind) ?? { undo: 0, runs: 0, reached: 0 }
          K.undo += o.stats.reverts
          K.runs++
          if (ok) K.reached++
          else res.missed.push(`ramp ${alpha}: ${kind} ${v}@${rate}`)
          kinds.set(kind, K)
          addOutcome(res.totals, o)
          await tick()
        }
      }
    }
    const cells = [...kinds]
      .map(([kn, K]) => `${kn}: undo ${K.undo}, reached ${K.reached}/${K.runs}`)
    res.rows.push(`  ramp ${alpha} deg railed ${cells.join(' | ')}`)
    // X2 side approaches, railed
    const sideCases: Array<[string, number, number]> = []
    for (const fz of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      for (const ang of [5, 15, 30, 45, 60, 75, 90]) sideCases.push(['side', toe + fz * run, ang])
    }
    for (const fz of [0.25, 0.5, 0.75]) {
      for (const ang of [15, 45, 90]) sideCases.push(['onramp', toe + fz * run, ang])
    }
    let undo = 0, runs = 0, samples = 0, calls = 0
    for (const [kind, zc, ang] of sideCases) {
      for (const v of [30, 141]) {
        for (const rate of [20, 120, 250]) {
          if (kind === 'side' && zc > 20 - 0.6) continue
          const t = (ang * Math.PI) / 180, step = v / rate
          const [x0, z0, dxu, dzu] = kind === 'side'
            ? [11.5 + 0.98, zc - (ang < 90 ? 0.98 / Math.tan(t) : 0), -Math.sin(t), Math.cos(t)]
            : [5, zc, Math.sin(t), ang === 90 ? 0 : Math.cos(t) * 0.2]
          const dist = kind === 'side' ? 8 : 10
          const c = withStream({
            name: `X2 ramp ${alpha} ${kind} ${zc} ${ang} ${v}@${rate}`, world,
            start: { x: x0, z: z0, feetY: kind === 'side' ? 0 : (zc - toe) * Math.tan(a) },
            samples: constant(dxu * step, dzu * step, rate, Math.ceil(dist / step)),
          }, stream, k++)
          const o = runCase(driver, c, ({ after }) => body(after))
          const p = o.final
          if (kind === 'side' && p.y > 0.05) res.sideOnRamp++
          if (kind === 'onramp' && p.y < 0.05 && Math.abs(p.x) > 10) res.leftBySide++
          undo += o.stats.reverts
          runs++
          samples += o.samples
          calls += o.stats.calls
          addOutcome(res.totals, o)
          await tick()
        }
      }
    }
    res.rows.push(`  X2 ramp ${alpha} deg railed: runs ${runs} samples ${samples} KCC calls `
      + `${calls} guard undo ${undo}`)
  }
  return res
}

// ---- t7: adversarial cast-miss census ----

export interface CensusRow {
  name: string
  row: string
}

/**
 * t7: single-sample trials from adversarial starts (gap 0.02 +- 2e-5, 0.03 +- 2e-5 or 0.02-0.10
 * to one obstacle; a quarter within 0.05 degrees of head-on; sample lengths 0.05-5) at slab faces
 * of 90, 45, 60, 120 and 135 degrees, balls of radius 3, 10, 25 and 256-gon hull cones upright and
 * inverted: `trials` per obstacle (the study: 6,000). On the rotating stream each trial's sample
 * also turns the heading by up to +-0.38 rad (the largest turn of a 20 samples/s sample of the
 * rotating streams), so that its sub-steps fan out.
 */
export async function census(driver: MotionDriver, stream: Stream, trials = 6000): Promise<Result> {
  const res = result()
  const OBS: Array<[string, () => Obstacle]> = [
    ...[90, 45, 60, 120, 135].map((th): [string, () => Obstacle] =>
      ['slab ' + th, () => slab({ th, fz: 0, W: 40, L: 20, T: 1 })]),
    ...[3, 10, 25].map((Rr): [string, () => Obstacle] =>
      ['ball R' + Rr, () => sphere(0, Rr, 0, Rr)]),
    ['cone up hull256', () => cone(0, 0, 10, 20, false, 256)],
    ['cone inv hull256', () => cone(0, 0, 10, 20, true, 256)],
  ]
  for (const [oname, mk] of OBS) {
    const o = mk(), w = makeWorld([o], [-80, 80, -80, 80])
    const gapOf = (x: number, z: number, fy: number) => (o.t === 'slab'
      ? slabGapGeneric(o, x, z, fy + 0.3, fy + TOP, 0.5, 10)
      : agentGap(o, x, z, fy + 0.3, fy + TOP, 0.5))
    let s = 20261007
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const m: Agent = driver.create(w, { x: 70, z: 70 })
    const T = {
      n: 0, inside: 0, over: 0, worst: Infinity, skipped: 0, rev: 0, revTrials: 0, rec: 0,
      recOk: 0, noWall: 0, byC: 0, byP: 0, byD: 0,
      byBand: { skin: [0, 0], stepoff: [0, 0], free: [0, 0] } as Record<string, [number, number]>,
    }
    const st = m.stats
    let calls0 = st.calls, sub0 = st.sub, us = 0n, usMax = 0n
    for (let i = 0; i < trials; i++) {
      const band = ['skin', 'stepoff', 'free'][i % 3]
      const g0 = band === 'skin' ? 0.02 + (rnd() - 0.5) * 4e-5
        : band === 'stepoff' ? 0.03 + (rnd() - 0.5) * 4e-5
          : 0.02 + 0.08 * rnd()
      let x: number, z: number, hx: number, hz: number
      if (o.t === 'slab') {
        const nh = Math.hypot(o.n[0], o.n[2])
        hx = o.n[0] / nh
        hz = o.n[2] / nh
        const along = (rnd() - 0.5) * 2 * (o.W - 4)
        const yTerm = Math.min(o.n[1] * 0.3, o.n[1] * TOP)
        const sAx = (g0 + 0.5 * nh - yTerm) / nh
        x = o.P0[0] + o.u[0] * along + hx * sAx
        z = o.P0[2] + o.u[2] * along + hz * sAx
      } else {
        const ph = 2 * Math.PI * rnd()
        hx = Math.cos(ph)
        hz = Math.sin(ph)
        const cx = o.c ? o.c[0] : o.cx, cz = o.c ? o.c[2] : o.cz
        let lo = 0, hi = 60
        for (let j = 0; j < 70; j++) {
          const mid = (lo + hi) / 2
          if (agentGap(o, cx + hx * mid, cz + hz * mid, 0.3, TOP, 0.5) > g0) hi = mid
          else lo = mid
        }
        x = cx + hx * hi
        z = cz + hz * hi
      }
      if (!(gapOf(x, z, 0) > 0.0195 - 1e-4)) {
        T.skipped++
        continue
      }
      const headOn = rnd() < 0.25, inc = headOn ? 90 - 0.05 * rnd() : 1 + 89 * rnd()
      const side = rnd() < 0.5 ? 1 : -1
      const a = (inc * Math.PI) / 180, tx = -hz * side, tz = hx * side
      const L = [0.05, 0.12, 0.25, 1.175, 5][Math.floor(rnd() * 5)]
      const dx = L * (-Math.sin(a) * hx + Math.cos(a) * tx)
      const dz = L * (-Math.sin(a) * hz + Math.cos(a) * tz)
      m.place(x, z, 0)
      const r0 = st.reverts, q0 = st.recoveries, q1 = st.recoverOk, q2 = st.recoverNoWall
      const q3 = st.recoverByContact, q4 = st.recoverByProjection, q5 = st.recoverByDirection
      const us0 = L > 2 ? 50000 : 8333 // t7's dt: 1/20 s for the 5-unit sample, else 1/120 s
      let d: [number, number, number] = [-dz, -dx, 0]
      if (stream === 'rotating') {
        // the archived world displacement turned back by the midpoint heading of a turn of dyaw
        const dyaw = 0.38 * Math.sin(swingPhase(i) * 7)
        d = [...bodyFrame(dx, dz, m.yaw + dyaw / 2), dyaw]
      }
      const t0 = process.hrtime.bigint()
      m.apply(d, us0)
      const t = process.hrtime.bigint() - t0
      us += t
      if (t > usMax) usMax = t
      const g = gapOf(m.x, m.z, m.feetY)
      T.n++
      if (g < 0) T.inside++
      if (g < -0.02) T.over++
      T.worst = Math.min(T.worst, g)
      const dr = st.reverts - r0
      T.rev += dr
      if (dr) {
        T.revTrials++
        T.byBand[band][1]++
      }
      T.byBand[band][0]++
      T.rec += st.recoveries - q0
      T.recOk += st.recoverOk - q1
      T.noWall += st.recoverNoWall - q2
      T.byC += st.recoverByContact - q3
      T.byP += st.recoverByProjection - q4
      T.byD += st.recoverByDirection - q5
    }
    const { skin, stepoff, free } = T.byBand
    res.rows.push(`  ${oname.padEnd(17)} ${NAME.padEnd(16)} trials ${T.n} (skipped ${T.skipped}) `
      + `inside ${T.inside} overlaps ${T.over} worst gap ${f(T.worst, 4)} guard reverts ${T.rev} `
      + `in ${T.revTrials} trials (skin ${skin[1]}/${skin[0]}, step-off ${stepoff[1]}/`
      + `${stepoff[0]}, free ${free[1]}/${free[0]}); recoveries ${T.rec} (clear ${T.recOk}; `
      + `guard hits with no wall found ${T.noWall}; wall normals from contactShape ${T.byC}, `
      + `projectPoint ${T.byP}, motion direction ${T.byD})`)
    res.overlaps += T.over
    res.minGap = Math.min(res.minGap, T.worst)
    addOutcome(res.totals, {
      name: oname, samples: T.n,
      final: { x: m.x, y: m.feetY, z: m.z, yaw: m.yaw, airborne: m.airborne },
      stats: { ...st, calls: st.calls - calls0, sub: st.sub - sub0 },
      deviations: { ...m.deviations },
      us: Number(us) / 1e3, usMax: Number(usMax) / 1e3,
    })
    calls0 = st.calls
    sub0 = st.sub
    m.free()
    w.free()
    await tick()
  }
  return res
}
