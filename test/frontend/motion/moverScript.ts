// A session of the motion core with the hover mover on the collider fixture of the instantiate
// tests (fixtures/colliders.manifest.json: a floor, a rotated wall, side walls, a trimesh ramp, a
// hull post and a gate): turning and running into the walls, the ramp and the post, with a
// teleport and the gate closed half-way. mover.test.ts runs it in Node and, bundled by Vite, in a
// worker; the results must be equal. Plain data only, so that a result can cross postMessage.
import type { ColliderManifest } from '../../../src/motion/manifest.ts'
import { createMotionCore } from '../../../src/motion/core.ts'
import type { MotionEvent, PoseRecord } from '../../../src/motion/core.ts'
import { instantiate } from '../../../src/motion/instantiate.ts'
import type { Rapier } from '../../../src/motion/instantiate.ts'
import { createHoverMover } from '../../../src/motion/mover.ts'
import type { HoverStats } from '../../../src/motion/mover.ts'
import { lcg } from './coreScript.ts'

export interface MoverScriptResult {
  records: Array<PoseRecord | null>
  events: MotionEvent[]
  stats: HoverStats
}

export function runMoverScript(R: Rapier, manifest: ColliderManifest): MoverScriptResult {
  const q = instantiate(R, manifest)
  const events: MotionEvent[] = []
  const mover = createHoverMover(R, q.world, { x: 0, z: 10 })
  const core = createMotionCore({ mover, onEvent: (e) => events.push(e) })
  const rnd = lcg(11)
  const records: Array<PoseRecord | null> = []
  let t = 0
  for (let seq = 0; seq < 3000; seq++) {
    if (seq === 1500) q.setEnabled('gate', true)
    if (seq === 2000) core.teleport({ x: -10, z: -10, yaw: 2, cmd_id: 1, cause: 'test' })
    t += 4000
    // 250 samples/s, forward at up to 120 units/s, turning now and then
    const turn = seq % 400 < 40 ? 0.03 : (rnd() - 0.5) * 0.004
    records.push(core.apply({
      seq, seq_source: 'device', t_dev_us: t, dt_us: 4000,
      d: [0.48 * rnd(), (rnd() - 0.5) * 0.05, turn],
    }))
  }
  const stats = structuredClone(mover.stats)
  q.world.free()
  return { records, events, stats }
}
