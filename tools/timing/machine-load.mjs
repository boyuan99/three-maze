// Machine-load record for timing results (DPR-27). Every agent stream and bench run shares one
// development PC, so a timing number means little without what else ran at the time. A snapshot
// records the whole machine's CPU load over one second, each GPU engine's utilisation, the busiest
// processes over one second, and every other running process whose command line names a three-maze
// checkout (bench runs, dev servers, backends, test runs and shells of other worktrees). A sampler
// records the CPU load every 2 s while a measurement runs.
//
//   node tools/timing/machine-load.mjs [--out FILE]     print (or write) one snapshot as JSON
//
// Windows: processes and GPU engines come from one hidden Windows PowerShell call (Get-Process,
// CIM classes Win32_Process and Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine, whose
// names do not depend on the Windows display language), plus `nvidia-smi` where it is installed.
// Elsewhere only the CPU part is recorded. Nothing is changed on the machine.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCHEMA = 'three-maze/machine-load@1'
const TOP_PROCESSES = 10
const COMMAND_LINE_CHARS = 300

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function cpuTimes () {
  let idle = 0
  let total = 0
  for (const c of os.cpus()) {
    idle += c.times.idle
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle
  }
  return { idle, total }
}

function busyPct (a, b) {
  const total = b.total - a.total
  return total > 0 ? +(100 * (1 - (b.idle - a.idle) / total)).toFixed(1) : null
}

function run (file, args, timeoutMs) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// One second between two Get-Process readings gives each process's CPU time over that second
const PS_SCRIPT = (windowMs, selfPid) => `
$ErrorActionPreference = 'Stop'
$out = @{}
$before = @{}
foreach ($p in Get-Process) { if ($p.CPU -ne $null) { $before[$p.Id] = $p.CPU } }
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds ${windowMs}
$after = Get-Process
$out.window_s = $sw.Elapsed.TotalSeconds
$out.processes = @(foreach ($p in $after) {
  if ($p.CPU -ne $null -and $before.ContainsKey($p.Id)) {
    [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; cpu_s = [double]($p.CPU - $before[$p.Id]); ws_mb = [math]::Round($p.WorkingSet64 / 1MB) }
  }
})
try {
  $out.gpu_engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine |
    Where-Object { $_.UtilizationPercentage -gt 0 } |
    ForEach-Object { [pscustomobject]@{ name = $_.Name; pct = [double]$_.UtilizationPercentage } })
} catch { $out.gpu_error = $_.Exception.Message }
try {
  # Not this PowerShell and not the process that asked, nor its ancestors (the shell that ran it)
  $all = @(Get-CimInstance Win32_Process)
  $parent = @{}
  foreach ($p in $all) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }
  $skip = @{ $PID = $true }
  $id = ${selfPid}
  for ($i = 0; $i -lt 64 -and $id -gt 0 -and -not $skip.ContainsKey($id); $i++) { $skip[$id] = $true; $id = $parent[$id] }
  $out.three_maze = @($all | Where-Object { $_.CommandLine -match 'three-maze' -and -not $skip.ContainsKey([int]$_.ProcessId) } |
    ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine } })
} catch { $out.three_maze_error = $_.Exception.Message }
$out | ConvertTo-Json -Depth 4 -Compress
`

/** GPU engine instances summed per adapter and engine type, e.g. { "luid_0x..._phys_0": { "3D": 7 } } */
export function summarizeGpuEngines (engines) {
  const byAdapter = {}
  for (const e of engines || []) {
    const m = /(luid_0x[0-9a-f]+_0x[0-9a-f]+_phys_\d+)_eng_\d+_engtype_(.*)$/i.exec(e.name || '')
    if (!m) continue
    const adapter = (byAdapter[m[1]] ||= {})
    adapter[m[2] || 'other'] = +((adapter[m[2] || 'other'] || 0) + e.pct).toFixed(1)
  }
  return byAdapter
}

async function nvidiaSmi () {
  const fields = ['name', 'utilization.gpu', 'memory.used', 'memory.total']
  const r = await run('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'], 10000)
  if (r.error) return { error: r.error.code === 'ENOENT' ? 'nvidia-smi not found' : String(r.error.message || r.error).slice(0, 300) }
  return {
    gpus: r.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [name, util, used, total] = line.split(',').map(s => s.trim())
      return { name, util_pct: Number(util), mem_used_mb: Number(used), mem_total_mb: Number(total) }
    })
  }
}

async function windowsDetails (windowMs, selfPid) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const [r, nvidia] = await Promise.all([
    run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT(windowMs, selfPid)], 60000),
    nvidiaSmi()
  ])
  let raw
  try {
    raw = JSON.parse(r.stdout)
  } catch {
    return { error: `PowerShell: ${String(r.error?.message || r.stderr || r.stdout).trim().slice(0, 500)}`, nvidia }
  }
  const cpus = os.cpus().length
  const windowS = raw.window_s || windowMs / 1000
  const top = (raw.processes || [])
    .map(p => ({ pid: p.pid, name: p.name, cpu_pct: +(100 * p.cpu_s / (windowS * cpus)).toFixed(1), working_set_mb: p.ws_mb }))
    .sort((a, b) => b.cpu_pct - a.cpu_pct)
    .slice(0, TOP_PROCESSES)
  const threeMaze = (raw.three_maze || [])
    .map(p => ({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: String(p.cmd || '').slice(0, COMMAND_LINE_CHARS) }))
  const byName = {}
  for (const p of threeMaze) byName[p.name] = (byName[p.name] || 0) + 1
  return {
    top_processes: { window_s: +windowS.toFixed(2), cpu_pct_of_machine: true, list: top },
    gpu_engines_pct: raw.gpu_error ? { error: raw.gpu_error } : summarizeGpuEngines(raw.gpu_engines),
    nvidia,
    three_maze_by_name: raw.three_maze_error ? undefined : byName,
    three_maze_processes: raw.three_maze_error ? { error: raw.three_maze_error } : threeMaze
  }
}

/**
 * One machine-load snapshot (about 3 s on Windows: the CPU second, then the process second).
 * The three-maze processes listed are the others: not this process, nor its ancestors.
 */
export async function machineLoad ({ windowMs = 1000 } = {}) {
  const takenAt = new Date().toISOString()
  // The CPU second comes first, before PowerShell starts, so it does not count PowerShell itself
  const a = cpuTimes()
  await sleep(windowMs)
  const cpuBusy = busyPct(a, cpuTimes())
  const snapshot = {
    schema: SCHEMA,
    taken_at: takenAt,
    host: os.hostname(),
    os: `${os.version()} ${os.release()} ${os.arch()}`,
    cpu_model: os.cpus()[0]?.model || '?',
    logical_cpus: os.cpus().length,
    memory_mb: { total: Math.round(os.totalmem() / 2 ** 20), free: Math.round(os.freemem() / 2 ** 20) },
    cpu_busy_pct: cpuBusy,
    cpu_window_s: windowMs / 1000
  }
  if (process.platform !== 'win32') return { ...snapshot, windows_details: 'not recorded: Windows only' }
  try {
    return { ...snapshot, ...(await windowsDetails(windowMs, process.pid)) }
  } catch (e) {
    return { ...snapshot, error: String(e.message || e) }
  }
}

/** A short line for the console: "CPU 7 %, GPU 3D 5 %, 2 other three-maze processes" */
export function describeLoad (s) {
  const parts = [`CPU ${s.cpu_busy_pct ?? '?'} % over ${s.cpu_window_s} s`]
  const engines = s.gpu_engines_pct && !s.gpu_engines_pct.error ? Object.values(s.gpu_engines_pct) : []
  if (engines.length) parts.push(`GPU 3D ${Math.max(...engines.map(e => e['3D'] || 0))} %`)
  else if (s.gpu_engines_pct) parts.push('GPU 3D 0 %')
  if (Array.isArray(s.three_maze_processes)) parts.push(`${s.three_maze_processes.length} other three-maze processes`)
  return parts.join(', ')
}

/** CPU load every intervalMs until stop(), which returns { samples, mean, p95 and max busy % } */
export function startCpuSampler (intervalMs = 2000) {
  const values = []
  let last = cpuTimes()
  const timer = setInterval(() => {
    const now = cpuTimes()
    const v = busyPct(last, now)
    if (v !== null) values.push(v)
    last = now
  }, intervalMs)
  timer.unref()
  return {
    stop () {
      clearInterval(timer)
      const s = [...values].sort((x, y) => x - y)
      const q = (p) => s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null
      return {
        interval_s: intervalMs / 1000,
        samples: s.length,
        mean_busy_pct: s.length ? +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1) : null,
        p95_busy_pct: q(0.95),
        max_busy_pct: s.length ? s[s.length - 1] : null
      }
    }
  }
}

// ---------------------------------------------------------------- command line
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out')
  const snapshot = await machineLoad()
  const text = JSON.stringify(snapshot, null, 2)
  if (i > 0 && process.argv[i + 1]) {
    fs.writeFileSync(process.argv[i + 1], text + '\n')
    console.log(`${describeLoad(snapshot)}; written to ${path.resolve(process.argv[i + 1])}`)
  } else {
    console.log(text)
  }
}
