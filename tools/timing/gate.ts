// Gate analysis over session folders (ADR-0003 Decision 2; plan item REN-13). Reads each folder's
// frame log and long-task entries, prints a timing summary per session (for QC) and the pooled
// gate verdict, and writes everything as JSON. The rules are in gateCounting.ts and
// docs/timing/gate-analysis.md.
//
//   npm run timing:gate -- <session folder> [<session folder> ...] [--out report.json]
//   (= node --experimental-strip-types tools/timing/gate.ts ...; Node 22.6 or newer)
//
// Files read in each folder (formats: docs/timing/gate-analysis.md, Inputs):
//   frames.tsv         required: one row per rendered frame, header row with at least
//                      frame, raf_ms, entry_ms (optional exit_ms, hidden, context_lost, post_ready_rise);
//                      raf_us, entry_us, exit_us (microseconds) instead are read too
//   longtasks.jsonl    long-task, long-animation-frame, timed-handler and trace-task entries
//                      (without it the session is not valid for the gate)
//   attribution.jsonl  optional (REN-15): {"frame": N, "class": "main-thread"|"gpu"|"clock"|"unattributed"}
//
// Exit code: 0 the analysis ran (whatever the verdict), 2 bad arguments or unreadable input.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  gateVerdict, INTERVAL_CLASSES, recheckRule, SPEC_VERSION, summarizeSession,
  type FrameRecord, type IntervalClass, type PooledResult, type SessionSummary, type TaskRecord
} from './gateCounting.ts'

export class InputError extends Error {}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v.trim())
const withoutBom = (text: string) => text.replace(/^\uFEFF/, '')

/**
 * frames.tsv: tab-separated, a header row, '#' comment lines; a damaged last line is dropped.
 * Times are in milliseconds (columns raf_ms, entry_ms, exit_ms) or in microseconds (raf_us,
 * entry_us, exit_us, as the link protocol carries them); either is read as milliseconds.
 */
export function parseFramesTsv(text: string, file = 'frames.tsv'): { frames: FrameRecord[], droppedLastLine: boolean } {
  text = withoutBom(text)
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const rows = lines.map((line, i) => ({ line, n: i + 1 })).filter(r => r.line.trim() !== '' && !r.line.startsWith('#'))
  if (!rows.length) throw new InputError(`${file}: no header row`)
  const header = rows[0]!.line.split('\t').map(h => h.trim())
  const col = (name: string) => header.indexOf(name)
  // A time column, in ms or in us: [column, factor to ms], or null if the header has neither
  const timeCol = (name: string): [number, number] | null =>
    col(`${name}_ms`) >= 0 ? [col(`${name}_ms`), 1] : col(`${name}_us`) >= 0 ? [col(`${name}_us`), 1e-3] : null
  if (col('frame') < 0) throw new InputError(`${file}: no column "frame" in the header (${header.join(', ')})`)
  for (const name of ['raf', 'entry']) {
    if (!timeCol(name)) throw new InputError(`${file}: no column "${name}_ms" or "${name}_us" in the header (${header.join(', ')})`)
  }
  const frames: FrameRecord[] = []
  let droppedLastLine = false
  for (let k = 1; k < rows.length; k++) {
    const { line, n } = rows[k]!
    const f = line.split('\t')
    const cell = (c: number) => (c >= 0 && f[c] !== undefined && f[c]!.trim() !== '' ? Number(f[c]) : undefined)
    const time = (name: string) => {
      const tc = timeCol(name)
      const v = tc ? cell(tc[0]) : undefined
      return v === undefined || !tc ? undefined : v * tc[1]
    }
    const frame = cell(col('frame'))
    const rafMs = time('raf')
    const entryMs = time('entry')
    const exitMs = time('exit')
    const ok = f.length >= header.length && [frame, rafMs, entryMs].every(v => v !== undefined && Number.isFinite(v)) &&
      (exitMs === undefined || Number.isFinite(exitMs))
    if (!ok) {
      if (k === rows.length - 1 && !text.endsWith('\n')) { droppedLastLine = true; break } // still being written
      throw new InputError(`${file}:${n}: not a complete frame row: ${JSON.stringify(line.slice(0, 200))}`)
    }
    const rec: FrameRecord = { frame: frame!, rafMs: rafMs!, entryMs: entryMs! }
    if (exitMs !== undefined) rec.exitMs = exitMs
    if (col('hidden') >= 0 && truthy(f[col('hidden')])) rec.hidden = true
    if (col('context_lost') >= 0 && truthy(f[col('context_lost')])) rec.contextLost = true
    if (col('post_ready_rise') >= 0 && truthy(f[col('post_ready_rise')])) rec.postReadyRise = true
    const prev = frames[frames.length - 1]
    if (prev && !(rec.frame > prev.frame)) throw new InputError(`${file}:${n}: frame ${rec.frame} does not follow frame ${prev.frame}`)
    frames.push(rec)
  }
  return { frames, droppedLastLine }
}

/** JSON Lines; a damaged last line without a newline (a file still being written) is dropped. */
function jsonLines(text: string, file: string): { rows: Array<Record<string, unknown>>, droppedLastLine: boolean } {
  const rows: Array<Record<string, unknown>> = []
  const lines = withoutBom(text).split(/\r?\n/)
  let droppedLastLine = false
  lines.forEach((line, i) => {
    if (!line.trim()) return
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      if (i === lines.length - 1) { droppedLastLine = true; return }
      throw new InputError(`${file}:${i + 1}: not JSON: ${JSON.stringify(line.slice(0, 200))}`)
    }
  })
  return { rows, droppedLastLine }
}

/** longtasks.jsonl: type, start and duration in ms (start_ms, duration_ms) or us (start_us, duration_us). */
export function parseLongTasks(text: string, file = 'longtasks.jsonl'): { tasks: TaskRecord[], droppedLastLine: boolean } {
  const { rows, droppedLastLine } = jsonLines(text, file)
  const ms = (o: Record<string, unknown>, name: string) =>
    o[`${name}_ms`] !== undefined ? Number(o[`${name}_ms`]) : o[`${name}_us`] !== undefined ? Number(o[`${name}_us`]) / 1000 : Number.NaN
  const tasks = rows.map((o, i) => {
    const startMs = ms(o, 'start')
    const durationMs = ms(o, 'duration')
    if (typeof o.type !== 'string' || !Number.isFinite(startMs) || !Number.isFinite(durationMs)) {
      throw new InputError(`${file}: entry ${i + 1} needs type, start_ms and duration_ms (or _us): ${JSON.stringify(o).slice(0, 200)}`)
    }
    return { type: o.type, startMs, durationMs, ...(typeof o.name === 'string' ? { name: o.name } : {}) }
  })
  return { tasks, droppedLastLine }
}

export function parseAttribution(text: string, file = 'attribution.jsonl'): { attribution: Map<number, IntervalClass>, droppedLastLine: boolean } {
  const { rows, droppedLastLine } = jsonLines(text, file)
  const attribution = new Map<number, IntervalClass>()
  for (const o of rows) {
    const cls = o.class as IntervalClass
    if (!Number.isInteger(o.frame) || !INTERVAL_CLASSES.includes(cls)) {
      throw new InputError(`${file}: needs an integer frame and a class of ${INTERVAL_CLASSES.join(', ')}: ${JSON.stringify(o).slice(0, 200)}`)
    }
    attribution.set(o.frame as number, cls)
  }
  return { attribution, droppedLastLine }
}

export function readSession(dir: string): { summary: SessionSummary, notes: string[] } {
  const read = (name: string) => {
    const file = path.join(dir, name)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  }
  const framesText = read('frames.tsv')
  if (framesText === null) throw new InputError(`${dir}: no frames.tsv`)
  const notes: string[] = []
  const { frames, droppedLastLine } = parseFramesTsv(framesText, path.join(dir, 'frames.tsv'))
  if (droppedLastLine) notes.push('frames.tsv: incomplete last line dropped')
  const tasksText = read('longtasks.jsonl')
  const longTasks = tasksText === null ? null : parseLongTasks(tasksText, path.join(dir, 'longtasks.jsonl'))
  if (longTasks?.droppedLastLine) notes.push('longtasks.jsonl: incomplete last line dropped (an entry may be missing)')
  const attributionText = read('attribution.jsonl')
  const attribution = attributionText === null ? null : parseAttribution(attributionText, path.join(dir, 'attribution.jsonl'))
  if (attribution === null) notes.push('no attribution.jsonl: every late interval is unattributed')
  else if (attribution.droppedLastLine) notes.push('attribution.jsonl: incomplete last line dropped')
  const summary = summarizeSession({
    id: path.basename(path.resolve(dir)),
    frames,
    tasks: longTasks?.tasks ?? null,
    attribution: attribution?.attribution ?? null
  })
  return { summary, notes }
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x))

/** The G2 tasks for the console: how many, and the first 10 (the JSON report lists them all). */
function g2Line(tasks: PooledResult['g2Tasks']): string {
  if (!tasks.length) return 'none'
  const shown = tasks.slice(0, 10).map(t => `${t.session} ${t.type} ${t.durationMs.toFixed(1)} ms at ${t.startMs.toFixed(1)}`)
  return `${tasks.length} task(s): ${shown.join('; ')}${tasks.length > shown.length ? '; ...' : ''}`
}

function sessionLine(s: SessionSummary): string {
  const c = (cls: IntervalClass) => `${s.low.byClass[cls].missed}/${s.high.byClass[cls].missed}`
  return `${s.id}: ${(s.durationS / 60).toFixed(1)} min, ${s.frames} frames, P ${f3(s.periodMs)} ms (${s.hz.toFixed(2)} Hz); ` +
    `late intervals ${s.low.late}/${s.high.late} (rAF/entry), missed frames main-thread ${c('main-thread')}, ` +
    `unattributed ${c('unattributed')}, GPU ${c('gpu')}, clock ${c('clock')}; net deficit ${s.netDeficit.toFixed(1)}; ` +
    `longest interval ${s.low.maxIntervalMs.toFixed(1)}/${s.high.maxIntervalMs.toFixed(1)} ms; ` +
    `tasks >= 50 ms: ${s.tasks.g2.length}; callbacks longer than P: ${s.renderCallbackOverruns.length}; ` +
    (s.valid ? 'valid' : `NOT VALID: ${s.invalidReasons.join('; ')}`)
}

export function formatReport(sessions: SessionSummary[], pooled: PooledResult): string {
  const recheck = recheckRule(pooled)
  const est = (label: string, e: PooledResult['primary']['low']) =>
    `  ${label.padEnd(34)} ${f3(e.per1000)} per 1,000 (${e.missed} of ${e.expected}); 95 % CI ${f3(e.ci[0])}-${f3(e.ci[1])}` +
    ` (Poisson ${f3(e.poissonCi[0])}-${f3(e.poissonCi[1])})`
  return [
    `gate analysis, ${SPEC_VERSION}`,
    ...sessions.map(s => `  ${sessionLine(s)}`),
    `pooled over ${pooled.sessionsUsed.length} valid session(s): ${pooled.meetsGateRequirements ? 'gate requirements met' : 'GATE REQUIREMENTS NOT MET'}`,
    ...pooled.requirementNotes.map(n => `  note: ${n}`),
    est('G1 low (rAF timestamps)', pooled.primary.low),
    est('G1 high (callback entry times)', pooled.primary.high),
    est('sensitivity low (+ unattributed)', pooled.sensitivity.low),
    est('sensitivity high (+ unattributed)', pooled.sensitivity.high),
    `  G2: ${g2Line(pooled.g2Tasks)}`,
    `  sensitivity analysis says: ${pooled.sensitivity.decision.verdict} (${pooled.sensitivity.decision.reason})`,
    ...(pooled.poissonAgrees ? [] : ['  note: the Poisson cross-check reads the deciding CI differently (see docs/timing/gate-analysis.md)']),
    `VERDICT: ${pooled.verdict}: ${pooled.reason}`,
    `single-session re-check rule (REN-22b, REN-25): ${!recheck.checked ? 'NOT CHECKED' : recheck.triggered ? 'TRIGGERS D21' : 'not triggered'}: ${recheck.reason}`
  ].join('\n')
}

function main(argv: string[]): number {
  const dirs: string[] = []
  let out: string | null = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--out') out = argv[++i] ?? null
    else if (a === '--help' || a === '-h') {
      console.log('usage: npm run timing:gate -- <session folder> [...] [--out report.json]')
      return 0
    } else if (a.startsWith('--')) {
      console.error(`unknown option ${a}`)
      return 2
    } else dirs.push(a)
  }
  if (!dirs.length || (out === null && argv.includes('--out'))) {
    console.error('usage: npm run timing:gate -- <session folder> [...] [--out report.json]')
    return 2
  }
  try {
    const read = dirs.map(d => ({ dir: path.resolve(d), ...readSession(d) }))
    const sessions = read.map(r => r.summary)
    const pooled = gateVerdict(sessions)
    console.log(formatReport(sessions, pooled))
    for (const r of read) for (const n of r.notes) console.log(`  ${r.summary.id}: ${n}`)
    if (out) {
      const report = {
        schema: 'three-maze/gate-report@1',
        spec_version: SPEC_VERSION,
        generated: new Date().toISOString(),
        inputs: read.map(r => ({ dir: r.dir, notes: r.notes })),
        sessions: sessions.map(s => ({ ...s, blocks: s.blocks.length })),
        pooled,
        recheck_rule: recheckRule(pooled)
      }
      fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
      console.log(`report written to ${path.resolve(out)}`)
    }
    return 0
  } catch (e) {
    if (e instanceof InputError) {
      console.error(`timing:gate: ${e.message}`)
      return 2
    }
    throw e
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
