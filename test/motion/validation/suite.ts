// What the Validation test files (test/motion/full/validation.*.test.ts) share: the mover they
// run, the two streams, the archived outputs they compare the archived stream with, and the lines
// they print (runs, samples, wall time, µs per sample in the mover).
import { readFileSync } from 'node:fs'
import { coreDriver, referenceDriver } from './driver.ts'
import type { MotionDriver } from './driver.ts'
import type { Outcome, Stream, Totals } from './run.ts'

/**
 * The mover the suite runs. MOT-05a: the vendored reference (driver.ts referenceDriver). MOT-05b
 * switches the default to coreDriver, the TypeScript mover through the motion core. The
 * environment variable MOTION_VALIDATION_DRIVER=core|reference picks one for a local run.
 */
export const DRIVER: MotionDriver = (() => {
  const name = process.env.MOTION_VALIDATION_DRIVER
  if (name === undefined || name === '' || name === 'reference') return referenceDriver
  if (name === 'core') return coreDriver
  throw new Error(`MOTION_VALIDATION_DRIVER=${name}: expected 'reference' or 'core'`)
})()

export const STREAMS: Stream[] = ['archived', 'rotating']

/** An archived output of the study (reference/archive/, copied unchanged). */
export const archive = (name: string) =>
  readFileSync(new URL(`../reference/archive/${name}`, import.meta.url), 'utf8')

/** Lines of an archived output that start with `prefix`, with `strip` removed from their end. */
export function archivedRows(name: string, prefix: string | RegExp, strip?: RegExp): string[] {
  return archive(name).replace(/\r?\n$/, '').split(/\r?\n/)
    .filter((l) => (typeof prefix === 'string' ? l.startsWith(prefix) : prefix.test(l)))
    .map((l) => (strip ? l.replace(strip, '') : l))
}

/**
 * The rows of a table printed by console.table (the cross-tests' outputs): one object per row,
 * keyed by the header, values without their quotes.
 */
export function consoleTable(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('│'))
  const cells = (l: string) => l.split('│').slice(1, -1)
    .map((c) => c.trim().replace(/^'(.*)'$/, '$1'))
  const [head, ...rows] = lines.map(cells)
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])))
}

/** Sums of the reference driver's deviations (driver.ts) over outcomes. */
export const deviations = (outcomes: Outcome[]) => outcomes.reduce(
  (a, o) => ({
    resplit: a.resplit + o.deviations.resplit, airborne: a.airborne + o.deviations.airborne,
  }),
  { resplit: 0, airborne: 0 })

/** One line for the log: group, stream, runs, samples, wall time and the mover's µs per sample. */
export function costLine(group: string, stream: Stream,
  t: Pick<Totals, 'runs' | 'samples' | 'us' | 'usMax'>, wallMs: number, extra = ''): string {
  return `${group.padEnd(34)} ${stream.padEnd(8)} runs ${String(t.runs).padStart(5)} samples `
    + `${String(t.samples).padStart(7)} wall ${(wallMs / 1000).toFixed(1).padStart(6)} s, mover `
    + `${(t.us / t.samples).toFixed(1).padStart(6)} µs/sample `
    + `(max ${(t.usMax / 1000).toFixed(1)} ms)`
    + `${extra ? '; ' + extra : ''}`
}

/** Totals of a list of outcomes, for costLine(). */
export const totalsOf = (outcomes: Outcome[]) => outcomes.reduce((t, o) => ({
  runs: t.runs + 1, samples: t.samples + o.samples, us: t.us + o.us,
  usMax: Math.max(t.usMax, o.usMax),
  reverts: t.reverts + o.stats.reverts, recoveries: t.recoveries + o.stats.recoveries,
}), { runs: 0, samples: 0, us: 0, usMax: 0, reverts: 0, recoveries: 0 })

/**
 * The lines of an archived output between the header line starting with `from` and the next one
 * starting with any of `to` (headers start in the first column), that contain `mark`.
 */
export function archivedSection(name: string, from: string, to: string[], mark: string): string[] {
  const lines = archive(name).replace(/\r?\n$/, '').split(/\r?\n/)
  const start = lines.findIndex((l) => l.startsWith(from))
  if (start < 0) throw new Error(`${name}: no line starts with '${from}'`)
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (to.some((t) => l.startsWith(t))) break
    if (l.includes(mark)) out.push(l)
  }
  return out
}
