// The stall suite's counting and labelling (test/perf/stall/run.mjs; plan item REN-16) on synthetic
// frame times. The suite itself runs by hand in Electron (npm run test:stall); these tests check
// that its glue gives the gate's counts (tools/timing/gateCounting.ts) for the frames it counts.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { clockLabel, condenseLoad, condenseLock, countRun, stats, summarize } from '../perf/stall/run.mjs'

const P = 1000 / 60
/** The suite's results kept with the repository: Evidence 1's archived files and the runs on the pinned Electron */
const RESULTS = fileURLToPath(new URL('../perf/stall/results/', import.meta.url))

/** warm + counted frames at 60 Hz; `gaps` maps a frame index to the interval that ends at it */
function raw(frames: number, gaps: Record<number, number> = {}, entryDelay: Record<number, number> = {}) {
  const raf: number[] = []
  let t = 1000
  for (let i = 0; i < frames; i++) {
    if (i > 0) t += gaps[i] ?? P
    raf.push(t)
  }
  const entry = raf.map((r, i) => r + 0.5 + (entryDelay[i] ?? 0))
  return { mode: 'main', raf, entry, exit: entry.map(e => e + 0.3) }
}

describe('countRun', () => {
  it("counts a stall's interval as the gate does: round(interval / P) - 1 missed frames", () => {
    // 60 warm-up frames, then 1200 counted: the interval ending at frame 300 lasts 100 ms
    const counts = countRun(raw(1260, { 300: 100 }), 60)
    expect(counts.frames).toBe(1201)
    expect(counts.hz).toBeCloseTo(60, 1)
    expect(counts.raf).toMatchObject({ intervals: 1200, late: 1, missed: 5, expected: 1205 })
    expect(counts.raf.missedPct).toBeCloseTo((100 * 5) / 1205, 3)
    expect(counts.raf.maxIntervalMs).toBe(100)
    // The callback started 20 ms after its rAF timestamp: the entry interval is longer
    const late = countRun(raw(1260, { 300: 100 }, { 300: 20 }), 60)
    expect(late.entry).toMatchObject({ late: 1, missed: 6 })
    expect(late.entry.maxIntervalMs).toBe(120)
  })

  it('leaves the warm-up frames out, except the last one, which opens the first counted interval', () => {
    const counts = countRun(raw(1260, { 30: 200, 59: 50 }), 60)
    expect(counts.raf).toMatchObject({ intervals: 1200, late: 0, missed: 0 })
    const first = countRun(raw(1260, { 60: 50 }), 60)
    expect(first.raf).toMatchObject({ late: 1, missed: 2 })
  })

  it('reports the rAF interval spread and the callback durations', () => {
    const counts = countRun(raw(1260), 60)
    expect(counts.spreadMs).toBeLessThan(0.001)
    expect(counts.callbackMs?.p50).toBeCloseTo(0.3, 3)
    expect(counts.netDeficit).toBeCloseTo(0, 6)
  })
})

describe('clockLabel', () => {
  const display = (displayFrequency: number) => ({ displayFrequency })

  it('labels an offscreen window a fallback clock whatever its rate', () => {
    expect(clockLabel({ window: 'offscreen', osrHz: 60, hz: 59.88, display: display(60) }))
      .toMatchObject({ label: 'fallback clock', source: 'offscreen frame timer at 60 Hz' })
  })

  it('labels a visible window vsync-locked within 1 % (at least 1 Hz) of its display, else a fallback clock', () => {
    const label = (hz: number, displayHz: number) => clockLabel({ window: 'visible', osrHz: 60, hz, display: display(displayHz) }).label
    expect(label(59.88, 60)).toBe('vsync-locked')
    expect(label(59.94, 60)).toBe('vsync-locked')
    expect(label(56.5, 60)).toBe('fallback clock')
    expect(label(55.56, 60)).toBe('fallback clock')
    expect(label(143, 144)).toBe('vsync-locked')
    expect(label(142.4, 144)).toBe('fallback clock')
    expect(clockLabel({ window: 'visible', osrHz: 60, hz: 60, display: null }).label).toBe('fallback clock')
  })
})

describe('summary', () => {
  it('gives each condition its runs, median, minimum and maximum', () => {
    const run = (stallMs: number, mode: string, missed: number) => ({
      condition: { stallMs, mode }, clock: { label: 'fallback clock' },
      counts: { hz: 60, netDeficit: missed, raf: { late: 1, missed, missedPct: missed / 10, maxIntervalMs: 50 }, entry: { missed, missedPct: missed / 10, maxIntervalMs: 60 } }
    })
    const [main, worker] = summarize([run(50, 'main', 3), run(50, 'main', 1), run(50, 'main', 2), run(50, 'worker', 0), { error: 'x' }])
    expect(main).toMatchObject({ condition: '50ms-main', runs: 3, missedRaf: { values: [3, 1, 2], median: 2, min: 1, max: 3 } })
    expect(worker).toMatchObject({ condition: '50ms-worker', runs: 1, missedRaf: { median: 0 } })
    expect(stats([3, 1, 2])).toEqual({ n: 3, mean: 2, p50: 2, p95: 3, p99: 3, max: 3 })
  })
})

describe('result files', () => {
  it('keep the machine load and the lock without the computer, other programs, command lines or local paths', () => {
    const snapshot = {
      schema: 'three-maze/machine-load@1', host: 'LAB-PC-7', cpu_busy_pct: 3.1,
      top_processes: { window_s: 1.04, cpu_pct_of_machine: true, list: [{ pid: 12, name: 'SomeApp', cpu_pct: 0.3, working_set_mb: 82 }] },
      three_maze_processes: [{ pid: 7, ppid: 1, name: 'node.exe', cmd: 'node C:/Users/someone/three-maze/x.mjs' }]
    }
    expect(condenseLoad(snapshot)).toEqual({
      schema: 'three-maze/machine-load@1', cpu_busy_pct: 3.1,
      top_processes: { window_s: 1.04, cpu_pct_of_machine: true, list: [{ cpu_pct: 0.3, working_set_mb: 82 }] },
      three_maze_processes: [{ pid: 7, ppid: 1, name: 'node.exe' }]
    })
    expect(snapshot.host).toBe('LAB-PC-7') // the full snapshot, saved to machine-load/, is left as it is
    expect(condenseLoad({ host: 'LAB-PC-7', windows_details: 'not recorded: Windows only' })).toEqual({ windows_details: 'not recorded: Windows only' })
    const lock = { id: 'a', mode: 'exclusive', dir: 'C:/Temp/lock', purpose: 'run.mjs --out C:/x', pid: 9, acquired: '2026-10-22T00:00:00.000Z', waited_s: 1.5, held_s: 300, stale_removed: [{ id: 'b' }] }
    expect(condenseLock(lock)).toEqual({ id: 'a', mode: 'exclusive', acquired: '2026-10-22T00:00:00.000Z', waited_s: 1.5, held_s: 300, stale_removed: 1 })
  })

  it('in the repository carry no computer name, program names, command lines or local paths', () => {
    const files = fs.readdirSync(RESULTS, { recursive: true, encoding: 'utf8' })
      .filter(name => name.endsWith('.json')).map(name => path.join(RESULTS, name))
    expect(files.length).toBeGreaterThan(0)
    const found: string[] = []
    const visit = (value: unknown, where: string): void => {
      if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${where}[${i}]`))
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          if (key === 'host' || key === 'cmd' || key === 'dir' || key === 'purpose') found.push(`${where}.${key}`)
          visit(item, `${where}.${key}`)
        }
        const list = (value as { top_processes?: { list?: object[] } }).top_processes?.list ?? []
        list.forEach((entry, i) => {
          if ('name' in entry || 'pid' in entry) found.push(`${where}.top_processes.list[${i}] names its program`)
        })
      } else if (typeof value === 'string' && /(^|[^A-Za-z])[A-Za-z]:[\\/]|\\\\|\/Users\//.test(value)) found.push(`${where}: ${value}`)
    }
    for (const file of files) visit(JSON.parse(fs.readFileSync(file, 'utf8')), path.relative(RESULTS, file).split(path.sep).join('/'))
    expect(found).toEqual([])
  })
})
