// The bench lock (test/e2e/lib/benchLock.mjs, DPR-27): two bench runs started together must not
// overlap; the second waits, or refuses with a message that names the first. Every test uses its
// own lock folder, never the machine's real one.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireBenchLock, BenchBusyError, LOCK_DIR_ENV, lockStatus } from '../e2e/lib/benchLock.mjs'
import { freePort } from '../e2e/lib/ports.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const LOCK_MODULE = pathToFileURL(path.join(REPO, 'test', 'e2e', 'lib', 'benchLock.mjs')).href
const dirs: string[] = []

function tempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Exit {
  code: number | null
  stdout: string
  stderr: string
}

function runNode(args: string[], env: Record<string, string> = {}): Promise<Exit> {
  return new Promise(resolve => {
    const childEnv = { ...process.env, ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, args, { cwd: REPO, env: childEnv, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A separate process that takes the lock, holds it for holdMs and prints when it held it
function holderScript(dir: string, name: string, holdMs: number, mode = 'exclusive', pollMs = 100) {
  return `
    import { acquireBenchLock } from ${JSON.stringify(LOCK_MODULE)}
    const lock = await acquireBenchLock({ dir: ${JSON.stringify(dir)}, mode: ${JSON.stringify(mode)},
      purpose: ${JSON.stringify(name)}, pollMs: ${pollMs}, log: (m) => console.error(m) })
    const acquired = Date.now()
    await new Promise(r => setTimeout(r, ${holdMs}))
    const released = Date.now()
    lock.release()
    console.log(JSON.stringify({ name: ${JSON.stringify(name)}, acquired, released, waited_s: lock.record().waited_s }))
  `
}

describe('bench lock', () => {
  it('refuses a second exclusive holder that does not wait, naming the first', async () => {
    const dir = tempDir('bench-lock-')
    const first = await acquireBenchLock({ dir, purpose: 'first run' })
    try {
      const error = await acquireBenchLock({ dir, purpose: 'second run', wait: false }).catch(e => e)
      expect(error).toBeInstanceOf(BenchBusyError)
      expect(error.message).toContain('the bench is in use')
      expect(error.message).toContain(`pid ${process.pid}`)
      expect(error.message).toContain('first run')
      expect(error.message).toContain('--no-wait')
    } finally {
      first.release()
    }
    // Free again once released
    const again = await acquireBenchLock({ dir, wait: false })
    again.release()
    expect(lockStatus({ dir }).holders).toEqual([])
  })

  it('makes the second of two runs started together wait until the first has finished', async () => {
    const dir = tempDir('bench-lock-')
    const [a, b] = await Promise.all([
      runNode(['--input-type=module', '-e', holderScript(dir, 'run A', 1500)]),
      runNode(['--input-type=module', '-e', holderScript(dir, 'run B', 1500)])
    ])
    expect(a.code).toBe(0)
    expect(b.code).toBe(0)
    const [first, second] = [JSON.parse(a.stdout), JSON.parse(b.stdout)].sort((x, y) => x.acquired - y.acquired)
    // No overlap: the second acquired only after the first released
    expect(second.acquired).toBeGreaterThanOrEqual(first.released)
    expect(second.waited_s).toBeGreaterThanOrEqual(1)
    const waiter = second.name === 'run A' ? a : b
    expect(waiter.stderr).toContain('waiting for the bench lock')
    expect(waiter.stderr).toContain(first.name)
  }, 20000)

  it('gives up after the timeout with a message', async () => {
    const dir = tempDir('bench-lock-')
    const first = await acquireBenchLock({ dir, purpose: 'long run' })
    const messages: string[] = []
    try {
      const t0 = Date.now()
      const error = await acquireBenchLock({ dir, timeoutS: 1, pollMs: 100, log: m => messages.push(m) }).catch(e => e)
      expect(error).toBeInstanceOf(BenchBusyError)
      expect(error.message).toContain('still in use after waiting')
      expect(error.message).toContain('long run')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1000)
      expect(messages[0]).toContain('waiting for the bench lock')
      // The waiter's registration is gone with it
      expect(lockStatus({ dir }).waiting).toEqual([])
    } finally {
      first.release()
    }
  })

  it('removes a holder whose process is gone', async () => {
    const dir = tempDir('bench-lock-')
    const dead = await runNode(['-e', 'console.log(process.pid)'])
    const pid = Number(dead.stdout)
    fs.mkdirSync(path.join(dir, 'holders'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'holders', 'crashed.json'),
      JSON.stringify({ id: 'crashed', mode: 'exclusive', pid, started: new Date().toISOString(), purpose: 'crashed run' }))
    const lock = await acquireBenchLock({ dir, wait: false })
    expect(lock.record().stale_removed).toEqual([
      { id: 'crashed', pid, mode: 'exclusive', purpose: 'crashed run', reason: `process ${pid} is gone` }
    ])
    lock.release()
  })

  it('removes a holder without a heartbeat (a reused process id)', async () => {
    const dir = tempDir('bench-lock-')
    fs.mkdirSync(path.join(dir, 'holders'), { recursive: true })
    const file = path.join(dir, 'holders', 'old.json')
    // This test's own process is alive, as a reused process id would be
    fs.writeFileSync(file, JSON.stringify({ id: 'old', mode: 'exclusive', pid: process.pid, purpose: 'old run' }))
    const longAgo = new Date(Date.now() - 10 * 60 * 1000)
    fs.utimesSync(file, longAgo, longAgo)
    const lock = await acquireBenchLock({ dir, wait: false })
    expect(lock.record().stale_removed.map((s: { reason: string }) => s.reason)).toEqual(['no heartbeat for 600 s'])
    lock.release()
  })

  it('keeps a lock held longer than the stale limit alive with its heartbeat', async () => {
    // A timing measurement holds the lock for many minutes: only the heartbeat keeps it from
    // looking stale. Here the stale limit is 300 ms and the lock is held three times as long
    const dir = tempDir('bench-lock-')
    const long = await acquireBenchLock({ dir, purpose: 'long timing run', heartbeatMs: 50 })
    try {
      await sleep(900)
      const second = await acquireBenchLock({ dir, wait: false, staleMs: 300 }).catch(e => e)
      expect(second).toBeInstanceOf(BenchBusyError)
      expect(second.message).toContain('long timing run')
      expect(second.holders[0].heartbeat_age_s).toBeLessThan(0.3)
    } finally {
      long.release()
    }
  })

  it('releases the lock when the holding process exits without calling release()', async () => {
    const dir = tempDir('bench-lock-')
    const r = await runNode(['--input-type=module', '-e', `
      import { acquireBenchLock } from ${JSON.stringify(LOCK_MODULE)}
      await acquireBenchLock({ dir: ${JSON.stringify(dir)}, purpose: 'exits while holding the lock' })
      console.log('held')
      process.exit(3) // as run.mjs's fail() does
    `])
    expect(r.code).toBe(3)
    expect(r.stdout.trim()).toBe('held')
    expect(fs.readdirSync(path.join(dir, 'holders'))).toEqual([])
  })

  it('gives the lock to waiting exclusive runs in the order they started waiting', async () => {
    const dir = tempDir('bench-lock-')
    const first = await acquireBenchLock({ dir, purpose: 'first run' })
    const waiting = async (n: number) => {
      for (let i = 0; i < 200 && lockStatus({ dir }).waiting.length < n; i++) await sleep(25)
      expect(lockStatus({ dir }).waiting).toHaveLength(n)
    }
    // The earlier waiter polls slowly and the later one fast: only the queue lets the earlier one
    // go first
    const early = runNode(['--input-type=module', '-e', holderScript(dir, 'early waiter', 200, 'exclusive', 400)])
    await waiting(1)
    const late = runNode(['--input-type=module', '-e', holderScript(dir, 'late waiter', 200, 'exclusive', 20)])
    await waiting(2)
    first.release()
    const [e, l] = (await Promise.all([early, late])).map(r => JSON.parse(r.stdout))
    expect(e.acquired).toBeLessThan(l.acquired)
    expect(l.acquired).toBeGreaterThanOrEqual(e.released)
  }, 20000)

  it('lets shared holders run together, but not with an exclusive one', async () => {
    const dir = tempDir('bench-lock-')
    const s1 = await acquireBenchLock({ dir, mode: 'shared', purpose: 'v1 scenario 1' })
    const s2 = await acquireBenchLock({ dir, mode: 'shared', purpose: 'v1 scenario 2', wait: false })
    expect(lockStatus({ dir }).holders.map(h => h.mode)).toEqual(['shared', 'shared'])
    const refused = await acquireBenchLock({ dir, mode: 'exclusive', wait: false }).catch(e => e)
    expect(refused).toBeInstanceOf(BenchBusyError)
    expect(refused.message).toContain('v1 scenario 1')
    expect(refused.message).toContain('v1 scenario 2')
    s1.release()
    s2.release()

    const exclusive = await acquireBenchLock({ dir, purpose: 'timing run' })
    const shared = await acquireBenchLock({ dir, mode: 'shared', wait: false }).catch(e => e)
    expect(shared).toBeInstanceOf(BenchBusyError)
    expect(shared.message).toContain('timing run')
    exclusive.release()
  })

  it('lets a waiting exclusive run go before new shared holders', async () => {
    const dir = tempDir('bench-lock-')
    const shared = await acquireBenchLock({ dir, mode: 'shared', purpose: 'v1 scenario' })
    const waiter = runNode(['--input-type=module', '-e', holderScript(dir, 'timing run', 300)])
    // Wait until the exclusive run has registered as waiting
    for (let i = 0; i < 100 && lockStatus({ dir }).waiting.length === 0; i++) await new Promise(r => setTimeout(r, 50))
    expect(lockStatus({ dir }).waiting.map(w => w.purpose)).toEqual(['timing run'])
    const blocked = await acquireBenchLock({ dir, mode: 'shared', wait: false }).catch(e => e)
    expect(blocked).toBeInstanceOf(BenchBusyError)
    expect(blocked.message).toContain('timing run')
    shared.release()
    const done = await waiter
    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout).name).toBe('timing run')
  }, 20000)
})

describe.runIf(process.platform === 'win32')('test/e2e/run.mjs and the bench lock', () => {
  const RUN = path.join(REPO, 'test', 'e2e', 'run.mjs')

  it('refuses with --no-wait while another run holds the lock, before it starts anything', async () => {
    const dir = tempDir('bench-lock-')
    const out = tempDir('bench-out-')
    const other = await acquireBenchLock({ dir, purpose: 'test/e2e/run.mjs --only s1 (another worktree)' })
    try {
      const r = await runNode([RUN, '--only', 'sim', '--no-wait', '--out', out], { [LOCK_DIR_ENV]: dir })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('e2e: the bench is in use')
      expect(r.stderr).toContain('(another worktree)')
      expect(fs.readdirSync(out)).toEqual([]) // nothing written: refused before the output folder
    } finally {
      other.release()
    }
  }, 30000)

  it('waits for the lock and gives up after --lock-wait', async () => {
    const dir = tempDir('bench-lock-')
    const out = tempDir('bench-out-')
    const other = await acquireBenchLock({ dir, purpose: 'timing measurement' })
    try {
      const r = await runNode([RUN, '--only', 'sim', '--lock-wait', '1', '--out', out], { [LOCK_DIR_ENV]: dir })
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('e2e: waiting for the bench lock')
      expect(r.stderr).toContain('Gave up (--lock-wait 1)')
      expect(fs.readdirSync(out)).toEqual([])
    } finally {
      other.release()
    }
  }, 30000)
})

describe('freePort', () => {
  it('gives a port that can be bound on 127.0.0.1', async () => {
    const port = await freePort()
    expect(port).toBeGreaterThan(0)
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve()))
    })
  })
})
