'use strict'
// Electron main process of the render-host smoke test (test/render/smoke.mjs starts it). For each
// maze it opens the development page (host.html?mode=smoke) in a hidden offscreen window, waits for
// the page's result (window.renderHostSmoke) and keeps the page's console messages; then it writes
// OUT_DIR/results.json and the first frame of each maze as OUT_DIR/<maze>.png, and quits.
//
// Offscreen, as the e2e bench's scene window (test/e2e/harness/main.cjs): frames are painted at a
// fixed 60 Hz. A window that is merely hidden does not do: in Electron 44.7.0 a hidden window that
// draws WebGL on its main thread gets only one or two requestAnimationFrame callbacks a second.
//
// Environment: APP_URL (the built page's server), OUT_DIR, MAZES (comma-separated),
// SMOKE_SOFTWARE_GL=1 (render with SwiftShader), SMOKE_TIMEOUT_S (per maze, default 60).
// No window is ever shown.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const APP_URL = String(process.env.APP_URL || '').replace(/\/+$/, '')
const OUT_DIR = path.resolve(process.env.OUT_DIR || '.')
const MAZES = String(process.env.MAZES || '').split(',').filter(Boolean)
const SOFTWARE_GL = process.env.SMOKE_SOFTWARE_GL === '1'
const TIMEOUT_MS = 1000 * Number(process.env.SMOKE_TIMEOUT_S || '60')

// Without a listener, an error would open Electron's error dialog: a visible window
process.on('uncaughtException', (error) => {
  process.stderr.write(`render smoke: ${error && error.stack ? error.stack : error}\n`)
  process.exit(2)
})
if (!APP_URL || !MAZES.length) throw new Error('APP_URL and MAZES are required')

// WebGL may fall back to SwiftShader on a machine without a usable GPU, as in the e2e bench
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
if (SOFTWARE_GL) app.disableHardwareAcceleration()
fs.mkdirSync(OUT_DIR, { recursive: true })
app.setPath('userData', path.join(OUT_DIR, 'electron-userdata'))
app.setPath('crashDumps', path.join(OUT_DIR, 'electron-userdata', 'Crashpad'))

async function runMaze (maze) {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 }, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  })
  win.on('show', () => win.hide())
  win.webContents.setFrameRate(60)
  const consoleMessages = []
  const wc = win.webContents
  wc.on('console-message', (event) => {
    consoleMessages.push({ level: String(event.level), message: String(event.message).slice(0, 2000), source: `${String(event.sourceId || '').replace(APP_URL, '')}:${event.lineNumber}` })
  })
  let gone = null
  wc.on('render-process-gone', (event, details) => { gone = details })
  const started = Date.now()
  let result
  try {
    await win.loadURL(`${APP_URL}/test/render/host.html?mode=smoke&dpr=1&maze=${encodeURIComponent(maze)}`)
    result = await Promise.race([
      wc.executeJavaScript('window.renderHostSmoke', true),
      new Promise((resolve) => setTimeout(() => resolve({ maze, error: `no result within ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS))
    ])
  } catch (error) {
    result = { maze, error: String(error && error.stack ? error.stack : error) }
  }
  if (!result || typeof result !== 'object') result = { maze, error: `the page gave no result (${String(result)})` }
  for (const pose of result.poses || []) {
    if (pose.png) {
      fs.writeFileSync(path.join(OUT_DIR, `${maze}.png`), Buffer.from(pose.png.replace(/^data:image\/png;base64,/, ''), 'base64'))
      pose.png = `${maze}.png`
    }
  }
  result.consoleMessages = consoleMessages
  result.renderProcessGone = gone
  result.wallMs = Date.now() - started
  win.destroy()
  return result
}

app.whenReady().then(async () => {
  let gpu = null
  try { gpu = await app.getGPUInfo('basic') } catch (error) { gpu = String(error) }
  const results = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    softwareGl: SOFTWARE_GL,
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuDevices: gpu && gpu.gpuDevice ? gpu.gpuDevice : gpu,
    mazes: []
  }
  for (const maze of MAZES) results.mazes.push(await runMaze(maze))
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify(results, null, 2))
  app.quit()
}).catch((error) => {
  // A rejected promise only warns in Electron's main process, which would then stay up until
  // smoke.mjs's timeout: report it and quit at once instead
  process.stderr.write(`render smoke: ${error && error.stack ? error.stack : error}\n`)
  process.exit(2)
})
app.on('window-all-closed', () => { /* the loop above quits when it is done */ })
