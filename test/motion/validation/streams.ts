// Device-sample streams of the Validation cases: the archived stream of each case and its rotating
// variant (plan item MOT-05a).
//
// Archived: the study's own inputs. Its scripts gave the mover one world-frame displacement
// (dx, dz) per sample, and the heading never turned. As device samples that is heading 0 and
// d = [-dz, -dx, 0]: the core turns it with sin 0 = 0 and cos 0 = 1, which gives back dx and dz
// exactly (test/motion/equivalence.ts), and the reference driver passes them on unchanged, so these
// runs are the study's runs. Device time is whole µs (device-v1.md section 7.2), so a sample at
// 120 samples/s lasts 8,333 µs, not 1/120 s; dt only enters falls.
//
// Rotating: the same world path with the heading turning all the time. The archived evidence
// never had that (every per-sample test moved in one direction per sample), while the motion core
// turns each sub-step by the heading at its midpoint (ADR-0001 R1), so a sample's sub-steps fan
// out. The heading swings by +-0.6 rad around the starting heading twice per second (peak rate
// 7.5 rad/s, 432 degrees/s; up to 0.38 rad per sample at 20 samples/s), from a phase that differs
// from run to run, and each sample's body-frame displacement is the archived world displacement
// turned back by the heading at the sample's midpoint. A sample of n sub-steps then moves along
// the archived direction on average, its sub-steps spread over +-dyaw/2 around it; a sample of one
// sub-step moves along it exactly (up to rounding).
//
// One adjustment: a sample whose length is a whole number of 0.25 sub-steps, as the study's 30
// units/s at 120 samples/s (one sub-step of 0.25) and 100 units/s at 20 samples/s (twenty), is
// shortened by 1e-8 of its length (bodyFrame below). Turned back and forth, such a length lands an
// ulp above or below the multiple, so the sub-step count would depend on the last bit: the core
// counts from the body-frame length, the reference from each turned sub-step, and one of them could
// make an extra sub-step that the other does not (driver.ts, deviation `resplit`). Shortened, both
// count the archived sample's sub-steps.
import { SUB_STEP } from '../../../src/motion/core.ts'
import type { Body } from './driver.ts'

export interface Sample {
  d: Body
  dtUs: number
}

/** dt in whole µs for a sample rate. */
export const dtUs = (rate: number) => Math.round(1e6 / rate)

/** The archived sample for a world-frame displacement (dx, dz): heading 0, no rotation. */
export const worldSample = (dx: number, dz: number, us: number): Sample =>
  ({ d: [-dz, -dx, 0], dtUs: us })

/** count samples of the same world-frame displacement. */
export const constant = (dx: number, dz: number, rate: number, count: number): Sample[] =>
  Array.from({ length: count }, () => worldSample(dx, dz, dtUs(rate)))

/** Amplitude (rad) and frequency (Hz) of the rotating streams' heading swing. */
export const SWING = { amplitude: 0.6, hz: 2 }

/** Phase of run number `index` in a group: golden-angle steps, so phases spread evenly. */
export const swingPhase = (index: number) => (index * 2.399963229728653) % (2 * Math.PI)

/** Lengths within this fraction of a whole number of sub-steps are shortened (file header). */
export const TIE_WINDOW = 1e-9
/** The fraction of their length by which such samples are shortened. */
export const TIE_SHORTENING = 1e-8

/**
 * The body-frame displacement [forward, left] that the motion core turns into the world-frame
 * displacement (dx, dz) at heading m (core.ts: (-f sin m - l cos m, -f cos m + l sin m)), for a
 * rotating sample whose midpoint heading is m. A length within TIE_WINDOW of a whole number of
 * sub-steps is first shortened by TIE_SHORTENING of itself (file header).
 */
export function bodyFrame(dx: number, dz: number, m: number): [number, number] {
  const k = Math.hypot(dx, dz) / SUB_STEP, whole = Math.round(k)
  if (whole >= 1 && Math.abs(k - whole) <= TIE_WINDOW * k) {
    dx *= 1 - TIE_SHORTENING
    dz *= 1 - TIE_SHORTENING
  }
  const sin = Math.sin(m), cos = Math.cos(m)
  return [-(dx * sin + dz * cos), -(dx * cos - dz * sin)]
}

/**
 * The rotating variant of an archived stream (world displacements at heading 0, d[2] = 0): the
 * same world displacement per sample, delivered with the heading yaw0 + A sin(2 pi f t + phase).
 * Returns the samples and the starting heading.
 */
export function rotating(samples: readonly Sample[], yaw0: number, phase: number):
  { yaw: number, samples: Sample[] } {
  const { amplitude, hz } = SWING
  const heading = (tUs: number) => amplitude * Math.sin(2 * Math.PI * hz * tUs / 1e6 + phase)
  let t = 0, h = heading(0), yaw = yaw0 + h
  const start = yaw
  const out: Sample[] = []
  for (const s of samples) {
    if (s.d[2] !== 0) throw new Error('rotating(): the archived stream must not rotate')
    t += s.dtUs
    const next = heading(t), dyaw = next - h
    h = next
    // archived world displacement (heading 0), turned back by the midpoint heading
    const [f, l] = bodyFrame(-s.d[1], -s.d[0], yaw + dyaw / 2)
    out.push({ d: [f, l, dyaw], dtUs: s.dtUs })
    yaw += dyaw
  }
  return { yaw: start, samples: out }
}

/** Heading of a world-frame direction (dx, dz): yaw 0 looks down -Z, left is -X. */
export const headingOf = (dx: number, dz: number) => Math.atan2(-dx, -dz)

/**
 * The study's random running (adjudicator s4_soak.mjs, mover_fix/t4_soak.mjs, verify/xsoak.mjs):
 * every 0.5 s the direction changes by up to +-1.25 rad and the speed is drawn from 5-141
 * units/s, with their generator (seeds 1, 7, 21 and 99).
 */
export function randomRunning(rate: number, seed: number, seconds: number): Sample[] {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
  let heading = 0, v = 30
  const n = Math.round(rate * seconds), per = Math.round(rate / 2), us = dtUs(rate)
  const out: Sample[] = []
  for (let i = 0; i < n; i++) {
    if (i % per === 0) {
      heading += (rnd() - 0.5) * 2.5
      v = 5 + rnd() * 136
    }
    out.push(worldSample(-Math.sin(heading) * v / rate, -Math.cos(heading) * v / rate, us))
  }
  return out
}
