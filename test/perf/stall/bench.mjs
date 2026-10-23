// The stall suite's page script (ported from proto/rendering/bench.mjs, suiteWorker, :354-391, in
// three-maze-notes). One condition per page load: the scene drawn by a requestAnimationFrame loop
// on this page's main thread (mode=main) or in a dedicated worker on an OffscreenCanvas
// (mode=worker), while this page's main thread is blocked by a busy-wait of `stall` ms every
// `every` ms (a stand-in for Vue, IPC or garbage collection). The page resolves window.stallRun with
// the raw frame times; test/perf/stall/run.mjs counts them.
//
// Query: mode (main | worker), stall (ms), every (ms), frames, warm (frames before the counted ones).
import { buildScene, describeGl, runFrames } from '/scene.mjs'

const P = Object.fromEntries(new URLSearchParams(location.search))
const mode = P.mode
const stallMs = Number(P.stall)
const everyMs = Number(P.every || 1000)
const frames = Number(P.frames)
const warm = Number(P.warm ?? 60)

// Long tasks and long animation frames of this main thread, as the gate observes them (ADR-0003 1d)
const longTasks = []
for (const type of ['longtask', 'long-animation-frame']) {
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        longTasks.push({ type: e.entryType, startMs: e.startTime, durationMs: e.duration, ...(e.blockingDuration !== undefined ? { blockingMs: e.blockingDuration } : {}) })
      }
    }).observe({ type, buffered: true })
  } catch { /* entry type not supported: none recorded */ }
}

// The stalls: a busy main thread for stallMs, every everyMs, each recorded as it really ran
const stalls = []
function startStalls () {
  return setInterval(() => {
    const t0 = performance.now()
    while (performance.now() - t0 < stallMs) { /* busy */ }
    stalls.push([t0, performance.now()])
  }, everyMs)
}

async function mainThread () {
  const scene = await buildScene(document.getElementById('stimulus'))
  const timer = startStalls()
  const times = await runFrames(scene, callback => requestAnimationFrame(callback), { frames, warm })
  clearInterval(timer)
  return { ...times, gl: describeGl(scene.renderer) }
}

async function worker () {
  const canvas = document.getElementById('stimulus')
  const offscreen = canvas.transferControlToOffscreen()
  const w = new Worker('/render-worker.mjs', { type: 'module' })
  const done = new Promise((resolve, reject) => {
    w.onmessage = event => {
      if (event.data.type === 'done') resolve(event.data)
      else if (event.data.type === 'error') reject(new Error(`worker: ${event.data.message}`))
    }
    w.onerror = event => reject(new Error(`worker: ${event.message}`))
  })
  w.postMessage({ type: 'start', canvas: offscreen, frames, warm }, [offscreen])
  const timer = startStalls()
  const result = await done
  clearInterval(timer)
  w.terminate()
  return { raf: result.raf, entry: result.entry, exit: result.exit, gl: result.gl, workerTimeOrigin: result.timeOrigin }
}

async function run () {
  if (mode !== 'main' && mode !== 'worker') throw new Error(`mode must be main or worker (got ${mode})`)
  if (!(stallMs >= 0 && everyMs > 0 && frames > 0 && warm >= 1)) throw new Error('need stall >= 0, every > 0, frames > 0, warm >= 1')
  const page = { visibility: document.visibilityState, hasFocus: document.hasFocus(), devicePixelRatio, screen: [screen.width, screen.height], inner: [innerWidth, innerHeight] }
  const startedMs = performance.now()
  const result = mode === 'main' ? await mainThread() : await worker()
  return {
    mode, stallMs, everyMs, frames, warm, page, startedMs, endedMs: performance.now(),
    timeOrigin: performance.timeOrigin,
    // Arrays as plain lists, so they survive the trip to the main process
    raf: Array.from(result.raf), entry: Array.from(result.entry), exit: Array.from(result.exit),
    workerTimeOrigin: result.workerTimeOrigin ?? null,
    gl: result.gl, stalls, longTasks,
    pageAfter: { visibility: document.visibilityState, hasFocus: document.hasFocus() }
  }
}

window.stallRun = run().catch(error => ({ error: String(error?.stack ?? error) }))
