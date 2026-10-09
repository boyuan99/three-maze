// The bench lock: one machine-wide lock that every run of the e2e bench and every timing
// measurement takes (DPR-27). Every checkout and worktree on this PC shares the bench's fixed ports
// (8765, 8795) and its CPU and GPU, so a second run at the same time either fails on a port or
// distorts the first run's timing. With the lock, the second run waits for the first (or refuses,
// if told not to wait) instead.
//
// Two modes:
//   exclusive  nothing else holds the lock: every run of test/e2e/run.mjs (its v0.3 scenarios use
//              the fixed ports, and its sim self-test asserts timing tolerances) and every timing
//              measurement
//   shared     may run alongside other shared holders, never alongside an exclusive one: for
//              functional v1 scenarios that take their ports from freePort() (lib/ports.mjs)
// A waiting exclusive run blocks new shared holders, so it cannot be starved; exclusive runs get
// the lock in the order they started waiting.
//
// The lock is a folder, by default <system temp folder>/three-maze-bench-lock (the same for every
// checkout of this user; THREEMAZE_BENCH_LOCK_DIR moves it, for tests). It holds holders/<id>.json
// and waiting/<id>.json, which are created and removed only under a short mutex (mkdir, which is
// atomic on Windows and POSIX). A holder or waiter whose process is gone, or whose heartbeat (the
// file's modification time, renewed every 10 s) is older than 2 minutes, is stale and is removed:
// a crashed or killed run never blocks the bench.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const LOCK_DIR_ENV = 'THREEMAZE_BENCH_LOCK_DIR'
const HEARTBEAT_MS = 10000
const STALE_MS = 120000
const MUTEX_STALE_MS = 10000
const REPORT_EVERY_MS = 60000

export function lockDir () {
  return path.resolve(process.env[LOCK_DIR_ENV] || path.join(os.tmpdir(), 'three-maze-bench-lock'))
}

/** The lock is not free and the caller did not wait (or stopped waiting): message says who holds it */
export class BenchBusyError extends Error {
  constructor (message, holders) {
    super(message)
    this.name = 'BenchBusyError'
    this.holders = holders
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0) // signal 0 only tests whether the process exists (also on Windows)
    return true
  } catch (e) {
    return e.code === 'EPERM' // exists, but belongs to another user
  }
}

function readRecords (dir, now, staleMs) {
  const live = []
  const stale = []
  let names = []
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code !== 'ENOENT') throw e }
  for (const name of names.filter(n => n.endsWith('.json'))) {
    const file = path.join(dir, name)
    let rec
    let mtimeMs
    try {
      mtimeMs = fs.statSync(file).mtimeMs
      const text = fs.readFileSync(file, 'utf8')
      try { rec = JSON.parse(text) } catch (e) { rec = { id: name.slice(0, -5), damaged: String(e.message || e) } }
    } catch (e) {
      if (e.code === 'ENOENT') continue // released meanwhile
      // Cannot be read right now (another program has it open): count it as held, to be safe
      live.push({ id: name.slice(0, -5), file, mode: 'unknown', purpose: `unreadable: ${e.code || e.message}` })
      continue
    }
    const ageMs = now - mtimeMs
    // Files are written under the mutex, so a damaged one is not half-written by a live run
    const reason = rec.damaged ? `damaged (${rec.damaged})`
      : !pidAlive(rec.pid) ? `process ${rec.pid} is gone`
        : ageMs > staleMs ? `no heartbeat for ${Math.round(ageMs / 1000)} s`
          : null
    ;(reason ? stale : live).push({ ...rec, file, heartbeat_age_s: +(ageMs / 1000).toFixed(1), ...(reason ? { stale_reason: reason } : {}) })
  }
  return { live, stale }
}

async function withMutex (root, fn) {
  const mutex = path.join(root, 'mutex')
  for (;;) {
    try {
      fs.mkdirSync(mutex)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        // A process that died inside the few milliseconds it holds the mutex leaves it behind
        if (Date.now() - fs.statSync(mutex).mtimeMs > MUTEX_STALE_MS) fs.rmdirSync(mutex)
      } catch { /* removed meanwhile */ }
      await sleep(10 + Math.random() * 30)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmdirSync(mutex)
  }
}

/** One line per holder, for messages: "exclusive, pid 1234, since 12:01:02 (35 s): purpose (cwd)" */
export function describeHolder (h, now = Date.now()) {
  const since = Date.parse(h.started)
  const age = Number.isFinite(since) ? ` (${Math.round((now - since) / 1000)} s)` : ''
  const time = Number.isFinite(since) ? new Date(since).toLocaleTimeString() : '?'
  return `${h.mode || '?'}, pid ${h.pid}, since ${time}${age}: ${h.purpose || '?'} (in ${h.cwd || '?'})`
}

/** The live holders and waiters, without changing anything */
export function lockStatus ({ dir = lockDir(), staleMs = STALE_MS } = {}) {
  const now = Date.now()
  return {
    dir,
    holders: readRecords(path.join(dir, 'holders'), now, staleMs).live,
    waiting: readRecords(path.join(dir, 'waiting'), now, staleMs).live
  }
}

/**
 * Take the bench lock. Resolves to a lock { id, mode, file, release(), record() } once it is held;
 * rejects with BenchBusyError if it is held by others and wait is false, or after timeoutS.
 * The lock is released by release() or, at the latest, when this process exits.
 *
 *   mode      'exclusive' (default) or 'shared'
 *   purpose   what the lock is for, shown to whoever waits (e.g. "test/e2e/run.mjs sim,s1")
 *   wait      false: refuse at once if the lock is held
 *   timeoutS  how long to wait at most (default 3600)
 *   log       called with a message when the lock is busy, then every minute while waiting
 *
 * @param {{ mode?: 'exclusive' | 'shared', purpose?: string, wait?: boolean, timeoutS?: number,
 *   log?: (message: string) => void, dir?: string, pollMs?: number, staleMs?: number,
 *   heartbeatMs?: number }} [options]
 */
export async function acquireBenchLock ({
  mode = 'exclusive', purpose = '', wait = true, timeoutS = 3600, log = () => {}, dir = lockDir(),
  pollMs = 1000, staleMs = STALE_MS, heartbeatMs = HEARTBEAT_MS
} = {}) {
  if (mode !== 'exclusive' && mode !== 'shared') throw new Error(`bench lock: unknown mode ${mode}`)
  const holdersDir = path.join(dir, 'holders')
  const waitingDir = path.join(dir, 'waiting')
  fs.mkdirSync(holdersDir, { recursive: true })
  fs.mkdirSync(waitingDir, { recursive: true })

  const id = crypto.randomUUID()
  const record = {
    id, mode, pid: process.pid, host: os.hostname(), started: null, waiting_since: new Date().toISOString(),
    purpose, cwd: process.cwd(), argv: process.argv.slice(1)
  }
  const holderFile = path.join(holdersDir, `${id}.json`)
  const waitingFile = path.join(waitingDir, `${id}.json`)
  const t0 = Date.now()
  const staleRemoved = []
  let lastReport = 0
  let waited = false

  const cleanupWaiting = () => { try { fs.unlinkSync(waitingFile) } catch { /* not waiting */ } }
  process.on('exit', cleanupWaiting)
  try {
    for (;;) {
      const outcome = await withMutex(dir, () => {
        const now = Date.now()
        const holders = readRecords(holdersDir, now, staleMs)
        const waiters = readRecords(waitingDir, now, staleMs)
        for (const s of [...holders.stale, ...waiters.stale]) {
          try { fs.unlinkSync(s.file) } catch { /* removed meanwhile */ }
          if (s.id !== id) staleRemoved.push({ id: s.id, pid: s.pid, mode: s.mode, purpose: s.purpose, reason: s.stale_reason })
        }
        const others = holders.live.filter(h => h.id !== id)
        const queue = waiters.live.filter(w => w.mode === 'exclusive')
          .sort((a, b) => (a.waiting_since < b.waiting_since ? -1 : a.waiting_since > b.waiting_since ? 1 : a.id < b.id ? -1 : 1))
        let free
        if (mode === 'exclusive') {
          // Free when no one holds it and no exclusive run has waited longer
          const ahead = queue.filter(w => w.id !== id && (w.waiting_since < record.waiting_since ||
            (w.waiting_since === record.waiting_since && w.id < id)))
          free = others.length === 0 && ahead.length === 0
        } else {
          free = !others.some(h => h.mode === 'exclusive') && queue.length === 0
        }
        if (free) {
          record.started = new Date().toISOString()
          fs.writeFileSync(holderFile, JSON.stringify(record, null, 2))
          cleanupWaiting()
          return { acquired: true }
        }
        if (mode === 'exclusive' && wait) {
          // Registered as a waiter, so that new shared holders let this run go first
          fs.writeFileSync(waitingFile, JSON.stringify(record, null, 2))
        }
        return { acquired: false, holders: others, queue: queue.filter(w => w.id !== id) }
      })
      if (outcome.acquired) break

      const now = Date.now()
      const blocking = [...outcome.holders, ...outcome.queue.map(w => ({ ...w, mode: `${w.mode} (waiting)` }))]
      const who = blocking.map(h => describeHolder(h, now)).join('; ') || 'nobody (an exclusive run is waiting)'
      if (!wait) {
        throw new BenchBusyError(`the bench is in use: ${who}. Not waiting (--no-wait); run again when it has finished.`, blocking)
      }
      if (now - t0 >= timeoutS * 1000) {
        throw new BenchBusyError(`the bench is still in use after waiting ${Math.round((now - t0) / 1000)} s: ${who}. Gave up (--lock-wait ${timeoutS}).`, blocking)
      }
      if (!waited || now - lastReport >= REPORT_EVERY_MS) {
        log(`${waited ? 'still waiting' : 'waiting'} for the bench lock (${mode}; ${Math.round((now - t0) / 1000)} s so far, ` +
          `up to ${timeoutS} s): held by ${who}`)
        lastReport = now
      }
      waited = true
      try { fs.utimesSync(waitingFile, new Date(), new Date()) } catch { /* written again next round */ }
      await sleep(pollMs)
    }
  } finally {
    cleanupWaiting()
    process.off('exit', cleanupWaiting)
  }

  // Held: renew the heartbeat until release; release at exit at the latest
  const acquiredAt = Date.now()
  let released = null // time of release
  const beat = setInterval(() => {
    try { fs.utimesSync(holderFile, new Date(), new Date()) } catch { /* see release() */ }
  }, heartbeatMs)
  beat.unref()
  const releaseSync = () => {
    if (released) return
    released = Date.now()
    clearInterval(beat)
    try { fs.unlinkSync(holderFile) } catch { /* already gone */ }
  }
  process.on('exit', releaseSync)
  return {
    id,
    mode,
    file: holderFile,
    /** For result files: which lock the measurement ran under */
    record: () => ({
      id, mode, dir, purpose, pid: process.pid,
      waited_s: +((acquiredAt - t0) / 1000).toFixed(1),
      acquired: new Date(acquiredAt).toISOString(),
      held_s: +(((released ?? Date.now()) - acquiredAt) / 1000).toFixed(1),
      stale_removed: staleRemoved
    }),
    release: () => {
      releaseSync()
      process.off('exit', releaseSync)
    }
  }
}
