'use strict'
// Electron main process of the stall suite (ported from proto/rendering/main.cjs in
// three-maze-notes): one run of one condition. test/perf/stall/run.mjs starts it once per run.
//
// It serves this folder, three's build (/three/) and HallwaySerialMigrated (/maze/) on a free
// port of 127.0.0.1, opens bench.html in a window of its own with a fresh profile, waits for the
// page's result (window.stallRun) and writes it, with what Electron knows about the GPU, the
// displays and the window, to STALL_OUT. It holds prevent-display-sleep while it runs.
//
// Windows (STALL_WINDOW):
//   offscreen  (default) hidden and painted offscreen at STALL_OSR_HZ (default 60) by Electron's
//              frame timer, as the e2e bench's scene window: nothing is shown. Frames follow that
//              timer, not the display, so every run on it is on a fallback clock.
//   visible    shown without focus (showInactive) on the primary display, as Evidence 1 ran; for
//              runs on the rig or with someone at the machine. Frames follow the display's clock
//              when Chromium has it (vsync-locked), else its timer fallback.
// A window that is only hidden cannot be used: in Electron 44.7.0 a hidden window that draws WebGL
// on its main thread gets only one or two requestAnimationFrame callbacks a second, while a
// worker's OffscreenCanvas in the same window keeps drawing (about 55 Hz, on Chromium's timer).
//
// Environment: STALL_OUT (result file), STALL_MODE (main | worker), STALL_MS, STALL_EVERY_MS
// (default 1000), STALL_FRAMES (default 1200), STALL_WARM (default 60), STALL_WINDOW, STALL_OSR_HZ,
// STALL_GPU (high | low | default; default high, as Evidence 1), STALL_SOFTWARE_GL=1 (SwiftShader),
// STALL_USER_DATA (profile folder, fresh), STALL_TIMEOUT_S (default 300).
const { app, BrowserWindow, powerSaveBlocker, screen } = require('electron')
const fs = require('fs')
const http = require('http')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const E = process.env
const P = {
  out: E.STALL_OUT,
  mode: E.STALL_MODE,
  stallMs: Number(E.STALL_MS),
  everyMs: Number(E.STALL_EVERY_MS || 1000),
  frames: Number(E.STALL_FRAMES || 1200),
  warm: Number(E.STALL_WARM || 60),
  window: E.STALL_WINDOW || 'offscreen',
  osrHz: Number(E.STALL_OSR_HZ || 60),
  gpu: E.STALL_GPU || 'high',
  softwareGl: E.STALL_SOFTWARE_GL === '1',
  timeoutS: Number(E.STALL_TIMEOUT_S || 300)
}

// Without a listener an error would open Electron's error dialog, a visible window
process.on('uncaughtException', (error) => {
  process.stderr.write(`stall suite: ${error && error.stack ? error.stack : error}\n`)
  process.exit(2)
})
if (!P.out || !['main', 'worker'].includes(P.mode) || !(P.stallMs >= 0)) {
  throw new Error('STALL_OUT, STALL_MODE (main | worker) and STALL_MS are required')
}
if (!['offscreen', 'visible'].includes(P.window)) throw new Error(`STALL_WINDOW must be offscreen or visible (got ${P.window})`)

if (P.gpu === 'high') app.commandLine.appendSwitch('force_high_performance_gpu')
else if (P.gpu === 'low') app.commandLine.appendSwitch('force_low_power_gpu')
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
if (P.softwareGl) app.disableHardwareAcceleration()
// A fresh profile per run: a cold shader cache, as in Evidence 1
if (E.STALL_USER_DATA) {
  fs.mkdirSync(E.STALL_USER_DATA, { recursive: true })
  app.setPath('userData', E.STALL_USER_DATA)
  app.setPath('crashDumps', path.join(E.STALL_USER_DATA, 'Crashpad'))
}

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg' }
const ROUTES = [
  ['/three/', path.join(REPO_ROOT, 'node_modules', 'three', 'build')],
  ['/maze/', path.join(REPO_ROOT, 'public', 'mazes', 'HallwaySerialMigrated')],
  ['/', __dirname]
]
function serve (req, res) {
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { res.writeHead(400).end(); return }
  const [prefix, root] = ROUTES.find(([p]) => pathname.startsWith(p))
  const file = path.resolve(root, '.' + pathname.slice(prefix.length - 1))
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  })
}

const describeDisplay = (d) => ({ id: d.id, label: d.label, bounds: d.bounds, scaleFactor: d.scaleFactor, displayFrequency: d.displayFrequency, internal: d.internal })

app.whenReady().then(async () => {
  const blocker = powerSaveBlocker.start('prevent-display-sleep')
  let gpuInfo
  try { gpuInfo = await app.getGPUInfo('basic') } catch (error) { gpuInfo = String(error) }
  const server = http.createServer(serve)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const offscreen = P.window === 'offscreen'
  const primary = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: primary.workArea.x + 40,
    y: primary.workArea.y + 40,
    width: 1280,
    height: 720,
    useContentSize: true,
    show: false,
    focusable: false,
    backgroundColor: '#000000',
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(offscreen ? { offscreen: { deviceScaleFactor: 1 } } : {})
    }
  })
  const consoleMessages = []
  win.webContents.on('console-message', (event) => {
    consoleMessages.push({ level: String(event.level), message: String(event.message).slice(0, 1000) })
  })
  let gone = null
  win.webContents.on('render-process-gone', (event, details) => { gone = details })
  if (offscreen) {
    win.on('show', () => win.hide())
    win.webContents.setFrameRate(P.osrHz)
  } else {
    win.once('ready-to-show', () => win.showInactive())
  }
  const query = new URLSearchParams({ mode: P.mode, stall: String(P.stallMs), every: String(P.everyMs), frames: String(P.frames), warm: String(P.warm) })
  let result
  try {
    await win.loadURL(`http://127.0.0.1:${server.address().port}/bench.html?${query}`)
    result = await Promise.race([
      win.webContents.executeJavaScript('window.stallRun', true),
      new Promise(resolve => setTimeout(() => resolve({ error: `no result within ${P.timeoutS} s` }), P.timeoutS * 1000))
    ])
  } catch (error) {
    result = { error: String(error && error.stack ? error.stack : error) }
  }
  // window.stallRun is missing when bench.mjs did not run (a module that failed to load, say)
  if (!result || typeof result !== 'object') result = { error: `the page gave no result (${String(result)})` }
  result.harness = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    params: P,
    window: {
      kind: P.window,
      offscreen: win.webContents.isOffscreen(),
      offscreenFrameRate: win.webContents.isOffscreen() ? win.webContents.getFrameRate() : null,
      bounds: win.getBounds(),
      visibleAtEnd: win.isVisible(),
      display: describeDisplay(screen.getDisplayMatching(win.getBounds()))
    },
    primaryDisplayId: primary.id,
    displays: screen.getAllDisplays().map(describeDisplay),
    gpuDevices: gpuInfo && gpuInfo.gpuDevice ? gpuInfo.gpuDevice : gpuInfo,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    preventDisplaySleep: powerSaveBlocker.isStarted(blocker),
    renderProcessGone: gone,
    consoleMessages
  }
  fs.writeFileSync(P.out, JSON.stringify(result))
  powerSaveBlocker.stop(blocker)
  server.close()
  win.destroy()
  app.quit()
}).catch((error) => {
  // A rejected promise only warns in Electron's main process, which would then stay up, holding the
  // bench lock, until run.mjs's timeout: report it and quit at once instead
  process.stderr.write(`stall suite: ${error && error.stack ? error.stack : error}\n`)
  process.exit(2)
})
app.on('window-all-closed', () => { /* the run above quits when it is done */ })
