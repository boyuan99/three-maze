#!/usr/bin/env node
// Hardware-free end-to-end bench for three-maze (Windows). See test/e2e/README.md.
//
//   node test/e2e/run.mjs                      default: sim, s1, s2, lifecycle (about 60 s with a GPU)
//   node test/e2e/run.mjs --only s1,lifecycle  pick scenarios (--only all: every scenario)
//   node test/e2e/run.mjs --list               list the scenarios
//
// Options:
//   --only a,b,...     scenarios to run (see --list); "default" and "all" are accepted too
//   --duration S       seconds the S1 scene runs at least (default 20; it runs on, up to 90 s,
//                      until two rewards have been given, as trials are slower with slow frames)
//   --out DIR          output folder (default: a new folder under the system temp folder; not on D:).
//                      It must be new, empty, or the output folder of an earlier run: then each
//                      scenario's folder <DIR>/<scenario> is deleted before the scenario runs
//   --renderer DIR     use this vite build of the renderer instead of building one
//   --software-gl      render with SwiftShader (no GPU), as on a CI runner without a GPU
//   --ci               for shared CI runners: the sim self-test reports its tight timing
//                      tolerances instead of asserting them
//   --keep             keep the renderer build and the Electron profiles in the output folder
//
// Exit code: 0 every check passed (known failures, reported as KNOWN FAILURE, do not count),
// 1 a check failed, 2 the bench could not run (missing prerequisites, unsupported platform, bad
// arguments, an unusable --out folder, port 8765 or 8795 taken: close three-maze first).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  E2E_DIR, REPO_ROOT, PYTHON, PYTHONW, MONITOR, childEnv, electronPath, started, startLogged, runToEnd,
  isRunning, stopTree, stopAll, sleep, waitExit, aliveInfo, liveDescendants, probeConsole
} from './lib/proc.mjs'
import { serveDir } from './lib/static-server.mjs'
import { portTaken } from './lib/ports.mjs'
import {
  readJson, analyzeSession, checkSessionOk, checkSessionMissingTeensy, checkSessionCrash,
  checkSessionRegisterTimeout, sessionFacts, analyzeLifecycle, checkLifecycle, lifecycleFacts
} from './lib/checks.mjs'

const SIM_DIR = path.join(E2E_DIR, 'sim')
const HARNESS_MAIN = path.join(E2E_DIR, 'harness', 'main.cjs')
const LIFECYCLE_HARNESS = path.join(E2E_DIR, 'lifecycle', 'harness.cjs')
const SELFTEST = path.join(E2E_DIR, 'sim_selftest', 'selftest_sim.py')
const SCENE_ID = 'serial_custom_e2e_hallway04'
const OUT_MARKER = '.three-maze-e2e' // marks a folder as a bench output folder, so it may be reused
const APP_PORT = 8765 // the session backend (backend/src/main.py main())
const LIFECYCLE_PORT = 8795 // lifecycle/child_backend.py
const MAZE = path.join(REPO_ROOT, 'public', 'mazes', 'Hallway04', 'Hallway04.json')

const SCENARIOS = {
  sim: { kind: 'selftest', default: true, about: 'simulated Teensy / NI-DAQ / D: drive shim self-test (no backend)' },
  s1: { kind: 'session', default: true, duration: 20, minRewards: 2, maxDuration: 90, check: checkSessionOk, about: 'simulated Teensy: hallway04 runs, trials and rewards, outputs at 0 V, data file closed, graceful quit' },
  s2: { kind: 'session', default: true, duration: 10, simEnv: { THREEMAZE_SIM_SERIAL: 'missing' }, check: checkSessionMissingTeensy, about: 'missing Teensy (COM3): error overlay, no experiment_start, graceful quit' },
  lifecycle: { kind: 'lifecycle', default: true, about: 'Electron quit, double quit, crash, crash with hung cleanup (watchdog), quit with hung cleanup (kill path)' },
  close: { kind: 'session', default: false, duration: 16, minRewards: 1, maxDuration: 60, quitPath: 'close-window', check: checkSessionOk, about: 'S1, but quit by closing the scene window (window-all-closed)' },
  crash: { kind: 'session', default: false, duration: 30, crashAtS: 18, check: checkSessionCrash, about: 'Electron killed mid-session: the detached backend zeroes the valve and closes its files by itself' },
  t35: { kind: 'session', default: false, duration: 48, simEnv: { THREEMAZE_SIM_OPEN_DELAY_S: '35' }, check: checkSessionRegisterTimeout, about: 'registration outlasts the 30 s timeout: overlay, and the late experiment is stopped' }
}
const LIFECYCLE_CASES = [
  { name: 'quit', mode: 'quit' },
  { name: 'double', mode: 'double' },
  { name: 'crash', mode: 'crash' },
  { name: 'crash_hang', mode: 'crash', hang: true },
  { name: 'quit_hang', mode: 'quit', hang: true }
]

// ---------------------------------------------------------------- arguments
function usage (code) {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split(/\r?\n/).slice(1)
  const text = lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')
  ;(code ? console.error : console.log)(text)
  process.exit(code)
}
function parseArgs (argv) {
  const a = { only: null, duration: null, out: null, renderer: null, softwareGl: false, ci: false, keep: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = () => { if (i + 1 >= argv.length) usage(2); return argv[++i] }
    if (k === '--only') a.only = v()
    else if (k.startsWith('--only=')) a.only = k.slice(7)
    else if (k === '--duration') a.duration = Number(v())
    else if (k === '--out') a.out = v()
    else if (k === '--renderer') a.renderer = v()
    else if (k === '--software-gl') a.softwareGl = true
    else if (k === '--ci') a.ci = true
    else if (k === '--keep') a.keep = true
    else if (k === '--list') a.list = true
    else if (k === '--help' || k === '-h') usage(0)
    else { console.error(`unknown argument: ${k}`); usage(2) }
  }
  if (a.duration !== null && !(a.duration >= 5 && a.duration <= 600)) { console.error('--duration: 5..600 seconds'); process.exit(2) }
  return a
}
const args = parseArgs(process.argv.slice(2))
if (args.list) {
  for (const [name, s] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(10)} ${s.default ? '(default) ' : '          '}${s.about}`)
  process.exit(0)
}
let selected = Object.keys(SCENARIOS).filter(n => SCENARIOS[n].default)
if (args.only) {
  selected = []
  for (const n of args.only.split(',').map(x => x.trim().toLowerCase()).filter(Boolean)) {
    const names = n === 'all' ? Object.keys(SCENARIOS) : n === 'default' ? Object.keys(SCENARIOS).filter(x => SCENARIOS[x].default) : [n]
    for (const x of names) {
      if (!SCENARIOS[x]) { console.error(`unknown scenario: ${x} (see --list)`); process.exit(2) }
      if (!selected.includes(x)) selected.push(x)
    }
  }
}
if (args.duration !== null) SCENARIOS.s1.duration = args.duration

// ---------------------------------------------------------------- prerequisites
function fail (message) {
  console.error(`e2e: ${message}`)
  stopAll() // only processes this run started that are still running
  process.exit(2)
}
if (process.platform !== 'win32') fail('this bench runs on Windows only (pythonw.exe, Windows process and window APIs)')
for (const [what, file] of [['the repo venv python.exe (.venv/Scripts)', PYTHON], ['the repo venv pythonw.exe (.venv/Scripts)', PYTHONW]]) {
  if (!fs.existsSync(file)) fail(`missing ${what}: ${file}. Create the venv and install the backend requirements first (see README).`)
}
let ELECTRON
try { ELECTRON = electronPath() } catch (e) { fail(`Electron is not installed (npm ci): ${e.message}`) }
if (!fs.existsSync(ELECTRON)) fail(`Electron executable not found: ${ELECTRON} (npm ci)`)
if (!fs.existsSync(MAZE)) fail(`maze not found: ${MAZE}`)

// Ports: the session backend binds 8765 and the lifecycle backend 8795. On Windows a second backend
// on a taken port crashes on bind (it does not move to the next port), so stop here instead
{
  const needed = []
  if (selected.some(n => SCENARIOS[n].kind === 'session')) needed.push(APP_PORT)
  if (selected.includes('lifecycle')) needed.push(LIFECYCLE_PORT)
  for (const port of needed) {
    const taken = await portTaken(port)
    if (taken) fail(`port ${port} is in use (${taken}): close three-maze first (or another e2e run), then run again`)
  }
}

// The output folder: never on D: (checked before anything is created), and never a folder with
// other content, since scenario folders in it are deleted before each scenario runs
const outBase = args.out ? path.resolve(args.out) : os.tmpdir()
if (/^d:/i.test(path.parse(outBase).root)) {
  fail(`the output folder ${outBase} is on D:, which the simulated rig redirects; use --out on another drive`)
}
let runDir
if (args.out) {
  runDir = outBase
  let entries = null
  try { entries = fs.readdirSync(runDir) } catch (e) { if (e.code !== 'ENOENT') fail(`--out ${runDir}: ${e.message}`) }
  if (entries && entries.length && !entries.includes(OUT_MARKER)) {
    fail(`--out ${runDir} is not empty and is not the output folder of an earlier e2e run; use a new or empty folder`)
  }
  fs.mkdirSync(runDir, { recursive: true })
} else {
  runDir = fs.mkdtempSync(path.join(outBase, 'three-maze-e2e-'))
}
fs.writeFileSync(path.join(runDir, OUT_MARKER), 'output folder of test/e2e/run.mjs: the next run into this folder deletes and rewrites its scenario folders\n')
fs.rmSync(path.join(runDir, 'results.json'), { force: true }) // an earlier run's; written again at the end

const PYCACHE = path.join(runDir, 'pycache') // bytecode of every Python child goes here, not into the repo

process.on('SIGINT', () => {
  console.error('\ninterrupted: stopping the processes this run started')
  stopAll()
  process.exit(130)
})

const T0 = Date.now()
const runStartEpoch = T0 / 1000
const secs = (t) => ((Date.now() - t) / 1000).toFixed(1)
console.log(`three-maze e2e: ${selected.join(', ')}`)
console.log(`output: ${runDir}`)

// ---------------------------------------------------------------- shared setup
async function checkPythonPackages () {
  const r = await runToEnd('python packages', PYTHON, ['-c', 'import websockets, serial, nidaqmx, numpy'], { env: childEnv({ PYTHONPYCACHEPREFIX: PYCACHE }), timeoutMs: 60000 })
  if (r.code !== 0) fail(`the venv lacks backend packages (websockets, pyserial, nidaqmx, numpy):\n${r.stderr.trim()}`)
}

async function buildRenderer () {
  if (args.renderer) {
    const dir = path.resolve(args.renderer)
    if (!fs.existsSync(path.join(dir, 'index.html'))) fail(`--renderer ${dir} has no index.html`)
    return dir
  }
  const t = Date.now()
  const out = path.join(runDir, 'renderer')
  const r = await runToEnd('vite build', process.execPath, [path.join(E2E_DIR, 'lib', 'build-renderer.mjs'), out, path.join(runDir, 'vite-cache')],
    { timeoutMs: 300000, logFile: path.join(runDir, 'build.log') })
  const left = liveDescendants(r.pid).filter(p => p.created === null || p.created >= r.startedAt - 1)
  if (left.length) {
    console.error(`build left processes running: ${JSON.stringify(left)}`)
    leftoverNotes.push(...left.map(p => `build: ${p.exe} ${p.pid}`))
  }
  if (r.code !== 0 || !fs.existsSync(path.join(out, 'index.html'))) fail(`renderer build failed (see ${path.join(runDir, 'build.log')})`)
  console.log(`  renderer built in ${secs(t)} s`)
  return out
}

function writeFixture () {
  // The scene as the Serial Control tab stores it after loading public/mazes/Hallway04/Hallway04.json
  const dir = path.join(runDir, 'appdata')
  fs.mkdirSync(dir, { recursive: true })
  const config = { ...JSON.parse(fs.readFileSync(MAZE, 'utf8')), _basePath: 'mazes/Hallway04/' }
  fs.writeFileSync(path.join(dir, 'customScenes.json'), JSON.stringify({ [SCENE_ID]: { id: SCENE_ID, config } }, null, 2))
  return dir
}

// ---------------------------------------------------------------- scenario runners
const leftoverNotes = []

async function runSelftest (name) {
  const dir = path.join(runDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const r = await runToEnd('sim self-test', PYTHON, [SELFTEST, '--out', dir, ...(args.ci ? ['--report-timing'] : [])],
    { env: childEnv({ PYTHONPYCACHEPREFIX: PYCACHE }), timeoutMs: 180000, logFile: path.join(dir, 'selftest.log') })
  const results = readJson(path.join(dir, 'summary.json'), [])
  // With --ci the timing tolerances are only reported: list the ones outside their range
  const outside = (c) => (c.timing || []).filter(t => !t.asserted && !t.within).map(t => `${t.name}: ${t.value} (${t.low}..${t.high})`)
  const checks = results.map(c => ({
    name: c.name, ok: !!c.ok,
    detail: (c.ok ? `${c.checks.length} checks` : JSON.stringify(c.checks.filter(x => !x[1]))) +
      (outside(c).length ? `; timing reported, not asserted (--ci), outside range: ${outside(c).join('; ')}` : '')
  }))
  if (!results.length) checks.push({ name: 'selftest_ran', ok: false, detail: `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${r.stderr.slice(-1500)}` })
  const reported = results.flatMap(c => outside(c).map(x => `${c.name} ${x}`))
  const timingFact = args.ci ? `; timing reported only (--ci): ${reported.length ? `${reported.length} outside range: ${reported.join('; ')}` : 'all within range'}` : ''
  return { checks, facts: `${results.filter(c => c.ok).length}/${results.length} cases passed${timingFact}` }
}

async function runSession (name, spec, ctx) {
  const dir = path.join(runDir, name)
  fs.mkdirSync(dir, { recursive: true })
  const duration = spec.duration
  const maxDuration = Math.max(duration, spec.maxDuration || 0)
  const runner = { scenario: name, duration_s: duration, max_duration_s: maxDuration, started: new Date().toISOString() }
  const readyFile = path.join(dir, 'monitor.ready')
  const backendEnv = {
    PYTHONPATH: [SIM_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    THREEMAZE_SIM: '1',
    THREEMAZE_SIM_DIR: path.join(dir, 'sim'),
    PYTHONPYCACHEPREFIX: PYCACHE,
    ...(spec.simEnv || {})
  }
  const env = childEnv({
    APP_URL: ctx.appUrl,
    OUT_DIR: dir,
    THREEMAZE_APPDATA_DIR: ctx.appdata,
    SCENE_ID,
    DURATION_S: String(duration),
    MIN_REWARDS: String(spec.minRewards || 0),
    MAX_DURATION_S: String(maxDuration),
    EXPERIMENT_FILE: 'hallway04_experiment.py',
    BACKEND_EXTRA_ENV: JSON.stringify(backendEnv),
    QUIT_PATH: spec.quitPath || 'app-quit',
    WAIT_FOR_FILE: readyFile,
    ...(args.softwareGl ? { E2E_SOFTWARE_GL: '1' } : {})
  })
  runner.probe_before = await probeConsole(path.join(dir, 'probe_console.before.log'))

  const electron = startLogged(`electron ${name}`, ELECTRON, [HARNESS_MAIN], { logFile: path.join(dir, 'electron.stdio.log'), env })
  if (!electron.pid) fail(`could not start Electron: ${JSON.stringify(await electron.exited)}`)
  runner.electron_pid = electron.pid
  const grace = 15
  const monitor = startLogged(`monitor ${name}`, PYTHONW, [MONITOR, 'watch', '--root-pid', String(electron.pid), '--out', dir,
    '--deadline-s', String(maxDuration + 150), '--grace-s', String(grace), '--kill-leftovers', '--ready-file', readyFile],
  { logFile: path.join(dir, 'monitor.log'), env: childEnv() })
  runner.monitor_pid = monitor.pid

  const t0 = Date.now()
  const deadline = t0 + (maxDuration + 120) * 1000
  let probed = false
  while (isRunning(electron)) {
    const elapsed = (Date.now() - t0) / 1000
    if (!probed && elapsed >= duration / 2 + 2 && fs.existsSync(path.join(dir, 'backend.pid'))) {
      probed = true
      runner.probe_during = await probeConsole(path.join(dir, 'probe_console.during.log'))
    }
    if (spec.crashAtS && runner.crashed_at_s === undefined && elapsed >= spec.crashAtS) {
      // Only Electron's main process, without its children (taskkill /F without /T): a crash
      runner.crashed_at_s = +elapsed.toFixed(2)
      electron.child.kill('SIGKILL')
    }
    if (Date.now() > deadline) {
      runner.electron_killed_by_runner = true
      stopTree(electron)
      break
    }
    await sleep(200)
  }
  runner.electron_exit = await electron.exited
  runner.electron_wall_s = +((Date.now() - t0) / 1000).toFixed(2)
  if (!(await waitExit(monitor, (grace + 45) * 1000))) {
    runner.monitor_killed_by_runner = true
    stopTree(monitor)
  }
  runner.monitor_exit = await monitor.exited
  if (!args.keep) fs.rmSync(path.join(dir, 'electron-userdata'), { recursive: true, force: true })
  fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(runner, null, 2))

  const F = analyzeSession(dir)
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify({ ...F, summary: undefined, monitor: undefined }, null, 2))
  return { checks: spec.check(F, { minTrials: spec.minRewards ?? 1, softwareGl: args.softwareGl }), facts: sessionFacts(F) }
}

async function runLifecycle (name) {
  const all = []
  const facts = []
  for (const c of LIFECYCLE_CASES) {
    const dir = path.join(runDir, name, c.name)
    fs.mkdirSync(dir, { recursive: true })
    const readyFile = path.join(dir, 'monitor.ready')
    const runner = { case: c.name }
    const env = childEnv({
      MODE: c.mode,
      ...(c.hang ? { HANG: '1' } : {}),
      LOG: path.join(dir, 'lifecycle.log'),
      MARKER: path.join(dir, 'marker.txt'),
      WAIT_FOR_FILE: readyFile,
      PYTHONPYCACHEPREFIX: PYCACHE
    })
    const electron = startLogged(`electron lifecycle ${c.name}`, ELECTRON, [LIFECYCLE_HARNESS], { logFile: path.join(dir, 'electron.stdio.log'), env })
    if (!electron.pid) fail(`could not start Electron: ${JSON.stringify(await electron.exited)}`)
    const grace = 20 // crash_hang: the watchdog ends the backend 10 s after Electron
    const monitor = startLogged(`monitor lifecycle ${c.name}`, PYTHONW, [MONITOR, 'watch', '--root-pid', String(electron.pid), '--out', dir,
      '--deadline-s', '90', '--grace-s', String(grace), '--kill-leftovers', '--ready-file', readyFile],
    { logFile: path.join(dir, 'monitor.log'), env: childEnv() })
    if (!(await waitExit(electron, 60000))) {
      runner.electron_killed_by_runner = true
      stopTree(electron)
    }
    runner.electron_exit = await electron.exited
    if (!(await waitExit(monitor, (grace + 45) * 1000))) {
      runner.monitor_killed_by_runner = true
      stopTree(monitor)
    }
    fs.writeFileSync(path.join(dir, 'runner.json'), JSON.stringify(runner, null, 2))
    const L = analyzeLifecycle(dir)
    for (const ch of checkLifecycle(c.name, L)) all.push({ ...ch, name: `${c.name}: ${ch.name}` })
    facts.push(`${c.name}: ${lifecycleFacts(L)}`)
  }
  return { checks: all, facts: facts.join('\n             ') }
}

// ---------------------------------------------------------------- final check: nothing we started still runs
function finalLeftoverCheck () {
  const expect = [] // { pid, exe, created }
  for (const rec of started) {
    if (isRunning(rec)) leftoverNotes.push(`${rec.label}: ${rec.image} ${rec.pid} still running`)
  }
  const monitors = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory() && !['renderer', 'vite-cache', 'pycache', 'electron-userdata', 'sim'].includes(e.name)) walk(p)
      else if (e.name === 'monitor.json') monitors.push(readJson(p, {}))
    }
  }
  // Only this run's scenario folders: an earlier run's folders in a reused --out are not this run's
  for (const name of selected) if (fs.existsSync(path.join(runDir, name))) walk(path.join(runDir, name))
  for (const m of monitors) {
    for (const p of m.processes || []) expect.push({ pid: p.pid, exe: p.exe, created: p.created })
    if (m.monitor_pid) expect.push({ pid: m.monitor_pid, exe: 'pythonw.exe', created: null })
    if (m.monitor_launcher_pid) expect.push({ pid: m.monitor_launcher_pid, exe: 'pythonw.exe', created: null })
  }
  const alive = aliveInfo([...new Set(expect.map(e => e.pid))])
  for (const e of expect) {
    const a = alive[String(e.pid)]
    if (!a || String(a.exe).toLowerCase() !== String(e.exe).toLowerCase()) continue
    const same = e.created !== null && a.created !== null ? Math.abs(a.created - e.created) < 0.5 : (a.created ?? 0) >= runStartEpoch - 1
    if (same) leftoverNotes.push(`${e.exe} ${e.pid} still running`)
  }
  return { name: 'no_process_left_by_this_run', ok: leftoverNotes.length === 0, detail: leftoverNotes.join('; ') || `${expect.length} processes checked` }
}

// ---------------------------------------------------------------- main
const results = []
let server = null
let exitCode = 0
try {
  const needsSession = selected.some(n => SCENARIOS[n].kind === 'session')
  if (needsSession || selected.includes('sim')) await checkPythonPackages()
  const ctx = {}
  if (needsSession) {
    const rendererDir = await buildRenderer()
    server = await serveDir(rendererDir)
    ctx.appUrl = server.url
    ctx.appdata = writeFixture()
  }
  for (const name of selected) {
    const spec = SCENARIOS[name]
    const t = Date.now()
    console.log(`  ---- ${name}: ${spec.about}`)
    fs.rmSync(path.join(runDir, name), { recursive: true, force: true }) // an earlier run's, in a reused --out
    let res
    if (spec.kind === 'selftest') res = await runSelftest(name)
    else if (spec.kind === 'lifecycle') res = await runLifecycle(name)
    else res = await runSession(name, spec, ctx)
    // A known failure (a check that fails on a known product defect where that defect is expected,
    // see checks.mjs) is reported on its own line and in results.json, but does not fail the scenario
    const failed = res.checks.filter(c => !c.ok && !c.known_failure)
    const known = res.checks.filter(c => !c.ok && c.known_failure)
    const passed = res.checks.filter(c => c.ok)
    const r = {
      scenario: name, about: spec.about, ok: failed.length === 0 && res.checks.length > 0, seconds: +secs(t),
      known_failures: known.map(c => c.name), checks: res.checks, facts: res.facts, dir: path.join(runDir, name)
    }
    results.push(r)
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${name.padEnd(10)} ${String(r.seconds).padStart(5)} s  ${passed.length}/${res.checks.length} checks` +
      (known.length ? `, ${known.length} known failure${known.length > 1 ? 's' : ''}` : ''))
    console.log(`             ${res.facts}`)
    for (const c of failed) console.log(`       FAILED ${c.name}: ${c.detail.slice(0, 1500)}`)
    for (const c of known) {
      console.log(`       KNOWN FAILURE ${c.name}: ${c.known_failure}`)
      console.log(`         evidence: ${c.detail.slice(0, 1200)}`)
    }
  }
} catch (e) {
  console.error(`\ne2e: ${e.stack || e}`)
  exitCode = 2
} finally {
  if (server) await server.close()
  stopAll() // nothing should be running any more; this only acts on processes this run started
  await sleep(500)
}

const final = finalLeftoverCheck()
console.log(`  ${final.ok ? 'PASS' : 'FAIL'} ${final.name}: ${final.detail}`)
if (!args.keep && !args.renderer) fs.rmSync(path.join(runDir, 'renderer'), { recursive: true, force: true })
const ok = exitCode === 0 && final.ok && results.length === selected.length && results.every(r => r.ok)
const knownFailures = results.flatMap(r => r.known_failures.map(c => `${r.scenario}: ${c}`))
fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({
  ok, started: new Date(T0).toISOString(), seconds: +secs(T0), repo: REPO_ROOT, selected, software_gl: args.softwareGl,
  ci: args.ci, known_failures: knownFailures, results, final
}, null, 2))
console.log(`${ok ? 'PASSED' : 'FAILED'}: ${results.filter(r => r.ok).length}/${selected.length} scenarios in ${secs(T0)} s` +
  (knownFailures.length ? `, with ${knownFailures.length} KNOWN FAILURE${knownFailures.length > 1 ? 'S' : ''} (${knownFailures.join(', ')})` : '') +
  `; details in ${path.join(runDir, 'results.json')}`)
process.exit(exitCode || (ok ? 0 : 1))
