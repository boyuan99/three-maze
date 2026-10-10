// Equivalence harness for the hover mover (plan item MOT-03): runs the vendored reference mover
// (reference/lib/hover.mjs, U+RS at top 4.15) and the TypeScript mover (src/motion/mover.ts, eye
// height 3.7, driven through the motion core src/motion/core.ts) on identical worlds and inputs,
// and compares every sample's pose bit for bit, the counters at the end, and the time per sample.
//
// The reference takes world-frame displacements (dx, dz) per sample; the core takes body-frame
// samples. At heading 0 (yaw 0 looks down -Z, left is -X) the sample d = [-dz, -dx, 0] is the
// same displacement: the core turns it with sin 0 = 0 and cos 0 = 1, which reproduces dx and dz
// exactly, and its sub-step count from hypot(-dz, -dx) equals the reference's from hypot(dx, dz).
// Device time is integer µs (device-v1.md section 7.2), so both movers get dt = dt_us / 1e6
// seconds; at 120 samples/s that is 0.008333 s, not 1/120.
//
// The cases reproduce the worlds and inputs of the inclined-face study's scripts
// (proto/verify/inclined/mover_fix/ in the three-maze-notes repository; t3_walls.mjs is vendored
// as reference/t3_walls.mjs) with the vendored generators. Only the inputs are reproduced, not the
// study's measurements, and 120 samples/s use whole microseconds as above.
import { R } from './reference/lib/rapier.mjs'
import { makeHover } from './reference/lib/hover.mjs'
import { buildWorld, obstacles, refreshQueries } from './reference/lib/walls.mjs'
import { addObstacle, agentGap, cone, makeWorld, slab, sphere } from './reference/lib/geom.mjs'
import { inclinedAdditions } from './reference/lib/rooms.mjs'
import { createMotionCore } from '../../src/motion/core.ts'
import { instantiate } from '../../src/motion/instantiate.ts'
import type { ColliderManifest, ManifestCollider } from '../../src/motion/manifest.ts'
import { createHoverMover } from '../../src/motion/mover.ts'
import type { HoverStats } from '../../src/motion/mover.ts'

// geom.mjs's makeWorld reads this test hook; it must not change the slope angles here
delete process.env.KCCDEG

export { R }

/** World-frame displacement of one sample and its length in µs. */
export type Input = [dx: number, dz: number, dtUs: number]

/** A Rapier world built by the reference's builders (lib/walls.mjs, lib/geom.mjs), untyped. */
export type RefWorld = any

export interface Run {
  name: string
  /** Builds a fresh world; called once per mover. */
  world: () => RefWorld
  /** Builds the TypeScript mover's world instead, if given (for example through instantiate()). */
  moverWorld?: () => RefWorld
  x: number
  z: number
  /** Teleport right after creation (the reference's place(x, z, feetY)). */
  place?: [number, number, number]
  inputs: Input[]
  /** Stops the run after the first sample whose (reference) pose satisfies it. */
  stop?: (pose: { x: number, y: number, z: number }) => boolean
  /**
   * Called before sample i (from 0) with each mover's world, the reference's first, to change the
   * world at run time, for example to enable a collider.
   */
  before?: (i: number, world: RefWorld) => void
}

export interface Difference {
  sample: number
  reference: { x: number, y: number, z: number, airborne: boolean }
  mover: { x: number, y: number, z: number, airborne: boolean }
}

export interface RunResult {
  name: string
  samples: number
  /** Samples whose x, feet, z and airborne state are identical (Object.is on each number). */
  identical: number
  first: Difference | null
  /** Counters that differ at the end: name -> [reference, mover]. */
  counters: Record<string, [unknown, unknown]>
  /** The mover's counters at the end. */
  stats: HoverStats
  /** Time per sample in µs, reference and mover (mover time includes the motion core). */
  usReference: number
  usMover: number
}

const now = () => process.hrtime.bigint()

// Counters of options the TypeScript mover dropped, and the one it added (fall 'none')
const ONLY_REFERENCE = new Set(['retries', 'retryOk', 'maxNyVert'])
const ONLY_MOVER = new Set(['rayNone'])

/** Runs one case on both movers, interleaved sample by sample. */
export function compareRun(run: Run): RunResult {
  const wr = run.world(), wt = (run.moverWorld ?? run.world)()
  const ref = makeHover(R, wr, run.x, run.z, { fix: true, top: 4.15 })
  const mover = createHoverMover(R, wt, { x: run.x, z: run.z, eyeHeight: 3.7 })
  const core = createMotionCore({ mover })
  if (mover.top !== ref.top) throw new Error(`top ${mover.top} differs from ${ref.top}`)
  if (run.place) {
    ref.place(...run.place)
    core.teleport({ x: run.place[0], z: run.place[1], feetY: run.place[2] })
  }
  let identical = 0, samples = 0, first: Difference | null = null
  let tRef = 0n, tMover = 0n, t = 0
  for (const [dx, dz, dtUs] of run.inputs) {
    if (run.before) {
      run.before(samples, wr)
      run.before(samples, wt)
    }
    t += dtUs
    const t0 = now()
    ref.move(dx, dz, dtUs / 1e6)
    const t1 = now()
    const record = core.apply({
      seq: samples, seq_source: 'device', t_dev_us: t, dt_us: dtUs, d: [-dz, -dx, 0],
    })
    const t2 = now()
    tRef += t1 - t0
    tMover += t2 - t1
    const p = ref.pos()
    const same = record !== null && Object.is(p.x, record.x) && Object.is(p.y, record.feetY)
      && Object.is(p.z, record.z) && ref.airborne === record.airborne
    if (same) identical++
    else if (!first) {
      first = {
        sample: samples,
        reference: { ...p, airborne: ref.airborne },
        mover: record
          ? { x: record.x, y: record.feetY, z: record.z, airborne: record.airborne }
          : { x: NaN, y: NaN, z: NaN, airborne: false },
      }
    }
    samples++
    if (run.stop && run.stop(p)) break
  }
  const counters: Record<string, [unknown, unknown]> = {}
  const theirs = ref.st as Record<string, unknown>
  const ours = mover.stats as unknown as Record<string, unknown>
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
    if (ONLY_REFERENCE.has(key) || ONLY_MOVER.has(key)) continue
    if (JSON.stringify(theirs[key]) !== JSON.stringify(ours[key])) {
      counters[key] = [theirs[key], ours[key]]
    }
  }
  if (core.stats.subSteps !== mover.stats.sub) {
    counters.coreSubSteps = [mover.stats.sub, core.stats.subSteps]
  }
  const stats = structuredClone(mover.stats)
  mover.free()
  wr.free()
  wt.free()
  return {
    name: run.name, samples, identical, first, counters, stats,
    usReference: Number(tRef) / 1e3 / samples, usMover: Number(tMover) / 1e3 / samples,
  }
}

/**
 * Runs the cases one after the other, yielding to the event loop between runs, so that the test
 * runner's worker stays responsive during minutes of synchronous Rapier calls.
 */
export async function compareAll(runs: Run[]): Promise<RunResult[]> {
  const results: RunResult[] = []
  for (const run of runs) {
    results.push(compareRun(run))
    await new Promise((resolve) => setImmediate(resolve))
  }
  return results
}

/**
 * The same case with the TypeScript mover in a world built the way the application builds it:
 * the reference world's colliders, read back from Rapier in handle order, become a collider
 * manifest (layer 'world'), which instantiate() turns into a query world with its own collision
 * groups (src/motion/instantiate.ts). Cuboids only, as the manifest of v1.0 scenes.
 */
export function viaManifest(run: Run): Run {
  const w = run.world()
  const colliders: Array<ManifestCollider & { handle: number }> = []
  w.forEachCollider((c: RefWorld) => {
    if (c.shapeType() !== R.ShapeType.Cuboid) throw new Error(`${run.name}: not a cuboid`)
    const h = c.halfExtents(), t = c.translation(), q = c.rotation()
    colliders.push({
      handle: c.handle, id: `collider${c.handle}`, body: 'fixed', layer: 'world',
      shape: { kind: 'cuboid', halfExtents: [h.x, h.y, h.z] }, translation: [t.x, t.y, t.z],
      rotation: [q.x, q.y, q.z, q.w], enabled: true, sources: [run.name],
    })
  })
  w.free()
  const manifest: ColliderManifest = {
    format: 'three-maze-collider-manifest', version: 1, zones: [],
    colliders: colliders.sort((a, b) => a.handle - b.handle).map(({ handle, ...c }) => c),
  }
  const moverWorld = () => instantiate(R, manifest).world
  return { ...run, name: `${run.name} (instantiate)`, moverWorld }
}

/** Sums the mover's numeric counters over several runs. */
export function totals(results: RunResult[]): Record<string, number> {
  const sum: Record<string, number> = {}
  for (const r of results) {
    for (const [key, value] of Object.entries(r.stats)) {
      if (typeof value === 'number') sum[key] = (sum[key] ?? 0) + value
    }
  }
  return sum
}

// ---- inputs ----

/** dt in µs for a sample rate: whole µs, as device time is. */
export const dtUs = (rate: number) => Math.round(1e6 / rate)

/** count samples of the same displacement. */
export const constant = (dx: number, dz: number, rate: number, count: number): Input[] =>
  Array.from({ length: count }, () => [dx, dz, dtUs(rate)])

/**
 * Random running as in the study's soaks (mover_fix/t4_soak.mjs, t6_cost.mjs): every 0.5 s the
 * heading changes by up to +-1.25 rad and the speed is drawn from 5-141 units/s, with the study's
 * generator (its seeds are 1, 7, 21 and 99).
 */
export function soakInputs(rate: number, seed: number, seconds: number): Input[] {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  let heading = 0, v = 30
  const n = Math.round(rate * seconds), per = Math.round(rate / 2), out: Input[] = []
  for (let i = 0; i < n; i++) {
    if (i % per === 0) {
      heading += (rnd() - 0.5) * 2.5
      v = 5 + rnd() * 136
    }
    out.push([-Math.sin(heading) * v / rate, -Math.cos(heading) * v / rate, dtUs(rate)])
  }
  return out
}

// ---- cases ----

const G1 = ((1 << 16) | 0xffff) >>> 0, G2 = ((2 << 16) | 0xffff) >>> 0 // the study's floor, walls
const deg = (d: number) => (d * Math.PI) / 180
/** The regimes of t3: [name, displacement per sample, samples per second]. */
export const REGIMES: Array<[string, number, number]> = [
  ['120/s v30', 30 / 120, 120], ['120/s v141', 141 / 120, 120], ['20/s v100', 100 / 20, 20],
]
type Box = { t: 'box', cx: number, cz: number, hx: number, hz: number, yaw?: number }
const box = (cx: number, cz: number, hx: number, hz: number, yaw?: number): Box =>
  ({ t: 'box', cx, cz, hx, hz, ...(yaw ? { yaw } : {}) })

/** t3 section S1, long walls: one row (wall length L, split) over 3 regimes x 5 angles. */
export function longWallRuns(L: number, split: number): Run[] {
  const obs = [box(10.5, 0, 0.5, L / 2)], runs: Run[] = []
  for (const [rn, step, rate] of REGIMES) {
    for (const ang of [1, 5, 15, 30, 75]) {
      const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
      runs.push({
        name: `S1 L${L} split ${split || '-'} ${rn} ${ang} deg`,
        world: () => buildWorld(obs, { split, floor: [-20, 30, -L / 2 - 20, L / 2 + 20] }).w,
        x: 8, z: L / 2 - 10,
        inputs: constant(dx, dz, rate, Math.floor((L - 20) / (step * Math.cos(a)))),
      })
    }
  }
  return runs
}

/** t3 section S2, thin walls (0.1 thick) at 141-1,000 units/s, up to 20 start phases. */
export function thinWallRuns(lengths = [40, 400, 1200]): Run[] {
  const runs: Run[] = []
  const cases = [[120, 141], [120, 300], [120, 1000], [20, 141], [20, 1000]]
  for (const Lw of lengths) {
    for (const split of Lw > 40 ? [0, 40] : [0]) {
      for (const [rate, v] of cases) {
        for (const inc of [90, 20, 5]) {
          const step = v / rate, a = deg(inc), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
          for (let ph = 0; ph < 20; ph++) {
            const x0 = 9.48 - dx * (1 + ph / 20) - 0.5, K = Math.ceil((11.1 - x0) / dx) + 1
            if (K * Math.abs(dz) > Lw - 4) break
            const obs = [box(10.05, 0, 0.05, Lw / 2)]
            const floor = [-100, 120, -Lw / 2 - 60, Lw / 2 + 60]
            runs.push({
              name: `S2 Lw ${Lw} split ${split || '-'} ${v}@${rate} ${inc} deg phase ${ph}`,
              world: () => buildWorld(obs, { split, floor }).w,
              x: x0, z: (K * Math.abs(dz)) / 2, inputs: constant(dx, dz, rate, K),
            })
          }
        }
      }
    }
  }
  return runs
}

/** t3 section S3: coplanar seams, T-junction, corner and wedges, near head-on, seam trap. */
export function seamRuns(): Run[] {
  const runs: Run[] = []
  // S3a coplanar seam (second piece proud by lip, T stem behind)
  for (const lip of [0, 0.001, -0.001]) {
    for (const [rn, step, rate] of REGIMES) {
      for (const ang of [5, 30, 75]) {
        const obs = [box(10.5, 50, 0.5, 50), box(10.5 - lip, -50, 0.5, 50), box(26, 0, 15, 0.5)]
        const a = deg(ang), dx = Math.sin(a) * step, dz = -Math.cos(a) * step
        runs.push({
          name: `S3a lip ${lip} ${rn} ${ang} deg`,
          world: () => buildWorld(obs, { floor: [-20, 50, -120, 120] }).w, x: 9.3, z: 70,
          inputs: constant(dx, dz, rate, Math.ceil(140 / (step * Math.cos(a)))),
          stop: (p) => p.z < -60,
        })
      }
    }
  }
  // S3b T-junction
  const legs = [[0.15, 1, 100], [1, 0.15, 60], [1, -0.1, 40], [-1, 0.2, 120], [0.05, -1, 20]]
  for (const split of [0, 40]) {
    for (const [rn, step, rate] of REGIMES) {
      const obs = [box(5.5, -50, 0.5, 50), box(-5.5, -50, 0.5, 50), box(0, 10.5, 60, 0.5),
        box(32.5, -0.5, 27.5, 0.5), box(-32.5, -0.5, 27.5, 0.5), box(60.5, 5, 0.5, 6),
        box(-60.5, 5, 0.5, 6), box(0, -100.5, 6, 0.5)]
      const inputs: Input[] = []
      for (const [ux, uz, dist] of legs) {
        const l = Math.hypot(ux, uz)
        for (let i = 0; i < Math.ceil(dist / step); i++) {
          inputs.push([(ux / l) * step, (uz / l) * step, dtUs(rate)])
        }
      }
      runs.push({
        name: `S3b split ${split || '-'} ${rn}`,
        world: () => buildWorld(obs, { split, floor: [-70, 70, -110, 20] }).w, x: 3, z: -90, inputs,
      })
    }
  }
  // S3c inside corner and wedges, pushed along the bisector or the axis
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
        const obs = mk()
        runs.push({
          name: `S3c ${gname} split ${split || '-'} ${rn}`,
          world: () => buildWorld(obs, { split, floor: [-60, 60, -110, 60] }).w, x: x0, z: z0,
          inputs: constant(dir[0] * step, dir[1] * step, rate, 300),
        })
      }
    }
  }
  // S3d retention near head-on, also at 1,000 samples/s
  const regimesD: Array<[string, number, number]> = [...REGIMES, ['1000/s v30', 30 / 1000, 1000]]
  const geosD = [['one 200-u box', 0], ['split <=40', 40], ['split <=10', 10]] as const
  for (const [geo, split] of geosD) {
    for (const [rn, step, rate] of regimesD) {
      for (const ang of [60, 80, 85, 88]) {
        const obs = [box(10.5, 0, 0.5, 100)], a = deg(ang)
        const N = Math.min(40000, Math.ceil(100 / (step * Math.cos(a))))
        runs.push({
          name: `S3d ${geo} ${rn} ${ang} deg`,
          world: () => buildWorld(obs, { split, floor: [-20, 50, -120, 120] }).w, x: 9.3, z: 70,
          inputs: constant(Math.sin(a) * step, -Math.cos(a) * step, rate, N),
          stop: (p) => p.z < -60,
        })
      }
    }
  }
  // S3e seam trap: 4,000 samples of 0.25 at 70-89 degrees
  for (const ang of [70, 75, 80, 85, 89]) {
    for (const thickB of [1, 2]) {
      const obs = [box(10.5, 50, 0.5, 50), box(10 + thickB / 2, -50, thickB / 2, 50)], a = deg(ang)
      runs.push({
        name: `S3e ${ang} deg thick ${thickB}`,
        world: () => buildWorld(obs, { floor: [-20, 50, -120, 120] }).w, x: 9.4, z: 5,
        inputs: constant(Math.sin(a) * 0.25, -Math.cos(a) * 0.25, 120, 4000),
      })
    }
  }
  return runs
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

/** t3 section S3g: a 200-unit wall as a closed trimesh, triangles 200/40/10 long. */
export function trimeshWallRuns(): Run[] {
  const L = 200, runs: Run[] = []
  const fixFlags = R.TriMeshFlags.FIX_INTERNAL_EDGES | R.TriMeshFlags.MERGE_DUPLICATE_VERTICES
  for (const seg of [200, 40, 10]) {
    for (const flags of [0, fixFlags]) {
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
          runs.push({
            name: `S3g tri ${seg} ${flags ? 'FIX_INTERNAL_EDGES' : 'no flags'} ${rn} ${ang} deg`,
            world, x: 9.3, z: L / 2 - 20,
            inputs: constant(dx, dz, rate, Math.ceil((L - 50) / (step * Math.cos(a)))),
          })
        }
      }
    }
  }
  return runs
}

/** The closed 400 x 120 soak room (walls split 40), optionally with the inclined additions. */
export function soakRoom(inclined: boolean): () => RefWorld {
  const obs = obstacles(), extra = inclined ? inclinedAdditions() : []
  return () => {
    const { w } = buildWorld(obs, { split: 40, floor: [-205, 205, -65, 65] })
    for (const o of extra) addObstacle(w, o)
    refreshQueries(w)
    return w
  }
}

/** Soak runs (t4): random running from (0, -45) in the vertical or the inclined soak room. */
export function soakRuns(inclined: boolean, rates: number[], seeds: number[], seconds: number) {
  const world = soakRoom(inclined), runs: Run[] = []
  for (const rate of rates) {
    for (const seed of seeds) {
      runs.push({
        name: `soak ${inclined ? 'inclined' : 'vertical'} ${rate}/s seed ${seed} ${seconds} s`,
        world, x: 0, z: -45, inputs: soakInputs(rate, seed, seconds),
      })
    }
  }
  return runs
}

// A world of the study's t5: a floor cuboid, then the given colliders
function floorWorld(half: number, add: (w: RefWorld) => void) {
  return () => {
    const w = new R.World({ x: 0, y: -981, z: 0 })
    w.createCollider(R.ColliderDesc.cuboid(half, 0.5, half).setTranslation(0, -0.5, 0)
      .setCollisionGroups(G1))
    add(w)
    w.step()
    return w
  }
}

/**
 * Directed runs at inclined faces, curved obstacles, steps, a drop and falls, from the study's
 * t1 (ramps, Part A; long slabs, Part B), t2 (balls, a dome, 256-gon hull cones) and t5 (steps,
 * the 20-unit drop, falls onto steep faces). `full` takes more angles and regimes of each.
 */
export function inclinedRuns(full = false): Run[] {
  const runs: Run[] = []
  // t1 Part A: 20 x 20 slab rotated about X, approached head-on at 30 units/s for 5 s
  for (const th of full ? [15, 25, 30, 31, 35, 45, 60, 75, 90] : [15, 30, 31, 45]) {
    for (const rate of [120, 20, 250]) {
      const o = slab({ th, fz: 0.5 * Math.sin(deg(th)), W: 10, L: 20, T: 1 })
      runs.push({
        name: `t1A ${th} deg ${rate}/s`, world: () => makeWorld([o], [-50, 50, -100, 100]),
        x: 0, z: 10, inputs: constant(0, -30 / rate, rate, Math.round(rate * 5)),
      })
    }
  }
  // t1 Part B: 400-unit slabs (ten 40-unit pieces) along the strike line, 150 units of path
  const regimes: Array<[number, number]> = full
    ? [[30, 20], [30, 120], [30, 250], [141, 20], [141, 120], [141, 250]] : [[30, 20], [141, 250]]
  for (const th of full ? [31, 33, 35, 45, 60, 90, 110, 135, 150] : [31, 33, 60, 110, 150]) {
    for (const inc of full ? [5, 30, 60, 90] : [5, 60]) {
      for (const [v, rate] of regimes) {
        const o = slab({ th, fz: 0.5, W: 200, L: 20, T: 1 }), step = v / rate, a = deg(inc)
        runs.push({
          name: `t1B ${th} deg incidence ${inc} ${v}@${rate}`,
          world: () => makeWorld([o], [-250, 250, -60, 60]), x: -180, z: 10.5,
          inputs: constant(Math.cos(a) * step, -Math.sin(a) * step, rate, Math.ceil(150 / step)),
        })
      }
    }
  }
  // t2: past a ball, a dome or a hull cone, first contact at the given incidence
  const contactD = (o: unknown) => {
    let lo = 0, hi = 60
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2
      if (agentGap(o, mid, 0, 0.3, 4.15, 0.5) > 0.02) hi = mid
      else lo = mid
    }
    return hi
  }
  const curved: Array<[string, () => unknown]> = [
    ['ball R3', () => sphere(0, 3, 0, 3)], ['ball R10', () => sphere(0, 10, 0, 10)],
    ['dome R10', () => sphere(0, 0, 0, 10)], ['cone upright', () => cone(0, 0, 10, 20, false, 256)],
    ['cone inverted', () => cone(0, 0, 10, 20, true, 256)],
  ]
  for (const [name, mk] of curved) {
    for (const inc of full ? [5, 15, 30, 45, 60, 75, 90] : [15, 60, 90]) {
      for (const [v, rate] of regimes) {
        const D = contactD(mk()), step = v / rate
        runs.push({
          name: `t2 ${name} incidence ${inc} ${v}@${rate}`,
          world: () => makeWorld([mk()], [-80, 80, -80, 80]), x: D * Math.cos(deg(inc)), z: D + 10,
          inputs: constant(0, -step, rate, Math.ceil((2 * D + 20) / step)),
        })
      }
    }
  }
  // t5 (c): a platform of height h, head-on and at 45 degrees, 30 units/s at 120/s
  for (const h of full ? [0.1, 0.25, 0.28, 0.284, 0.29, 0.3, 0.31, 0.5] : [0.28, 0.31]) {
    for (const ang of [0, 45]) {
      const world = floorWorld(50, (w) => w.createCollider(R.ColliderDesc.cuboid(10, h / 2, 10)
        .setTranslation(0, h / 2, -10).setCollisionGroups(G2)))
      const a = deg(ang)
      runs.push({
        name: `t5c step ${h} ${ang} deg`, world, x: ang ? 5 : 0, z: 5,
        inputs: constant((-Math.sin(a) * 30) / 120, (-Math.cos(a) * 30) / 120, 120, 60),
      })
    }
  }
  // t5 (b): walk off a 10 x 20 x 10 box at 30 units/s and land 20 units lower
  for (const rate of [20, 120, 250]) {
    for (const [cx, cz] of full ? [[0, 0], [23.4, -17.7], [-60, 50], [37, 41]] : [[23.4, -17.7]]) {
      const world = floorWorld(600, (w) => w.createCollider(R.ColliderDesc.cuboid(5, 10, 5)
        .setTranslation(cx, 10, cz).setCollisionGroups(G2)))
      runs.push({
        name: `t5b drop from (${cx}, ${cz}) ${rate}/s`, world, x: cx, z: cz, place: [cx, cz, 20],
        inputs: constant(0, -30 / rate, rate, 2 * rate),
      })
    }
  }
  // t5 (d): off a 10-high ledge onto a 45-degree slab, a ball or a hull cone, then on, stop or
  // back (120/s)
  const ledge = box(0, 0, 5, 5)
  const below: Array<[string, unknown]> = [
    ['45-deg slab',
      slab({ th: 45, fx: 0, fz: -12.5, hyaw: 180, W: 10, L: 7 / Math.sin(Math.PI / 4), T: 1 })],
    ['R4 ball', sphere(0, 4, -12, 4)], ['cone 4/8 hull', cone(0, -11, 4, 8, false, 256)],
  ]
  for (const [bn, bo] of below) {
    for (const [inName, vz] of [['continue', -30], ['stop', 0], ['push back', 30]] as const) {
      const world = floorWorld(150, (w) => {
        addObstacle(w, ledge)
        addObstacle(w, bo)
      })
      const inputs: Input[] = []
      for (let i = 0; i < 420; i++) inputs.push([0, (i < 60 ? -30 : vz) / 120, dtUs(120)])
      runs.push({ name: `t5d onto ${bn}, ${inName}`, world, x: 0, z: 0, place: [0, 0, 10], inputs })
    }
  }
  return runs
}

/**
 * Guard undos after airborne sweeps, which no scene case reaches: a lid (a 2 x 1 x 2 cuboid, like
 * a gate enabled at run time, outside ADR-0001 R5) appears around the agent while it falls from
 * the 20-unit box of t5 (b), at 120 samples/s, and disappears four samples later. Every sweep in
 * between ends inside the lid and is undone, and so is every horizontal sub-step.
 */
export function forcedUndoRuns(): Run[] {
  let lid = -1
  const world = floorWorld(150, (w) => {
    w.createCollider(R.ColliderDesc.cuboid(5, 10, 5).setTranslation(0, 10, 0)
      .setCollisionGroups(G2))
    lid = w.createCollider(R.ColliderDesc.cuboid(1, 0.5, 1).setTranslation(6.5, 19, 0)
      .setCollisionGroups(G2).setEnabled(false)).handle
  })
  const inputs: Input[] = []
  for (let i = 0; i < 60; i++) inputs.push([i < 10 ? 0.25 : 0, 0, dtUs(120)])
  return [{
    name: 'forced undo: a lid around the agent falling off a 20-unit box, samples 12-15',
    world, x: 4, z: 0, place: [4, 0, 20], inputs,
    before: (i, w) => {
      if (i !== 12 && i !== 16) return
      w.getCollider(lid).setEnabled(i === 12)
      refreshQueries(w)
    },
  }]
}
