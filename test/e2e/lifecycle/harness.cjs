'use strict'
// Electron lifecycle harness. Started by test/e2e/run.mjs (scenario "lifecycle"), once per case.
//
// Runs the real getBackendLaunch, stopPythonBackend and before-quit code of electron/main.js (taken
// by source text, see ../harness/mainjs.cjs) in the Electron runtime, against child_backend.py: the
// real BackendServer (parent-pipe watcher, release lock, shutdown watchdog) with a fake experiment
// that records its cleanup in a marker file. No window is created.
//
// Environment:
//   MODE         quit    app.quit() once the backend is ready (ESC in the gallery)
//                double  app.quit(), and again 300 ms later while the backend is still stopping
//                crash   Electron kills itself without telling the backend (a crash)
//   HANG=1       the fake experiment's terminate() blocks the backend's event loop for 30 s
//   LOG          log file (appended)
//   MARKER       marker file the backend appends to (see child_backend.py)
//   WAIT_FOR_FILE  wait (up to 15 s) for this file before starting the backend (the monitor's ready file)
const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const mainJs = require('../harness/mainjs.cjs')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const MODE = process.env.MODE || 'quit'
const HANG = process.env.HANG === '1'
const LOG = process.env.LOG
const MARKER = process.env.MARKER
const WAIT_FOR_FILE = process.env.WAIT_FOR_FILE || null
const t0 = Date.now()
const log = s => fs.appendFileSync(LOG, `[${MODE}${HANG ? '+hang' : ''} +${Date.now() - t0}ms] ${String(s).trimEnd()}\n`)

// No error dialogs (a visible window): log and exit instead
process.on('uncaughtException', (e) => {
  try { log(`uncaughtException: ${e && e.stack ? e.stack : e}`) } catch {}
  process.exit(2)
})
if (!LOG || !MARKER || !['quit', 'double', 'crash'].includes(MODE)) {
  process.stderr.write('lifecycle harness: LOG, MARKER and MODE (quit|double|crash) are required\n')
  process.exit(2)
}

// main.js's own console output ("Python backend did not exit in time; killing it", ...)
for (const level of ['log', 'info', 'warn', 'error']) console[level] = (...args) => log(`[main.js ${level}] ${args.join(' ')}`)

// ---- state and code of electron/main.js (the evaluated code reads and writes these) ----
let pythonProcess = null
let backendStopping = null
const src = mainJs.readMainJs(REPO_ROOT)
const code = [
  mainJs.grab(src, 'const getBackendLaunch = '),
  mainJs.grab(src, 'function stopPythonBackend('),
  mainJs.grab(src, "app.on('before-quit',")
].join('\n\n').replace('const getBackendLaunch', 'getBackendLaunch')
let getBackendLaunch
// A direct eval, so the code sees and assigns the variables above. In strict mode its function
// declarations (stopPythonBackend) stay inside the eval, where the before-quit handler uses them.
// eslint-disable-next-line no-eval
eval(code)
// ---- end of main.js code ----

app.on('will-quit', () => log('will-quit'))
app.on('quit', () => log('quit: Electron exits now'))
app.on('window-all-closed', () => {})

async function waitForFile (file, timeoutMs) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    if (fs.existsSync(file)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

app.whenReady().then(async () => {
  if (WAIT_FOR_FILE) log(await waitForFile(WAIT_FOR_FILE, 15000) ? 'monitor ready' : 'WARNING: monitor not ready after 15 s')
  const { spawn } = require('child_process')
  const launch = getBackendLaunch({ interpreter: path.join(REPO_ROOT, '.venv', 'Scripts', 'python.exe') })
  log(`launch ${path.basename(launch.interpreter)} detached=${launch.detached}`)
  const args = [path.join(__dirname, 'child_backend.py'), MARKER].concat(HANG ? ['hang'] : [])
  // The same spawn options as startPythonBackend in electron/main.js
  pythonProcess = spawn(launch.interpreter, args, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: launch.detached,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', THREEMAZE_PARENT_PIPE: '1' }
  })
  const spawned = pythonProcess
  log(`backend launcher pid ${spawned.pid}`)
  spawned.stdin.on('error', e => log('stdin error: ' + e.message))
  spawned.once('exit', (c, s) => { log(`child exit ${c} ${s}`); if (pythonProcess === spawned) pythonProcess = null })
  spawned.stderr.on('data', d => log('child stderr: ' + d))
  let ready = false
  spawned.stdout.on('data', d => {
    if (ready || !String(d).includes('WebSocket server ready')) return
    ready = true
    log('backend ready')
    // A short pause, so the monitor has certainly seen the backend's processes
    setTimeout(() => {
      if (MODE === 'crash') {
        log('killing Electron (no shutdown sent)')
        process.kill(process.pid, 'SIGKILL')
        return
      }
      log('app.quit() #1')
      app.quit()
      if (MODE === 'double') setTimeout(() => { log('app.quit() #2 during the stop'); app.quit() }, 300)
    }, 300)
  })
})
