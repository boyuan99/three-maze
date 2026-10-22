// One timing measurement in an exclusive bench window (DPR-27): run a command under the bench lock
// (test/e2e/lib/benchLock.mjs, mode exclusive), with the machine load recorded before, during and
// after it (tools/timing/machine-load.mjs), and write that record next to the measurement's own
// results. For timing measurements that are not Node scripts, such as the serial reader's hand-off
// latency (tools/timing/reader_handoff.py, plan item DPR-03).
//
//   node tools/timing/bench-run.mjs [--purpose TEXT] [--record FILE] [--lock-wait S] \
//        -- <command> [args ...]
//
// The command inherits stdin, stdout and stderr, and its exit code is this script's. Exit code 2:
// bad arguments, or the bench lock was not acquired within --lock-wait seconds (default 3600).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireBenchLock, BenchBusyError } from '../../test/e2e/lib/benchLock.mjs'
import { describeLoad, machineLoad, startCpuSampler } from './machine-load.mjs'

export const SCHEMA = 'three-maze/bench-run@1'

export class UsageError extends Error {}

/** { purpose, record, lockWaitS, command } from the command line (after the script's name) */
export function parseArgs (argv) {
  const split = argv.indexOf('--')
  if (split < 0 || split === argv.length - 1) throw new UsageError('no command: put it after --')
  const out = { purpose: '', record: null, lockWaitS: 3600, command: argv.slice(split + 1) }
  const options = argv.slice(0, split)
  for (let i = 0; i < options.length; i++) {
    const value = options[i + 1]
    if (options[i] === '--purpose' && value !== undefined) out.purpose = options[++i]
    else if (options[i] === '--record' && value !== undefined) out.record = options[++i]
    else if (options[i] === '--lock-wait' && value !== undefined && Number(value) >= 0) out.lockWaitS = Number(options[++i])
    else throw new UsageError(`unknown or incomplete option ${options[i]}`)
  }
  if (!out.purpose) out.purpose = out.command.map(a => path.basename(a)).join(' ').slice(0, 200)
  return out
}

/**
 * Run the command under the exclusive bench lock; resolves to the record (also written to
 * `record` when given). load and sampler are machineLoad and startCpuSampler unless replaced
 * (tests); lockOptions go to acquireBenchLock (tests: dir).
 *
 * @param {{ command: string[], purpose?: string, record?: string | null, lockWaitS?: number,
 *   load?: () => Promise<any>, sampler?: () => { stop: () => any }, log?: (m: string) => void,
 *   lockOptions?: Record<string, any> }} options
 */
export async function benchRun ({
  command, purpose = '', record = null, lockWaitS = 3600, load = machineLoad, sampler = startCpuSampler,
  log = (m) => console.error(m), lockOptions = {}
}) {
  const lock = await acquireBenchLock({ mode: 'exclusive', purpose, timeoutS: lockWaitS, log, ...lockOptions })
  try {
    const start = await load()
    log(`bench lock ${lock.id} (waited ${lock.record().waited_s} s); machine load: ${describeLoad(start)}`)
    const cpu = sampler()
    const t0 = Date.now()
    const exitCode = await new Promise(resolve => {
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit', windowsHide: true })
      child.on('error', e => { log(`cannot start ${command[0]}: ${e.message}`); resolve(127) })
      child.on('exit', code => resolve(code ?? 1))
    })
    const during = cpu.stop()
    const end = await load()
    const result = {
      schema: SCHEMA,
      purpose,
      command,
      exit_code: exitCode,
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      bench_lock: lock.record(),
      machine_load: { start, during, end }
    }
    if (record) {
      fs.mkdirSync(path.dirname(path.resolve(record)), { recursive: true })
      fs.writeFileSync(record, JSON.stringify(result, null, 2) + '\n')
    }
    return result
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------- command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`bench-run: ${e.message}`)
    process.exit(2)
  }
  try {
    const result = await benchRun(args)
    if (args.record) console.error(`bench-run: record written to ${path.resolve(args.record)}`)
    process.exitCode = result.exit_code
  } catch (e) {
    if (!(e instanceof BenchBusyError)) throw e
    console.error(`bench-run: ${e.message}`)
    process.exitCode = 2
  }
}
