// tools/timing/bench-run.mjs (DPR-27, used by plan item DPR-03's timing measurement): a command run
// under the exclusive bench lock, with the machine load recorded around it. Every test uses its own
// lock folder, never the machine's real one, and a stub instead of the machine-load snapshot.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireBenchLock, lockStatus } from '../e2e/lib/benchLock.mjs'
import { benchRun, parseArgs, SCHEMA, UsageError } from '../../tools/timing/bench-run.mjs'

const dirs: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-run-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const stubLoad = async () => ({ schema: 'three-maze/machine-load@1', cpu_busy_pct: 1, cpu_window_s: 1 })
const stubSampler = () => ({ stop: () => ({ samples: 0 }) })

describe('bench-run', () => {
  it('reads its options and the command after --', () => {
    expect(parseArgs(['--purpose', 'x', '--record', 'r.json', '--lock-wait', '5', '--', 'py', '-V']))
      .toEqual({ purpose: 'x', record: 'r.json', lockWaitS: 5, command: ['py', '-V'] })
    expect(parseArgs(['--', 'tools/a.py']).purpose).toBe('a.py')
    expect(() => parseArgs(['py'])).toThrow(UsageError)
    expect(() => parseArgs(['--'])).toThrow(UsageError)
    expect(() => parseArgs(['--speed', '2', '--', 'py'])).toThrow(UsageError)
  })

  it('runs the command under the exclusive lock and records the lock and the load', async () => {
    const dir = tempDir()
    const record = path.join(dir, 'out', 'record.json')
    const messages: string[] = []
    const script = `const fs = require('fs'); const p = ${JSON.stringify(path.join(dir, 'locks'))};` +
      'fs.writeFileSync(process.argv[1], JSON.stringify(fs.readdirSync(p + "/holders"))); process.exit(3)'
    const seen = path.join(dir, 'seen.json')
    const result = await benchRun({
      command: [process.execPath, '-e', script, seen], purpose: 'test', record,
      load: stubLoad, sampler: stubSampler, log: m => messages.push(m),
      lockOptions: { dir: path.join(dir, 'locks') }
    })
    expect(result.exit_code).toBe(3)
    expect(JSON.parse(fs.readFileSync(seen, 'utf8'))).toHaveLength(1)   // held while it ran
    expect(lockStatus({ dir: path.join(dir, 'locks') }).holders).toEqual([])  // released after
    const written = JSON.parse(fs.readFileSync(record, 'utf8'))
    expect(written).toEqual(result)
    expect(written.schema).toBe(SCHEMA)
    expect(written.bench_lock.mode).toBe('exclusive')
    expect(Object.keys(written.machine_load)).toEqual(['start', 'during', 'end'])
    expect(messages[0]).toMatch(/^bench lock .*; machine load: CPU 1 %/)
  })

  it('waits for another holder of the lock', async () => {
    const dir = tempDir()
    const other = await acquireBenchLock({ dir, purpose: 'another measurement' })
    const started = Date.now()
    setTimeout(() => other.release(), 300)
    const result = await benchRun({
      command: [process.execPath, '-e', 'process.exit(0)'], load: stubLoad, sampler: stubSampler,
      log: () => {}, lockOptions: { dir, pollMs: 50 }
    })
    expect(result.exit_code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(result.bench_lock.waited_s).toBeGreaterThan(0)
  })
})
