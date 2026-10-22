// Gate counting rules and statistics (ADR-0003 Decision 2 and Validation 4; plan item REN-13).
// The only implementation of the missed-frame count: the per-session timing summaries for QC and
// the week-6 gate verdict both come from here (plan reconciliation R6). The rules are written out,
// with their reasons, in docs/timing/gate-analysis.md; a change here is a change of that
// pre-specification and must be made there too, before any gate data are analysed.
//
// Pure functions, no I/O, erasable TypeScript only, so that Node runs this file directly
// (tools/timing/gate.ts is the command line over session folders) and Vitest tests it
// (test/frontend/gateCounting.test.ts).

/** Version of the pre-specification this code implements (docs/timing/gate-analysis.md). */
export const SPEC_VERSION = 'gate-analysis 1 (proposed; approval under D18 pending)'

/** An interval longer than LATE_FACTOR * P is late (ADR-0003 Decision 2). */
export const LATE_FACTOR = 1.5
/** G1 threshold: missed frames per 1,000 expected frames (ADR-0003 Decision 2). */
export const G1_PER_1000 = 1
/** G2 threshold: a main-thread task of this many milliseconds or more (ADR-0003 Decision 2). */
export const G2_TASK_MS = 50
/**
 * Task types that are main-thread tasks for G2: browser long tasks, the app's timed handlers, tasks
 * from the trace (REN-15) and the rAF callbacks themselves (exit - entry in the frame log).
 * Long-animation-frame entries are frames, not tasks: listed, not counted.
 */
export const G2_TASK_TYPES: readonly string[] = ['longtask', 'handler', 'trace', 'raf-callback']
/** The app logs its own timed main-thread handlers from this duration on (REN-12; proposed). */
export const HANDLER_LOG_MS = 3
/** Gate requirements (ADR-0003 Decision 2): at least 3 sessions of at least 30 minutes. */
export const GATE_MIN_SESSIONS = 3
export const GATE_MIN_SESSION_S = 30 * 60
/** Block bootstrap (proposed, D18 a): 1-minute blocks, 10,000 resamples, fixed seed, 95 % CI. */
export const BOOTSTRAP = { blockS: 60, reps: 10000, seed: 20261113, level: 0.95 } as const

export type IntervalClass = 'main-thread' | 'gpu' | 'clock' | 'unattributed'
export const INTERVAL_CLASSES: readonly IntervalClass[] = ['main-thread', 'gpu', 'clock', 'unattributed']

/** One rendered frame of the frame log (REN-11, written by DPR-17 as a row of frames.tsv). */
export interface FrameRecord {
  /** Frame index: one more for each rendered frame, so a jump means frame-log records were lost. */
  frame: number
  /** requestAnimationFrame timestamp, ms (performance.now() clock of the stimulus window). */
  rafMs: number
  /** performance.now() at the start of the rAF callback, ms. */
  entryMs: number
  /** performance.now() at the end of the rAF callback, ms (optional). */
  exitMs?: number
  /** The document was hidden at some time since the previous frame. */
  hidden?: boolean
  /** The WebGL context was lost at some time since the previous frame. */
  contextLost?: boolean
  /** A shader program or texture count rose after ready (ADR-0003 1b) since the previous frame. */
  postReadyRise?: boolean
}

/** One main-thread task or entry (REN-12's longtasks.jsonl, REN-15's trace tasks). */
export interface TaskRecord {
  /** 'longtask' | 'long-animation-frame' | 'handler' (the app's timed handlers) | 'trace' */
  type: string
  startMs: number
  durationMs: number
  name?: string
}

export interface SessionInput {
  id: string
  frames: FrameRecord[]
  /** null: no long-task observation in this session (the session is then not valid for the gate). */
  tasks: TaskRecord[] | null
  /** Class of each late interval, by the index of the frame that ends it (REN-15). Missing: unattributed. */
  attribution?: ReadonlyMap<number, IntervalClass> | null
}

export interface LateInterval {
  /** Index of the frame that ends the interval. */
  frame: number
  startMs: number
  intervalMs: number
  missed: number
  cls: IntervalClass
}

type ClassCounts = Record<IntervalClass, { late: number, missed: number }>

/** One estimate's count over a session: rAF timestamps (low) or callback entry times (high). */
export interface SeriesCount {
  /** Intervals counted (rendered frames after the first; excluded intervals left out). */
  intervals: number
  late: number
  missed: number
  /** rendered + missed */
  expected: number
  byClass: ClassCounts
  maxIntervalMs: number
  lateIntervals: LateInterval[]
}

export interface Rate {
  missed: number
  expected: number
  /** missed frames per 1,000 expected frames */
  per1000: number
}

/** Per-minute block of one session: the bootstrap's unit. */
export interface Block {
  session: string
  index: number
  intervals: number
  low: { expected: number, main: number, unattributed: number }
  high: { expected: number, main: number, unattributed: number }
}

export interface SessionSummary {
  id: string
  frames: number
  durationS: number
  periodMs: number
  hz: number
  excludedIntervals: { hidden: number, contextLost: number, logGap: number }
  postReadyRises: number
  valid: boolean
  invalidReasons: string[]
  /** elapsed / P minus the number of intervals, on rAF timestamps (ADR-0003 Validation 4). */
  netDeficit: number
  low: SeriesCount
  high: SeriesCount
  rates: { lowMain: Rate, highMain: Rate, lowSensitivity: Rate, highSensitivity: Rate }
  tasks: {
    observed: boolean
    /** Tasks before the first frame (before ready) or after the last one: not counted. */
    outsideSession: number
    byType: Record<string, number>
    /** Main-thread tasks of G2_TASK_MS or more (G2). */
    g2: TaskRecord[]
    longestMs: number | null
  }
  /** rAF callbacks longer than one frame (exit - entry > P), listed separately (ADR-0003 Decision 2). */
  renderCallbackOverruns: Array<{ frame: number, durationMs: number }>
  blocks: Block[]
}

// ------------------------------------------------------------------------------------------------
// Counting

export function median(values: readonly number[]): number {
  if (!values.length) return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Missed frames in an interval: round(interval / P) - 1 if it is late (> 1.5 P), else 0. */
export function missedFrames(intervalMs: number, periodMs: number): number {
  return intervalMs > LATE_FACTOR * periodMs ? Math.round(intervalMs / periodMs) - 1 : 0
}

function emptyClassCounts(): ClassCounts {
  return { 'main-thread': { late: 0, missed: 0 }, gpu: { late: 0, missed: 0 }, clock: { late: 0, missed: 0 }, unattributed: { late: 0, missed: 0 } }
}

/**
 * Whether the interval ending at frames[i] is left out: the window was hidden, the context lost, or
 * frame-log records are missing before it (a jump in the frame index), so its length is unknown.
 */
function excludedReason(frames: readonly FrameRecord[], i: number): 'hidden' | 'contextLost' | 'logGap' | null {
  const f = frames[i]!
  return f.hidden ? 'hidden' : f.contextLost ? 'contextLost' : f.frame !== frames[i - 1]!.frame + 1 ? 'logGap' : null
}

/**
 * Count one series. times[i] is frame i's rAF timestamp (low estimate) or callback entry time
 * (high estimate); P is the session's median rAF interval for both series.
 */
export function countSeries(frames: readonly FrameRecord[], times: readonly number[], periodMs: number,
  classOf: (frame: number) => IntervalClass): SeriesCount {
  const out: SeriesCount = { intervals: 0, late: 0, missed: 0, expected: 0, byClass: emptyClassCounts(), maxIntervalMs: 0, lateIntervals: [] }
  for (let i = 1; i < frames.length; i++) {
    if (excludedReason(frames, i)) continue
    const interval = times[i]! - times[i - 1]!
    out.intervals++
    out.maxIntervalMs = Math.max(out.maxIntervalMs, interval)
    const missed = missedFrames(interval, periodMs)
    if (missed > 0) {
      const cls = classOf(frames[i]!.frame)
      out.late++
      out.missed += missed
      out.byClass[cls].late++
      out.byClass[cls].missed += missed
      out.lateIntervals.push({ frame: frames[i]!.frame, startMs: times[i - 1]!, intervalMs: interval, missed, cls })
    }
  }
  out.expected = out.intervals + out.missed
  return out
}

export function rate(missed: number, expected: number): Rate {
  return { missed, expected, per1000: expected > 0 ? (1000 * missed) / expected : Number.NaN }
}

/** Summary of one session: counts, rates, G2 tasks, validity and the per-minute blocks. */
export function summarizeSession(input: SessionInput): SessionSummary {
  const frames = input.frames
  const id = input.id
  const raf = frames.map(f => f.rafMs)
  const entry = frames.map(f => f.entryMs)
  const rafIntervals: number[] = []
  const excluded = { hidden: 0, contextLost: 0, logGap: 0 }
  for (let i = 1; i < frames.length; i++) {
    const reason = excludedReason(frames, i)
    if (reason) excluded[reason]++
    else rafIntervals.push(raf[i]! - raf[i - 1]!)
  }
  const periodMs = median(rafIntervals)
  const attribution = input.attribution ?? null
  const classOf = (frame: number): IntervalClass => attribution?.get(frame) ?? 'unattributed'
  const low = countSeries(frames, raf, periodMs, classOf)
  const high = countSeries(frames, entry, periodMs, classOf)
  const durationS = frames.length > 1 ? (raf[raf.length - 1]! - raf[0]!) / 1000 : 0
  const elapsedCounted = rafIntervals.reduce((a, b) => a + b, 0)
  const netDeficit = elapsedCounted / periodMs - rafIntervals.length

  // Tasks from ready (the first frame) to the end of the last frame
  const t0 = frames.length ? Math.min(frames[0]!.entryMs, frames[0]!.rafMs) : 0
  const last = frames[frames.length - 1]
  const t1 = last ? Math.max(last.exitMs ?? last.entryMs, last.entryMs) : 0
  const tasks = input.tasks
  const inSession = (tasks ?? []).filter(t => t.startMs >= t0 && t.startMs <= t1)
  // The rAF callbacks are main-thread tasks too, timed by the frame log itself
  const callbacks: TaskRecord[] = frames.filter(f => f.exitMs !== undefined)
    .map(f => ({ type: 'raf-callback', startMs: f.entryMs, durationMs: f.exitMs! - f.entryMs, name: `frame ${f.frame}` }))
  const byType: Record<string, number> = {}
  for (const t of inSession) byType[t.type] = (byType[t.type] ?? 0) + 1
  const g2 = [...inSession, ...callbacks].filter(t => G2_TASK_TYPES.includes(t.type) && t.durationMs >= G2_TASK_MS)
    .sort((a, b) => a.startMs - b.startMs)
  const overruns = frames.filter(f => f.exitMs !== undefined && f.exitMs - f.entryMs > periodMs)
    .map(f => ({ frame: f.frame, durationMs: f.exitMs! - f.entryMs }))

  const postReadyRises = frames.filter(f => f.postReadyRise).length
  const invalidReasons: string[] = []
  if (frames.length < 2) invalidReasons.push('fewer than 2 frames')
  if (excluded.hidden) invalidReasons.push(`window hidden before ${excluded.hidden} frame(s) (displays must stay awake)`)
  if (excluded.contextLost) invalidReasons.push(`WebGL context lost before ${excluded.contextLost} frame(s)`)
  if (excluded.logGap) invalidReasons.push(`frame log incomplete: the frame index jumps ${excluded.logGap} time(s) (records lost)`)
  if (postReadyRises) invalidReasons.push(`${postReadyRises} program or texture rise(s) after ready (ADR-0003 1b: fix, then repeat)`)
  if (tasks === null) invalidReasons.push('no long-task observation (longtasks.jsonl missing)')

  return {
    id,
    frames: frames.length,
    durationS,
    periodMs,
    hz: 1000 / periodMs,
    excludedIntervals: excluded,
    postReadyRises,
    valid: invalidReasons.length === 0,
    invalidReasons,
    netDeficit,
    low,
    high,
    rates: {
      lowMain: rate(low.byClass['main-thread'].missed, low.expected),
      highMain: rate(high.byClass['main-thread'].missed, high.expected),
      lowSensitivity: rate(low.byClass['main-thread'].missed + low.byClass.unattributed.missed, low.expected),
      highSensitivity: rate(high.byClass['main-thread'].missed + high.byClass.unattributed.missed, high.expected)
    },
    tasks: {
      observed: tasks !== null,
      outsideSession: (tasks ?? []).length - inSession.length,
      byType,
      g2,
      longestMs: inSession.length ? Math.max(...inSession.map(t => t.durationMs)) : null
    },
    renderCallbackOverruns: overruns,
    blocks: makeBlocks(id, frames, raf, entry, periodMs, classOf)
  }
}

/** Split a session into 1-minute blocks by the rAF time of each interval's end frame. */
export function makeBlocks(session: string, frames: readonly FrameRecord[], raf: readonly number[], entry: readonly number[],
  periodMs: number, classOf: (frame: number) => IntervalClass, blockS = BOOTSTRAP.blockS): Block[] {
  const blocks: Block[] = []
  if (frames.length < 2) return blocks
  const t0 = raf[0]!
  for (let i = 1; i < frames.length; i++) {
    if (excludedReason(frames, i)) continue
    const index = Math.floor((raf[i]! - t0) / (blockS * 1000))
    while (blocks.length <= index) {
      blocks.push({ session, index: blocks.length, intervals: 0, low: { expected: 0, main: 0, unattributed: 0 }, high: { expected: 0, main: 0, unattributed: 0 } })
    }
    const b = blocks[index]!
    b.intervals++
    const cls = classOf(frames[i]!.frame)
    for (const [series, times] of [[b.low, raf], [b.high, entry]] as const) {
      const missed = missedFrames(times[i]! - times[i - 1]!, periodMs)
      series.expected += 1 + missed
      if (cls === 'main-thread') series.main += missed
      if (cls === 'unattributed') series.unattributed += missed
    }
  }
  return blocks.filter(b => b.intervals > 0)
}

// ------------------------------------------------------------------------------------------------
// Statistics

/** mulberry32: a small seeded generator, so that every run of the analysis gives the same CI. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Quantile with linear interpolation between order statistics (numpy's default, Hyndman-Fan 7). */
export function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return Number.NaN
  const h = (sorted.length - 1) * p
  const lo = Math.floor(h)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

/**
 * Percentile block-bootstrap CI of the pooled rate 1000 * sum(num) / sum(den): resample the
 * blocks with replacement (as many as there are), reps times.
 */
export function blockBootstrapCI(blocks: ReadonlyArray<{ num: number, den: number }>,
  { reps = BOOTSTRAP.reps, seed = BOOTSTRAP.seed, level = BOOTSTRAP.level }: { reps?: number, seed?: number, level?: number } = {}): [number, number] {
  const n = blocks.length
  if (!n) return [Number.NaN, Number.NaN]
  const random = seededRandom(seed)
  const values = new Float64Array(reps)
  for (let r = 0; r < reps; r++) {
    let num = 0
    let den = 0
    for (let k = 0; k < n; k++) {
      const b = blocks[Math.floor(random() * n)]!
      num += b.num
      den += b.den
    }
    values[r] = den > 0 ? (1000 * num) / den : 0
  }
  const sorted = Array.from(values).sort((a, b) => a - b)
  const alpha = 1 - level
  return [quantile(sorted, alpha / 2), quantile(sorted, 1 - alpha / 2)]
}

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9), accurate to about 15 digits for x > 0
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x)
  x -= 1
  let a = c[0]!
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularized lower incomplete gamma function P(a, x) (series or continued fraction). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0
  const lnPrefix = a * Math.log(x) - x - logGamma(a)
  if (x < a + 1) {
    let sum = 1 / a
    let term = sum
    for (let n = 1; n < 10000; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break
    }
    return sum * Math.exp(lnPrefix)
  }
  // Continued fraction for Q(a, x) (modified Lentz)
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < 1e-15) break
  }
  return 1 - Math.exp(lnPrefix) * h
}

/** Quantile of the Gamma(shape, 1) distribution: x with P(shape, x) = p (bisection). */
export function gammaQuantile(p: number, shape: number): number {
  let lo = 0
  let hi = shape + 20 * Math.sqrt(shape) + 50
  while (gammaP(shape, hi) < p) hi *= 2
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (gammaP(shape, mid) < p) lo = mid
    else hi = mid
    if (hi - lo <= 1e-12 * Math.max(1, hi)) break
  }
  return (lo + hi) / 2
}

/** Exact (Garwood) Poisson CI of the rate per 1,000 for k events in `exposure` expected frames. */
export function poissonExactCI(k: number, exposure: number, level = BOOTSTRAP.level): [number, number] {
  const alpha = 1 - level
  const lower = k === 0 ? 0 : gammaQuantile(alpha / 2, k)
  const upper = gammaQuantile(1 - alpha / 2, k + 1)
  return [(1000 * lower) / exposure, (1000 * upper) / exposure]
}

// ------------------------------------------------------------------------------------------------
// Verdict

export type Verdict = 'promote' | 'keep-P1' | 'owner-decides'

export interface Estimate {
  missed: number
  expected: number
  per1000: number
  /** Block-bootstrap 95 % CI (the deciding interval). */
  ci: [number, number]
  /** Exact Poisson 95 % CI (cross-check only: it ignores that missed frames come in clusters). */
  poissonCi: [number, number]
}

export interface Decision {
  verdict: Verdict
  /** 'G2' | 'low' | 'high' | 'between': what decided */
  decidedBy: 'G2' | 'low' | 'high' | 'between'
  reason: string
}

const spans = (ci: readonly [number, number]) => ci[0] < G1_PER_1000 && ci[1] >= G1_PER_1000
const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x))
const fmtCi = (ci: readonly [number, number]) => `[${fmt(ci[0])}, ${fmt(ci[1])}]`

/** ADR-0003 Decision 2's rule, for one way of counting (main-thread only, or the sensitivity). */
export function decide(g2: boolean, low: Estimate, high: Estimate): Decision {
  if (g2) return { verdict: 'promote', decidedBy: 'G2', reason: `a main-thread task of ${G2_TASK_MS} ms or more (G2)` }
  if (low.per1000 >= G1_PER_1000) {
    if (spans(low.ci)) {
      return { verdict: 'owner-decides', decidedBy: 'low', reason: `G1 low estimate ${fmt(low.per1000)} per 1,000 reaches 1, but its 95 % CI ${fmtCi(low.ci)} spans 1` }
    }
    return { verdict: 'promote', decidedBy: 'low', reason: `G1 low estimate ${fmt(low.per1000)} per 1,000 (95 % CI ${fmtCi(low.ci)}) reaches 1` }
  }
  if (high.per1000 < G1_PER_1000) {
    if (spans(high.ci)) {
      return { verdict: 'owner-decides', decidedBy: 'high', reason: `G1 high estimate ${fmt(high.per1000)} per 1,000 is below 1, but its 95 % CI ${fmtCi(high.ci)} spans 1` }
    }
    return { verdict: 'keep-P1', decidedBy: 'high', reason: `G1 high estimate ${fmt(high.per1000)} per 1,000 (95 % CI ${fmtCi(high.ci)}) is below 1 and there is no G2` }
  }
  return { verdict: 'owner-decides', decidedBy: 'between', reason: `G1 low estimate ${fmt(low.per1000)} is below 1 per 1,000 and the high estimate ${fmt(high.per1000)} reaches it` }
}

export interface PooledResult {
  specVersion: string
  sessionsUsed: string[]
  sessionsInvalid: Array<{ id: string, reasons: string[] }>
  meetsGateRequirements: boolean
  requirementNotes: string[]
  g2Tasks: Array<TaskRecord & { session: string }>
  primary: { low: Estimate, high: Estimate, decision: Decision }
  sensitivity: { low: Estimate, high: Estimate, decision: Decision }
  verdict: Verdict
  reason: string
  /** Late intervals with no class: counted as main-thread only in the sensitivity analysis. */
  unattributed: { lowMissed: number, highMissed: number }
  poissonAgrees: boolean
}

function estimate(blocks: readonly Block[], series: 'low' | 'high', count: 'main' | 'sensitivity',
  options: { reps?: number, seed?: number }): Estimate {
  const units = blocks.map(b => ({ num: b[series].main + (count === 'sensitivity' ? b[series].unattributed : 0), den: b[series].expected }))
  const missed = units.reduce((s, u) => s + u.num, 0)
  const expected = units.reduce((s, u) => s + u.den, 0)
  return {
    missed,
    expected,
    per1000: expected > 0 ? (1000 * missed) / expected : Number.NaN,
    ci: blockBootstrapCI(units, options),
    poissonCi: poissonExactCI(missed, expected)
  }
}

/**
 * The gate verdict over the valid sessions, pooled (ADR-0003 Decision 2 with the D18 proposal):
 * main-thread late intervals decide; the sensitivity analysis counts unattributed ones as
 * main-thread too, and keep P1 needs both to say so.
 */
export function gateVerdict(sessions: readonly SessionSummary[], options: { reps?: number, seed?: number } = {}): PooledResult {
  const valid = sessions.filter(s => s.valid)
  const blocks = valid.flatMap(s => s.blocks)
  const notes: string[] = []
  const longEnough = valid.filter(s => s.durationS >= GATE_MIN_SESSION_S)
  if (longEnough.length < GATE_MIN_SESSIONS) {
    notes.push(`${longEnough.length} valid session(s) of at least ${GATE_MIN_SESSION_S / 60} min; the gate needs ${GATE_MIN_SESSIONS}`)
  }
  for (const s of sessions.filter(x => !x.valid)) notes.push(`session ${s.id} not valid: ${s.invalidReasons.join('; ')}`)
  notes.push('not checked here: rig computer, no 1d warning (clock, display, primary display), and at least one session with normal control-window use (REN-21 checklist)')
  const g2Tasks = valid.flatMap(s => s.tasks.g2.map(t => ({ ...t, session: s.id })))
  const primary = { low: estimate(blocks, 'low', 'main', options), high: estimate(blocks, 'high', 'main', options) }
  const sensitivity = { low: estimate(blocks, 'low', 'sensitivity', options), high: estimate(blocks, 'high', 'sensitivity', options) }
  const p = decide(g2Tasks.length > 0, primary.low, primary.high)
  const s = decide(g2Tasks.length > 0, sensitivity.low, sensitivity.high)
  let verdict = p.verdict
  let reason = p.reason
  if (p.verdict === 'keep-P1' && s.verdict !== 'keep-P1') {
    verdict = 'owner-decides'
    reason = `${p.reason}; but counting the unattributed late intervals as main-thread gives "${s.verdict}" (${s.reason})`
  }
  if (!valid.length) {
    verdict = 'owner-decides'
    reason = 'no valid session'
  }
  // Does the Poisson cross-check read the deciding rate's CI the same way (spans 1 or not)?
  const deciding = p.decidedBy === 'low' ? primary.low : p.decidedBy === 'high' ? primary.high : null
  const poissonAgrees = deciding === null || spans(deciding.ci) === spans(deciding.poissonCi)
  return {
    specVersion: SPEC_VERSION,
    sessionsUsed: valid.map(x => x.id),
    sessionsInvalid: sessions.filter(x => !x.valid).map(x => ({ id: x.id, reasons: x.invalidReasons })),
    meetsGateRequirements: longEnough.length >= GATE_MIN_SESSIONS,
    requirementNotes: notes,
    g2Tasks,
    primary: { ...primary, decision: p },
    sensitivity: { ...sensitivity, decision: s },
    verdict,
    reason,
    unattributed: {
      lowMissed: valid.reduce((a, x) => a + x.low.byClass.unattributed.missed, 0),
      highMissed: valid.reduce((a, x) => a + x.high.byClass.unattributed.missed, 0)
    },
    poissonAgrees
  }
}

/**
 * The single-session re-check rule of REN-22b (rc workload) and REN-25 (rc rendering check),
 * fixed with the gate analysis (D18 a): any G2 task, or a G1 low estimate of 1 per 1,000 or more,
 * triggers D21. The CI is reported, not used: one 30-minute session cannot bound a rate near 1.
 * Without a valid session the rule cannot be applied (checked: false): fix the cause and repeat.
 */
export function recheckRule(result: PooledResult): { checked: boolean, triggered: boolean, reason: string } {
  if (!result.sessionsUsed.length) {
    const why = result.sessionsInvalid.map(s => `${s.id}: ${s.reasons.join('; ')}`).join(' | ')
    return { checked: false, triggered: false, reason: `no valid session${why ? ` (${why})` : ''}; fix the cause, then repeat the session` }
  }
  if (result.g2Tasks.length) return { checked: true, triggered: true, reason: `${result.g2Tasks.length} main-thread task(s) of ${G2_TASK_MS} ms or more (G2)` }
  const low = result.primary.low
  if (low.per1000 >= G1_PER_1000) return { checked: true, triggered: true, reason: `G1 low estimate ${fmt(low.per1000)} per 1,000 reaches 1` }
  return { checked: true, triggered: false, reason: `no G2 task; G1 low estimate ${fmt(low.per1000)} per 1,000 (95 % CI ${fmtCi(low.ci)}) is below 1` }
}
