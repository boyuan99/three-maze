// Rig and display information probe (plan item REN-1):
//
//   npm run rig:info                 writes out/rig-info/rig-info-<computer>-<date>-<time>.json
//   npm run rig:info -- --out FILE   writes FILE
//
// One JSON file with every display (id, label, bounds, scale factor, refresh rate; the primary
// display named by screen.getPrimaryDisplay().id), the GPUs (app.getGPUInfo('basic'), GPU feature
// status, and the WebGL vendor and renderer strings of a default, a high-performance and a WebGL 1
// context from a hidden window), the Electron, Chromium, Node (the system's and Electron's own),
// V8, three.js and Rapier versions, the Windows version and session (remote desktop or not), and
// the repository commit. It answers which GPU the rig renders on, the refresh rates, and whether
// the stimulus display is the primary display (REN-3, REN-4, the week-6 gate); every gate bundle
// includes it.
//
// Needs no Teensy, NI-DAQ or backend, opens no visible window, and changes nothing: Electron
// gets a throwaway profile folder in the system temp folder, deleted at the end. Run from Node,
// the script starts Electron on itself (without ELECTRON_RUN_AS_NODE, which would make Electron
// a plain Node); inside Electron it probes.
'use strict'
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')
const TIMEOUT_MS = 60000
const PROFILE_ENV = 'THREEMAZE_RIG_INFO_PROFILE' // the throwaway profile folder, made by the launcher
const NODE_ENV = 'THREEMAZE_RIG_INFO_NODE' // the launcher's Node version: the Node that runs the tools

function parseArgs (argv) {
  const i = argv.indexOf('--out')
  return { out: i >= 0 ? argv[i + 1] : null }
}

// ---------------------------------------------------------------- launcher (plain Node)
function launch () {
  let electron
  try {
    electron = require(require.resolve('electron', { paths: [REPO] })) // the path of electron.exe
  } catch (e) {
    console.error(`rig:info: Electron is not installed (${e.message.split('\n')[0]}). Run npm ci, then npx --no install-electron.`)
    process.exit(2)
  }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) {
    console.error(`rig:info: the Electron executable is missing (${electron}). Run npx --no install-electron (needs the network).`)
    process.exit(2)
  }
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k]
  // Chromium keeps files of its profile open until Electron has exited, so the launcher removes it
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'three-maze-rig-info-'))
  env[PROFILE_ENV] = profile
  env[NODE_ENV] = process.versions.node
  const removeProfile = () => { try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* left in the temp folder */ } }
  const child = spawn(electron, [__filename, ...process.argv.slice(2)], { cwd: process.cwd(), env, stdio: 'inherit', windowsHide: true })
  child.on('error', (e) => { console.error(`rig:info: could not start Electron: ${e.message}`); removeProfile(); process.exit(2) })
  child.on('exit', (code) => { removeProfile(); process.exit(code ?? 1) })
}

// ---------------------------------------------------------------- probe (inside Electron)
// Runs in the hidden page: the WebGL strings of three kinds of context
const WEBGL_PROBE = `(() => {
  const probe = (kind, attributes) => {
    try {
      const gl = document.createElement('canvas').getContext(kind, attributes)
      if (!gl) return { error: kind + ' not available' }
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const out = {
        context: kind, power_preference: attributes.powerPreference || 'default',
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
        masked_renderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION),
        shading_language: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        unmasked_available: !!ext
      }
      const lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
      return out
    } catch (e) { return { error: String(e && e.message || e) } }
  }
  return {
    default: probe('webgl2', {}),
    high_performance: probe('webgl2', { powerPreference: 'high-performance' }),
    webgl1: probe('webgl', {}),
    device_pixel_ratio: window.devicePixelRatio
  }
})()`

function git (args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function packageVersion (name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

function stamp (d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function probe () {
  const { app, BrowserWindow, screen } = require('electron')
  const args = parseArgs(process.argv.slice(2))
  const profile = process.env[PROFILE_ENV] || fs.mkdtempSync(path.join(os.tmpdir(), 'three-maze-rig-info-'))
  app.setPath('userData', profile) // never the app's own profile
  app.on('window-all-closed', () => {}) // quit only when done
  const errors = []
  const done = (code) => app.exit(code)
  const timer = setTimeout(() => { console.error(`rig:info: no result after ${TIMEOUT_MS / 1000} s`); done(1) }, TIMEOUT_MS)

  app.whenReady().then(async () => {
    const takenAt = new Date()
    const displays = screen.getAllDisplays()
    const primaryId = screen.getPrimaryDisplay().id
    let gpuInfo = null
    try { gpuInfo = await app.getGPUInfo('basic') } catch (e) { errors.push(`app.getGPUInfo('basic'): ${e.message}`) }
    let gpuFeatureStatus = null
    try { gpuFeatureStatus = app.getGPUFeatureStatus() } catch (e) { errors.push(`app.getGPUFeatureStatus(): ${e.message}`) }
    let webgl = null
    const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    try {
      await win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>rig-info</title>')
      webgl = await win.webContents.executeJavaScript(WEBGL_PROBE)
    } catch (e) {
      errors.push(`WebGL probe: ${e.message}`)
    } finally {
      win.destroy()
    }
    const { formatRigInfo, describeRigInfo } = await import('./rig-info-format.mjs')
    const info = formatRigInfo({
      takenAt: takenAt.toISOString(),
      host: os.hostname(),
      displays,
      primaryId,
      gpuInfo,
      gpuFeatureStatus,
      webgl,
      versions: {
        electron: process.versions.electron,
        chromium: process.versions.chrome,
        node: process.env[NODE_ENV] || null, // the system Node (npm run, the timing tools)
        node_in_electron: process.versions.node,
        v8: process.versions.v8,
        three: packageVersion('three'),
        rapier: packageVersion('@dimforge/rapier3d-compat')
      },
      system: {
        os: os.version(),
        release: os.release(),
        system_version: process.getSystemVersion(),
        arch: os.arch(),
        session: process.env.SESSIONNAME ?? null
      },
      repo: {
        commit: git(['rev-parse', 'HEAD']),
        describe: git(['describe', '--tags', '--always', '--dirty']),
        package_version: JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version
      },
      errors
    })
    const out = path.resolve(args.out || path.join(REPO, 'out', 'rig-info', `rig-info-${os.hostname()}-${stamp(takenAt)}.json`))
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n')
    console.log(`rig information (${info.displays.length} display(s), ${info.warnings.length} warning(s)):`)
    console.log(describeRigInfo(info))
    console.log(`written to ${out}`)
    clearTimeout(timer)
    done(0)
  }).catch((e) => {
    console.error(`rig:info: ${e.stack || e}`)
    done(1)
  })
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) probe()
else launch()
