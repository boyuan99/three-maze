// Analysis of one scenario's raw artifacts and the pass/fail checks.
//
// Session scenarios read: summary.json (harness/main.cjs), monitor.json (harness/monitor.py),
// runner.json (run.mjs), ws.jsonl (the page's WebSocket frames), backend.log, and the simulated
// rig's own logs in sim/ (serial.jsonl, daq.jsonl, sim.jsonl, VirmenData/). The rig's logs are
// written by the backend process itself, so they survive an Electron crash.
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------- reading
export function readJson (file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
export function readText (file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}
export function readJsonl (file) {
  const out = []
  for (const line of readText(file).split(/\r?\n/)) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { out.push({ _bad: line.slice(0, 200) }) }
  }
  return out
}

const median = (v) => {
  const s = v.filter(x => typeof x === 'number').sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
const round = (x, n = 1) => x === null || x === undefined ? x : Math.round(x * 10 ** n) / 10 ** n

/**
 * x as Python's f"{x:.3f}" writes it (the experiments' data rows). Both round the exact binary value,
 * but at an exact tie toFixed rounds away from zero and Python to even: 64.5625 is 64.563 in JS and
 * 64.562 in the data file. At 3 decimals only odd multiples of 1/16 are exact ties.
 */
export function pyFixed3 (x) {
  const sixteenths = x * 16
  if (!Number.isInteger(sixteenths) || sixteenths % 2 === 0) return x.toFixed(3)
  const m = Math.floor(Math.abs(x) * 1000) // |x| * 1000 is exactly m + 0.5
  return (Math.sign(x) * (m % 2 === 0 ? m : m + 1) / 1000).toFixed(3)
}

// ---------------------------------------------------------------- processes (monitor.json)
export function processFacts (mon) {
  const procs = mon?.processes || []
  const root = procs.find(p => p.pid === mon?.root_pid) || null
  const py = procs.filter(p => /^pythonw?\.exe$/i.test(p.exe))
  // The venv's python.exe/pythonw.exe is a launcher that starts the base interpreter as its child
  const launcher = py.find(p => root && p.ppid === root.pid) || null
  const interpreter = py.find(p => launcher && p.ppid === launcher.pid) || launcher
  const sinceRoot = (p) => p && root && p.exit_time !== null && root.exit_time !== null
    ? round(p.exit_time - root.exit_time, 3) : null
  return {
    procs, root, launcher, interpreter,
    electron_exit_code: root?.exit_code ?? null,
    backend: py.map(p => ({ pid: p.pid, exe: p.exe, role: p === launcher ? 'launcher' : 'interpreter', exit_code: p.exit_code, exit_after_electron_s: sinceRoot(p), terminated_by_monitor: p.terminated_by_monitor })),
    interpreter_exit_after_electron_s: sinceRoot(interpreter),
    leftovers: mon?.leftovers_at_end || [],
    killed_by_monitor: procs.filter(p => p.terminated_by_monitor).map(p => `${p.exe} ${p.pid}`),
    not_exited: procs.filter(p => p.exit_time === null).map(p => `${p.exe} ${p.pid}`)
  }
}

// ---------------------------------------------------------------- session analysis
const ROW_RE = /^-?\d+\.\d{3}\t-?\d+\.\d{3}\t-?\d+\.\d{3}\t-?\d+(\.\d+)?\t-?\d+(\.\d+)?\t\d+\t\d+\t\S+$/

// A trial-end row: y >= 70 and then the reset (a row near the start) or the end of the file
function isTrialEndRow (rows, i) {
  return rows[i].y >= 69.99 && (i === rows.length - 1 || rows[i + 1].y < 10)
}
// The reset row hallway04 writes after resetting the player: exactly the start position, right after
// a row far down the hallway (normally the trial-end row)
function isResetRow (rows, i) {
  return i > 0 && rows[i].x === 0 && rows[i].y === 0 && rows[i].theta === 0 && rows[i - 1].y >= 10
}
const MAX_PULSE_WINDOW_SAMPLES = 2 // samples read during a 70 ms reward pulse at 20 Hz: 1, at most 2

// Why a sample has no data row. Each row is matched to the position_update it logged (by x, -z and
// theta, in order), so for a sample without a row the bench can tell what happened to its update:
//   logged_with_newer_sample    its update was logged, but with a newer sample's timestamp: the
//                               signature of the v0.3 low-frame-rate defect (KNOWN_V03_LOGGING_DEFECT)
//   skipped_after_late_update   its update was skipped as a duplicate after an older update had been
//                               logged two or more samples late: the low-frame-rate defect's second
//                               signature (sampleCoverage)
//   reset_frame_loss            the renderer sent no update for it, with the signature of the v0.3
//                               reset-frame loss (rendererLosses, KNOWN_V03_RESET_FRAME_LOSS)
//   overwritten_between_frames  the renderer sent no update for it, with the signature of the v0.3
//                               overwrite between frames (rendererLosses, KNOWN_V03_OVERWRITE)
//   no_position_update          the renderer sent no update for it, without either signature
//   update_without_row          its update reached the backend but no row has it
//   logged_with_older_sample    its update was logged with an older sample's timestamp
// The first four can be known failures (the first two in data_rows_one_per_sample, the renderer's
// two each in its own check); every other class is an ordinary failure
export const LOW_FRAME_RATE_CLASSES = ['logged_with_newer_sample', 'skipped_after_late_update']
export const RENDERER_LOSS_CLASSES = ['reset_frame_loss', 'overwritten_between_frames']
export const MISSING_SAMPLE_CLASSES = [...LOW_FRAME_RATE_CLASSES, ...RENDERER_LOSS_CLASSES, 'no_position_update', 'update_without_row', 'logged_with_older_sample']
const EXAMPLES = 12

// The time limits of the renderer losses' signatures (ws.jsonl, t_ms). In every unmodified output on
// the development machine, the serial_data that replaced an overwritten sample arrived 0-1 ms after
// it (both delivered in one burst after a long frame), while samples otherwise arrive about 50 ms
// apart (a renderer that skipped updates on purpose left gaps of 40-63 ms); and the sample a reset
// cleared arrived 0-16 ms after the reset
export const OVERWRITE_BURST_MS = 5
export const RESET_FRAME_MS = 20

/**
 * The renderer's two v0.3 losses (src/scenes/serial/PythonCustomScene.vue), told apart by their
 * signature in ws.jsonl, where every frame is in the page's own order with its time (t_ms). A sample
 * s qualifies only if the page received its serial_data exactly once and in order (after no later
 * sample's), sent no position_update for it, and the first position_update after it is for a newer
 * sample. Its window runs from the last position_update before s's serial_data to that next one.
 *   overwritten_between_frames  the next serial_data after s's is newer, arrived at most
 *                               OVERWRITE_BURST_MS after it (one burst) and before the next
 *                               position_update: handleSerialData (line 300) replaced s before a
 *                               frame took it (its rotation step is lost too)
 *   reset_frame_loss            at most one sample per reset (position_confirm, action 'set'): the
 *                               first sample after the reset that a frame could take, that is the
 *                               first serial_data after it, or, if that one was overwritten in a
 *                               burst, the burst's last sample. It must arrive at most RESET_FRAME_MS
 *                               after the reset, with no position_update in between (the reset is in
 *                               its window): the frame that applied the reset also took s, and the
 *                               reset cleared it (pendingSerialData = null, line 214)
 * Any other sample without a position_update, in a reset's window or not, is not in the result
 * (no_position_update).
 * Returns a Map: sample -> { class, update_before, update_after, replaced_by and replaced_after_ms |
 * set_ms and after_set_ms }
 */
export function rendererLosses (ws) {
  const isUpdate = (r) => r.dir === 'out' && r.type === 'position_update'
  const isSample = (r) => r.dir === 'in' && r.type === 'serial_data'
  const isSet = (r) => r.dir === 'in' && r.type === 'position_confirm' && r.action === 'set'
  const f = ws.filter(r => isUpdate(r) || isSample(r) || isSet(r))
  const updated = new Set(f.filter(isUpdate).map(r => r.seq))
  const received = new Map()
  for (const r of f) if (isSample(r)) received.set(r.seq, (received.get(r.seq) || 0) + 1)
  // Indexes in f of the next serial_data and the next position_update after each frame
  const nextSample = new Array(f.length).fill(-1)
  const nextUpdate = new Array(f.length).fill(-1)
  for (let i = f.length - 1, ns = -1, nu = -1; i >= 0; i--) {
    nextSample[i] = ns
    nextUpdate[i] = nu
    if (isSample(f[i])) ns = i
    if (isUpdate(f[i])) nu = i
  }
  const ms = (a, b) => Number.isFinite(f[a].t_ms) && Number.isFinite(f[b].t_ms) ? f[b].t_ms - f[a].t_ms : NaN

  const qualified = new Map() // index in f -> its window
  let before = -1 // index in f of the last position_update so far
  let newest = -Infinity // the newest sample received so far
  f.forEach((r, i) => {
    if (isUpdate(r)) { before = i; return }
    if (!isSample(r) || !Number.isInteger(r.seq)) return
    const inOrder = r.seq > newest
    newest = Math.max(newest, r.seq)
    if (!inOrder || updated.has(r.seq) || received.get(r.seq) !== 1) return
    const after = nextUpdate[i]
    if (after < 0 || !(f[after].seq > r.seq)) return
    qualified.set(i, { update_before: before >= 0 ? f[before].seq : null, update_after: f[after].seq })
  })

  const out = new Map()
  // The overwrite: the next serial_data is newer and came in the same burst, before any update
  const replacedBy = (i) => {
    const j = nextSample[i]
    if (j < 0 || !(f[j].seq > f[i].seq) || (nextUpdate[i] >= 0 && nextUpdate[i] < j)) return -1
    const gap = ms(i, j)
    return gap >= 0 && gap <= OVERWRITE_BURST_MS ? j : -1
  }
  const overwritten = new Set()
  for (const [i, ev] of qualified) {
    const j = replacedBy(i)
    if (j < 0) continue
    overwritten.add(i)
    out.set(f[i].seq, { class: 'overwritten_between_frames', ...ev, replaced_by: f[j].seq, replaced_after_ms: ms(i, j) })
  }
  // The reset-frame loss: one sample per reset at most
  f.forEach((r, k) => {
    if (!isSet(r)) return
    let i = nextSample[k]
    if (i < 0 || (nextUpdate[k] >= 0 && nextUpdate[k] < i)) return
    while (overwritten.has(i)) i = nextSample[i]
    if (i < 0 || !qualified.has(i) || out.has(f[i].seq)) return
    const after = ms(k, i)
    if (!(after >= 0 && after <= RESET_FRAME_MS)) return
    out.set(f[i].seq, { class: 'reset_frame_loss', ...qualified.get(i), set_ms: r.t_ms, after_set_ms: after })
  })
  return out
}

function newRange (first, last) {
  const r = {
    first_sample: first, last_sample: last, samples: Math.max(0, last - first + 1), samples_with_one_row: 0,
    pulse_window_samples: 0, samples_without_row: 0, without_row: {}, without_row_examples: {},
    samples_with_several_rows: 0, several_rows_examples: [],
    renderer_loss: {}, renderer_loss_samples: 0 // every sample of each RENDERER_LOSS_CLASSES, with its window
  }
  for (const k of MISSING_SAMPLE_CLASSES) { r.without_row[k] = 0; r.without_row_examples[k] = [] }
  for (const k of RENDERER_LOSS_CLASSES) r.renderer_loss[k] = []
  return r
}
function addMissing (r, cls, s, loss = null) {
  r.samples_without_row++
  r.without_row[cls] = (r.without_row[cls] || 0) + 1
  if (!r.without_row_examples[cls]) r.without_row_examples[cls] = []
  if (r.without_row_examples[cls].length < EXAMPLES) r.without_row_examples[cls].push(s)
  if (RENDERER_LOSS_CLASSES.includes(cls)) {
    const { class: _, ...window } = loss || {}
    r.renderer_loss[cls].push({ sample: s, ...window })
    r.renderer_loss_samples++
  }
}
const spans = (list) => { // [1,2,3,7] -> '1-3, 7'
  const out = []
  for (const s of list) {
    const last = out[out.length - 1]
    if (last && s === last[1] + 1) last[1] = s
    else out.push([s, s])
  }
  return out.map(([a, b]) => a === b ? `${a}` : `${a}-${b}`).join(', ')
}

/**
 * One data row per serial sample. The rows carry the Teensy timestamp, which the simulated Teensy
 * sets to seq * period, so each row names the sample it was logged with. Counting starts at the
 * first sample the backend read (seq 1), not at the first row, and is split in two ranges:
 *
 * - session_start: the samples read before experiment_start (seq 1 to firstAfterStart - 1). The
 *   backend is busy registering the experiment then, so the renderer's position_updates for them
 *   queue up and reach the experiment together when registration ends. v0.3 logs the first of them
 *   with the newest sample's timestamp and skips the rest as duplicates: the session-start backlog
 *   (KNOWN_V03_SESSION_START_BACKLOG). Its signature: the first row was logged by the session's first
 *   update, which the renderer sent before experiment_start, with a newer sample than its own; the
 *   samples without a row are the ones before the first row's.
 * - session: from the first sample read after experiment_start (firstAfterStart) to the last row's
 *   sample. Every sample must have exactly one row. Around a trial end, two things are allowed: the
 *   reset row (logged after the reward pulse with the newest sample) may share the trial-end row's
 *   sample, and the samples read during the pulse, between the trial-end row and the reset row, have
 *   no row (the renderer's updates for them are stale and the backend drops them). Every other
 *   sample without a row is classed by what happened to its update (MISSING_SAMPLE_CLASSES).
 *
 * In both ranges, a sample the renderer lost (RENDERER_LOSS_CLASSES) is listed in renderer_loss with
 * its window; data_rows_reset_frame_loss and data_rows_overwritten_between_frames judge those, and
 * the two data-row checks judge every other sample (unexplained_without_row and checked_without_row
 * leave them out).
 *
 * skipped_after_late_update, the low-frame-rate defect at a lag of two samples or more (frames longer
 * than a sample period): an older update u was logged with sample s2 >= u + 2, and the update of a
 * sample s between them (u < s < s2) then arrived while s2 was still the newest sample, so the
 * backend skipped it as a duplicate. Exact signature: s has no row, has position_updates and none of
 * them has a row, an update u < s sent before them was logged with a sample s2 > s, and the page sent
 * each of s's updates after u's and before it had received any sample newer than s2
 * (newest_received). A sample with any part missing stays update_without_row.
 *
 * Every row except the reset rows must also match an update (rows_without_update). Of those that do
 * not, rows_after_capture counts the ones after the last row that matched, each logged with a sample
 * newer than the last update in ws.jsonl: after a crash, their updates can be missing from ws.jsonl
 * because its capture ends with Electron.
 *
 * updates: the renderer's position_updates in send order, each { seq, x, z, theta, before_start,
 * newest_received } (newest_received: the newest serial_data the page had received when it sent
 * the update). losses: rendererLosses(ws).
 */
export function sampleCoverage (rows, periodUs, lastReadSeq, updates = [], firstAfterStart = null, losses = new Map()) {
  const c = {
    rows: rows.length, first_sample_after_start: firstAfterStart, last_sample: null,
    unmapped_timestamps: [], beyond_last_read: false, reset_rows: 0, resets_without_trial_end_row: [],
    pulse_window_samples: [], position_updates: updates.length,
    position_updates_before_start: updates.filter(u => u.before_start).length, rows_matched_to_updates: 0,
    rows_without_update: null, rows_without_update_examples: [], rows_after_capture: null, rows_after_capture_examples: [],
    session_start: null, session: null
  }
  if (!rows.length || !periodUs) return c
  const seq = rows.map(r => Number.isInteger(r.ts / periodUs) && r.ts > 0 ? r.ts / periodUs : null)
  rows.forEach((r, i) => { if (seq[i] === null && c.unmapped_timestamps.length < EXAMPLES) c.unmapped_timestamps.push(r.ts) })
  if (seq.some(s => s === null)) return c
  const count = new Map()
  const pulseWindow = new Set()
  rows.forEach((r, i) => {
    if (isResetRow(rows, i)) {
      c.reset_rows++
      if (isTrialEndRow(rows, i - 1)) {
        const gap = seq[i] - seq[i - 1] - 1
        if (gap > 0 && gap <= MAX_PULSE_WINDOW_SAMPLES) {
          for (let s = seq[i - 1] + 1; s < seq[i]; s++) { pulseWindow.add(s); c.pulse_window_samples.push(s) }
        }
        if (seq[i] === seq[i - 1]) return // shares the trial-end row's sample
      } else {
        c.resets_without_trial_end_row.push({ row: i + 1, sample: seq[i], previous_row_y: rows[i - 1].y, previous_row_sample: seq[i - 1] })
      }
    }
    count.set(seq[i], (count.get(seq[i]) || 0) + 1)
  })
  c.last_sample = Math.max(...seq)
  c.beyond_last_read = lastReadSeq !== null && c.last_sample > lastReadSeq

  // Match rows to the updates they logged (the row has x, -z and theta of the update), in order. The
  // file has 3 decimals, so -0.0004 is written -0.000: both zeros are the same here
  const fix3 = (v) => { const t = pyFixed3(Number(v)); return t === '-0.000' ? '0.000' : t }
  const key = (x, y, th) => `${fix3(x)}|${fix3(y)}|${fix3(th)}`
  const loggedAs = new Map() // update index -> sample of the row that logged it
  const rowUpdate = new Map() // row index -> update index
  const unmatched = [] // row indexes
  let next = 0
  rows.forEach((r, i) => {
    if (isResetRow(rows, i)) return
    const k = key(r.x, r.y, r.theta)
    let j = next
    while (j < updates.length && key(updates[j].x || 0, -(updates[j].z || 0), updates[j].theta || 0) !== k) j++
    if (j >= updates.length) { unmatched.push(i); return }
    next = j + 1
    c.rows_matched_to_updates++
    loggedAs.set(j, seq[i])
    rowUpdate.set(i, j)
  })
  const example = (i) => ({ row: i + 1, sample: seq[i], x: rows[i].x, y: rows[i].y, theta: rows[i].theta })
  const lastMatched = Math.max(-1, ...rowUpdate.keys())
  const lastUpdateSeq = updates.length ? updates[updates.length - 1].seq : null
  const afterCapture = unmatched.filter(i => lastMatched >= 0 && i > lastMatched && Number.isInteger(lastUpdateSeq) && seq[i] > lastUpdateSeq)
  c.rows_without_update = unmatched.length
  c.rows_without_update_examples = unmatched.slice(0, EXAMPLES).map(example)
  c.rows_after_capture = afterCapture.length
  c.rows_after_capture_examples = afterCapture.slice(0, EXAMPLES).map(example)
  c.last_update_in_ws = lastUpdateSeq
  const updatesOf = new Map() // sample -> indexes of the updates computed from it
  updates.forEach((u, j) => { if (!updatesOf.has(u.seq)) updatesOf.set(u.seq, []); updatesOf.get(u.seq).push(j) })
  // The spans of the updates logged two or more samples late: update index -> { u, s2 }
  const lateSpans = [...loggedAs].filter(([j, s2]) => s2 - updates[j].seq >= 2).map(([j, s2]) => ({ j, u: updates[j].seq, s2 }))
  const skippedAfter = (s, js) => lateSpans.find(({ j: j0, u, s2 }) => u < s && s < s2 &&
    js.every(j => j > j0 && Number.isInteger(updates[j].newest_received) && updates[j].newest_received <= s2)) || null
  const missingClass = (s) => {
    const js = updatesOf.get(s) || []
    if (!js.length) return losses.get(s)?.class ?? 'no_position_update'
    if (js.some(j => loggedAs.has(j) && loggedAs.get(j) > s)) return 'logged_with_newer_sample'
    if (js.some(j => loggedAs.has(j) && loggedAs.get(j) < s)) return 'logged_with_older_sample'
    if (skippedAfter(s, js)) return 'skipped_after_late_update'
    return 'update_without_row'
  }
  const tally = (r, s, missing) => {
    const n = count.get(s) || 0
    if (n === 1) r.samples_with_one_row++
    else if (n > 1) {
      r.samples_with_several_rows++
      if (r.several_rows_examples.length < EXAMPLES) r.several_rows_examples.push({ sample: s, rows: n })
    } else if (pulseWindow.has(s)) r.pulse_window_samples++
    else addMissing(r, missing(s), s, losses.get(s))
  }

  // Session start: the samples read before experiment_start
  const start = firstAfterStart ?? 1
  if (firstAfterStart !== null) {
    const b = newRange(1, Math.min(firstAfterStart - 1, c.last_sample))
    const j0 = rowUpdate.get(0)
    const firstRow = j0 === undefined ? null : { sample: seq[0], update_seq: updates[j0].seq, update_is_first: j0 === 0, update_sent_before_start: !!updates[j0].before_start }
    // The backlog's signature (see above)
    b.first_row = firstRow ?? { sample: seq[0], update_seq: null }
    b.backlog_signature = !!firstRow && firstRow.update_is_first && firstRow.update_sent_before_start && firstRow.sample > firstRow.update_seq
    b.without_row.session_start_backlog = 0
    b.without_row_examples.session_start_backlog = []
    const backlog = []
    for (let s = b.first_sample; s <= b.last_sample; s++) {
      tally(b, s, (x) => {
        if (b.backlog_signature && x < seq[0]) { backlog.push(x); return 'session_start_backlog' }
        return missingClass(x)
      })
    }
    b.backlog_samples = backlog.length
    b.backlog_spans = spans(backlog)
    b.checked_without_row = b.samples_without_row - b.renderer_loss_samples
    b.unexplained_without_row = b.checked_without_row - b.backlog_samples
    c.session_start = b
  }

  // The session: from the first sample read after experiment_start
  const m = newRange(start, c.last_sample)
  for (let s = m.first_sample; s <= m.last_sample; s++) tally(m, s, missingClass)
  m.fraction_without_row = m.samples ? round(m.samples_without_row / m.samples, 3) : null
  m.checked_without_row = m.samples_without_row - m.renderer_loss_samples
  m.low_frame_rate_without_row = LOW_FRAME_RATE_CLASSES.reduce((n, k) => n + m.without_row[k], 0)
  m.unexplained_without_row = m.checked_without_row - m.low_frame_rate_without_row
  // Evidence: the late update behind each skipped_after_late_update sample
  m.skipped_after_late_update_examples = []
  for (let s = m.first_sample; s <= m.last_sample && m.skipped_after_late_update_examples.length < EXAMPLES; s++) {
    if (count.get(s) || pulseWindow.has(s) || missingClass(s) !== 'skipped_after_late_update') continue
    const span = skippedAfter(s, updatesOf.get(s))
    m.skipped_after_late_update_examples.push(`${s}: update ${span.u} logged as sample ${span.s2}`)
  }
  // Evidence: rows logged with a newer sample than their update's own (the defect's other half)
  m.rows_with_newer_sample = 0
  m.newer_sample_examples = []
  for (const [i, j] of rowUpdate) {
    if (updates[j].seq >= start && seq[i] > updates[j].seq) {
      m.rows_with_newer_sample++
      if (m.newer_sample_examples.length < 6) m.newer_sample_examples.push(`update ${updates[j].seq} logged as sample ${seq[i]}`)
    }
  }
  c.session = m
  return c
}

// The parts of the data file every data-row check needs intact
function rowsReadable (c) {
  return !!c && c.rows > 0 && !c.unmapped_timestamps.length && !!c.session
}

export function analyzeSession (dir) {
  const s = readJson(path.join(dir, 'summary.json'), {})
  const mon = readJson(path.join(dir, 'monitor.json'), null)
  const runner = readJson(path.join(dir, 'runner.json'), {})
  const ws = readJsonl(path.join(dir, 'ws.jsonl'))
  const simDir = path.join(dir, 'sim')
  const simLog = readJsonl(path.join(simDir, 'sim.jsonl'))
  const serial = readJsonl(path.join(simDir, 'serial.jsonl'))
  const daq = readJsonl(path.join(simDir, 'daq.jsonl'))
  const F = { dir, summary: s, monitor: mon, runner, proc: processFacts(mon) }

  // ---- backend.log: "<iso> +<ms>ms [out|err] <line>", ms on the harness clock (as quit.requested_ms).
  // line: the position in the log, which orders the backend's own events even if its output is buffered
  const lines = readText(path.join(dir, 'backend.log')).split(/\r?\n/).map(l => {
    const m = /^\S+ \+\s*(\d+)ms \[(?:out|err)\] (.*)$/.exec(l)
    return m ? { ms: Number(m[1]), text: m[2] } : null
  }).filter(Boolean).map((l, i) => ({ ...l, line: i }))
  const grep = (re) => lines.filter(l => re.test(l.text))
  F.log = {
    trial_end: grep(/Trial end detected/).map(l => ({ ms: l.ms, line: l.line, y: Number(/Y=(-?[\d.]+)/.exec(l.text)?.[1]) })),
    rewards: grep(/Reward #\d+ delivered/).map(l => ({ ms: l.ms, line: l.line, trial_time_s: Number(/Trial time: ([\d.]+)/.exec(l.text)?.[1]) })),
    tracebacks: grep(/Traceback \(most recent call last\)/).length,
    errors: grep(/ - ERROR - /).map(l => l.text.replace(/^.* - ERROR - /, '').slice(0, 300)),
    serial_closed: grep(/Serial port closed/).length,
    daq_closed: grep(/DAQ task closed/).length,
    data_closed: grep(/Data file closed/).length,
    shutdown_requested: grep(/Shutdown requested/).map(l => l.ms),
    cleanup_complete: grep(/CLEANUP COMPLETE/).map(l => l.ms),
    watchdog: grep(/Shutdown did not finish in time/).length,
    experiment_started: grep(/Experiment started:/).length,
    register_error: grep(/Error registering experiment: /).map(l => l.text.replace(/^.*Error registering experiment: /, ''))
  }

  // ---- simulated rig
  const activate = simLog.filter(r => r.event === 'activate')
  F.sim = {
    activations: activate.map(a => ({ pid: a.pid, exe: path.basename(a.executable || ''), serial_mode: a.settings?.serial_mode, open_delay_s: a.settings?.open_delay_s, sim_dir: a.settings?.sim_dir })),
    patched: simLog.filter(r => r.event === 'patched').map(r => r.module),
    error_log: fs.existsSync(path.join(simDir, 'sim_error.log'))
  }
  const ev = (name) => serial.filter(r => r.event === name)
  const sent = ev('sent')
  const read = ev('read')
  const streamStart = ev('stream_start')[0]
  F.serial = {
    open: ev('open').length,
    open_failed: ev('open_failed').map(r => ({ mode: r.mode, error: r.error })),
    close: ev('close').length,
    stream_stop: ev('stream_stop').map(r => r.reason),
    received: ev('received').map(r => r.data),
    period_ms: streamStart?.period_ms ?? null,
    sent: sent.length,
    read: read.length,
    dropped: ev('dropped').length,
    sent_contiguous: sent.every((r, i) => r.seq === i + 1),
    read_contiguous: read.every((r, i) => r.seq === i + 1),
    last_read_seq: read.length ? read[read.length - 1].seq : null,
    rate_hz: sent.length > 2 ? round((sent.length - 1) / (sent[sent.length - 1].t - sent[0].t), 2) : null,
    read_latency_ms_median: median(read.map(r => r.latency_ms))
  }

  const tasks = new Map()
  for (const r of daq) {
    if (!r.task) continue
    const key = `${r.pid}:${r.task}`
    if (!tasks.has(key)) tasks.set(key, { key, created: false, writes: [], close: null, errors: [] })
    const t = tasks.get(key)
    if (r.event === 'create') t.created = true
    else if (r.event === 'write') t.writes.push(r)
    else if (r.event === 'close') t.close = r
    else if (r.event === 'write_error') t.errors.push(r.error)
  }
  const pulses = []
  for (const t of tasks.values()) {
    t.writes.forEach((w, i) => {
      if (typeof w.value === 'number' && w.value > 0) {
        const next = t.writes[i + 1]
        pulses.push({ v: w.value, width_ms: next ? round((next.t - w.t) * 1e3, 1) : null, off: next ? next.value : null })
      }
    })
  }
  F.daq = {
    create_failed: daq.filter(r => r.event === 'create_failed').length,
    tasks: [...tasks.values()].map(t => ({ task: t.key, writes: t.writes.length, last: t.writes.length ? t.writes[t.writes.length - 1].value : null, closed: !!t.close, value_at_close: t.close ? t.close.value_at_close : undefined, errors: t.errors })),
    pulses,
    pulse_widths_ms: pulses.map(p => p.width_ms)
  }

  // ---- WebSocket frames as the page saw them
  const of = (dir, type) => ws.filter(r => r.dir === dir && r.type === type)
  const sd = of('in', 'serial_data')
  // position_updates in send order, each marked if the page sent it before experiment_start (the
  // backend was still registering the experiment) and with the newest sample the page had received
  // when it sent it; and the first sample the page received after sending experiment_start: the
  // first sample read after it
  const startAt = ws.findIndex(r => r.dir === 'out' && r.type === 'experiment_start')
  const pu = []
  let newestIn = null
  ws.forEach((r, i) => {
    if (r.dir === 'in' && r.type === 'serial_data' && Number.isInteger(r.seq)) newestIn = Math.max(newestIn ?? r.seq, r.seq)
    if (r.dir === 'out' && r.type === 'position_update') pu.push({ ...r, before_start: startAt >= 0 && i < startAt, newest_received: newestIn })
  })
  const firstAfterStart = startAt < 0 ? null : (ws.slice(startAt).find(r => r.dir === 'in' && r.type === 'serial_data')?.seq ?? null)
  const seqs = sd.map(r => r.seq)
  F.ws = {
    sockets: ws.filter(r => r.dir === 'created').length,
    serial_data_in: sd.length,
    serial_seq_gaps: seqs.slice(1).filter((q, i) => q !== seqs[i] + 1).length,
    position_update_out: pu.length,
    position_confirm_in: of('in', 'position_confirm').length,
    resets_in: of('in', 'position_confirm').filter(r => r.action === 'set').length,
    max_abs_z: round(Math.max(0, ...pu.map(r => Math.abs(r.z || 0))), 2),
    registered_in: of('in', 'experiment_registered').map(r => r.t_ms),
    start_out: of('out', 'experiment_start').map(r => r.t_ms),
    stop_out: of('out', 'experiment_stop').map(r => r.t_ms),
    errors_in: ws.filter(r => r.dir === 'in' && /error/i.test(r.type)).map(r => ({ t_ms: r.t_ms, type: r.type, msg: JSON.stringify(r.msg).slice(0, 300) })),
    renderer_status_out: of('out', 'renderer_status').length
  }

  // ---- data file and renderer-status sidecar
  const vd = path.join(simDir, 'VirmenData')
  const listing = fs.existsSync(vd) ? fs.readdirSync(vd) : []
  F.data_files = listing.filter(f => f.endsWith('.txt') && !f.endsWith('.renderer.jsonl'))
  F.sidecars = listing.filter(f => f.endsWith('.renderer.jsonl'))
  if (F.data_files.length) {
    const raw = fs.readFileSync(path.join(vd, F.data_files[0]))
    const text = raw.toString('latin1')
    const parts = text.split('\r\n')
    const partial = parts.pop()
    const rows = parts
    // Columns: x, -y, theta, raw_x, raw_y, water, Teensy timestamp (us), scene name
    const good = rows.filter(r => ROW_RE.test(r)).map(r => {
      const c = r.split('\t')
      return { x: Number(c[0]), y: Number(c[1]), theta: Number(c[2]), ts: Number(c[6]) }
    })
    const ts = good.map(r => r.ts)
    const trialEndRows = good.filter((r, i) => isTrialEndRow(good, i)).length
    const periodUs = (F.serial.period_ms || 50) * 1000
    F.data = {
      file: F.data_files[0],
      bytes: raw.length,
      rows: rows.length,
      bad_rows: rows.length - good.length,
      bad_examples: rows.filter(r => !ROW_RE.test(r)).slice(0, 3),
      ends_with_crlf: partial === '',
      lf_only: (text.match(/\n/g) || []).length - (text.match(/\r\n/g) || []).length,
      ts_non_decreasing: ts.every((t, i) => i === 0 || t >= ts[i - 1]),
      trial_end_rows: trialEndRows,
      last_row_sample: ts.length ? Math.round(ts[ts.length - 1] / periodUs) : null
    }
    F.data.samples_after_last_row = F.serial.last_read_seq !== null && F.data.last_row_sample !== null
      ? F.serial.last_read_seq - F.data.last_row_sample : null
    F.data.coverage = sampleCoverage(good, periodUs, F.serial.last_read_seq, pu, firstAfterStart, rendererLosses(ws))
  }
  if (F.sidecars.length) {
    const recs = readJsonl(path.join(vd, F.sidecars[0]))
    F.sidecar = {
      file: F.sidecars[0],
      lines: recs.length,
      bad_lines: recs.filter(r => r._bad).length,
      messages: [...new Set(recs.map(r => r.message))],
      effective_hz: [...new Set(recs.map(r => r.details?.effectiveHz).filter(x => x !== undefined).map(x => round(x, 2)))],
      dropped_frames: recs.map(r => r.details?.droppedFrames).filter(x => x !== undefined)
    }
  }

  // ---- page, quit, rendering
  const dom = s.dom || []
  F.page = { error_overlay: dom.length ? dom[dom.length - 1].errorOverlay : null, info_panel: dom.length ? dom[dom.length - 1].infoPanel : null }
  F.quit = {
    requested_ms: s.quit?.requested_ms ?? null,
    duration_ms: s.quit?.duration_ms ?? null,
    events: (s.quit?.events || []).map(e => e.event),
    stop_timeout_fired: !!s.quit?.stop_timeout_fired,
    backend_exited_before_quit: s.quit?.backend_exited_before_quit ?? null
  }
  const pps = (s.window?.paints_per_second || []).slice(1, -1)
  F.render = {
    component: s.renderer?.component ?? null,
    paints_per_s_median: median(pps),
    shots: (s.shots || []).map(x => ({ name: x.name, std: x.scene_region?.std ?? null, blank: x.blank, error: x.error || x.reason || null })),
    webgl: s.gpu?.webgl?.renderer ?? null,
    frame_clock_warnings: s.renderer?.frame_clock_warnings ?? null
  }
  return F
}

// ---------------------------------------------------------------- checks
// A check result is { name, ok, detail }. A failing check whose failure is expected in this run (a
// known product defect) also carries known_failure: the reason, and the runner reports it on its own
// line as KNOWN FAILURE instead of failing the scenario. A passing check never carries it.
function makeChecks () {
  const list = []
  const check = (name, ok, detail = '', { knownFailure = null } = {}) => {
    const rec = { name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }
    if (!ok && knownFailure) rec.known_failure = knownFailure
    list.push(rec)
    return !!ok
  }
  return { list, check }
}

// The four known v0.3 data-logging defects (test/e2e/README.md, Known limits), each with its own check
// so that a change in any of them shows: two in the backend (the low-frame-rate defect and the
// session-start backlog) and two in the renderer (the reset-frame loss and the overwrite between
// frames). Phase 1 removes all four code paths; then all four checks must pass.
//
// The low-frame-rate defect shows with software rendering (16-26 frames/s): the run used
// --software-gl, or Chromium fell back to SwiftShader. With a GPU it is an ordinary failure
export const KNOWN_V03_LOGGING_DEFECT = 'v0.3 low-frame-rate defect in experiments/hallway04_experiment.py:447-486, ' +
  'expected with software rendering: a position_update that arrives after the next sample was read is logged with ' +
  "that newer sample's timestamp and the next update is skipped as a duplicate, so the update's own sample gets no " +
  "data row; when it is logged two or more samples late, the skipped update's sample gets none either " +
  '(test/e2e/README.md, Known limits)'
// The session-start backlog shows in every run, GPU or not
export const KNOWN_V03_SESSION_START_BACKLOG = 'v0.3 session-start backlog in experiments/hallway04_experiment.py:447-486, ' +
  'expected in every run: the position_updates the renderer sends while the backend registers the experiment reach it ' +
  "together when registration ends; the first is logged with the newest sample's timestamp and the rest are skipped " +
  'as duplicates, so the samples read before experiment_start get no data row (test/e2e/README.md, Known limits)'
// The renderer's two losses show in every rendering mode: a reset arrives with a sample only now and
// then, and a stalled main thread lets two samples arrive between frames on a GPU too
export const KNOWN_V03_RESET_FRAME_LOSS = 'v0.3 reset-frame loss in src/scenes/serial/PythonCustomScene.vue:214, ' +
  "expected in every rendering mode: when the reset (position_confirm, action 'set') reaches the renderer in the same " +
  'frame as a new serial_data, the reset clears that sample (pendingSerialData = null), so the renderer sends no ' +
  'position_update for it and it gets no data row (test/e2e/README.md, Known limits)'
export const KNOWN_V03_OVERWRITE = 'v0.3 overwrite between frames in src/scenes/serial/PythonCustomScene.vue:300, ' +
  'expected in every rendering mode whenever two serial_data arrive between two frames (a slow or stalled frame): ' +
  'handleSerialData replaces the older sample before a frame takes it, so its rotation step is never applied, the ' +
  'renderer sends no position_update for it and it gets no data row (test/e2e/README.md, Known limits)'

export function softwareRendering (F, { softwareGl = false } = {}) {
  return !!softwareGl || /swiftshader/i.test(F.render?.webgl || '')
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The note in a data-row check's evidence when the renderer lost samples of its range
const rendererLossNote = (r) => r && r.renderer_loss_samples
  ? { renderer_loss_note: `${plural(r.renderer_loss_samples, 'sample')} without a row ${r.renderer_loss_samples === 1 ? 'was' : 'were'} lost in the renderer (` +
      RENDERER_LOSS_CLASSES.filter(k => r.without_row[k]).map(k => `${r.without_row[k]} ${k}`).join(', ') +
      '); data_rows_reset_frame_loss and data_rows_overwritten_between_frames judge them, this check the other samples' }
  : {}

/**
 * data_rows_one_per_sample: one row per sample from the first sample read after experiment_start
 * (the samples before it are data_rows_session_start_backlog's), except the samples the renderer
 * lost (RENDERER_LOSS_CLASSES), which their own checks judge. A known failure only with software
 * rendering, and only if every sample it judges without a row has one of the low-frame-rate defect's
 * two signatures (LOW_FRAME_RATE_CLASSES: its update was logged with a newer sample's timestamp, or
 * skipped after an older update was logged two or more samples late): any other sample without a
 * row, any sample with several rows, and any other problem make it an ordinary failure, in every
 * rendering mode
 */
function dataRowsCheck (F, check, opts) {
  const c = F.data?.coverage
  const m = c?.session
  const readable = rowsReadable(c)
  const ok = readable && c.first_sample_after_start !== null && m.samples > 0 && m.checked_without_row === 0 &&
    m.samples_with_several_rows === 0 && !c.resets_without_trial_end_row.length && !c.beyond_last_read
  const signatureOnly = readable && m.checked_without_row > 0 && m.unexplained_without_row === 0 &&
    m.samples_with_several_rows === 0 && !c.resets_without_trial_end_row.length && !c.beyond_last_read
  const known = !ok && signatureOnly && c.first_sample_after_start !== null && softwareRendering(F, opts)
  const detail = !c
    ? { data_files: F.data_files }
    : {
        samples: m?.samples ?? null,
        from_sample: m?.first_sample ?? null,
        to_sample: m?.last_sample ?? null,
        samples_with_one_row: m?.samples_with_one_row ?? null,
        pulse_window_samples: m?.pulse_window_samples ?? null,
        samples_without_row: m?.samples_without_row ?? null,
        judged_here_without_row: m?.checked_without_row ?? null,
        without_row: m?.without_row ?? null,
        ...rendererLossNote(m),
        ...(m && m.skipped_after_late_update_examples.length
          ? { skipped_after_late_update: m.skipped_after_late_update_examples }
          : {}),
        samples_with_several_rows: m?.samples_with_several_rows ?? null,
        ...(m && m.low_frame_rate_without_row && !softwareRendering(F, opts)
          ? { note: 'logged_with_newer_sample and skipped_after_late_update are the signatures of the v0.3 low-frame-rate defect; they are a known failure only with software rendering' }
          : {}),
        without_row_examples: m?.without_row_examples ?? null,
        several_rows_examples: m?.several_rows_examples ?? null,
        resets_without_trial_end_row: c.resets_without_trial_end_row,
        unmapped_timestamps: c.unmapped_timestamps,
        beyond_last_read: c.beyond_last_read,
        first_sample_after_start: c.first_sample_after_start,
        fraction_without_row: m?.fraction_without_row ?? null,
        rows: c.rows,
        rows_with_newer_sample: m?.rows_with_newer_sample ?? null,
        newer_sample_examples: m?.newer_sample_examples ?? null,
        position_update_out: F.ws.position_update_out
      }
  const skipped = m?.without_row.skipped_after_late_update || 0
  const reason = known
    ? `${m.checked_without_row} of ${m.samples} samples from sample ${m.first_sample} on have no row, each with the ` +
      (skipped
        ? `defect's signature: ${m.without_row.logged_with_newer_sample} logged_with_newer_sample (its update was logged with a newer ` +
          `sample's timestamp) and ${skipped} skipped_after_late_update (its update was skipped after an older one was logged two ` +
          `or more samples late: ${m.skipped_after_late_update_examples.slice(0, 3).join(', ')}${skipped > 3 ? ', ...' : ''})`
        : "defect's signature (its update was logged with a newer sample's timestamp)") +
      (m.renderer_loss_samples ? ` (not counting ${plural(m.renderer_loss_samples, 'sample')} lost in the renderer, judged by their own checks)` : '') +
      `: ${KNOWN_V03_LOGGING_DEFECT}`
    : null
  check('data_rows_one_per_sample', ok, detail, { knownFailure: reason })
}

/**
 * data_rows_match_position_updates: every data row except the reset rows was logged by a
 * position_update the renderer sent (same x, y and theta, matched in order). The v0.3 backend writes
 * rows only for position_updates and the reset row, so a row without one is an ordinary failure in
 * every rendering mode. One exception, after a crash only (afterCrash): the rows after the last row
 * that matched, each logged with a sample newer than the last update in ws.jsonl, are not judged
 * (rows_after_capture), because ws.jsonl's capture ends with Electron while the backend still logs
 * the last updates it received
 */
function rowsFromUpdatesCheck (F, check, { afterCrash = false } = {}) {
  const c = F.data?.coverage
  const readable = rowsReadable(c)
  const excused = readable && afterCrash ? c.rows_after_capture : 0
  const judged = readable ? c.rows_without_update - excused : null
  const ok = readable && judged === 0
  check('data_rows_match_position_updates', ok, !c
    ? { data_files: F.data_files }
    : {
        rows: c.rows,
        reset_rows: c.reset_rows,
        rows_matched_to_updates: c.rows_matched_to_updates,
        rows_without_update: c.rows_without_update,
        judged_rows_without_update: judged,
        rows_without_update_examples: c.rows_without_update_examples,
        ...(excused
          ? {
              rows_after_capture: excused,
              rows_after_capture_note: 'not judged: logged after the last row that matched, with a sample newer than the last ' +
                `update in ws.jsonl (${c.last_update_in_ws}), whose capture ended with Electron`,
              rows_after_capture_examples: c.rows_after_capture_examples
            }
          : {}),
        position_updates: c.position_updates,
        unmapped_timestamps: c.unmapped_timestamps
      })
}

/**
 * data_rows_session_start_backlog: every sample read before experiment_start has its own row,
 * except the samples the renderer lost (RENDERER_LOSS_CLASSES), which their own checks judge. In
 * v0.3 it fails in every run (KNOWN_V03_SESSION_START_BACKLOG); it is a known failure only with the
 * backlog's signature (sampleCoverage) and no other sample without a row, or with several rows,
 * among those samples. The size of the backlog is in the known-failure line
 */
function sessionStartCheck (F, check) {
  const c = F.data?.coverage
  const b = c?.session_start
  const readable = rowsReadable(c) && !!b
  const ok = readable && b.checked_without_row === 0 && b.samples_with_several_rows === 0
  const known = !ok && readable && b.backlog_signature && b.backlog_samples > 0 && b.unexplained_without_row === 0 &&
    b.samples_with_several_rows === 0
  const detail = !c
    ? { data_files: F.data_files }
    : !b
        ? { first_sample_after_start: c.first_sample_after_start, experiment_start_sent: F.ws.start_out.length, unmapped_timestamps: c.unmapped_timestamps }
        : {
            samples_read_before_start: b.samples,
            backlog_samples: b.backlog_samples,
            backlog: b.backlog_spans,
            samples_without_row: b.samples_without_row,
            without_row: b.without_row,
            ...rendererLossNote(b),
            samples_with_several_rows: b.samples_with_several_rows,
            backlog_signature: b.backlog_signature,
            first_row: b.first_row,
            position_updates_sent_before_start: c.position_updates_before_start,
            first_sample_after_start: c.first_sample_after_start,
            without_row_examples: b.without_row_examples,
            several_rows_examples: b.several_rows_examples,
            unmapped_timestamps: c.unmapped_timestamps
          }
  const reason = known
    ? `session-start backlog of ${plural(b.backlog_samples, 'sample')} (${b.backlog_spans}) without a row, of ` +
      `${b.samples} read before experiment_start; the first row is update ${b.first_row.update_seq} logged with ` +
      `sample ${b.first_row.sample}'s timestamp: ${KNOWN_V03_SESSION_START_BACKLOG}`
    : null
  check('data_rows_session_start_backlog', ok, detail, { knownFailure: reason })
}

/**
 * data_rows_reset_frame_loss and data_rows_overwritten_between_frames: the renderer lost no sample
 * of the counted ranges (both data-row checks' samples) with this loss's signature (rendererLosses).
 * Each fails only on such samples, and then as a known failure in every rendering mode; its line
 * gives the count and every sample number. A sample without a position_update but without either
 * signature is no_position_update, an ordinary failure of the data-row check of its range
 */
const RENDERER_LOSS_CHECKS = {
  reset_frame_loss: {
    name: 'data_rows_reset_frame_loss',
    known: KNOWN_V03_RESET_FRAME_LOSS,
    signature: "the first sample a frame could take after a reset (position_confirm, action 'set'), at most " +
      `${RESET_FRAME_MS} ms after it and with no update in between; one sample per reset at most`,
    window: (w) => `${w.sample}: ${w.after_set_ms} ms after a reset, between updates ${w.update_before ?? '-'} and ${w.update_after}`
  },
  overwritten_between_frames: {
    name: 'data_rows_overwritten_between_frames',
    known: KNOWN_V03_OVERWRITE,
    signature: `the next serial_data, a newer sample, arrived at most ${OVERWRITE_BURST_MS} ms later (one burst) and before the next update`,
    window: (w) => `${w.sample}: replaced by ${w.replaced_by} ${w.replaced_after_ms} ms later, before update ${w.update_after}`
  }
}

function rendererLossCheck (F, check, cls) {
  const spec = RENDERER_LOSS_CHECKS[cls]
  const c = F.data?.coverage
  const readable = rowsReadable(c)
  const lost = readable ? [...(c.session_start?.renderer_loss[cls] || []), ...c.session.renderer_loss[cls]] : []
  const ok = readable && lost.length === 0
  const samples = lost.map(w => w.sample)
  const detail = !c
    ? { data_files: F.data_files }
    : {
        samples_lost: lost.length,
        samples: spans(samples),
        signature: spec.signature,
        windows: lost.slice(0, EXAMPLES),
        resets_received: F.ws.resets_in,
        serial_data_in: F.ws.serial_data_in,
        position_update_out: F.ws.position_update_out,
        counted_from_sample: c.session_start ? 1 : c.session?.first_sample ?? null,
        counted_to_sample: c.last_sample,
        unmapped_timestamps: c.unmapped_timestamps
      }
  const shown = lost.slice(0, EXAMPLES).map(spec.window).join('; ') + (lost.length > EXAMPLES ? '; ...' : '')
  const reason = !ok && readable && lost.length
    ? `${plural(lost.length, 'sample')} (${spans(samples)}) without a position_update or a row, ` +
      `${lost.length === 1 ? '' : 'each '}with this loss's signature (${shown}): ${spec.known}`
    : null
  check(spec.name, ok, detail, { knownFailure: reason })
}

// The five data-row checks of a session
function dataRowChecks (F, check, opts) {
  sessionStartCheck(F, check)
  dataRowsCheck(F, check, opts)
  for (const cls of RENDERER_LOSS_CLASSES) rendererLossCheck(F, check, cls)
  rowsFromUpdatesCheck(F, check, opts)
}

function harnessChecks (F, check, { expectFinished = true } = {}) {
  const s = F.summary
  if (expectFinished) {
    check('harness_finished', s.result?.finished === true && !s.result?.harness_timeout && !s.result?.fatal &&
      F.runner.electron_exit?.code === 0 && !F.runner.electron_killed_by_runner,
    { result: s.result, electron_exit: F.runner.electron_exit, killed_by_runner: F.runner.electron_killed_by_runner })
  }
  // The harness builds the scene window from its own copy of createSceneWindow (route, display
  // choice, web preferences, load order). These flags record that electron/main.js still does what
  // the copy does; a change there must be mirrored in harness/main.cjs
  const sw = s.main_js?.scene_window
  check('harness_matches_main_js', !!sw && Object.keys(sw).length > 0 && Object.values(sw).every(v => v === true),
    { scene_window: sw ?? null, not_matching: sw ? Object.keys(sw).filter(k => sw[k] !== true) : null, main_js: s.main_js?.file ?? null })
  const spawn = s.backend?.spawn
  check('backend_started_detached_pythonw', s.backend?.ready === true && /pythonw\.exe$/i.test(spawn?.command || '') &&
    spawn?.detached === true && spawn?.stdio?.[0] === 'pipe' && Object.values(spawn?.extra_env_in_spawn || {}).every(Boolean),
  { ready: s.backend?.ready, start_error: s.backend?.start_error, command: spawn && path.basename(spawn.command), detached: spawn?.detached, stdin: spawn?.stdio?.[0], env: spawn?.extra_env_in_spawn })
}

function simActiveCheck (F, check, serialMode) {
  const interp = F.proc.interpreter
  const act = F.sim.activations
  check('sim_active_in_backend', act.length === 1 && (!interp || act[0].pid === interp.pid) &&
    act[0].serial_mode === serialMode && F.sim.patched.includes('serial') && !F.sim.error_log,
  { activations: act, interpreter_pid: interp?.pid, patched: F.sim.patched, sim_error_log: F.sim.error_log })
}

function windowAndProcessChecks (F, check) {
  const mon = F.monitor
  check('no_visible_window', !!mon && mon.visible_windows_of_tree.length === 0 && !F.summary.window?.shown,
    mon ? { visible_windows_of_tree: mon.visible_windows_of_tree, shown: !!F.summary.window?.shown } : 'no monitor.json')
  const before = new Set(F.runner.probe_before || [])
  const newProbe = (F.runner.probe_during || []).filter(l => !before.has(l))
  check('no_console_window', !!mon && mon.new_console_windows.length === 0 && newProbe.length === 0 && F.runner.probe_during !== undefined,
    { monitor_new_console_windows: mon?.new_console_windows, probe_new: newProbe, probed: F.runner.probe_during !== undefined })
  check('nothing_left_running', !!mon && F.proc.leftovers.length === 0 && F.proc.not_exited.length === 0 &&
    F.proc.killed_by_monitor.length === 0 && !F.runner.monitor_killed_by_runner && !F.runner.electron_killed_by_runner,
  { leftovers: F.proc.leftovers, not_exited: F.proc.not_exited, killed_by_monitor: F.proc.killed_by_monitor, tracked: F.proc.procs.length })
}

function gracefulQuitCheck (F, check) {
  const ev = F.quit.events
  const backendExit = ev.indexOf('backend-exit')
  const willQuit = ev.indexOf('will-quit')
  check('graceful_quit', F.log.shutdown_requested.length > 0 && F.log.cleanup_complete.length > 0 &&
    backendExit >= 0 && willQuit > backendExit && !F.quit.stop_timeout_fired && F.log.watchdog === 0 &&
    F.summary.backend?.exit?.code === 0,
  { quit_ms: F.quit.duration_ms, events: ev, shutdown_requested: F.log.shutdown_requested.length, cleanup_complete: F.log.cleanup_complete.length, stop_timeout_fired: F.quit.stop_timeout_fired, backend_exit: F.summary.backend?.exit, watchdog: F.log.watchdog })
}

// pulses: 'some' (rewards expected), 'none' (no reward may happen) or 'any'
function outputsSafeCheck (F, check, { pulses }) {
  const tasks = F.daq.tasks
  const n = F.daq.pulses.length
  const ok = F.daq.pulses.every(p => p.off === 0) &&
    tasks.every(t => t.closed && (t.writes === 0 || t.last === 0) && (t.value_at_close === 0 || t.value_at_close === null) && !t.errors.length) &&
    (pulses === 'some' ? n > 0 : pulses === 'none' ? n === 0 : true)
  check('pulses_end_at_0V_and_daq_closed', ok, { pulses: n, expected: pulses, widths_ms: F.daq.pulse_widths_ms, offs: [...new Set(F.daq.pulses.map(p => p.off))], tasks })
}

function serialClosedCheck (F, check) {
  check('serial_port_closed', F.serial.open > 0 && F.serial.close === F.serial.open && F.serial.stream_stop.length > 0,
    { open: F.serial.open, close: F.serial.close, stream_stop: F.serial.stream_stop })
}

function dataFileCheck (F, check, maxSamplesShort) {
  const d = F.data
  check('data_file_complete', F.data_files.length === 1 && d && d.rows > 0 && d.bad_rows === 0 && d.ends_with_crlf &&
    d.lf_only === 0 && d.ts_non_decreasing && d.samples_after_last_row !== null && d.samples_after_last_row >= 0 &&
    d.samples_after_last_row <= maxSamplesShort,
  d ? { file: d.file, rows: d.rows, bad_rows: d.bad_rows, bad_examples: d.bad_examples, ends_with_crlf: d.ends_with_crlf, lf_only: d.lf_only, samples_after_last_row: d.samples_after_last_row, max: maxSamplesShort } : { data_files: F.data_files })
}

/**
 * Pair rewards with trials in log order: each trial end must be followed by its reward before the
 * next trial end. Only the final trial may lack one, and only if it ended less than 1 s before the
 * quit (the stop cancelled its pulse). A reward with no trial end before it, or a second reward for
 * one trial, is stray.
 */
export function pairTrialsAndRewards (F) {
  const events = [...F.log.trial_end.map(t => ({ kind: 'trial', ...t })), ...F.log.rewards.map(r => ({ kind: 'reward', ...r }))]
    .sort((a, b) => a.line - b.line)
  const trials = []
  const stray = []
  for (const e of events) {
    if (e.kind === 'trial') trials.push({ trial: trials.length + 1, end_ms: e.ms, reward_ms: null })
    else if (trials.length && trials[trials.length - 1].reward_ms === null) trials[trials.length - 1].reward_ms = e.ms
    else stray.push(e.ms)
  }
  const unrewarded = trials.filter(t => t.reward_ms === null)
  const last = trials[trials.length - 1]
  const quitMs = F.quit.requested_ms
  const lastCutByQuit = unrewarded.length === 1 && unrewarded[0] === last && quitMs !== null && last.end_ms >= quitMs - 1000
  return { trials, stray, unrewarded: unrewarded.map(t => t.trial), lastCutByQuit, ok: stray.length === 0 && (unrewarded.length === 0 || lastCutByQuit) }
}

/** S1: a session against the simulated Teensy (also used for the close-window quit path) */
export function checkSessionOk (F, { minTrials = 1, softwareGl = false } = {}) {
  const { list, check } = makeChecks()
  harnessChecks(F, check)
  simActiveCheck(F, check, 'ok')
  check('registration_ok', F.ws.registered_in.length === 1 && F.ws.start_out.length === 1 &&
    F.ws.start_out[0] >= F.ws.registered_in[0] && F.ws.errors_in.length === 0 && !F.page.error_overlay,
  { registered_ms: F.ws.registered_in, start_ms: F.ws.start_out, errors: F.ws.errors_in, overlay: F.page.error_overlay })
  // A shot taken right at the end of a trial shows little but the plain end wall and looks "blank";
  // so: every shot was captured, and at least one shows the textured hallway
  check('scene_rendered', F.render.component === 'PythonCustomScene' && F.render.shots.length >= 2 &&
    F.render.shots.every(x => !x.error && x.std !== null) && F.render.shots.some(x => x.blank === false) &&
    F.render.paints_per_s_median > 0,
  { component: F.render.component, shots: F.render.shots, paints_per_s_median: F.render.paints_per_s_median, webgl: F.render.webgl })
  // The renderer sends one position_update per frame that consumed a sample (frames drive the data,
  // ADR-0003), so the ratio falls with the frame rate: 0.5 still passes at about 10 frames/s
  const sr = F.serial
  check('closed_loop_runs', sr.sent > 0 && sr.sent_contiguous && sr.read_contiguous && sr.dropped === 0 &&
    sr.rate_hz >= 19 && sr.rate_hz <= 21 && F.ws.serial_data_in >= 50 && F.ws.serial_seq_gaps === 0 &&
    F.ws.position_update_out >= 0.5 * F.ws.serial_data_in && F.ws.max_abs_z > 10,
  { sent: sr.sent, read: sr.read, rate_hz: sr.rate_hz, dropped: sr.dropped, serial_data_in: F.ws.serial_data_in, seq_gaps: F.ws.serial_seq_gaps, position_update_out: F.ws.position_update_out, update_ratio: round(F.ws.position_update_out / Math.max(1, F.ws.serial_data_in), 3), max_abs_z: F.ws.max_abs_z })

  // Trials, rewards (log), pulses (DAQ) and trial-end rows (data file) must agree, each reward after
  // its own trial end. The one allowed difference: the final trial, if it ended less than 1 s before
  // the quit, may have lost its reward to the stop (its pulse, if started, still ends at 0 V)
  const trials = F.log.trial_end.length
  const rewards = F.log.rewards.length
  const pulses = F.daq.pulses.length
  const pairing = pairTrialsAndRewards(F)
  const cutByQuit = pairing.lastCutByQuit
  const trialsOk = trials >= minTrials && pairing.ok &&
    (pulses === rewards || (cutByQuit && pulses === rewards + 1)) && F.data?.trial_end_rows === trials
  const unexplained = pairing.unrewarded.length - (cutByQuit ? 1 : 0)
  check('trials_and_rewards_match', trialsOk,
    {
      trials, rewards, pulses, data_trial_end_rows: F.data?.trial_end_rows, min_trials: minTrials,
      unrewarded_trials: pairing.unrewarded, stray_rewards_ms: pairing.stray, last_trial_cut_by_quit: cutByQuit,
      trial_end_and_reward_ms: pairing.trials.map(t => [t.end_ms, t.reward_ms]), quit_requested_ms: F.quit.requested_ms,
      trial_times_s: F.log.rewards.map(r => r.trial_time_s),
      ...(unexplained > 0 && trials - (F.data?.trial_end_rows ?? trials) === unexplained
        ? { note: 'each unrewarded trial also lacks its trial-end row: the trial-end update was skipped as a duplicate, the known v0.3 defect (README, Known limits)' }
        : {})
    })
  outputsSafeCheck(F, check, { pulses: minTrials > 0 ? 'some' : 'any' })
  serialClosedCheck(F, check)
  dataFileCheck(F, check, 3)
  dataRowChecks(F, check, { softwareGl })
  check('data_file_closed_by_backend', F.log.data_closed === 1 && F.log.serial_closed === 1 && F.log.daq_closed === 1,
    { data_file_closed: F.log.data_closed, serial_port_closed: F.log.serial_closed, daq_task_closed: F.log.daq_closed })
  const sc = F.sidecar
  check('renderer_status_sidecar', !!sc && sc.lines >= 1 && sc.bad_lines === 0 && sc.lines <= F.ws.renderer_status_out,
    sc ? { ...sc, renderer_status_sent: F.ws.renderer_status_out } : { sidecars: F.sidecars, renderer_status_sent: F.ws.renderer_status_out })
  gracefulQuitCheck(F, check)
  const r = F.summary.renderer || {}
  check('no_errors_or_tracebacks', F.log.tracebacks === 0 && F.log.errors.length === 0 && r.error_count === 0 &&
    !r.gone && !(r.failed_loads || []).length && !(r.network_errors || []).length && !(r.preload_errors || []).length &&
    !(F.summary.main_process?.console_errors || []).length && !(F.summary.main_process?.uncaught || []).length,
  { tracebacks: F.log.tracebacks, backend_errors: F.log.errors, renderer_errors: r.errors, network_errors: r.network_errors, main_errors: F.summary.main_process })
  windowAndProcessChecks(F, check)
  return list
}

/** S2: the Teensy's COM port does not exist */
export function checkSessionMissingTeensy (F) {
  const { list, check } = makeChecks()
  const COM = /could not open port 'COM3'/
  harnessChecks(F, check)
  simActiveCheck(F, check, 'missing')
  check('serial_open_failed', F.serial.open === 0 && F.serial.open_failed.length >= 1 && F.serial.open_failed.every(f => f.mode === 'missing'),
    { open: F.serial.open, open_failed: F.serial.open_failed })
  check('registration_failed_with_port_error', F.log.register_error.length >= 1 && F.log.register_error.every(e => COM.test(e)),
    { register_error: F.log.register_error })
  check('error_overlay_shown', /Failed to load experiment/.test(F.page.error_overlay || '') && COM.test(F.page.error_overlay || ''),
    { error_overlay: F.page.error_overlay, info_panel: F.page.info_panel })
  check('no_experiment_start', F.ws.start_out.length === 0 && F.log.experiment_started === 0,
    { experiment_start_sent: F.ws.start_out.length, backend_experiment_started: F.log.experiment_started })
  outputsSafeCheck(F, check, { pulses: 'none' })
  check('no_data_rows', !F.data || F.data.rows === 0, { data_files: F.data_files, rows: F.data?.rows })
  const r = F.summary.renderer || {}
  check('only_the_expected_errors', (r.errors || []).length >= 1 && (r.errors || []).every(e => /Failed to register experiment/.test(e.message) && COM.test(e.message)) &&
    F.log.errors.every(e => COM.test(e)) && F.log.tracebacks <= 1 && !r.gone && !(r.network_errors || []).length &&
    !(F.summary.main_process?.uncaught || []).length,
  { renderer_errors: (r.errors || []).map(e => e.message), backend_errors: F.log.errors, tracebacks: F.log.tracebacks })
  check('graceful_quit', F.log.shutdown_requested.length > 0 && F.quit.events.indexOf('backend-exit') >= 0 &&
    F.quit.events.indexOf('will-quit') > F.quit.events.indexOf('backend-exit') && !F.quit.stop_timeout_fired &&
    F.summary.backend?.exit?.code === 0,
  { quit_ms: F.quit.duration_ms, events: F.quit.events, backend_exit: F.summary.backend?.exit })
  windowAndProcessChecks(F, check)
  return list
}

/** crash: Electron's main process is killed mid-session; the detached backend must clean up by itself */
export function checkSessionCrash (F, { softwareGl = false } = {}) {
  const { list, check } = makeChecks()
  harnessChecks(F, check, { expectFinished: false })
  simActiveCheck(F, check, 'ok')
  check('electron_was_killed', F.runner.crashed_at_s !== undefined && F.proc.root && F.proc.root.exit_time !== null && F.summary.result?.finished !== true,
    { crashed_at_s: F.runner.crashed_at_s, electron_exit: F.runner.electron_exit })
  const interp = F.proc.interpreter
  check('backend_cleaned_up_by_itself', !!interp && interp.exit_code === 0 && !interp.terminated_by_monitor &&
    F.proc.interpreter_exit_after_electron_s !== null && F.proc.interpreter_exit_after_electron_s >= 0 &&
    F.proc.interpreter_exit_after_electron_s <= 3,
  { backend: F.proc.backend, interpreter_exit_after_electron_s: F.proc.interpreter_exit_after_electron_s })
  outputsSafeCheck(F, check, { pulses: 'any' })
  serialClosedCheck(F, check)
  // Rows are written per position_update, which stop with the renderer, while the backend still reads
  // samples until the broken pipe is noticed (0.2 s poll) and the port is closed
  dataFileCheck(F, check, 10)
  dataRowChecks(F, check, { softwareGl, afterCrash: true })
  windowAndProcessChecks(F, check)
  return list
}

/** t35: opening the port blocks 35 s, so registration outlasts the renderer's 30 s timeout */
export function checkSessionRegisterTimeout (F) {
  const { list, check } = makeChecks()
  harnessChecks(F, check)
  simActiveCheck(F, check, 'ok')
  check('timeout_overlay_shown', /Request timeout: experiment_register/.test(F.page.error_overlay || ''),
    { error_overlay: F.page.error_overlay })
  const reg = F.ws.registered_in[0]
  const stop = F.ws.stop_out[0]
  check('late_experiment_stopped', reg !== undefined && reg - (F.summary.window?.load_started_ms || 0) >= 30000 &&
    stop !== undefined && stop >= reg && F.ws.start_out.length === 0,
  { registered_ms: F.ws.registered_in, stop_sent_ms: F.ws.stop_out, start_sent: F.ws.start_out.length, scene_load_ms: F.summary.window?.load_started_ms })
  check('released_before_quit', F.log.cleanup_complete.length > 0 && F.quit.requested_ms !== null &&
    F.log.cleanup_complete[0] < F.quit.requested_ms && F.log.serial_closed === 1 && F.log.daq_closed === 1 && F.log.data_closed === 1,
  { cleanup_complete_ms: F.log.cleanup_complete, quit_requested_ms: F.quit.requested_ms, serial_closed: F.log.serial_closed, daq_closed: F.log.daq_closed, data_closed: F.log.data_closed })
  outputsSafeCheck(F, check, { pulses: 'none' })
  serialClosedCheck(F, check)
  const r = F.summary.renderer || {}
  check('only_the_expected_errors', (r.errors || []).every(e => /Request timeout: experiment_register/.test(e.message)) &&
    F.log.errors.length === 0 && F.log.tracebacks === 0 && !r.gone && !(r.network_errors || []).length,
  { renderer_errors: (r.errors || []).map(e => e.message), backend_errors: F.log.errors, tracebacks: F.log.tracebacks })
  gracefulQuitCheck(F, check)
  windowAndProcessChecks(F, check)
  return list
}

/** One-line facts for the console report */
export function sessionFacts (F) {
  const parts = []
  if (F.summary.window?.scene_s) parts.push(`scene ${F.summary.window.scene_s} s`)
  if (F.render.paints_per_s_median !== null) parts.push(`${F.render.paints_per_s_median} frames/s`)
  if (F.render.webgl) parts.push(`WebGL ${F.render.webgl}`)
  parts.push(`serial ${F.serial.sent} sent/${F.serial.read} read`)
  if (F.ws.registered_in.length) parts.push(`registered at ${(F.ws.registered_in[0] / 1000).toFixed(1)} s`)
  parts.push(`trials ${F.log.trial_end.length}, rewards ${F.log.rewards.length}, pulses ${F.daq.pulses.length}${F.daq.pulses.length ? ` (${F.daq.pulse_widths_ms.join('/')} ms)` : ''}`)
  if (F.data) {
    const c = F.data.coverage
    const b = c?.session_start
    const m = c?.session
    const startClasses = b
      ? [...(b.backlog_samples ? [`${b.backlog_samples} session-start backlog`] : []),
          ...MISSING_SAMPLE_CLASSES.filter(k => b.without_row[k]).map(k => `${b.without_row[k]} ${k}`)]
      : []
    const startPart = b ? `; before experiment_start: ${b.samples_without_row} of ${b.samples} samples without a row` +
      (startClasses.length ? ` (${startClasses.join(', ')})` : '') +
      (b.samples_with_several_rows ? `, ${b.samples_with_several_rows} with several rows` : '') : ''
    const classes = m ? MISSING_SAMPLE_CLASSES.filter(k => m.without_row[k]).map(k => `${m.without_row[k]} ${k}`) : []
    const sessionPart = m && m.samples
      ? `; from sample ${m.first_sample}: ${m.samples_without_row} of ${m.samples} samples without a row` +
        (classes.length ? ` (${classes.join(', ')})` : '') +
        (m.samples_with_several_rows ? `, ${m.samples_with_several_rows} with several rows` : '')
      : ''
    const orphanPart = c?.rows_without_update ? `; ${plural(c.rows_without_update, 'row')} without a position_update in ws.jsonl` : ''
    parts.push(`data ${F.data.rows} rows (${F.data.samples_after_last_row} samples short${startPart}${sessionPart}${orphanPart})`)
  }
  if (F.sidecar) parts.push(`sidecar ${F.sidecar.lines} lines`)
  if (F.quit.duration_ms !== null) parts.push(`quit ${F.quit.duration_ms} ms`)
  if (F.proc.interpreter_exit_after_electron_s !== null) parts.push(`backend exit ${F.proc.interpreter_exit_after_electron_s} s after Electron`)
  if (F.page.error_overlay) parts.push(`overlay "${F.page.error_overlay.slice(0, 90)}"`)
  return parts.join('; ')
}

// ---------------------------------------------------------------- lifecycle
export function analyzeLifecycle (dir) {
  const mon = readJson(path.join(dir, 'monitor.json'), null)
  const runner = readJson(path.join(dir, 'runner.json'), {})
  const log = readText(path.join(dir, 'lifecycle.log')).split(/\r?\n/).filter(Boolean)
  const marker = readText(path.join(dir, 'marker.txt')).split(/\r?\n/).filter(Boolean).map(l => l.replace(/^\S+ pid=\d+ /, ''))
  const at = (re) => log.findIndex(l => re.test(l))
  const msOf = (re) => { const l = log.find(x => re.test(x)); const m = l && /\+(\d+)ms\]/.exec(l); return m ? Number(m[1]) : null }
  return {
    dir, monitor: mon, runner, log, marker, proc: processFacts(mon),
    idx: {
      launch: at(/launch pythonw\.exe detached=true/),
      quit1: at(/app\.quit\(\) #1/),
      quit2: at(/app\.quit\(\) #2/),
      childExit0: at(/child exit 0 /),
      willQuit: at(/will-quit/),
      killTimeout: at(/did not exit in time; killing it/)
    },
    willQuitCount: log.filter(l => /will-quit/.test(l)).length,
    quit1Ms: msOf(/app\.quit\(\) #1/),
    willQuitMs: msOf(/will-quit/),
    terminateBegin: marker.filter(l => l === 'terminate begin').length,
    terminateEnd: marker.filter(l => l === 'terminate end').length,
    mainReturned: marker.includes('main returned'),
    startedPythonw: marker.some(l => /^started exe=pythonw\.exe/.test(l))
  }
}

export function checkLifecycle (name, L) {
  const { list, check } = makeChecks()
  const i = L.idx
  const p = L.proc
  const interp = p.interpreter
  const launcher = p.launcher
  check('backend_launched_detached_pythonw', i.launch >= 0 && L.startedPythonw, { launch_line: L.log[i.launch], marker: L.marker[0] })
  if (name === 'quit' || name === 'double') {
    check('graceful_stop', L.terminateBegin === 1 && L.terminateEnd === 1 && L.mainReturned && i.killTimeout < 0, { marker: L.marker })
    check('backend_exited_before_electron', i.childExit0 >= 0 && i.willQuit > i.childExit0 && L.willQuitCount === 1 &&
      !!interp && interp.exit_code === 0 && p.interpreter_exit_after_electron_s !== null && p.interpreter_exit_after_electron_s <= 0,
    { log: L.log, backend: p.backend })
    if (name === 'double') {
      check('second_quit_deferred', i.quit2 >= 0 && i.quit2 < i.childExit0 && i.willQuit > i.childExit0 && L.willQuitCount === 1 && L.terminateBegin === 1,
        { log: L.log, terminate_begin: L.terminateBegin })
    }
  } else if (name === 'crash') {
    check('backend_cleaned_up_after_crash', L.terminateBegin === 1 && L.terminateEnd === 1 && L.mainReturned &&
      !!interp && interp.exit_code === 0 && !interp.terminated_by_monitor &&
      p.interpreter_exit_after_electron_s !== null && p.interpreter_exit_after_electron_s >= 0 && p.interpreter_exit_after_electron_s <= 3,
    { marker: L.marker, backend: p.backend })
  } else if (name === 'crash_hang') {
    // The pipe breaks with Electron; the watchdog ends the process SHUTDOWN_DEADLINE_S (10 s) later
    check('watchdog_ended_backend', L.terminateBegin === 1 && L.terminateEnd === 0 && !L.mainReturned &&
      !!interp && interp.exit_code === 1 && !interp.terminated_by_monitor &&
      p.interpreter_exit_after_electron_s !== null && p.interpreter_exit_after_electron_s >= 9 && p.interpreter_exit_after_electron_s <= 13,
    { marker: L.marker, backend: p.backend })
  } else if (name === 'quit_hang') {
    // stopPythonBackend's 4 s timeout kills the backend (the venv launcher; the interpreter dies with it)
    const quitToWillQuit = L.quit1Ms !== null && L.willQuitMs !== null ? L.willQuitMs - L.quit1Ms : null
    check('kill_path', i.killTimeout >= 0 && i.willQuit > i.killTimeout && quitToWillQuit >= 3900 && quitToWillQuit <= 6000 &&
      L.terminateBegin === 1 && L.terminateEnd === 0 && !!launcher && launcher.exit_code === 1 && !launcher.terminated_by_monitor &&
      !!interp && !interp.terminated_by_monitor && p.interpreter_exit_after_electron_s !== null && p.interpreter_exit_after_electron_s <= 1,
    { quit_to_will_quit_ms: quitToWillQuit, marker: L.marker, backend: p.backend, log: L.log })
  }
  const mon = L.monitor
  check('no_visible_or_console_window', !!mon && mon.visible_windows_of_tree.length === 0 && mon.new_console_windows.length === 0,
    mon ? { visible: mon.visible_windows_of_tree, new_consoles: mon.new_console_windows } : 'no monitor.json')
  check('nothing_left_running', !!mon && p.leftovers.length === 0 && p.not_exited.length === 0 && p.killed_by_monitor.length === 0 &&
    !L.runner.electron_killed_by_runner && !L.runner.monitor_killed_by_runner,
  { leftovers: p.leftovers, not_exited: p.not_exited, killed_by_monitor: p.killed_by_monitor, tracked: p.procs.length })
  return list
}

export function lifecycleFacts (L) {
  const b = L.proc.backend.map(x => `${x.role} exit ${x.exit_code} at ${x.exit_after_electron_s ?? '?'} s`).join(', ')
  return `electron exit ${L.proc.electron_exit_code}; backend ${b || 'not seen'}; marker: ${L.marker.join(' | ')}`
}
