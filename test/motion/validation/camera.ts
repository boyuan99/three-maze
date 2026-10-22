// Camera clearance (ADR-0001 Validation 5: "eye-point clearance >= 0.43 and near-plane clearance
// > 0 at 16:9 to 32:9"): the measure of approach A's lib/checks.mjs cam() (reference/proxy/
// checks.mjs; the cross-tests X1-X9 used it), with the aspect ratio as a parameter instead of the
// environment variable ASPECT, so that one run measures 16:9 and 32:9. The code is cam() and its
// patternMin(), which checks.mjs does not export, unchanged otherwise.
//
// The scene camera (v0.3 and the v1 designs): eye on the agent's axis at feet + 3.7, near plane
// 0.1, vertical field of view 75 degrees. For a true shape's exact signed distance f:
// - eye: f at the eye point;
// - rect: the minimum of f over the near-plane rectangle at the agent's heading;
// - env: the minimum over a vertical cylinder around the eye of radius hypot(near, half width)
//   and the near plane's half height, which holds the near-plane rectangle and the frustum's tip
//   for every heading (the "any-yaw envelope").
// Negative means the camera or its near plane is inside the shape. The near-plane rectangle at
// 32:9 contains the one at 16:9 (same height, wider), so 32:9's values bound every aspect between.
import { minOverCyl } from '../reference/proxy/checks.mjs'

export const EYE = 3.7

export interface Camera {
  aspect: number
  near: number
  /** Half height and half width of the near plane. */
  hh: number
  hw: number
  /** Radius of the any-yaw envelope, and the farthest near-plane corner from the eye. */
  rhoN: number
  reach: number
}

export function camera(aspect: number): Camera {
  const near = 0.1, vfov = 75
  const hh = near * Math.tan((vfov * Math.PI) / 360), hw = hh * aspect
  return { aspect, near, hh, hw, rhoN: Math.hypot(near, hw), reach: Math.hypot(near, hw, hh) }
}

export const CAM_16_9 = camera(16 / 9)
export const CAM_32_9 = camera(32 / 9)

type Sdf = (x: number, y: number, z: number) => number

// checks.mjs patternMin, unchanged
function patternMin(F: (q: number[]) => number, p0: number[], lo: number[], hi: number[],
  step0: number[], iters = 80): number {
  let p = p0.slice(), fp = F(p)
  const step = step0.slice()
  for (let it = 0; it < iters; it++) {
    let improved = false
    for (let d = 0; d < p.length; d++) {
      for (const s of [1, -1]) {
        const q = p.slice()
        q[d] = Math.min(hi[d], Math.max(lo[d], q[d] + s * step[d]))
        const fq = F(q)
        if (fq < fp) {
          p = q
          fp = fq
          improved = true
        }
      }
    }
    if (!improved) {
      let done = true
      for (let d = 0; d < step.length; d++) {
        step[d] *= 0.5
        if (step[d] > 1e-7) done = false
      }
      if (done) break
    }
  }
  return fp
}

export interface CameraClearance {
  eye: number
  rect: number
  env: number
  /** true: f at the eye was above exactBelow, rect and env are the lower bound eye - reach. */
  bound: boolean
}

/**
 * checks.mjs cam(): the clearances of a camera at the agent's pose (feet, heading h; yaw 0 looks
 * down -Z). Exact (grid plus pattern search) only where the eye is within exactBelow of the shape.
 */
export function cam(c: Camera, f: Sdf, x: number, feet: number, z: number, h: number,
  exactBelow = 1.0): CameraClearance {
  const ey = feet + EYE, fe = f(x, ey, z)
  if (fe > exactBelow) return { eye: fe, rect: fe - c.reach, env: fe - c.reach, bound: true }
  const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h)
  const cx = x + c.near * fx, cz = z + c.near * fz
  const Rf = (u: number, v: number) => f(cx + u * rx, ey + v, cz + u * rz)
  let best = Infinity, bp: number[] = [0, 0]
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 4; j++) {
      const u = -c.hw + (2 * c.hw * i) / 8, v = -c.hh + (2 * c.hh * j) / 4, val = Rf(u, v)
      if (val < best) {
        best = val
        bp = [u, v]
      }
    }
  }
  const rect = Math.min(best, patternMin((q) => Rf(q[0], q[1]), bp, [-c.hw, -c.hh], [c.hw, c.hh],
    [c.hw / 8, c.hh / 4]))
  const env = Math.min(minOverCyl(f, x, z, c.rhoN, ey - c.hh, ey + c.hh, 32, 3), fe)
  return { eye: fe, rect, env, bound: false }
}

/** A running minimum that remembers whether it is a lower bound (X1 printed those as '>='). */
export class Least {
  value = Infinity
  bound = false
  add(v: number, bound: boolean): void {
    if (v < this.value) {
      this.value = v
      this.bound = bound
    }
  }
  merge(o: Least): void { this.add(o.value, o.bound) }
}

/**
 * The lowest clearances seen at 16:9 and 32:9, kept as the cross-test X1 kept them (minimum over
 * every measured value, exact or bound), and the samples where the camera clipped (X1's count):
 * the eye inside, or an exactly measured near-plane rectangle or envelope inside.
 */
export class CameraMin {
  eye = Infinity
  rect169 = new Least()
  env169 = new Least()
  rect329 = new Least()
  env329 = new Least()
  clips169 = 0
  clips = 0

  /** Measures one pose (heading h) against one shape. */
  add(f: Sdf, x: number, feet: number, z: number, h: number, exactBelow = 1.0): CameraClearance {
    const a = cam(CAM_16_9, f, x, feet, z, h, exactBelow)
    const b = a.bound
      ? { eye: a.eye, rect: a.eye - CAM_32_9.reach, env: a.eye - CAM_32_9.reach, bound: true }
      : cam(CAM_32_9, f, x, feet, z, h, exactBelow)
    if (a.eye < this.eye) this.eye = a.eye
    this.rect169.add(a.rect, a.bound)
    this.env169.add(a.env, a.bound)
    this.rect329.add(b.rect, b.bound)
    this.env329.add(b.env, b.bound)
    if (a.eye < 0 || (!a.bound && (a.rect < 0 || a.env < 0))) this.clips169++
    if (b.eye < 0 || (!b.bound && (b.rect < 0 || b.env < 0))) this.clips++
    return a
  }

  merge(o: CameraMin): this {
    this.eye = Math.min(this.eye, o.eye)
    this.rect169.merge(o.rect169)
    this.env169.merge(o.env169)
    this.rect329.merge(o.rect329)
    this.env329.merge(o.env329)
    this.clips169 += o.clips169
    this.clips += o.clips
    return this
  }
}
