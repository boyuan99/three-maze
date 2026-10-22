// The stall suite (ADR-0003 Validation 5; plan item REN-16): the scene drawn by a main-thread
// requestAnimationFrame loop and by an OffscreenCanvas worker loop, while the page's main thread is
// blocked by a busy-wait of 50 or 100 ms once a second; missed frames counted by the gate's rules.
// Runs by hand, like the e2e bench (Windows; it needs the Electron binary and a GPU, or SwiftShader).
//
//   npm run test:stall                                    50 and 100 ms x main and worker, 3 runs each
//   node --experimental-strip-types test/perf/stall/run.mjs [--stalls 50,100] [--modes main,worker]
//        [--repeats 3] [--seconds 20] [--every 1000] [--warm 60] [--window offscreen|visible]
//        [--osr-hz 60] [--gpu high|low|default] [--software-gl] [--out DIR] [--no-wait] [--lock-wait S]
//
// Each run is one Electron process (main.cjs) with a fresh profile; the conditions take turns
// (repeat 1: 50 main, 50 worker, 100 main, 100 worker; then repeat 2, ...), so that a change of the
// machine's state during the suite spreads over all of them. It holds the bench lock exclusively
// (test/e2e/lib/benchLock.mjs, DPR-27) and records the machine's load before each run and the CPU
// load during it (tools/timing/machine-load.mjs). Counting is tools/timing/gateCounting.ts, the
// gate's own code: P is the median rAF interval, an interval over 1.5 P is late and counts
// round(interval / P) - 1 missed frames, on rAF timestamps (low estimate) and callback entry times
// (high estimate). Each run is labelled vsync-locked or fallback clock (README.md).
//
// Output (a new temporary folder unless --out): one <stall>ms-<mode>-<repeat>.json per run, with the
// raw frame times, and summary.json, both free of local paths and command lines so that they can be
// kept with the repository; machine-load/ with the full snapshots; a table on the console.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeSession } from '../../../tools/timing/gateCounting.ts'
import { machineLoad, describeLoad, startCpuSampler } from '../../../tools/timing/machine-load.mjs'
import { acquireBenchLock, BenchBusyError } from '../../e2e/lib/benchLock.mjs'
import { childEnv, electronPath, startLogged, stopAll, stopTree, waitExit } from '../../e2e/lib/proc.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SCHEMA = 'three-maze/stall-run@1'
export const NOMINAL_HZ = 60

function parseArgs (argv) {
  const a = {
    stalls: [50, 100], modes: ['main', 'worker'], repeats: 3, seconds: 20, every: 1000, warm: 60,
    window: 'offscreen', osrHz: 60, gpu: 'high', softwareGl: false, out: null, noWait: false, lockWait: 3600
  }
  const list = (value) => value.split(',').map(s => s.trim()).filter(Boolean)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === '--stalls') a.stalls = list(next()).map(Number)
    else if (arg === '--modes') a.modes = list(next())
    else if (arg === '--repeats') a.repeats = Number(next())
    else if (arg === '--seconds') a.seconds = Number(next())
    else if (arg === '--every') a.every = Number(next())
    else if (arg === '--warm') a.warm = Number(next())
    else if (arg === '--window') a.window = next()
    else if (arg === '--osr-hz') a.osrHz = Number(next())
    else if (arg === '--gpu') a.gpu = next()
    else if (arg === '--software-gl') a.softwareGl = true
    else if (arg === '--out') a.out = next()
    else if (arg === '--no-wait') a.noWait = true
    else if (arg === '--lock-wait') a.lockWait = Number(next())
    else fail(`unknown argument ${arg}`)
  }
  if (!a.stalls.length || !a.stalls.every(s => Number.isFinite(s) && s >= 0)) fail('--stalls: milliseconds, 0 or more')
  if (!a.modes.length || !a.modes.every(m => m === 'main' || m === 'worker')) fail('--modes: main, worker')
  if (!(Number.isInteger(a.repeats) && a.repeats >= 1)) fail('--repeats: a whole number, 1 or more')
  if (!(a.seconds > 0 && a.every > 0 && Number.isInteger(a.warm) && a.warm >= 1)) fail('--seconds and --every > 0, --warm >= 1')
  if (!['offscreen', 'visible'].includes(a.window)) fail('--window: offscreen or visible')
  if (!['high', 'low', 'default'].includes(a.gpu)) fail('--gpu: high, low or default')
  return a
}

function fail (message) {
  console.error(`stall suite: ${message}`)
  stopAll()
  process.exit(2)
}

const round = (value, digits = 3) => (Number.isFinite(value) ? +value.toFixed(digits) : null)

/** n, mean and the 50th, 95th and 99th percentiles and maximum (nearest rank), as Evidence 1 reported them */
export function stats (values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y)
  if (!a.length) return null
  const q = p => a[Math.min(a.length - 1, Math.round(p * (a.length - 1)))]
  return { n: a.length, mean: round(a.reduce((s, x) => s + x, 0) / a.length), p50: round(q(0.5)), p95: round(q(0.95)), p99: round(q(0.99)), max: round(a[a.length - 1]) }
}

/**
 * The counts of one run: the frames after the warm-up (and the last warm-up frame, so that the
 * first counted interval is there), through the gate's summarizeSession.
 */
export function countRun (raw, warm) {
  const first = warm - 1
  const frames = []
  for (let i = first; i < raw.raf.length; i++) {
    frames.push({ frame: i - first, rafMs: raw.raf[i], entryMs: raw.entry[i], exitMs: raw.exit[i] })
  }
  const s = summarizeSession({ id: 'stall-run', frames, tasks: null })
  const series = (c) => ({
    intervals: c.intervals, late: c.late, missed: c.missed, expected: c.expected,
    missedPct: round((100 * c.missed) / c.expected), maxIntervalMs: round(c.maxIntervalMs, 2)
  })
  const intervals = (times) => times.slice(1).map((t, i) => t - times[i])
  const counted = frames.map(f => f.rafMs)
  const rafIntervals = intervals(counted)
  const sorted = [...rafIntervals].sort((x, y) => x - y)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return {
    frames: frames.length,
    durationS: round(s.durationS),
    periodMs: round(s.periodMs),
    hz: round(s.hz, 2),
    /** 95th minus 5th percentile of the rAF intervals (ADR-0003 1d's spread) */
    spreadMs: round(pct(0.95) - pct(0.05)),
    netDeficit: round(s.netDeficit, 1),
    raf: series(s.low),
    entry: series(s.high),
    callbackOverruns: s.renderCallbackOverruns.length,
    rafIntervalMs: stats(rafIntervals),
    entryIntervalMs: stats(intervals(frames.map(f => f.entryMs))),
    callbackMs: stats(frames.map(f => f.exitMs - f.entryMs))
  }
}

/**
 * vsync-locked: the median frame rate is within 1 % (at least 1 Hz; Electron reports whole hertz)
 * of the refresh rate of the window's display (ADR-0003 1d). An offscreen window's frames follow
 * Electron's frame timer, not a display: always a fallback clock.
 */
export function clockLabel ({ window, osrHz, hz, display }) {
  if (window === 'offscreen') {
    return { label: 'fallback clock', source: `offscreen frame timer at ${osrHz} Hz`, medianHz: hz, displayHz: display?.displayFrequency ?? null }
  }
  const displayHz = display?.displayFrequency
  if (!(displayHz > 0)) return { label: 'fallback clock', source: 'display rate unknown', medianHz: hz, displayHz: null }
  const toleranceHz = Math.max(0.01 * displayHz, 1)
  const locked = Math.abs(hz - displayHz) <= toleranceHz
  return { label: locked ? 'vsync-locked' : 'fallback clock', source: locked ? 'display' : 'timer (median off the display rate)', medianHz: hz, displayHz, toleranceHz: round(toleranceHz, 2) }
}

/**
 * The counted frames' span on the page's clock: the worker's times are on the worker's clock, whose
 * origin differs (both origins are in the raw result).
 */
function countedSpanOnPageClock (raw, warm) {
  const shift = raw.mode === 'worker' ? raw.workerTimeOrigin - raw.timeOrigin : 0
  return [raw.raf[warm - 1] + shift, raw.exit[raw.exit.length - 1] + shift]
}

/** The injected stalls and the page's long tasks that started while the counted frames ran */
function mainThreadSummary (raw, warm) {
  const [from, to] = countedSpanOnPageClock(raw, warm)
  const inSpan = (start) => start >= from && start <= to
  const stalls = raw.stalls.filter(([start]) => inSpan(start))
  const tasks = raw.longTasks.filter(t => t.type === 'longtask' && inSpan(t.startMs))
  const frames = raw.longTasks.filter(t => t.type === 'long-animation-frame' && inSpan(t.startMs))
  return {
    stalls: { injected: stalls.length, durationMs: stats(stalls.map(([a, b]) => b - a)) },
    tasks: {
      longTasks: tasks.length,
      longTaskMs: stats(tasks.map(t => t.durationMs)),
      longAnimationFrames: frames.length,
      longAnimationFrameMs: stats(frames.map(t => t.durationMs))
    }
  }
}

/**
 * A machine-load snapshot fit to be kept with the repository, which is published: without the
 * computer's name, without the names of the busiest programs (their CPU and memory use stay; they
 * are whatever else the computer runs, personal applications among them), and without the other
 * three-maze processes' command lines (their names stay), which hold local paths and other tools'
 * arguments. The full snapshots go to machine-load/ in the output folder.
 */
export function condenseLoad (snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot
  const condensed = { ...snapshot }
  delete condensed.host
  if (Array.isArray(snapshot.top_processes?.list)) {
    condensed.top_processes = {
      ...snapshot.top_processes,
      list: snapshot.top_processes.list.map(({ cpu_pct: cpuPct, working_set_mb: workingSetMb }) => ({ cpu_pct: cpuPct, working_set_mb: workingSetMb }))
    }
  }
  if (Array.isArray(snapshot.three_maze_processes)) {
    condensed.three_maze_processes = snapshot.three_maze_processes.map(({ pid, ppid, name }) => ({ pid, ppid, name }))
  }
  return condensed
}

/** The bench lock's record without its folder and purpose (local paths and arguments) */
export function condenseLock (record) {
  const { id, mode, acquired, waited_s: waitedS, held_s: heldS, stale_removed: staleRemoved } = record
  return { id, mode, acquired, waited_s: waitedS, held_s: heldS, stale_removed: staleRemoved.length }
}

function saveLoad (outDir, name, snapshot) {
  fs.mkdirSync(path.join(outDir, 'machine-load'), { recursive: true })
  fs.writeFileSync(path.join(outDir, 'machine-load', `${name}.json`), JSON.stringify(snapshot, null, 2) + '\n')
}

async function runOne (args, condition, outDir, lock) {
  const name = `${condition.stallMs}ms-${condition.mode}-${condition.repeat}`
  const resultFile = path.join(outDir, `${name}.raw.json`)
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'three-maze-stall-profile-'))
  const loadBefore = await machineLoad()
  saveLoad(outDir, name, loadBefore)
  const sampler = startCpuSampler()
  const frames = Math.round(args.seconds * NOMINAL_HZ)
  const electron = startLogged(`electron ${name}`, electronPath(), [path.join(HERE, 'main.cjs')], {
    logFile: path.join(outDir, `${name}.electron.log`),
    env: childEnv({
      STALL_OUT: resultFile, STALL_MODE: condition.mode, STALL_MS: String(condition.stallMs), STALL_EVERY_MS: String(args.every),
      STALL_FRAMES: String(frames), STALL_WARM: String(args.warm), STALL_WINDOW: args.window, STALL_OSR_HZ: String(args.osrHz),
      STALL_GPU: args.gpu, STALL_SOFTWARE_GL: args.softwareGl ? '1' : '0', STALL_USER_DATA: userData,
      STALL_TIMEOUT_S: String(Math.ceil(args.seconds * 4 + 120))
    })
  })
  const timeoutMs = (args.seconds * 4 + 180) * 1000
  if (!(await waitExit(electron, timeoutMs))) {
    stopTree(electron)
    console.error(`stall suite: ${name}: Electron did not finish within ${timeoutMs / 1000} s; stopped it`)
  }
  const cpuDuring = sampler.stop()
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  } catch (error) {
    raw = { error: `no result file (${error.message}); see ${name}.electron.log` }
  }
  fs.rmSync(resultFile, { force: true })

  const record = {
    schema: SCHEMA,
    run: name,
    condition: { stallMs: condition.stallMs, everyMs: args.every, mode: condition.mode, repeat: condition.repeat },
    params: { seconds: args.seconds, frames, warm: args.warm, window: args.window, osrHz: args.window === 'offscreen' ? args.osrHz : null, gpu: args.gpu, softwareGl: args.softwareGl },
    error: raw.error ?? null,
    versions: raw.harness ? { electron: raw.harness.electron, chrome: raw.harness.chrome, node: raw.harness.node } : null,
    bench_lock: condenseLock(lock.record()),
    machine_load: { before: condenseLoad(loadBefore), cpu_during: cpuDuring }
  }
  if (raw.error && raw.harness) {
    // What the page logged, which tells why it gave no result
    record.consoleErrors = raw.harness.consoleMessages.filter(m => m.level === 'error')
  }
  if (!raw.error) {
    const counts = countRun(raw, args.warm)
    const display = raw.harness.window.display
    const mainThread = mainThreadSummary(raw, args.warm)
    Object.assign(record, {
      clock: clockLabel({ window: args.window, osrHz: args.osrHz, hz: counts.hz, display }),
      counts,
      // Both while the counted frames ran
      stalls: mainThread.stalls,
      mainThreadTasks: mainThread.tasks,
      gl: raw.gl,
      page: { before: raw.page, after: raw.pageAfter },
      window: raw.harness.window,
      displays: raw.harness.displays,
      primaryDisplayId: raw.harness.primaryDisplayId,
      gpuDevices: raw.harness.gpuDevices,
      gpuFeatureStatus: raw.harness.gpuFeatureStatus,
      preventDisplaySleep: raw.harness.preventDisplaySleep,
      renderProcessGone: raw.harness.renderProcessGone,
      consoleErrors: raw.harness.consoleMessages.filter(m => m.level === 'error'),
      // Raw times of every frame, warm-up included, ms from the first rAF timestamp (0.001 ms)
      raw: {
        clock: raw.mode === 'worker' ? 'worker' : 'page',
        timeOriginMs: raw.mode === 'worker' ? raw.workerTimeOrigin : raw.timeOrigin,
        t0Ms: raw.raf[0],
        raf: raw.raf.map(t => round(t - raw.raf[0])),
        entry: raw.entry.map(t => round(t - raw.raf[0])),
        exit: raw.exit.map(t => round(t - raw.raf[0]))
      }
    })
  }
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(record) + '\n')
  const log = path.join(outDir, `${name}.electron.log`)
  if (fs.existsSync(log) && !fs.readFileSync(log, 'utf8').trim()) fs.rmSync(log)
  return record
}

function line (r) {
  if (r.error) {
    const page = r.consoleErrors?.[0] ? `; page: ${String(r.consoleErrors[0].message).split('\n')[0]}` : ''
    return `${r.run.padEnd(16)} ERROR ${String(r.error).split('\n')[0]}${page}`
  }
  const c = r.counts
  return `${r.run.padEnd(16)} ${r.clock.label.padEnd(14)} ${String(c.hz).padStart(6)} Hz  late ${String(c.raf.late).padStart(3)}  ` +
    `missed ${String(c.raf.missed).padStart(4)} (${c.raf.missedPct.toFixed(3)} %) rAF, ${String(c.entry.missed).padStart(4)} ` +
    `(${c.entry.missedPct.toFixed(3)} %) entry  max ${c.raf.maxIntervalMs} / ${c.entry.maxIntervalMs} ms  ` +
    `stalls ${r.stalls.injected}  CPU ${r.machine_load.cpu_during.mean_busy_pct} %`
}

/** Per condition: the runs' values and their median, minimum and maximum */
export function summarize (records) {
  const groups = new Map()
  for (const r of records.filter(x => !x.error)) {
    const key = `${r.condition.stallMs}ms-${r.condition.mode}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const spread = (values) => {
    const s = [...values].sort((x, y) => x - y)
    return { values, median: s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, min: s[0], max: s[s.length - 1] }
  }
  return [...groups.entries()].map(([key, runs]) => ({
    condition: key,
    runs: runs.length,
    clocks: runs.map(r => r.clock.label),
    hz: spread(runs.map(r => r.counts.hz)),
    lateIntervals: spread(runs.map(r => r.counts.raf.late)),
    missedRaf: spread(runs.map(r => r.counts.raf.missed)),
    missedRafPct: spread(runs.map(r => r.counts.raf.missedPct)),
    missedEntry: spread(runs.map(r => r.counts.entry.missed)),
    missedEntryPct: spread(runs.map(r => r.counts.entry.missedPct)),
    maxRafIntervalMs: spread(runs.map(r => r.counts.raf.maxIntervalMs)),
    maxEntryIntervalMs: spread(runs.map(r => r.counts.entry.maxIntervalMs)),
    netDeficit: spread(runs.map(r => r.counts.netDeficit))
  }))
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  let lock
  try {
    lock = await acquireBenchLock({
      mode: 'exclusive', purpose: `test/perf/stall/run.mjs ${process.argv.slice(2).join(' ')}`.trim(),
      wait: !args.noWait, timeoutS: args.lockWait, log: message => console.error(`stall suite: ${message}`)
    })
  } catch (error) {
    if (error instanceof BenchBusyError) fail(error.message)
    throw error
  }
  let electron
  try { electron = electronPath() } catch (error) { fail(`Electron is not installed (npm ci, then npx --no install-electron): ${error.message}`) }
  if (!fs.existsSync(electron)) fail(`Electron executable not found: ${electron}`)

  const outDir = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'three-maze-stall-'))
  fs.mkdirSync(outDir, { recursive: true })
  const conditions = []
  for (let repeat = 1; repeat <= args.repeats; repeat++) {
    for (const stallMs of args.stalls) for (const mode of args.modes) conditions.push({ stallMs, mode, repeat })
  }
  console.log(`stall suite: ${conditions.length} runs (${args.stalls.join(', ')} ms x ${args.modes.join(', ')} x ${args.repeats}), ` +
    `${args.seconds} s each, window ${args.window}${args.softwareGl ? ', SwiftShader' : ''}; output ${outDir}`)
  const loadAtStart = await machineLoad()
  saveLoad(outDir, 'start', loadAtStart)
  console.log(`bench lock ${lock.id} (waited ${lock.record().waited_s} s); machine load: ${describeLoad(loadAtStart)}`)
  const started = new Date().toISOString()
  const records = []
  for (const condition of conditions) {
    const record = await runOne(args, condition, outDir, lock)
    records.push(record)
    console.log(`  ${line(record)}`)
  }
  const loadAtEnd = await machineLoad()
  saveLoad(outDir, 'end', loadAtEnd)
  const { out: _out, ...params } = args
  const summary = {
    schema: 'three-maze/stall-summary@1',
    started,
    ended: new Date().toISOString(),
    params,
    versions: records.find(r => r.versions)?.versions ?? null,
    gl: records.find(r => r.gl)?.gl?.renderer ?? null,
    bench_lock: condenseLock(lock.record()),
    machine_load: { start: condenseLoad(loadAtStart), end: condenseLoad(loadAtEnd) },
    runs: records.map(r => r.error ? { run: r.run, error: r.error } : {
      run: r.run, clock: r.clock, hz: r.counts.hz, spreadMs: r.counts.spreadMs, raf: r.counts.raf, entry: r.counts.entry,
      netDeficit: r.counts.netDeficit, stalls: r.stalls, mainThreadTasks: r.mainThreadTasks, cpuDuringPct: r.machine_load.cpu_during
    }),
    conditions: summarize(records)
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
  lock.release()
  const failed = records.filter(r => r.error)
  console.log(`${failed.length ? `FAILED: ${failed.length} of ${records.length} runs gave no result` : `done: ${records.length} runs`}; summary in ${path.join(outDir, 'summary.json')}`)
  process.exit(failed.length ? 1 : 0)
}

process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    stopAll()
    console.error(error)
    process.exit(1)
  })
}
