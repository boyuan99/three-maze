// Frame-clock self-check (src/utils/frameClock.js) on simulated requestAnimationFrame timestamps.
import { describe, expect, it } from 'vitest'
import { FrameClockMonitor } from '../../src/utils/frameClock.js'

interface DisplayInfo {
  displayFrequency: number
  isPrimary: boolean
  primaryDisplayFrequency: number
}

interface Issue {
  kind: string
  text: string
}

interface Report {
  gain: number
  vsyncHz: number
  droppedFrames: number
  maxMs: number
  issues: Issue[]
  warnings: Issue[]
}

interface Simulation {
  hz: number
  display?: DisplayInfo | null
  windows?: number
  /** Whether the frame after vsync `k` is dropped (its interval then spans two vsyncs). */
  skip?: (k: number, random: () => number) => boolean
  /** Frame after which the renderer stalls for 100 ms (-1: no stall). */
  hitchAt?: number
  seed?: number
}

// Timestamps are clamped to 0.1 ms like Chromium's (the page is not cross-origin isolated).
function simulate({ hz, display = null, windows = 3, skip = () => false, hitchAt = -1, seed = 1 }: Simulation): Report[] {
  const monitor = new FrameClockMonitor()
  const periodMs = 1000 / hz
  const reports: Report[] = []
  let state = seed
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647
  monitor.addFrame(undefined, display)  // the first, direct animate() call
  let vsync = 0
  const frames = 1 + 60 + 300 * windows  // first timestamp + warm-up + the windows
  for (let f = 0; f < frames; f++) {
    vsync += 1
    while (skip(vsync, random)) vsync += 1
    const t = vsync * periodMs + 1000
    if (f === hitchAt) vsync += Math.round(100 / periodMs)  // a 100 ms stall before the next frame
    // addFrame is documented as returning Object; the Report interface is what these tests rely on
    const report = monitor.addFrame(Math.floor(t * 10) / 10, display) as Report | null
    if (report) reports.push(report)
  }
  return reports
}

const kinds = (report: Report) => report.warnings.map(warning => warning.kind).join(',')
const issueKinds = (report: Report) => report.issues.map(issue => issue.kind).join(',')
const d60: DisplayInfo = { displayFrequency: 60, isPrimary: true, primaryDisplayFrequency: 60 }

describe('FrameClockMonitor', () => {
  describe('60 Hz', () => {
    it('reports once per 300 frames after the warm-up', () => {
      expect(simulate({ hz: 60, display: d60 })).toHaveLength(3)
    })

    it('raises no warnings and measures gain 1.000', () => {
      const reports = simulate({ hz: 60, display: d60 })
      expect(reports.map(kinds)).toEqual(['', '', ''])
      for (const report of reports) expect(Math.abs(report.gain - 1)).toBeLessThan(0.001)
    })
  })

  describe('59.94 Hz', () => {
    it('raises no warnings when Electron reports the display as 59 Hz', () => {
      const reports = simulate({ hz: 59.94, display: { ...d60, displayFrequency: 59, primaryDisplayFrequency: 59 } })
      expect(reports.map(kinds)).toEqual(['', '', ''])
    })

    it('raises no warnings when the display is reported as 60 Hz', () => {
      expect(simulate({ hz: 59.94, display: d60 }).map(kinds)).toEqual(['', '', ''])
    })
  })

  describe('every third frame dropped (intervals P, P, 2P)', () => {
    const everyThird = { hz: 60, display: d60, skip: (k: number) => k % 4 === 3 }

    it('measures gain 0.75 from the mean frame rate', () => {
      expect(Math.abs(simulate(everyThird)[0].gain - 0.75)).toBeLessThan(0.002)
    })

    it('warns from the second window on', () => {
      const reports = simulate(everyThird)
      expect(issueKinds(reports[0])).toBe('drops')
      expect(reports.map(kinds)).toEqual(['', 'drops', 'drops'])
    })

    it('counts the dropped frames', () => {
      expect(simulate(everyThird)[0].droppedFrames).toBe(100)
    })
  })

  it('measures gain ~0.8 and warns with 25 % random drops', () => {
    const reports = simulate({ hz: 60, display: d60, skip: (_k, random) => random() < 0.25 })
    expect(reports[1].gain).toBeLessThan(0.85)
    expect(kinds(reports[1])).toBe('drops')
  })

  it('raises a rate warning with gain 2.4 and no display mismatch on a 144 Hz display', () => {
    const [report] = simulate({ hz: 144, display: { ...d60, displayFrequency: 144, primaryDisplayFrequency: 144 } })
    expect(kinds(report)).toBe('rate')
    expect(Math.abs(report.gain - 2.4)).toBeLessThan(0.005)
  })

  it('raises no false display mismatch from timestamp rounding on a 165 Hz display', () => {
    const [report] = simulate({ hz: 165, display: { ...d60, displayFrequency: 165, primaryDisplayFrequency: 165 } })
    expect(kinds(report)).toBe('rate')
  })

  it('raises rate and display warnings for the timer fallback (~56.5 Hz) on a 60 Hz display', () => {
    const [report] = simulate({ hz: 56.5, display: d60 })
    expect(kinds(report)).toBe('rate,display')
  })

  it('shows a single 100 ms stall in the numbers without a warning', () => {
    const reports = simulate({ hz: 60, display: d60, hitchAt: 200 })
    expect(issueKinds(reports[0])).toBe('drops')
    expect(kinds(reports[0])).toBe('')
    expect(kinds(reports[1])).toBe('')
    expect(issueKinds(reports[1])).toBe('')
  })

  it('raises display and primary warnings for a 75 Hz stimulus display paced by a 60 Hz primary', () => {
    const [report] = simulate({ hz: 60, display: { displayFrequency: 75, isPrimary: false, primaryDisplayFrequency: 60 } })
    expect(kinds(report)).toBe('display,primary')
  })

  it('raises no warning for a non-primary 60 Hz display next to a 59.94 Hz primary', () => {
    const [report] = simulate({ hz: 60, display: { displayFrequency: 60, isPrimary: false, primaryDisplayFrequency: 59 } })
    expect(kinds(report)).toBe('')
  })

  it('raises no display warnings when the refresh rate is unknown (0)', () => {
    const [report] = simulate({ hz: 60, display: { displayFrequency: 0, isPrimary: false, primaryDisplayFrequency: 0 } })
    expect(kinds(report)).toBe('')
  })

  it('runs the rate checks only outside Electron (no display info)', () => {
    const reports = simulate({ hz: 60, display: null })
    expect(reports).toHaveLength(3)
    expect(kinds(reports[0])).toBe('')
  })

  it('raises only the rate warning for the timer fallback (~56.5 Hz) without display info', () => {
    // The same clock on a known 60 Hz display gives 'rate,display' (see above), so this shows
    // that the display checks are skipped, not merely passed
    const [report] = simulate({ hz: 56.5, display: null })
    expect(kinds(report)).toBe('rate')
  })
})
