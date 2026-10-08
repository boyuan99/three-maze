// Process helpers for the e2e runner. Every process is started with windowsHide, its PID is
// recorded, and only processes started here (and their descendants) are ever stopped: never by
// image name.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const REPO_ROOT = path.resolve(E2E_DIR, '..', '..')
export const VENV_SCRIPTS = path.join(REPO_ROOT, '.venv', 'Scripts')
export const PYTHON = path.join(VENV_SCRIPTS, 'python.exe')
export const PYTHONW = path.join(VENV_SCRIPTS, 'pythonw.exe') // no console window, ever
export const MONITOR = path.join(E2E_DIR, 'harness', 'monitor.py')
export const PROBE = path.join(E2E_DIR, 'harness', 'probe_console.py')

export function electronPath () {
  // node_modules/electron's main export is the path of the Electron executable
  return createRequire(path.join(REPO_ROOT, 'package.json'))('electron')
}

// The environment for every child: without ELECTRON_RUN_AS_NODE (electron.exe would run as plain
// Node) and without the caller's THREEMAZE_* variables (only the scenario's own reach the backend)
export function childEnv (extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || k.toUpperCase().startsWith('THREEMAZE_')) continue
    env[k] = v
  }
  return { ...env, ...extra }
}

// Every process started by the runner, for the final leftover check and for an emergency stop
export const started = []

/**
 * Start a process with stdout and stderr appended to logFile (or ignored). Returns
 * { child, pid, startedAt, exited } where exited resolves to { code, signal } (or { error }).
 */
export function startLogged (label, command, args, { logFile = null, env = childEnv(), cwd = REPO_ROOT } = {}) {
  const fd = logFile ? fs.openSync(logFile, 'a') : 'ignore'
  const startedAt = Date.now() / 1000
  let child
  try {
    child = spawn(command, args, { cwd, env, stdio: ['ignore', fd, fd], windowsHide: true })
  } finally {
    if (typeof fd === 'number') fs.closeSync(fd)
  }
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error: error.message }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const rec = { label, pid: child.pid, image: path.basename(command).toLowerCase(), startedAt, child, exited }
  started.push(rec)
  return rec
}

/** Run a process to its end (stdout and stderr captured); kills it (and only it) after timeoutMs. */
export async function runToEnd (label, command, args, { env = childEnv(), cwd = REPO_ROOT, timeoutMs = 120000, logFile = null } = {}) {
  const startedAt = Date.now() / 1000
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const rec = { label, pid: child.pid, image: path.basename(command).toLowerCase(), startedAt, child }
  started.push(rec)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; stopTree(rec) }, timeoutMs)
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  if (logFile) fs.writeFileSync(logFile, stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ''))
  return { ...result, stdout, stderr, timedOut, pid: child.pid, startedAt }
}

export function isRunning (rec) {
  return !!rec?.child && rec.child.exitCode === null && rec.child.signalCode === null
}

/** Stop a process this runner started, with its descendants (taskkill /T), if it is still running. */
export function stopTree (rec) {
  if (!isRunning(rec) || !rec.pid) return false
  spawnSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  return true
}

export function stopAll () {
  for (const rec of [...started].reverse()) stopTree(rec)
}

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** Resolves true when the process exits within timeoutMs, false otherwise. */
export async function waitExit (rec, timeoutMs) {
  if (!isRunning(rec)) return true
  return await Promise.race([rec.exited.then(() => true), sleep(timeoutMs).then(() => false)])
}

/** monitor.py alive: { pid: { exe, created } | null } */
export function aliveInfo (pids) {
  if (!pids.length) return {}
  const r = spawnSync(PYTHONW, [MONITOR, 'alive', ...pids.map(String)], { encoding: 'utf8', windowsHide: true, env: childEnv() })
  try { return JSON.parse(r.stdout) } catch { return Object.fromEntries(pids.map(p => [p, { exe: '?', created: null, error: r.stderr }])) }
}

/** monitor.py tree: live descendants of pid (pid itself may be gone), with creation times */
export function liveDescendants (pid) {
  const r = spawnSync(PYTHONW, [MONITOR, 'tree', String(pid)], { encoding: 'utf8', windowsHide: true, env: childEnv() })
  try { return JSON.parse(r.stdout) } catch { return [] }
}

/** Run the console-window probe (pythonw) and save its output; returns the visible console windows. */
export async function probeConsole (file) {
  const r = await runToEnd('console probe', PYTHONW, [PROBE], { timeoutMs: 30000 })
  fs.writeFileSync(file, r.stdout + r.stderr)
  return r.stdout.split(/\r?\n/).filter(l => l.startsWith('visible console window:'))
}
