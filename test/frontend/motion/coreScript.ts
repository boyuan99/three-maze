// A scripted session of the motion core with the free mover: a seeded sample stream that crosses
// the seq wrap, has a gap and a duplicate, and a gain change, a teleport and a freeze in between.
// core.test.ts runs it in Node and, bundled by Vite, in a worker; the results must be equal.
// Plain data only, so that a result can cross postMessage.
import { createFreeMover, createMotionCore } from '../../../src/motion/core.ts'
import type {
  DeviceSample, MotionEvent, MotionStats, PoseRecord,
} from '../../../src/motion/core.ts'

/** Seeded uniform numbers in [0, 1) (a linear congruential generator, 32 bits). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * count samples at 250 per second from seq `first`, running forward at up to 150 units/s with
 * some sideways motion and turning. Every sample is the next one in seq except where `skip`
 * names an index: there seq jumps by skip[index].
 */
export function makeStream(
  count: number, seed: number, first = 0, skip: Record<number, number> = {},
): DeviceSample[] {
  const rnd = lcg(seed)
  const samples: DeviceSample[] = []
  let seq = first, t = 1_000_000
  for (let i = 0; i < count; i++) {
    if (i > 0) seq = (seq + (skip[i] ?? 1)) >>> 0
    t += 4000
    samples.push({
      seq, seq_source: 'device', t_dev_us: t, dt_us: 4000,
      d: [(rnd() - 0.2) * 0.6, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.02],
    })
  }
  return samples
}

/** The scripted session's stream: 400 samples from just below the seq wrap. */
export function scriptStream(): DeviceSample[] {
  const samples = makeStream(400, 7, 4_294_967_200, { 150: 3 })
  samples.splice(260, 0, { ...samples[259] }) // a duplicate of the sample before
  return samples
}

export interface ScriptResult {
  records: Array<PoseRecord | null>
  events: MotionEvent[]
  stats: MotionStats
}

export function runScript(samples: DeviceSample[]): ScriptResult {
  const events: MotionEvent[] = []
  const core = createMotionCore({
    mover: createFreeMover({ x: 1, z: 2 }), yaw: 0.3, onEvent: (e) => events.push(e),
  })
  const records = samples.map((sample, i) => {
    if (i === 50) {
      core.setParams({ cmd_id: 1, apply_seq: (sample.seq + 10) >>> 0, gain: { fwd: 0.5, yaw: 2 } })
    }
    if (i === 120) core.teleport({ x: -5, z: 3, yaw: 0, cmd_id: 2, cause: 'trial_end' })
    if (i === 200) core.setParams({ cmd_id: 3, apply_seq: 0, freeze: { fwd: true, left: true } })
    if (i === 300) core.setParams({ cmd_id: 4, apply_seq: sample.seq, freeze: { fwd: false } })
    return core.apply(sample)
  })
  return { records, events, stats: { ...core.stats } }
}
