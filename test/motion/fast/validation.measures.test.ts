// Fast tier (runs under `npm test`): the wall-crossing measure of the Validation suite
// (test/motion/validation/measures.ts Crossings), which Validation 3's "contained" rests on in
// test/motion/full/validation.walls.test.ts. Synthetic sample ends, no mover: a run that ends a
// sample beyond a wall it was beside counts, a slide along the wall and a walk round its end do
// not, also for a wall turned about +Y as the wedges of t3 S3c are.
import { describe, expect, it } from 'vitest'
import { Crossings } from '../validation/measures.ts'
import type { WallBox } from '../validation/measures.ts'

// the face at x = 10 of a 1-unit wall from z = -100 to 100, as in t3 S3d
const WALL: WallBox = { cx: 10.5, cz: 0, hx: 0.5, hz: 100 }

const run = (walls: WallBox[], path: Array<[number, number]>) => {
  const c = new Crossings(walls, path[0][0], path[0][1])
  for (const [x, z] of path.slice(1)) c.visit(x, z)
  return c.count
}

describe('Validation suite: wall crossings (test/motion/validation/measures.ts)', () => {
  it('counts a sample that ends beyond a wall the agent was beside', () => {
    expect(run([WALL], [[9.3, 70], [9.48, 60], [12.6, 55], [14, 50]])).toBe(1)
    // through and back again: two crossings
    expect(run([WALL], [[9.48, 0], [11.6, -5], [9.48, -10]])).toBe(2)
  })

  it('does not count a slide along the face or a sample that ends inside the wall', () => {
    expect(run([WALL], [[9.3, 70], [9.48, 60], [9.48, 0], [9.47, -60]])).toBe(0)
    // inside the wall's thickness, past its middle (an overlap, worstPen), and back: no side change
    expect(run([WALL], [[9.48, 0], [10.9, -1], [9.48, -2]])).toBe(0)
    // inside, then out beyond the far face: that is a crossing
    expect(run([WALL], [[9.48, 0], [10.9, -1], [11.6, -2]])).toBe(1)
  })

  it('does not count a walk round the wall\'s end', () => {
    expect(run([WALL], [[9.48, -90], [9.48, -99.9], [9.6, -100.6], [12, -101], [12, -110]]))
      .toBe(0)
    // round the end and back up the far side: still no crossing (t3 S3e passes the wall's end)
    expect(run([WALL], [[9.48, -90], [9.48, -101], [12, -101], [12, -90]])).toBe(0)
  })

  it('works across the short extent of any box, also turned about +Y', () => {
    // a wall long in x (t3 S3b's far wall): its sides are z < 10 and z > 11
    const far: WallBox = { cx: 0, cz: 10.5, hx: 60, hz: 0.5 }
    expect(run([far], [[0, 9.4], [3, 9.48], [4, 12]])).toBe(1)
    expect(run([far], [[0, 9.4], [30, 9.48], [59, 9.48]])).toBe(0)
    // the right wall of t3's 60-degree wedge (yaw 30 degrees), with the agent inside the wedge
    const h = Math.PI / 6
    const right: WallBox = {
      cx: Math.sin(h) * 30 + Math.cos(h) * 0.5, cz: -50 + Math.cos(h) * 30 - Math.sin(h) * 0.5,
      hx: 0.5, hz: 30, yaw: 30,
    }
    // a point 2 inside the inner face, and the same point 2 beyond the outer face
    const along = (s: number, off: number): [number, number] =>
      [Math.sin(h) * s + Math.cos(h) * off, -50 + Math.cos(h) * s - Math.sin(h) * off]
    expect(run([right], [[0.3, -10], along(20, -2), along(22, -0.6)])).toBe(0)
    expect(run([right], [[0.3, -10], along(20, -2), along(22, 3)])).toBe(1)
  })
})
