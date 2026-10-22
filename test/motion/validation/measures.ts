// Measures shared by the Validation cases that the study's scripts did not need: the sideways
// range against a perfect slide, for streams whose sub-steps do not all point the same way, and
// the crossings of a wall, for Validation 3's "contained" on every stream.
import { subStepDisplacement, subSteps } from './driver.ts'
import type { Body } from './driver.ts'

/**
 * A perfect slide along a vertical wall plane. s = u . (x, z) is the agent axis's distance across
 * the plane, u its horizontal unit normal pointing to the agent; the axis can come no closer than
 * contact(x, z) (the skin: 0.5 + 0.02 from the face). Each of the motion core's sub-steps moves s
 * by its own component along u, stopped at contact. The sideways range of a run is then the range
 * of (s - ideal) after the first touch: the across-wall motion the input did not command. On the
 * archived streams (one direction per sample, into the wall) the ideal stays at contact once it
 * gets there, so this is the study's sideways range (the range of s) without the last approach to
 * the wall, which the study counted when it began within 0.01 of contact.
 */
export class Slide {
  readonly u: readonly [number, number]
  private readonly contact: (x: number, z: number) => number
  private s: number
  private x: number
  private z: number
  private lo = Infinity
  private hi = -Infinity

  constructor(u: readonly [number, number], contact: (x: number, z: number) => number,
    x0: number, z0: number) {
    this.u = u
    this.contact = contact
    this.x = x0
    this.z = z0
    this.s = u[0] * x0 + u[1] * z0
  }

  /** Advances the ideal by one sample (heading yaw0 before it, displacement d). */
  step(yaw0: number, d: Body): void {
    const n = subSteps(d)
    for (let i = 0; i < n; i++) {
      const [dx, dz] = subStepDisplacement(yaw0, d, i, n)
      this.x += dx / n
      this.z += dz / n
      const across = (this.u[0] * dx + this.u[1] * dz) / n
      this.s = Math.max(this.contact(this.x, this.z), this.s + across)
    }
  }

  /** Records the agent's actual axis after a sample (call only after the first touch). */
  record(x: number, z: number): void {
    const dev = this.u[0] * x + this.u[1] * z - this.s
    if (dev < this.lo) this.lo = dev
    if (dev > this.hi) this.hi = dev
  }

  /** Range of (s - ideal) over the recorded samples; null if none. */
  get range(): number | null {
    return this.hi >= this.lo ? this.hi - this.lo : null
  }
}

/** A vertical box wall as the study's builders take it (reference/lib/walls.mjs); yaw, degrees. */
export interface WallBox {
  cx: number
  cz: number
  hx: number
  hz: number
  yaw?: number
}

/**
 * Crossings of walls (Validation 3: "contained"). Beside a wall, within its long extent, the
 * agent's axis is on one side of the wall or the other, across the wall's short extent (in the
 * box coordinates of walls.mjs sdObs). A sample that ends beside a wall, on the other side from
 * where the agent was beside it before, has gone through the wall; footprint overlap (walls.mjs
 * worstPen) does not see that when the sample ends clear of the far face. A sample end within a
 * wall's thickness is an overlap, not a side, and the side is forgotten when the agent leaves the
 * wall's long extent, so going round a wall's end is not a crossing.
 */
export class Crossings {
  private readonly walls: readonly WallBox[]
  private readonly side: number[]
  count = 0

  /** Starts with the agent at (x0, z0). */
  constructor(walls: readonly WallBox[], x0: number, z0: number) {
    this.walls = walls
    this.side = walls.map(() => 0)
    this.visit(x0, z0)
  }

  /** Records the agent's axis after a sample. */
  visit(x: number, z: number): void {
    for (let k = 0; k < this.walls.length; k++) {
      const o = this.walls[k]
      const th = ((o.yaw ?? 0) * Math.PI) / 180, c = Math.cos(th), s = Math.sin(th)
      const dx = x - o.cx, dz = z - o.cz
      const lx = c * dx - s * dz, lz = s * dx + c * dz
      const [across, half, along, length] = o.hx <= o.hz
        ? [lx, o.hx, lz, o.hz] : [lz, o.hz, lx, o.hx]
      if (Math.abs(along) >= length) {
        this.side[k] = 0
        continue
      }
      if (Math.abs(across) <= half) continue
      const side = Math.sign(across)
      if (this.side[k] !== 0 && side !== this.side[k]) this.count++
      this.side[k] = side
    }
  }
}

/** Running minimum or maximum that starts empty. */
export const minOf = (a: number | null, b: number | null) =>
  (a === null ? b : b === null ? a : Math.min(a, b))
export const maxOf = (a: number | null, b: number | null) =>
  (a === null ? b : b === null ? a : Math.max(a, b))
