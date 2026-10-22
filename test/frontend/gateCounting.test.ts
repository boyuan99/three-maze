// Gate counting rules and statistics (tools/timing/gateCounting.ts; ADR-0003 Validation 4, plan
// item REN-13) on synthetic frame logs with known answers. Every expected number below is worked
// out by hand in the comment next to it, not taken from the code under test.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  blockBootstrapCI, gateVerdict, missedFrames, poissonExactCI, recheckRule, summarizeSession,
  type FrameRecord, type IntervalClass, type TaskRecord
} from '../../tools/timing/gateCounting.ts'
import { formatReport, parseFramesTsv, readSession } from '../../tools/timing/gate.ts'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
// Chromium clamps both timestamps to 0.1 ms (the page is not cross-origin isolated)
const q = (ms: number) => Math.round(ms * 10) / 10

interface Spec {
  hz?: number
  seconds?: number
  /** vsync j renders no frame */
  skip?: (j: number) => boolean
  /** the callback for vsync j starts this much later than usual (its rAF timestamp does not move) */
  entryDelay?: (j: number) => number
  /** class of a late interval ending at vsync j (default: unattributed) */
  cls?: (j: number) => IntervalClass
  tasks?: TaskRecord[] | null
  frameFlags?: (j: number) => Partial<FrameRecord>
}

/** A session on a vsync grid: frame at vsync j has rAF timestamp j * P, entry 0.3 ms later. */
function session(id: string, { hz = 60, seconds = 1800, skip = () => false, entryDelay = () => 0, cls, tasks = [], frameFlags }: Spec = {}) {
  const P = 1000 / hz
  const frames: FrameRecord[] = []
  const attribution = new Map<number, IntervalClass>()
  let gapBefore = false
  for (let j = 0; j <= Math.round(seconds * hz); j++) {
    if (j > 0 && skip(j)) { gapBefore = true; continue }
    const frame = frames.length
    const entry = j * P + 0.3 + entryDelay(j)
    frames.push({ frame, rafMs: q(j * P), entryMs: q(entry), exitMs: q(entry + 1), ...(frameFlags?.(j) ?? {}) })
    if (cls && (gapBefore || entryDelay(j) > 0)) attribution.set(frame, cls(j))
    gapBefore = false
  }
  return summarizeSession({ id, frames, tasks, attribution })
}

/**
 * Chromium-like stalls (the model of ADR-0003 Evidence 1): the main thread is busy for durationMs
 * from startMs; a callback whose vsync falls inside the stall runs when the stall ends, with the
 * rAF timestamp of the latest vsync before that; the vsyncs in between render nothing.
 */
function stalled(hz: number, seconds: number, stalls: Array<{ startMs: number, durationMs: number }>) {
  const P = 1000 / hz
  const frames: FrameRecord[] = []
  const tasks: TaskRecord[] = []
  let busyUntil = 0
  let k = 0
  let j = 0
  while (j * P <= seconds * 1000) {
    const ready = j * P + 0.3
    let entry = Math.max(ready, busyUntil)
    while (k < stalls.length && stalls[k].startMs <= entry) {
      const start = Math.max(stalls[k].startMs, busyUntil)
      busyUntil = start + stalls[k].durationMs
      tasks.push({ type: 'longtask', startMs: q(start), durationMs: stalls[k].durationMs })
      entry = Math.max(ready, busyUntil)
      k++
    }
    const vsync = Math.max(j, Math.floor((entry - 0.3) / P + 1e-9))
    frames.push({ frame: frames.length, rafMs: q(vsync * P), entryMs: q(entry), exitMs: q(entry + 1) })
    busyUntil = entry + 1
    j = vsync + 1
  }
  return { frames, tasks }
}

const three = (spec: (i: number) => Spec) => [0, 1, 2].map(i => session(`s${i + 1}`, spec(i)))

describe('counting rules (ADR-0003 Decision 2)', () => {
  it('counts round(interval / P) - 1 missed frames in intervals over 1.5 P', () => {
    const P = 1000 / 60
    expect(missedFrames(P, P)).toBe(0)
    expect(missedFrames(1.5 * P, P)).toBe(0) // "over 1.5 P": exactly 1.5 P is not late
    expect(missedFrames(25.1, P)).toBe(1) // 25.1 / 16.667 = 1.506: late, round = 2
    expect(missedFrames(2 * P, P)).toBe(1)
    expect(missedFrames(100, P)).toBe(5) // 100 / 16.667 = 6.0
    expect(missedFrames(118.1, 17.7)).toBe(6) // Evidence 1's longest entry interval: 6.67 -> 7
  })

  it('finds no missed frame in a steady 60 Hz session', () => {
    const s = session('steady', { seconds: 600 })
    expect(s.periodMs).toBeCloseTo(16.7, 6) // 0.1 ms clamping: intervals of 16.6 and 16.7, median 16.7
    expect(s.hz).toBeCloseTo(59.88, 2)
    expect(s.low.late + s.high.late).toBe(0)
    expect(s.low.missed + s.high.missed).toBe(0)
    expect(s.low.expected).toBe(36000) // 600 s * 60 Hz intervals, none missed
    expect(s.rates.lowMain.per1000).toBe(0)
    expect(s.valid).toBe(true)
  })

  it('100 ms stalls once per second: the rAF count equals the net frame deficit, the entry count is at least as large', () => {
    // 20 stalls, at 1 s, 2 s, ... with a phase that moves against the 60 Hz grid
    const stalls = Array.from({ length: 20 }, (_, m) => ({ startMs: 1000 * (m + 1) + ((m * 3.7) % 16), durationMs: 100 }))
    const { frames, tasks } = stalled(60, 21.5, stalls)
    const s = summarizeSession({ id: 'stall-100', frames, tasks })
    expect(s.low.late).toBe(20)
    expect(s.high.late).toBe(20)
    // Evidence 1's check: |rAF count - (elapsed / P - intervals)| within 1 per stall
    expect(Math.abs(s.low.missed - s.netDeficit)).toBeLessThanOrEqual(20)
    // In this model the rAF count is exactly the number of vsyncs that rendered nothing
    const vsyncs = Math.round((frames[frames.length - 1].rafMs - frames[0].rafMs) / (1000 / 60))
    expect(s.low.missed).toBe(vsyncs - (frames.length - 1))
    // The entry times see each stall from its start, the rAF timestamps only from the last vsync
    // before its end (Evidence 1: 89.2 against 118.1 ms), so the entry count is larger here
    expect(s.high.missed).toBeGreaterThan(s.low.missed)
    expect(s.high.maxIntervalMs).toBeGreaterThan(s.low.maxIntervalMs)
    s.high.lateIntervals.forEach((late, k) => expect(late.missed).toBeGreaterThanOrEqual(s.low.lateIntervals[k]!.missed))
    // Each stall skips 5 or 6 vsyncs (100 ms = 6 periods, minus the frame that is late, plus phase)
    for (const late of s.low.lateIntervals) expect([5, 6]).toContain(late.missed)
    // Every stall is a G2 task (unattributed late intervals: no trace in this fixture)
    expect(s.tasks.g2).toHaveLength(20)
    expect(s.rates.lowMain.per1000).toBe(0)
    expect(s.rates.lowSensitivity.missed).toBe(s.low.missed)
  })

  it('works at 144 Hz', () => {
    // One vsync skipped every second for 30 s: 30 late intervals of 2 P, one missed frame each;
    // 30 s * 144 Hz = 4,320 expected frames
    const s = session('144', { hz: 144, seconds: 30, skip: j => j % 144 === 72 })
    expect(s.periodMs).toBeGreaterThan(6.85)
    expect(s.periodMs).toBeLessThan(7.05)
    expect(s.low.late).toBe(30)
    expect(s.low.missed).toBe(30)
    expect(s.low.expected).toBe(4320)
    expect(s.rates.lowSensitivity.per1000).toBeCloseTo(1000 * 30 / 4320, 9)
  })

  it('a 17 ms GC-like hitch is late but not G2; a 50.0 ms task is G2, a 49.9 ms one is not', () => {
    const gc: TaskRecord = { type: 'trace', startMs: 16.7 * 300 + 2, durationMs: 17, name: 'V8.GC' }
    const s = session('gc', { seconds: 10, skip: j => j === 301, tasks: [gc], cls: () => 'main-thread' })
    expect(s.low.late).toBe(1)
    expect(s.low.missed).toBe(1)
    expect(s.rates.lowMain.missed).toBe(1)
    expect(s.tasks.g2).toEqual([])

    const at = (ms: number, durationMs: number): TaskRecord => ({ type: 'longtask', startMs: ms, durationMs })
    const g = session('g2', { seconds: 10, tasks: [at(1000, 49.9), at(2000, 50.0), at(3000, 50.1)] })
    expect(g.tasks.g2.map(t => t.durationMs)).toEqual([50.0, 50.1])
  })

  it('counts a long rAF callback as a task, and lists callbacks longer than one frame', () => {
    // One second at 60 Hz in which the callback of frame 20 takes 20 ms (longer than P, not G2)
    // and that of frame 40 takes 55 ms (G2)
    const frames = Array.from({ length: 61 }, (_, j): FrameRecord => ({ frame: j, rafMs: q(j * 1000 / 60), entryMs: q(j * 1000 / 60 + 0.3), exitMs: q(j * 1000 / 60 + 1.3) }))
    frames[20].exitMs = frames[20].entryMs + 20
    frames[40].exitMs = frames[40].entryMs + 55
    const s = summarizeSession({ id: 'cb', frames, tasks: [] })
    expect(s.renderCallbackOverruns.map(o => o.frame)).toEqual([20, 40])
    expect(s.tasks.g2).toEqual([{ type: 'raf-callback', startMs: frames[40].entryMs, durationMs: 55, name: 'frame 40' }])
  })

  it('leaves out intervals after a hidden window or a lost context, and marks the session not valid', () => {
    const s = session('hidden', { seconds: 60, frameFlags: j => (j === 600 ? { hidden: true } : j === 900 ? { contextLost: true } : {}) })
    expect(s.excludedIntervals).toEqual({ hidden: 1, contextLost: 1, logGap: 0 })
    expect(s.low.intervals).toBe(3600 - 2)
    expect(s.valid).toBe(false)
    expect(s.invalidReasons.join(' ')).toMatch(/hidden.*context lost/)

    const rise = session('rise', { seconds: 10, frameFlags: j => (j === 10 ? { postReadyRise: true } : {}) })
    expect(rise.valid).toBe(false)
    expect(rise.invalidReasons[0]).toContain('after ready')

    const unobserved = session('no-tasks', { seconds: 10, tasks: null })
    expect(unobserved.invalidReasons).toEqual(['no long-task observation (longtasks.jsonl missing)'])
  })

  it('does not count lost frame-log records as missed frames, and marks the session not valid', () => {
    // Every vsync rendered at 60 Hz, but the records of frames 100 to 104 are missing from the log:
    // the frame index jumps from 99 to 105 over 6 periods. Counted, that interval would give 5
    // missed frames; its real pacing is unknown, so it is left out
    const frames: FrameRecord[] = []
    for (let j = 0; j <= 600; j++) if (j < 100 || j > 104) frames.push({ frame: j, rafMs: q(j * 1000 / 60), entryMs: q(j * 1000 / 60 + 0.3) })
    const s = summarizeSession({ id: 'gap', frames, tasks: [] })
    expect(s.excludedIntervals).toEqual({ hidden: 0, contextLost: 0, logGap: 1 })
    expect(s.low.missed + s.high.missed).toBe(0)
    expect(s.low.intervals).toBe(595 - 1)
    expect(s.blocks.reduce((a, b) => a + b.intervals, 0)).toBe(595 - 1)
    expect(s.valid).toBe(false)
    expect(s.invalidReasons).toEqual(['frame log incomplete: the frame index jumps 1 time(s) (records lost)'])
  })

  it('ignores tasks before ready (the first frame) and after the last frame', () => {
    const s = session('window', { seconds: 10, tasks: [{ type: 'longtask', startMs: -500, durationMs: 300 }, { type: 'longtask', startMs: 20000, durationMs: 80 }] })
    expect(s.tasks.g2).toEqual([])
    expect(s.tasks.outsideSession).toBe(2)
  })
})

describe('statistics (D18 proposal)', () => {
  it('gives the textbook exact Poisson intervals', () => {
    // Garwood intervals for k events, as rates per 1,000 with an exposure of 1,000
    const [l0, u0] = poissonExactCI(0, 1000)
    expect(l0).toBe(0)
    expect(u0).toBeCloseTo(3.6889, 4) // -ln(0.025)
    const [l1, u1] = poissonExactCI(1, 1000)
    expect(l1).toBeCloseTo(0.02532, 5)
    expect(u1).toBeCloseTo(5.5716, 4)
    const [l10, u10] = poissonExactCI(10, 1000)
    expect(l10).toBeCloseTo(4.7954, 4)
    expect(u10).toBeCloseTo(18.3904, 4)
  })

  it('bootstraps reproducibly, and collapses to the point when every block has the same rate', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ num: i % 7, den: 3600 }))
    expect(blockBootstrapCI(blocks)).toEqual(blockBootstrapCI(blocks))
    const [lo, hi] = blockBootstrapCI(blocks)
    const point = 1000 * blocks.reduce((a, b) => a + b.num, 0) / (50 * 3600)
    expect(lo).toBeLessThan(point)
    expect(hi).toBeGreaterThan(point)
    expect(blockBootstrapCI(Array.from({ length: 30 }, () => ({ num: 6, den: 3600 })))).toEqual([1000 * 6 / 3600, 1000 * 6 / 3600])
  })
})

describe('verdict (ADR-0003 Decision 2), against hand computations', () => {
  // Three 30-minute sessions at 60 Hz: 108,000 vsync periods each, 324,000 in all. A skipped vsync
  // keeps the expected count (rendered + missed) at 108,000 per session.
  const everyTenSeconds = (j: number) => j > 0 && j < 108000 && j % 600 === 0 // 600, ..., 107400: 179 per session

  it('1. steady 60 Hz: keep P1', () => {
    const v = gateVerdict(three(() => ({})))
    expect(v.meetsGateRequirements).toBe(true)
    expect(v.primary.low.per1000).toBe(0)
    expect(v.primary.high.ci).toEqual([0, 0])
    expect(v.primary.high.poissonCi[1]).toBeCloseTo(1000 * 3.6889 / 324000, 6) // 0.0114 per 1,000
    expect(v.verdict).toBe('keep-P1')
  })

  it('2. one 50.0 ms main-thread task in one session: promote (G2), whatever G1 says', () => {
    const v = gateVerdict(three(i => ({ tasks: i === 1 ? [{ type: 'longtask', startMs: 600000, durationMs: 50.0 }] : [] })))
    expect(v.primary.low.per1000).toBe(0)
    expect(v.verdict).toBe('promote')
    expect(v.primary.decision.decidedBy).toBe('G2')
    expect(v.g2Tasks).toEqual([{ type: 'longtask', startMs: 600000, durationMs: 50, session: 's2' }])
  })

  it('3. one missed frame every 10 s on the main thread: promote (G1 low = 537 / 324,000 = 1.657 per 1,000)', () => {
    const v = gateVerdict(three(() => ({ skip: everyTenSeconds, cls: () => 'main-thread' })))
    expect(v.primary.low.missed).toBe(537) // 3 * 179
    expect(v.primary.low.expected).toBe(324000)
    expect(v.primary.low.per1000).toBeCloseTo(1000 * 537 / 324000, 9)
    expect(v.primary.low.ci[0]).toBeGreaterThan(1) // the hitches are spread evenly: a narrow CI
    expect(v.verdict).toBe('promote')
    expect(v.primary.decision.decidedBy).toBe('low')
    expect(v.poissonAgrees).toBe(true)
  })

  it('4. the same missed frames attributed to the GPU process: keep P1 (they do not count)', () => {
    const v = gateVerdict(three(() => ({ skip: everyTenSeconds, cls: () => 'gpu' })))
    expect(v.primary.low.missed).toBe(0)
    expect(v.primary.high.per1000).toBe(0)
    expect(v.sensitivity.low.missed).toBe(0)
    expect(v.verdict).toBe('keep-P1')
  })

  it('5. the same missed frames unattributed: the owner decides (the sensitivity analysis promotes)', () => {
    const v = gateVerdict(three(() => ({ skip: everyTenSeconds })))
    expect(v.primary.decision.verdict).toBe('keep-P1') // 0 main-thread missed frames
    expect(v.unattributed.lowMissed).toBe(537)
    expect(v.sensitivity.decision.verdict).toBe('promote') // 1.657 per 1,000 counted as main-thread
    expect(v.verdict).toBe('owner-decides')
    expect(v.reason).toContain('unattributed')
  })

  it('6. late by callback entry times only: the owner decides (low 0, high 179 / 108,179 = 1.655 per 1,000)', () => {
    // The callback starts 10 ms late every 10 s; its rAF timestamp stays on the grid. Entry interval
    // 26.7 ms > 1.5 P (25 ms): late, round(26.7 / 16.7) - 1 = 1 missed frame; the next is short.
    const v = gateVerdict(three(() => ({ entryDelay: j => (everyTenSeconds(j) ? 10 : 0), cls: () => 'main-thread' })))
    expect(v.primary.low.per1000).toBe(0)
    expect(v.primary.high.missed).toBe(537)
    expect(v.primary.high.expected).toBe(324000 + 537) // every vsync rendered, plus the missed
    expect(v.primary.high.per1000).toBeCloseTo(1000 * 537 / 324537, 9)
    expect(v.verdict).toBe('owner-decides')
    expect(v.primary.decision.decidedBy).toBe('between')
  })

  it('7. missed frames clustered in three minutes: the CI spans 1 and the owner decides; Poisson would not', () => {
    // In minute 5 of each session one vsync in 20 is skipped: 180 per session, 540 in all,
    // 540 / 324,000 = 1.667 per 1,000. Three of 93 blocks hold them all, so the block bootstrap's
    // CI is wide; the Poisson interval treats the 540 as independent and is narrow.
    const v = gateVerdict(three(() => ({ skip: j => j >= 18000 && j < 21600 && j % 20 === 0, cls: () => 'main-thread' })))
    expect(v.primary.low.missed).toBe(540)
    expect(v.primary.low.per1000).toBeCloseTo(1000 * 540 / 324000, 9)
    expect(v.primary.low.ci[0]).toBeLessThan(1)
    expect(v.primary.low.ci[1]).toBeGreaterThan(1)
    expect(v.primary.low.poissonCi[0]).toBeGreaterThan(1)
    expect(v.verdict).toBe('owner-decides')
    expect(v.primary.decision.decidedBy).toBe('low')
    expect(v.poissonAgrees).toBe(false)
  })

  it('the single-session re-check rule (REN-22b, REN-25): G2 or a G1 low estimate of 1 per 1,000 triggers D21', () => {
    const one = (spec: Spec) => gateVerdict([session('rc', spec)])
    expect(recheckRule(one({})).triggered).toBe(false)
    expect(recheckRule(one({ tasks: [{ type: 'longtask', startMs: 1000, durationMs: 50 }] })).triggered).toBe(true)
    // 179 main-thread missed frames in 108,000: 1.657 per 1,000
    expect(recheckRule(one({ skip: everyTenSeconds, cls: () => 'main-thread' })).triggered).toBe(true)
    // The same unattributed: not counted by this rule
    expect(recheckRule(one({ skip: everyTenSeconds })).triggered).toBe(false)
    // Late by callback entry times only (the high estimate): not counted by this rule either
    expect(recheckRule(one({ entryDelay: j => (everyTenSeconds(j) ? 10 : 0), cls: () => 'main-thread' })).triggered).toBe(false)
    expect(recheckRule(one({})).checked).toBe(true)
  })

  it('the re-check rule cannot pass a session that is not valid (REN-25: no compile after ready)', () => {
    // A post-ready shader compile makes the session not valid: no rate exists, so the rule must not
    // report "not triggered" from an empty pool (its G1 rate would be NaN)
    const rc = session('rc', { frameFlags: j => (j === 600 ? { postReadyRise: true } : {}) })
    const v = gateVerdict([rc])
    const r = recheckRule(v)
    expect(r.checked).toBe(false)
    expect(r.triggered).toBe(false)
    expect(r.reason).toContain('no valid session (rc: 1 program or texture rise(s) after ready')
    expect(r.reason).toContain('repeat the session')
    expect(formatReport([rc], v)).toContain('single-session re-check rule (REN-22b, REN-25): NOT CHECKED')
  })

  it('per-session counts and the pooled per-minute blocks agree (two code paths, one count)', () => {
    // Main-thread, GPU and unattributed late intervals in both series, in one set of sessions
    const sessions = three(i => ({
      seconds: 600,
      skip: j => j % 900 === 450,
      entryDelay: j => (j % 1200 === 0 && j > 0 ? 10 : 0),
      cls: j => (['main-thread', 'gpu', 'unattributed'] as const)[(j + i) % 3]!
    }))
    const v = gateVerdict(sessions)
    const sum = (series: 'low' | 'high', cls: IntervalClass) => sessions.reduce((a, s) => a + s[series].byClass[cls].missed, 0)
    for (const series of ['low', 'high'] as const) {
      expect(v.primary[series].missed).toBe(sum(series, 'main-thread'))
      expect(v.sensitivity[series].missed).toBe(sum(series, 'main-thread') + sum(series, 'unattributed'))
      expect(v.primary[series].expected).toBe(sessions.reduce((a, s) => a + s[series].expected, 0))
    }
    expect(sum('high', 'main-thread') + sum('high', 'gpu') + sum('high', 'unattributed')).toBeGreaterThan(sum('low', 'main-thread') + sum('low', 'gpu') + sum('low', 'unattributed'))
  })

  it('pools only valid sessions, and says when the gate requirements are not met', () => {
    const sessions = [
      session('ok1'), session('ok2'),
      session('hidden', { frameFlags: j => (j === 100 ? { hidden: true } : {}) }),
      session('short', { seconds: 600 })
    ]
    const v = gateVerdict(sessions)
    expect(v.sessionsUsed).toEqual(['ok1', 'ok2', 'short'])
    expect(v.sessionsInvalid.map(s => s.id)).toEqual(['hidden'])
    expect(v.meetsGateRequirements).toBe(false)
    expect(v.requirementNotes[0]).toBe('2 valid session(s) of at least 30 min; the gate needs 3')
  })
})

describe('command line (tools/timing/gate.ts)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

  function writeSession(rows: string[], tasks: string[] | null, attribution?: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-session-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'frames.tsv'), rows.join('\n') + '\n')
    if (tasks) fs.writeFileSync(path.join(dir, 'longtasks.jsonl'), tasks.join('\n') + '\n')
    if (attribution) fs.writeFileSync(path.join(dir, 'attribution.jsonl'), attribution.join('\n') + '\n')
    return dir
  }

  function rows(n: number, skipAt: number) {
    const out = ['# frame log, synthetic', 'frame\traf_ms\tentry_ms\texit_ms\thidden\tcontext_lost']
    let frame = 0
    for (let j = 0; j <= n; j++) {
      if (j === skipAt) continue
      const raf = q(j * 1000 / 60)
      out.push(`${frame++}\t${raf}\t${q(raf + 0.3)}\t${q(raf + 1.3)}\t0\t0`)
    }
    return out
  }

  it('parses frames.tsv, dropping only an incomplete last line', () => {
    const { frames, droppedLastLine } = parseFramesTsv('frame\traf_ms\tentry_ms\n0\t0\t0.3\n1\t16.7\t17\n2\t33.')
    expect(frames).toEqual([{ frame: 0, rafMs: 0, entryMs: 0.3 }, { frame: 1, rafMs: 16.7, entryMs: 17 }])
    expect(droppedLastLine).toBe(true)
    expect(() => parseFramesTsv('frame\traf_ms\tentry_ms\n0\t0\t0.3\n1\tx\t17\n2\t33.3\t33.6\n')).toThrow(/frames.tsv:3: not a complete frame row/)
    expect(() => parseFramesTsv('frame\tentry_ms\n0\t0\n')).toThrow(/no column "raf_ms"/)
  })

  it('reads times in microseconds too (the link protocol carries integer us), and a byte-order mark', () => {
    const ms = parseFramesTsv('frame\traf_ms\tentry_ms\texit_ms\n0\t0\t0.3\t1.3\n1\t16.7\t17\t18.25\n').frames
    const us = parseFramesTsv('\uFEFFframe\traf_us\tentry_us\texit_us\n0\t0\t300\t1300\n1\t16700\t17000\t18250\n').frames
    expect(us).toEqual(ms)
    const dir = writeSession(['frame\traf_us\tentry_us\thidden', '0\t0\t300\t0', '1\t16700\t17000\t1'],
      ['{"type":"longtask","start_us":5000,"duration_us":50000}'])
    const { summary } = readSession(dir)
    expect(summary.tasks.g2).toEqual([{ type: 'longtask', startMs: 5, durationMs: 50 }])
    expect(summary.valid).toBe(false) // the hidden flag is read
    expect(summary.invalidReasons[0]).toContain('window hidden')
  })

  it('reports an incomplete last line of longtasks.jsonl or attribution.jsonl (an entry may be missing)', () => {
    const dir = writeSession(rows(60, 30), null)
    fs.writeFileSync(path.join(dir, 'longtasks.jsonl'), '{"type":"longtask","start_ms":100,"duration_ms":60}\n{"type":"longt')
    fs.writeFileSync(path.join(dir, 'attribution.jsonl'), '{"frame":30,"class":"gpu"}\n{"fra')
    const { summary, notes } = readSession(dir)
    expect(summary.tasks.g2).toHaveLength(1)
    expect(notes).toEqual(['longtasks.jsonl: incomplete last line dropped (an entry may be missing)',
      'attribution.jsonl: incomplete last line dropped'])
    // A damaged line that is not the last one is an error, not a note
    fs.writeFileSync(path.join(dir, 'longtasks.jsonl'), '{"type":"longt\n{"type":"longtask","start_ms":100,"duration_ms":60}\n')
    expect(() => readSession(dir)).toThrow(/longtasks.jsonl:1: not JSON/)
  })

  it('reads a session folder: the late interval, its class and the tasks', () => {
    const dir = writeSession(rows(600, 300), ['{"type":"longtask","start_ms":4990,"duration_ms":30}', '{"type":"long-animation-frame","start_ms":4990,"duration_ms":60}'],
      ['{"frame":300,"class":"main-thread"}'])
    const { summary, notes } = readSession(dir)
    expect(notes).toEqual([])
    expect(summary.frames).toBe(600)
    expect(summary.low.lateIntervals).toEqual([{ frame: 300, startMs: q(299 * 1000 / 60), intervalMs: q(301 * 1000 / 60) - q(299 * 1000 / 60), missed: 1, cls: 'main-thread' }])
    expect(summary.tasks.byType).toEqual({ longtask: 1, 'long-animation-frame': 1 })
    expect(summary.tasks.g2).toEqual([]) // a 60 ms long animation frame is a frame, not a task
    // One main-thread missed frame in 600: 1.667 per 1,000. With one block the bootstrap CI is a
    // point, which is why the gate needs 3 sessions of 30 min (90 blocks); the report says so
    const report = formatReport([summary], gateVerdict([summary]))
    expect(report).toContain('GATE REQUIREMENTS NOT MET')
    expect(report).toContain('VERDICT: promote: G1 low estimate 1.667 per 1,000')
  })

  it('runs in Node (type stripping) and writes the report', () => {
    const dirsIn = [0, 1, 2].map(() => writeSession(rows(3600, 1800), []))
    const out = path.join(dirsIn[0], 'report.json')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
      path.join(REPO, 'tools', 'timing', 'gate.ts'), ...dirsIn, '--out', out], { encoding: 'utf8', env, windowsHide: true })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('GATE REQUIREMENTS NOT MET') // three 1-minute sessions
    expect(r.stdout).toContain('no attribution.jsonl')
    const report = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(report.schema).toBe('three-maze/gate-report@1')
    // One unattributed missed frame per session: 3 of 10,800, 0.278 per 1,000 even counted as main-thread
    expect(report.pooled.sensitivity.low.missed).toBe(3)
    expect(report.pooled.sensitivity.low.expected).toBe(10800)
    expect(report.pooled.verdict).toBe('keep-P1')

    const bad = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
      path.join(REPO, 'tools', 'timing', 'gate.ts'), path.join(dirsIn[0], 'nowhere')], { encoding: 'utf8', env, windowsHide: true })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('no frames.tsv')
  })
})
