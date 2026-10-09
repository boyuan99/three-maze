'use strict'
// three-maze offscreen e2e harness (Electron main process). Started by test/e2e/run.mjs.
//
// Runs this repository's real renderer scene (a vite build served at APP_URL) and its real Python
// backend, with no visible window. The code that decides behaviour is taken at run time, by source
// text, from electron/main.js and evaluated here (see mainjs.cjs): getPythonConfig,
// getBackendLaunch, startPythonBackend, stopPythonBackend, the before-quit and window-all-closed
// handlers, and the read-only ipcMain handlers. The other ipcMain handlers (they write the app's
// user-data files or open dialogs) are registered as logged stubs. The scene window is built like
// createSceneWindow's, but hidden and offscreen (frames are painted at a fixed 60 Hz). The exact code
// that ran is saved to OUT_DIR/main-js.extracted.js.
//
// Parameters (environment):
//   APP_URL                 base URL serving the built renderer (required)
//   OUT_DIR                 output folder (required)
//   THREEMAZE_APPDATA_DIR   folder with customScenes.json, read like the app's user-data folder
//                           (required; run.mjs writes a fixture, the owner's profile is never read)
//   SCENE_ID                key in customScenes.json; opened as the scene window's id (required).
//                           A serial_custom_ id renders PythonCustomScene.vue, as the Serial Control
//                           tab does; a gallery_custom_ id is opened as serial_custom_<same suffix>.
//   DURATION_S              seconds the scene runs before the quit (default 20)
//   MIN_REWARDS, MAX_DURATION_S  keep the scene running after DURATION_S, up to MAX_DURATION_S, until
//                           the backend has logged MIN_REWARDS rewards (default 0: no extension).
//                           Trials take longer when frames are slow (software rendering).
//   EXPERIMENT_FILE         file in experiments/ (default hallway04_experiment.py; empty = none)
//   BACKEND_EXTRA_ENV       JSON object merged into the environment the backend inherits (default {})
//   QUIT_PATH               app-quit (default; ESC in the gallery: app.quit -> before-quit) |
//                           close-window (closing the scene window: window-all-closed -> app.quit)
//   WAIT_FOR_FILE           wait (up to 15 s) for this file before starting the backend (run.mjs
//                           passes the monitor's ready file, so the monitor sees every child process)
//   E2E_SOFTWARE_GL=1       render with SwiftShader (app.disableHardwareAcceleration())
//
// Outputs in OUT_DIR: summary.json, main.log (main-process console, incl. main.js's own messages),
// backend.log (backend stdout/stderr, timestamped), renderer.log (console messages with level),
// network.log, ipc.log, ws.jsonl (the page's WebSocket frames), shot-*.png, electron.pid,
// backend.pid, main-js.extracted.js, electron-userdata/ (this run's own Chromium profile).

const { app, BrowserWindow, ipcMain: realIpcMain, screen, dialog, powerSaveBlocker } = require('electron')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')
const util = require('util')
const mainJs = require('./mainjs.cjs')

const T0 = Date.now()
const ms = () => Date.now() - T0
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// Until the summary exists, an error ends the harness at once. Without any listener, Electron would
// show an error dialog, i.e. a visible window.
function earlyError (error) {
  process.stderr.write(`harness: ${error && error.stack ? error.stack : error}\n`)
  process.exit(2)
}
process.on('uncaughtException', earlyError)

// ---------------------------------------------------------------- parameters
const E = process.env
function required (name) {
  if (!E[name]) earlyError(`${name} is required`)
  return E[name]
}
const APP_URL = required('APP_URL').replace(/\/+$/, '')
const OUT_DIR = path.resolve(required('OUT_DIR'))
const APPDATA_DIR = path.resolve(required('THREEMAZE_APPDATA_DIR'))
const SCENE_ID = required('SCENE_ID')
const DURATION_S = Number(E.DURATION_S || '20')
const MIN_REWARDS = Number(E.MIN_REWARDS || '0')
const MAX_DURATION_S = Math.max(DURATION_S, Number(E.MAX_DURATION_S || '0'))
const EXPERIMENT_FILE = E.EXPERIMENT_FILE === undefined ? 'hallway04_experiment.py' : E.EXPERIMENT_FILE
const BACKEND_EXTRA_ENV = E.BACKEND_EXTRA_ENV ? JSON.parse(E.BACKEND_EXTRA_ENV) : {}
const SCENE_WINDOW_ID = defaultWindowId(SCENE_ID)
const QUIT_PATH = E.QUIT_PATH || 'app-quit'
const WAIT_FOR_FILE = E.WAIT_FOR_FILE || null
const SOFTWARE_GL = E.E2E_SOFTWARE_GL === '1'
const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 900

function defaultWindowId (id) {
  const m = /^gallery_custom_(.+)$/.exec(id)
  return m ? `serial_custom_${m[1]}` : id
}

// Lets WebGL fall back to SwiftShader on machines without a usable GPU (CI runners); it changes
// nothing where a GPU is used. Without this switch Chromium no longer falls back to SwiftShader
// (on Windows, Electron 44 uses WARP instead), so the real app, which does not pass it, can differ.
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
if (SOFTWARE_GL) app.disableHardwareAcceleration()

// This run's own Chromium profile, so nothing is written to the owner's three-maze profile
// (which a running three-maze would also have locked)
fs.mkdirSync(OUT_DIR, { recursive: true })
app.setPath('userData', path.join(OUT_DIR, 'electron-userdata'))
app.setPath('crashDumps', path.join(OUT_DIR, 'electron-userdata', 'Crashpad'))
fs.writeFileSync(path.join(OUT_DIR, 'electron.pid'), String(process.pid))

// ---------------------------------------------------------------- logging (buffered, flushed twice a second)
class Sink {
  constructor (name) { this.file = path.join(OUT_DIR, name); this.buf = []; fs.writeFileSync(this.file, '') }
  line (s) { this.buf.push(s) }
  flush () {
    if (!this.buf.length) return
    const text = this.buf.join('\n') + '\n'
    this.buf = []
    try { fs.appendFileSync(this.file, text) } catch (e) { process.stderr.write(`harness: log write failed: ${e}\n`) }
  }
}
const sinks = {
  main: new Sink('main.log'),
  backend: new Sink('backend.log'),
  renderer: new Sink('renderer.log'),
  network: new Sink('network.log'),
  ipc: new Sink('ipc.log'),
  ws: new Sink('ws.jsonl') // the page's WebSocket frames (see startWsCapture)
}
const flushAll = () => Object.values(sinks).forEach(s => s.flush())
setInterval(flushAll, 500).unref()
const stamp = () => `${new Date().toISOString()} +${String(ms()).padStart(6)}ms`
const fmt = a => typeof a === 'string' ? a : (a instanceof Error ? (a.stack || String(a)) : util.inspect(a, { depth: 3, breakLength: Infinity }))
const log = (s) => sinks.main.line(`${stamp()} [harness] ${s}`)

// ---------------------------------------------------------------- summary
const summary = {
  harness: {
    file: __filename, started_at: new Date(T0).toISOString(), electron_pid: process.pid,
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    software_gl: SOFTWARE_GL, monitor_ready_ms: null
  },
  params: {
    REPO_ROOT, APP_URL, OUT_DIR, DURATION_S, MIN_REWARDS, MAX_DURATION_S, SCENE_ID, SCENE_WINDOW_ID, EXPERIMENT_FILE, BACKEND_EXTRA_ENV,
    QUIT_PATH, APPDATA_DIR, WAIT_FOR_FILE
  },
  main_js: {},
  ports: { app_url: Number(new URL(APP_URL).port) || null, ws: null },
  backend: {
    spawn: null, launcher_pid: null, ready: false, ready_ms: null, start_error: null, exit: null,
    stdout_lines: 0, stderr_lines: 0, renderer_status_lines: 0, renderer_status: [], markers: {}, rewards: 0
  },
  window: {},
  renderer: {
    console_counts: { verbose: 0, info: 0, warning: 0, error: 0 }, error_count: 0, errors: [], warnings: [],
    component: null, frame_clock_warnings: 0, gone: null, failed_loads: [], network_errors: [], preload_errors: []
  },
  ipc: { calls: {}, blocked: [] },
  // The page's WebSocket traffic as the renderer saw it (Chrome DevTools Protocol, read only)
  ws: { attached: false, error: null, detached: null, sockets: [], sent: {}, received: {}, first_ms: {}, last_ms: {} },
  shots: [],
  dom: [],
  main_process: { console_errors: [], uncaught: [] },
  quit: { path: QUIT_PATH, requested_ms: null, events: [], duration_ms: null, stop_timeout_fired: false, backend_exited_before_quit: null },
  result: { finished: false, exit_code: null, harness_timeout: false, fatal: null }
}
function writeSummary () {
  try {
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2))
  } catch (e) { process.stderr.write(`harness: summary write failed: ${e}\n`) }
}
const quitEvent = (event, extra = {}) => {
  summary.quit.events.push({ event, t_ms: ms(), ...extra })
  log(`event ${event} ${JSON.stringify(extra)}`)
}

// main.js's own console output (e.g. "Python backend did not exit in time; killing it") goes to main.log
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  console[level] = (...args) => {
    const text = args.map(fmt).join(' ')
    sinks.main.line(`${stamp()} [${level}] ${text}`)
    if (/did not exit in time/.test(text)) summary.quit.stop_timeout_fired = true
    if (level === 'error') summary.main_process.console_errors.push({ t_ms: ms(), text: text.slice(0, 1000) })
  }
}

process.removeListener('uncaughtException', earlyError)
process.on('uncaughtException', (error) => {
  summary.main_process.uncaught.push({ t_ms: ms(), error: fmt(error).slice(0, 2000) })
  sinks.main.line(`${stamp()} [uncaughtException] ${fmt(error)}`)
})
process.on('unhandledRejection', (error) => {
  summary.main_process.uncaught.push({ t_ms: ms(), rejection: fmt(error).slice(0, 2000) })
  sinks.main.line(`${stamp()} [unhandledRejection] ${fmt(error)}`)
})
process.on('exit', () => { flushAll(); if (!summary.result.finished) writeSummary() })

// ---------------------------------------------------------------- state shared with main.js's code
// Same names as the module-level variables of electron/main.js: the evaluated code reads and writes
// these. The gallery window (mainWindow) is not created: no ESC or session-end paths offscreen.
let pythonProcess = null
let backendStopping = null
let detectedWsPort = null
let preferredDisplayId = null
const sceneWindows = new Map()
const sceneConfigs = new Map()

// ---------------------------------------------------------------- backend spawn (wraps the real spawn)
// First time each of these appears in the backend's output (summary.backend.markers, ms since start)
const BACKEND_MARKERS = [
  ['ws_ready', /WebSocket server ready on port (\d+)/],
  ['renderer_connected', /Client connected: /],
  ['experiment_loading', /Loading experiment from file: (\S+)/],
  ['experiment_initialized', /Experiment initialized successfully/],
  ['experiment_register_error', /Error registering experiment: (.*)/],
  ['experiment_init_error', /Failed to initialize (.*)/],
  ['data_file_opened', /Data file opened: (.*)/],
  ['experiment_started_msg', /Experiment started: (.*)/],
  ['shutdown_requested', /Shutdown requested/],
  ['client_disconnect_cleanup', /No active clients, cleaning up/],
  ['experiment_cleanup_begin', /Cleaning up active experiment due to (.*)/],
  ['cleanup_complete', /CLEANUP COMPLETE/],
  ['data_file_closed', /Data file closed: (.*)/],
  ['watchdog_exit', /Shutdown did not finish in time/],
  ['traceback', /Traceback \(most recent call last\)/]
]
function spawnLogged (command, args, options) {
  const child = childProcess.spawn(command, args, options)
  const addedEnv = Object.keys(options.env || {}).filter(k => process.env[k] !== options.env[k])
  summary.backend.spawn = {
    command, args, cwd: options.cwd, stdio: options.stdio, detached: options.detached ?? false,
    windowsHide: options.windowsHide ?? false, env_set_by_main_js: Object.fromEntries(addedEnv.map(k => [k, options.env[k]])),
    // BACKEND_EXTRA_ENV reaches the backend through main.js's {...process.env}: true per key if it did
    extra_env_in_spawn: Object.fromEntries(Object.keys(BACKEND_EXTRA_ENV).map(k => [k, options.env?.[k] === String(BACKEND_EXTRA_ENV[k])])),
    at_ms: ms()
  }
  summary.backend.launcher_pid = child.pid
  log(`backend spawned: pid ${child.pid} ${command} ${args.join(' ')} ${JSON.stringify(summary.backend.spawn)}`)
  if (child.pid) fs.writeFileSync(path.join(OUT_DIR, 'backend.pid'), String(child.pid))
  for (const [name, stream] of [['out', child.stdout], ['err', child.stderr]]) {
    if (!stream) continue
    let partial = ''
    const emit = (line) => {
      if (!line) return
      sinks.backend.line(`${stamp()} [${name}] ${line}`)
      summary.backend[name === 'out' ? 'stdout_lines' : 'stderr_lines']++
      if (summary.backend.ready_ms === null && /WebSocket server ready on port (\d+)/i.test(line)) summary.backend.ready_ms = ms()
      if (/Reward #\d+ delivered/.test(line)) summary.backend.rewards++
      for (const [marker, re] of BACKEND_MARKERS) {
        const m = re.exec(line)
        if (m && !(marker in summary.backend.markers)) {
          summary.backend.markers[marker] = m[1] ? { t_ms: ms(), value: m[1] } : ms()
        }
      }
      // Frame-clock reports from the renderer, logged by the backend when the warning kinds change
      const status = /- (\w+) - \[renderer\] (.*?)\s*(\{.*\})?\s*$/.exec(line)
      if (status) {
        summary.backend.renderer_status_lines++
        if (summary.backend.renderer_status.length < 50) {
          let details = null
          try { details = status[3] ? JSON.parse(status[3]) : null } catch { details = status[3] }
          summary.backend.renderer_status.push({ t_ms: ms(), level: status[1], message: status[2], details })
        }
      }
    }
    stream.on('data', (d) => {
      const parts = (partial + d.toString()).split(/\r?\n/)
      partial = parts.pop()
      parts.forEach(emit)
    })
    stream.on('end', () => { emit(partial); partial = '' })
  }
  child.once('exit', (code, signal) => {
    summary.backend.exit = { code, signal, t_ms: ms() }
    quitEvent('backend-exit', { code, signal })
  })
  child.once('error', (e) => log(`backend spawn error: ${e.message}`))
  return child
}

// ---------------------------------------------------------------- IPC wrapper (logs every call)
const READ_ONLY_IPC = new Set([
  'get-ws-port', 'get-window-display-info', 'get-scene-config', 'get-stored-scenes',
  'get-stored-control-files', 'get-displays', 'get-preferred-display'
])
const brief = (v) => {
  if (v && typeof v === 'object' && v.config && typeof v.config === 'object') {
    v = { ...v, config: { name: v.config.name, objects: v.config.objects?.length, _basePath: v.config._basePath, _mazeDir: v.config._mazeDir } }
  }
  let s
  try { s = JSON.stringify(v) } catch { s = String(v) }
  return s === undefined ? 'undefined' : (s.length > 600 ? s.slice(0, 600) + '...' : s)
}
const ipcCall = (channel, args, outcome) => {
  summary.ipc.calls[channel] = (summary.ipc.calls[channel] || 0) + 1
  sinks.ipc.line(`${stamp()} ${channel} args=${brief(args)} -> ${outcome}`)
}
const loggingIpcMain = {
  handle (channel, fn) {
    realIpcMain.handle(channel, async (event, ...args) => {
      try {
        const result = await fn(event, ...args)
        ipcCall(channel, args, brief(result))
        return result
      } catch (e) {
        ipcCall(channel, args, `THREW ${e.message}`)
        throw e
      }
    })
  },
  on (channel, fn) {
    realIpcMain.on(channel, (event, ...args) => { ipcCall(channel, args, '(on)'); return fn(event, ...args) })
  }
}

// ---------------------------------------------------------------- main.js's own code
// eval in a function with no other locals, so nothing here shadows main.js's free variables
// eslint-disable-next-line no-eval
function evalMainJsCode (__mainJsSrc) { return eval(__mainJsSrc) }

function loadMainJsCode () {
  const src = mainJs.readMainJs(REPO_ROOT)
  const parts = {
    loadStoredScenes: mainJs.grab(src, 'function loadStoredScenes('),
    loadStoredControlFiles: mainJs.grab(src, 'function loadStoredControlFiles('),
    loadDisplayPreference: mainJs.grab(src, 'function loadDisplayPreference('),
    getPythonConfig: mainJs.grab(src, 'const getPythonConfig = '),
    getBackendLaunch: mainJs.grab(src, 'const getBackendLaunch = '),
    stopPythonBackend: mainJs.grab(src, 'function stopPythonBackend('),
    startPythonBackend: mainJs.grab(src, 'const startPythonBackend = '),
    beforeQuit: mainJs.grab(src, "app.on('before-quit',"),
    windowAllClosed: mainJs.grab(src, "app.on('window-all-closed',")
  }
  const createSceneWindowSrc = mainJs.grab(src, 'async function createSceneWindow(')
  const openSceneSrc = mainJs.grab(src, "ipcMain.on('open-scene',")

  const ipc = mainJs.ipcBlocks(src)
  const realIpc = ipc.filter(b => READ_ONLY_IPC.has(b.channel) && !/writeFileSync|save[A-Z]\w*\(|dialog\./.test(b.code))
  const stubIpc = ipc.filter(b => !realIpc.includes(b))

  const body = [...Object.values(parts), ...realIpc.map(b => b.code)].join('\n\n')
  const factorySrc = `// Taken from ${src.file} at ${new Date().toISOString()} by the e2e harness
(function mainJs (__dirname, isDevelopment, VITE_DEV_SERVER_URL, userDataPath, customScenesPath,
  controlFilesPath, displayPreferencePath, ipcMain, spawn) {
${body}

return {
  loadStoredScenes, loadStoredControlFiles, loadDisplayPreference, getPythonConfig, startPythonBackend,
  getBackendLaunch, stopPythonBackend
}
})`
  fs.writeFileSync(path.join(OUT_DIR, 'main-js.extracted.js'), factorySrc)

  // Stubs for the handlers that write the app's user-data files or open dialogs (a scene window calls none)
  for (const b of stubIpc) {
    const stub = (event, ...args) => {
      summary.ipc.blocked.push({ channel: b.channel, t_ms: ms() })
      ipcCall(b.channel, args, 'BLOCKED by harness (writes user data, opens a dialog or a window)')
      return null
    }
    if (b.kind === 'handle') realIpcMain.handle(b.channel, stub)
    else realIpcMain.on(b.channel, stub)
  }

  const factory = evalMainJsCode(factorySrc)
  const M = factory(
    path.join(REPO_ROOT, 'electron'), true, APP_URL, APPDATA_DIR,
    path.join(APPDATA_DIR, 'customScenes.json'), path.join(APPDATA_DIR, 'controlFiles.json'),
    path.join(APPDATA_DIR, 'displayPreference.json'), loggingIpcMain, spawnLogged
  )

  const loadAt = createSceneWindowSrc.indexOf('await sceneWindow.loadURL(url)')
  const registerAt = createSceneWindowSrc.indexOf('sceneWindows.set(sceneName, sceneWindow)')
  summary.main_js = {
    file: src.file,
    extracted: Object.keys(parts),
    ipc_real: realIpc.map(b => `${b.kind}:${b.channel}`),
    ipc_stubbed: stubIpc.map(b => `${b.kind}:${b.channel}`),
    // What createSceneWindow and open-scene do, which openScene() below copies (offscreen where it
    // must). Every flag must be true (checks.mjs, harness_matches_main_js): a false flag means
    // main.js changed and openScene() no longer tests what the app does
    scene_window: {
      background_throttling_false: /backgroundThrottling:\s*false/.test(createSceneWindowSrc),
      web_preferences_match: /contextIsolation:\s*true/.test(createSceneWindowSrc) &&
        /nodeIntegration:\s*false/.test(createSceneWindowSrc) &&
        createSceneWindowSrc.includes("preload: join(__dirname, 'preload.cjs')"),
      display_choice_matches: createSceneWindowSrc.includes('displays.find(display => display.id === preferredDisplayId)') &&
        createSceneWindowSrc.includes('displays.find(display => display.id !== primaryDisplay.id) || primaryDisplay'),
      prevent_display_sleep: /powerSaveBlocker\.start\('prevent-display-sleep'\)/.test(createSceneWindowSrc),
      custom_route_matches: createSceneWindowSrc.includes('`scene/custom/${sceneName}`') &&
        ['gallery_custom_', 'physics_custom_', 'serial_custom_'].every(p => createSceneWindowSrc.includes(`sceneName.startsWith('${p}')`)),
      dev_url_matches: createSceneWindowSrc.includes('`${VITE_DEV_SERVER_URL}/#/${scenePath}`'),
      registers_after_load: loadAt >= 0 && registerAt >= 0 && loadAt < registerAt,
      open_scene_stores_data: openSceneSrc.includes('sceneConfigs.set(sceneName, sceneData)')
    }
  }
  return M
}

// Instrumentation listeners, registered before main.js's own handlers (they only record)
app.on('before-quit', () => quitEvent('before-quit', { pythonProcess: !!pythonProcess, backendStopping: !!backendStopping }))
app.on('window-all-closed', () => quitEvent('window-all-closed', { pythonProcess: !!pythonProcess }))
app.on('will-quit', () => { quitEvent('will-quit'); flushAll() })
app.on('quit', (event, exitCode) => {
  quitEvent('quit', { exitCode })
  summary.result.exit_code = exitCode
  summary.result.finished = true
  if (summary.quit.requested_ms !== null) summary.quit.duration_ms = ms() - summary.quit.requested_ms
  summary.quit.backend_exited_before_quit = summary.backend.exit !== null
  flushAll()
  writeSummary()
})

let M
try {
  M = loadMainJsCode()
  log(`main.js code loaded: ${JSON.stringify(summary.main_js)}`)
} catch (e) {
  summary.result.fatal = `cannot load ${REPO_ROOT}/electron/main.js: ${e.message}`
  log(summary.result.fatal)
  flushAll()
  writeSummary()
  app.exit(2)
}

// ---------------------------------------------------------------- WebSocket capture (renderer side of the loop)
// Records every WebSocket frame the page sends or receives through the DevTools protocol's Network
// domain, without touching the page's code: OUT_DIR/ws.jsonl (one line per frame; the frequent
// types keep only their key fields) and summary.ws (counts per direction and type, first/last time).
function startWsCapture (wc) {
  const w = summary.ws
  try {
    wc.debugger.attach('1.3')
  } catch (e) {
    w.error = `attach failed: ${e.message}`
    log(`ws capture: ${w.error}`)
    return
  }
  w.attached = true
  wc.debugger.on('detach', (event, reason) => { w.detached = { t_ms: ms(), reason } })
  wc.debugger.on('message', (event, method, params) => {
    try {
      if (method === 'Network.webSocketCreated') {
        w.sockets.push({ t_ms: ms(), url: params.url })
        sinks.ws.line(JSON.stringify({ t_ms: ms(), dir: 'created', url: params.url }))
        return
      }
      if (method === 'Network.webSocketClosed') {
        sinks.ws.line(JSON.stringify({ t_ms: ms(), dir: 'closed' }))
        return
      }
      if (method !== 'Network.webSocketFrameSent' && method !== 'Network.webSocketFrameReceived') return
      const dir = method === 'Network.webSocketFrameSent' ? 'out' : 'in'
      const payload = String(params.response?.payloadData ?? '')
      let msg = null
      try { msg = JSON.parse(payload) } catch {}
      const type = (msg && typeof msg.type === 'string') ? msg.type : '(not json)'
      const counts = dir === 'out' ? w.sent : w.received
      counts[type] = (counts[type] || 0) + 1
      const key = `${dir}:${type}`
      const t = ms()
      if (!(key in w.first_ms)) w.first_ms[key] = t
      w.last_ms[key] = t
      const d = msg?.data
      const rec = { t_ms: t, dir, type }
      if (type === 'serial_data') {
        Object.assign(rec, { seq: d?.seq, vz: d?.velocity?.z, vx: d?.velocity?.x, dth: d?.deltaTheta, ts: d?.timestamp })
      } else if (type === 'position_update') {
        Object.assign(rec, { seq: d?.seq, x: d?.x, z: d?.z, theta: d?.theta })
      } else if (type === 'position_confirm') {
        Object.assign(rec, { action: d?.action, z: d?.z, seq: d?.seq })
      } else {
        rec.msg = payload.length > 4000 ? payload.slice(0, 4000) + '...' : msg ?? payload
      }
      sinks.ws.line(JSON.stringify(rec))
    } catch (e) {
      w.error = w.error || `frame handling: ${e.message}`
    }
  })
  // Not awaited: before the window has navigated there is no page to answer; the command completes
  // once loadURL has started, long before the page opens its WebSocket (summary.ws.sockets shows it)
  w.enable_sent_ms = ms()
  wc.debugger.sendCommand('Network.enable').then(() => {
    w.enabled_ms = ms()
  }, (e) => {
    w.error = `Network.enable failed: ${e.message}`
    log(`ws capture: ${w.error}`)
  })
}

// ---------------------------------------------------------------- scene window (createSceneWindow, offscreen)
let sceneWindow = null
let sceneOpenMs = null
let lastPaint = null
const paintsPerSecond = []

function sceneUrl (sceneName) {
  // createSceneWindow: custom ids load the custom route; dev mode loads `${VITE_DEV_SERVER_URL}/#/${scenePath}`
  const scenePath = sceneName.startsWith('gallery_custom_') ||
    sceneName.startsWith('physics_custom_') ||
    sceneName.startsWith('serial_custom_')
    ? `scene/custom/${sceneName}`
    : `scene/${sceneName}`
  return `${APP_URL}/#/${scenePath}`
}

function targetDisplay () {
  // createSceneWindow's display choice: the preferred display, else the first non-primary, else primary
  const displays = screen.getAllDisplays()
  const primaryDisplay = screen.getPrimaryDisplay()
  let target
  if (preferredDisplayId !== null) target = displays.find(d => d.id === preferredDisplayId)
  if (!target) target = displays.find(d => d.id !== primaryDisplay.id) || primaryDisplay
  return target
}

async function openScene (sceneName, sceneData) {
  // ipcMain.on('open-scene'): keep the scene data for get-scene-config (not persisted: the real
  // handler also rewrites customScenes.json, which the harness never writes)
  if (sceneData) {
    if (sceneData.config || sceneData.experimentFile) sceneConfigs.set(sceneName, sceneData)
    else sceneConfigs.set(sceneName, { config: sceneData })
  }

  const display = targetDisplay()
  const describe = d => ({ id: d.id, label: d.label, bounds: d.bounds, scaleFactor: d.scaleFactor, displayFrequency: d.displayFrequency })
  summary.window.target_display = describe(display)
  summary.window.primary_display_id = screen.getPrimaryDisplay().id
  summary.window.displays = screen.getAllDisplays().map(describe)
  summary.window.preferred_display_id = preferredDisplayId
  // Electron 42+ paints offscreen pages at a scale factor of 1 unless told otherwise; before, it used
  // the primary display's. Kept, so the canvas has as many device pixels as with Electron 33
  const deviceScaleFactor = screen.getPrimaryDisplay().scaleFactor
  summary.window.offscreen_device_scale_factor = deviceScaleFactor

  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    useContentSize: true, // the page (and the WebGL canvas) is 1440x900
    frame: true,
    show: false,
    fullscreen: false,
    fullscreenable: false,
    webPreferences: {
      offscreen: { deviceScaleFactor },
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(REPO_ROOT, 'electron', 'preload.cjs')
    },
    backgroundColor: '#1a1a1a',
    titleBarStyle: 'default'
  })
  sceneWindow = win
  win.setMenuBarVisibility(false)
  // Chromium fits a new window into the display's work area; setting the size afterwards gives the
  // page the full 1440x900
  win.setContentSize(WINDOW_WIDTH, WINDOW_HEIGHT)
  summary.window.content_bounds = win.getContentBounds()
  win.webContents.setFrameRate(60)
  // Never let it on screen: hide again at once if anything shows it
  win.on('show', () => { log('VIOLATION: scene window was shown; hiding it'); summary.window.shown = true; win.hide() })
  win.on('enter-full-screen', () => { log('VIOLATION: scene window went full screen'); win.setFullScreen(false); win.hide() })

  const wc = win.webContents
  summary.window.offscreen = wc.isOffscreen()
  summary.window.frame_rate = wc.getFrameRate()
  wc.on('paint', (event, dirty, image) => {
    lastPaint = image
    if (sceneOpenMs === null) return
    const s = Math.floor((ms() - sceneOpenMs) / 1000)
    paintsPerSecond[s] = (paintsPerSecond[s] || 0) + 1
  })
  // Electron 35+ puts the details on the event (level 'debug' | 'info' | 'warning' | 'error') and
  // logs a deprecation warning when a listener declares the old positional arguments, so this one
  // declares only the event and reads those arguments only from older Electron (level 0-3)
  wc.on('console-message', function (event) {
    let level, message, line, sourceId
    if (event && typeof event.level === 'string') ({ level, message, lineNumber: line, sourceId } = event)
    else [, level, message, line, sourceId] = arguments
    // The same names as before: Chromium's level 0 ('verbose') is Electron 35's 'debug'
    const lv = typeof level === 'number' ? (['verbose', 'info', 'warning', 'error'][level] || String(level)) : (level === 'debug' ? 'verbose' : String(level))
    const r = summary.renderer
    r.console_counts[lv] = (r.console_counts[lv] || 0) + 1
    const src = sourceId ? String(sourceId).replace(APP_URL, '') : ''
    sinks.renderer.line(`${stamp()} [${lv}] ${message} (${src}:${line})`)
    if (lv === 'error') {
      r.error_count++
      if (r.errors.length < 50) r.errors.push({ t_ms: ms(), message: String(message).slice(0, 2000), source: `${src}:${line}` })
    } else if (lv === 'warning' && r.warnings.length < 50) {
      r.warnings.push({ t_ms: ms(), message: String(message).slice(0, 1000), source: `${src}:${line}` })
    }
    if (/PythonCustomScene: Component mounting/.test(message)) r.component = 'PythonCustomScene'
    else if (/CustomScene: Mounting component/.test(message) && !r.component) r.component = 'CustomScene'
    else if (/PhysicsCustomScene/.test(message) && !r.component) r.component = 'PhysicsCustomScene'
    if (/^\[Frame clock\]/.test(message)) r.frame_clock_warnings++
  })
  wc.on('render-process-gone', (event, details) => { summary.renderer.gone = { t_ms: ms(), ...details }; log(`render-process-gone ${JSON.stringify(details)}`) })
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    summary.renderer.failed_loads.push({ t_ms: ms(), errorCode, errorDescription, validatedURL, isMainFrame })
  })
  wc.on('preload-error', (event, preloadPath, error) => {
    summary.renderer.preload_errors.push({ t_ms: ms(), preloadPath, error: fmt(error).slice(0, 1000) })
  })
  wc.on('unresponsive', () => log('renderer unresponsive'))
  wc.on('dom-ready', () => { summary.window.dom_ready_ms = ms() })
  wc.on('did-finish-load', () => { summary.window.did_finish_load_ms = ms() })
  const ses = wc.session
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
    sinks.network.line(`${stamp()} ${d.statusCode} ${d.method} ${d.resourceType} ${d.url}${d.fromCache ? ' (cache)' : ''}`)
    if (d.statusCode >= 400) summary.renderer.network_errors.push({ t_ms: ms(), status: d.statusCode, url: d.url })
  })
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    sinks.network.line(`${stamp()} ERROR ${d.error} ${d.method} ${d.resourceType} ${d.url}`)
    summary.renderer.network_errors.push({ t_ms: ms(), error: d.error, url: d.url })
  })

  startWsCapture(wc)

  const url = sceneUrl(sceneName)
  summary.window.url = url
  summary.window.scene_name = sceneName
  sceneOpenMs = ms()
  summary.window.load_started_ms = sceneOpenMs
  log(`loading ${url}`)
  try {
    await win.loadURL(url)
  } catch (e) {
    log(`Failed to load scene: ${e.message}`) // main.js closes the window and gives up here
    summary.window.load_error = e.message
    win.close()
    return null
  }
  // Registered after the load, as in createSceneWindow (get-scene-config finds the window here)
  sceneWindows.set(sceneName, win)
  summary.window.registered_ms = ms()

  if (summary.main_js.scene_window.prevent_display_sleep) {
    const blockerId = powerSaveBlocker.start('prevent-display-sleep')
    summary.window.prevent_display_sleep = true
    win.on('closed', () => { if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId) })
  }
  win.on('closed', () => {
    quitEvent('scene-window-closed')
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
  })
  win.on('close', () => {
    quitEvent('scene-window-close')
    sceneWindows.delete(sceneName)
    sceneConfigs.delete(sceneName)
  })
  return win
}

// ---------------------------------------------------------------- screenshots and page state
function imageStats (img) {
  const { width, height } = img.getSize()
  const bmp = img.toBitmap() // BGRA
  if (!width || !height || bmp.length < width * height * 4) return { width, height, blank: true, reason: 'empty image' }
  const region = (x0, x1, y0, y1) => {
    let n = 0; let sum = 0; let sum2 = 0; let nonBg = 0
    const colors = new Set()
    for (let y = y0; y < y1; y += 2) { // every 2nd pixel each way keeps the main thread free
      for (let x = x0; x < x1; x += 2) {
        const i = (y * width + x) * 4
        const b = bmp[i]; const g = bmp[i + 1]; const r = bmp[i + 2]
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        n++; sum += lum; sum2 += lum * lum
        if (Math.abs(r - 0x1a) > 6 || Math.abs(g - 0x1a) > 6 || Math.abs(b - 0x1a) > 6) nonBg++
        if ((x & 7) === 0 && (y & 7) === 0) colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
      }
    }
    const mean = sum / n
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
    return { mean: +mean.toFixed(2), std: +std.toFixed(2), non_bg_fraction: +(nonBg / n).toFixed(4), distinct_colors: colors.size }
  }
  const full = region(0, width, 0, height)
  // The 3D view without the info panel (top right) and error box (centre): the left 55 %
  const scene = region(0, Math.floor(width * 0.55), 0, height)
  return { width, height, full, scene_region: scene, blank: scene.std < 3 || scene.distinct_colors < 8 }
}

async function pageState () {
  try {
    return await sceneWindow.webContents.executeJavaScript(`(() => {
      const q = s => document.querySelector(s)
      const txt = el => el ? el.innerText.trim().replace(/\\s+/g, ' ').slice(0, 1500) : null
      const c = q('canvas')
      return { href: location.href, errorOverlay: txt(q('.error-overlay')), infoPanel: txt(q('.info-panel')),
        canvas: c ? { width: c.width, height: c.height } : null, visibility: document.visibilityState }
    })()`)
  } catch (e) {
    return { error: e.message }
  }
}

async function webglInfo () {
  try {
    return await sceneWindow.webContents.executeJavaScript(`(() => {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      if (!gl) return { available: false }
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const info = { available: true, version: gl.getParameter(gl.VERSION),
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
      return info
    })()`)
  } catch (e) {
    return { error: e.message }
  }
}

async function takeShot (name) {
  if (!sceneWindow || sceneWindow.isDestroyed()) return
  const t = ms()
  const rec = { name, t_ms: t, t_scene_s: +((t - sceneOpenMs) / 1000).toFixed(2), file: `shot-${name}.png` }
  try {
    let img = await sceneWindow.webContents.capturePage()
    rec.source = 'capturePage'
    if (img.isEmpty() && lastPaint && !lastPaint.isEmpty()) { img = lastPaint; rec.source = 'last paint event' }
    fs.writeFileSync(path.join(OUT_DIR, rec.file), img.toPNG())
    Object.assign(rec, imageStats(img))
  } catch (e) {
    rec.error = e.message
    rec.blank = true
  }
  rec.paints_total = paintsPerSecond.reduce((a, b) => a + (b || 0), 0)
  rec.processing_ms = ms() - t
  summary.shots.push(rec)
  const state = await pageState()
  summary.dom.push({ name, t_ms: ms(), ...state })
  if (name === 'final') {
    // Which GL implementation actually rendered. The feature status read at app ready comes before
    // the GPU process is up, so read it again here
    try { summary.gpu.feature_status_at_end = app.getGPUFeatureStatus() } catch (e) { summary.gpu.feature_status_at_end = { error: e.message } }
    summary.gpu.webgl = await webglInfo()
  }
  log(`shot ${name}: ${JSON.stringify(rec)} page ${JSON.stringify(state)}`)
  flushAll()
  writeSummary()
}

// ---------------------------------------------------------------- run
function finishAndQuit () {
  summary.window.paints_per_second = paintsPerSecond.map(v => v || 0)
  try {
    summary.electron_processes = app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type, name: m.name || null, serviceName: m.serviceName || null }))
  } catch (e) { summary.electron_processes = { error: e.message } }
  summary.quit.requested_ms = ms()
  summary.quit.backend_alive_at_request = !!(pythonProcess && pythonProcess.exitCode === null)
  quitEvent('quit-requested', { via: QUIT_PATH })
  writeSummary()
  if (QUIT_PATH === 'close-window' && sceneWindow && !sceneWindow.isDestroyed()) {
    sceneWindow.close() // window-all-closed -> app.quit() -> before-quit
  } else {
    app.quit() // before-quit -> stopPythonBackend (graceful), then quits
  }
  // Hard stop if the quit path never finishes
  setTimeout(() => {
    summary.result.harness_timeout = true
    log('quit did not finish within 30 s; exiting')
    flushAll()
    writeSummary()
    app.exit(3)
  }, 30000).unref()
}

async function waitForFile (file, timeoutMs) {
  const t = Date.now()
  while (Date.now() - t < timeoutMs) {
    if (fs.existsSync(file)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

app.whenReady().then(async () => {
  if (!M) return
  summary.harness.ready_ms = ms()
  try {
    summary.gpu = { feature_status: app.getGPUFeatureStatus() }
    const info = await app.getGPUInfo('basic')
    summary.gpu.devices = info.gpuDevice
  } catch (e) { summary.gpu = { error: e.message } }

  // Absolute safety net: never run much longer than asked
  setTimeout(() => {
    summary.result.harness_timeout = true
    log('harness deadline reached; exiting')
    flushAll()
    writeSummary()
    app.exit(3)
  }, (MAX_DURATION_S + 90) * 1000).unref()

  if (WAIT_FOR_FILE) {
    const ok = await waitForFile(WAIT_FOR_FILE, 15000)
    summary.harness.monitor_ready_ms = ok ? ms() : null
    log(ok ? `found ${WAIT_FOR_FILE}` : `WARNING: ${WAIT_FOR_FILE} did not appear within 15 s; starting anyway`)
  }

  // main.js: app.whenReady -> loadDisplayPreference(); await startPythonBackend(); createMainWindow()
  M.loadDisplayPreference()
  Object.assign(process.env, { NODE_ENV: 'development', VITE_DEV_SERVER_PORT: String(summary.ports.app_url || '') })
  Object.assign(process.env, BACKEND_EXTRA_ENV) // reaches the backend through main.js's {...process.env}
  try {
    await M.startPythonBackend()
    summary.backend.ready = true
    summary.ports.ws = detectedWsPort
    log(`backend ready on port ${detectedWsPort}`)
  } catch (e) {
    summary.backend.start_error = e.message
    log(`backend failed to start: ${e.message}`)
  }
  if (!summary.backend.ready) {
    // Never open the scene without our own backend: get-ws-port would fall back to 8765,
    // which could be someone else's backend
    summary.quit.requested_ms = ms()
    quitEvent('quit-requested', { via: 'backend start failure' })
    writeSummary()
    app.quit()
    return
  }

  // The scene as the Serial Control tab would open it
  const stored = M.loadStoredScenes()
  const entry = stored[SCENE_ID]
  const config = entry ? entry.config : null
  if (!entry) log(`WARNING: ${SCENE_ID} not found in ${APPDATA_DIR}/customScenes.json`)
  summary.window.scene_found = !!entry
  summary.window.scene_config_name = config ? config.name : null
  const sceneData = {
    config,
    basePath: config?._basePath || null,
    experimentFile: EXPERIMENT_FILE || null
  }
  const win = await openScene(SCENE_WINDOW_ID, sceneData)
  if (!win) {
    finishAndQuit()
    return
  }

  const atScene = (s) => Math.max(0, sceneOpenMs + s * 1000 - ms())
  const shots = [['05s', 5], ['mid', DURATION_S / 2]].filter(([, s]) => s < DURATION_S).sort((a, b) => a[1] - b[1])
  for (const [name, s] of shots) setTimeout(() => takeShot(name), atScene(s))
  setTimeout(async () => {
    // Slow frames make slow trials: wait for MIN_REWARDS (quitting right after a reward also keeps
    // the quit away from a trial end)
    while (summary.backend.rewards < MIN_REWARDS && ms() - sceneOpenMs < MAX_DURATION_S * 1000) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    summary.window.scene_s = +((ms() - sceneOpenMs) / 1000).toFixed(2)
    await takeShot('final')
    finishAndQuit()
  }, atScene(DURATION_S))
})
