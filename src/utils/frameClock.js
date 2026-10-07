/**
 * Frame-clock self-check for the closed loop.
 *
 * Physics advances a fixed 1/60 s per rendered frame, so the translational VR gain equals the
 * number of frames actually rendered per second divided by 60. A display that does not refresh at
 * 60 Hz changes the gain, and so do dropped frames.
 */

const NOMINAL_HZ = 60
const TOLERANCE = 0.01  // 1 %

const sum = values => values.reduce((total, value) => total + value, 0)

/**
 * Analyze one window of requestAnimationFrame intervals.
 * @param {ArrayLike<number>} intervals - rAF intervals in ms
 * @param {Object|null} display - from window.electron.getWindowDisplayInfo(), null outside Electron
 * @returns {Object} rates, gain, dropped frames and the issues found, each with a stable `kind`
 */
export function analyzeFrameClock(intervals, display = null) {
  const sorted = Array.from(intervals).sort((a, b) => a - b)
  const n = sorted.length
  const medianMs = sorted[Math.floor(n / 2)]

  // Frames rendered per second: this is what sets the VR gain
  const effectiveHz = 1000 * n / sum(sorted)
  const gain = effectiveHz / NOMINAL_HZ
  // Refresh rate seen by the renderer: the mean of the on-time intervals. Averaging cancels the
  // 0.1 ms resolution of rAF timestamps, which would bias a median by ~1 % at high refresh rates
  const onTime = sorted.filter(value => Math.abs(value - medianMs) < 0.25 * medianMs)
  const vsyncMs = sum(onTime) / onTime.length
  const vsyncHz = 1000 / vsyncMs
  const droppedFrames = sum(sorted.map(value => Math.max(0, Math.round(value / vsyncMs) - 1)))

  const issues = []
  if (Math.abs(vsyncHz / NOMINAL_HZ - 1) > TOLERANCE) {
    issues.push({
      kind: 'rate',
      text: `Frames run at ${vsyncHz.toFixed(1)} Hz, not 60 Hz: VR gain is ${gain.toFixed(3)}x`
    })
  } else if (Math.abs(gain - 1) > TOLERANCE) {
    issues.push({
      kind: 'drops',
      text: `${droppedFrames} of ${n + droppedFrames} frames were dropped: VR gain is ${gain.toFixed(3)}x`
    })
  }

  // Electron reports refresh rates as whole numbers (59.94 Hz reads as 59), so allow 1 Hz
  const displayHz = display?.displayFrequency
  if (displayHz > 0 && Math.abs(vsyncHz - displayHz) > Math.max(1, displayHz * TOLERANCE)) {
    issues.push({
      kind: 'display',
      text: `Frames run at ${vsyncHz.toFixed(1)} Hz but the display refreshes at ${displayHz} Hz: ` +
        'make sure the rendering GPU drives the primary display and no monitor is asleep'
    })
  }
  const primaryHz = display?.primaryDisplayFrequency
  if (display && !display.isPrimary && displayHz > 0 && primaryHz > 0 && Math.abs(displayHz - primaryHz) >= 2) {
    issues.push({
      kind: 'primary',
      text: `Stimulus display (${displayHz} Hz) is not the primary display (${primaryHz} Hz); ` +
        'frames are paced by the primary display'
    })
  }

  return {
    effectiveHz,
    vsyncHz,
    gain,
    droppedFrames,
    medianMs,
    p5Ms: sorted[Math.floor(n * 0.05)],
    p95Ms: sorted[Math.floor(n * 0.95)],
    maxMs: sorted[n - 1],
    issues
  }
}

/**
 * Collects rAF timestamps and analyzes them once per window of frames, after a warm-up that skips
 * start-up hitches (shader compilation, texture uploads).
 *
 * Dropped frames become a warning only when they occur in two windows in a row, so a single hitch
 * (garbage collection, say) does not raise one; it still shows in that window's numbers.
 */
export class FrameClockMonitor {
  constructor({ windowFrames = 300, warmupFrames = 60 } = {}) {
    this.windowFrames = windowFrames  // ~5 s at 60 Hz
    this.warmupFrames = warmupFrames
    this.intervals = new Float64Array(windowFrames)
    this.frameCount = 0
    this.lastTime = null
    this.previousDrops = false
  }

  /**
   * Record one frame.
   * @param {number|undefined} tRaf - the rAF timestamp (undefined for a direct call)
   * @param {Object|null} display - see analyzeFrameClock
   * @returns {Object|null} the analysis plus `warnings` when a window completes, otherwise null
   */
  addFrame(tRaf, display = null) {
    if (tRaf === undefined) return null
    const last = this.lastTime
    this.lastTime = tRaf
    if (last === null) return null

    this.frameCount++
    if (this.frameCount <= this.warmupFrames) return null
    const i = (this.frameCount - this.warmupFrames - 1) % this.windowFrames
    this.intervals[i] = tRaf - last
    if (i !== this.windowFrames - 1) return null

    const report = analyzeFrameClock(this.intervals, display)
    const drops = report.issues.some(issue => issue.kind === 'drops')
    report.warnings = report.issues.filter(issue => issue.kind !== 'drops' || this.previousDrops)
    this.previousDrops = drops
    return report
  }
}
