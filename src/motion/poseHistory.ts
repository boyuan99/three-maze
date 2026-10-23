// Pose history and display modes (plan item MOT-13): which pose the renderer shows in a frame.
// The motion core makes one pose record per device sample (./core.ts), on device time, at the
// device's sample rate (20 samples/s for the v0.3 device); the display draws at its own frame rate.
// The render host (plan item REN-10) pushes every pose record into a history as it arrives and asks
// the history, in each frame, for the pose to show:
//
// - 'latest': the newest record. No added delay, but the view steps once per sample, a visible
//   stutter when a sample lasts several frames (the design's simulation at 20 samples/s: judder
//   198 % on a 60 Hz display, 341 % on a 144 Hz one).
// - 'smooth': the poses interpolated at a fixed delay D behind the device clock, so that the
//   record after the shown time has nearly always arrived: shown device time
//   = local time - devToLocal - D. D defaults to one sample period plus 1 ms (T + 1 ms); the rig
//   file's motion.displayDelayUs overrides it, and a session records the D it used.
//
// Which mode a session uses is the caller's choice; there is no default. The mode for paper data is
// the owner's decision D17 (three-maze-notes plan/phase1-plan.md), still open; the design's rule
// (latest when a sample period is at most half a frame), which docs/rig-file-v1.md names for a rig
// file without motion.displayMode, is not applied here for that reason.
//
// devToLocal is a leaky lower envelope of (local arrival time - device time): the smallest offset
// seen, rising by at most envelopeLeakPerS ms per second of local time (default 0.2), so that it
// follows a device clock up to 200 ppm slower than the local one; a faster device clock lowers it
// at once. Transport jitter only ever adds to an offset, so the envelope is the delay of the
// fastest delivery.
//
// The history never interpolates across an epoch (a teleport or reset, ADR-0001 R4; core.ts): the
// shown pose holds the old epoch's last record until the shown device time reaches the new
// epoch's first record and then jumps to it exactly. It never extrapolates: past the newest record
// it holds that record. The shown device time never decreases, so the shown pose never moves
// backward along the trajectory.
//
// Pure: no clock, no DOM, no worker API. Times come in as arguments: local times in milliseconds
// (the render host's frame and message timestamps), device times in µs (the pose records').

export type DisplayMode = 'latest' | 'smooth'

/** What the history needs of a pose record (core.ts PoseRecord has these fields and more). */
export interface HistoryPose {
  seq: number
  epoch: number
  /** Device time at the end of the sample, integer µs (device-v1.md section 7.2). */
  t_dev_us: number
  x: number
  feetY: number
  z: number
  /** Heading, rad, not wrapped (core.ts), so that it interpolates linearly. */
  yaw: number
}

export interface PoseHistoryOptions {
  /** 'latest' or 'smooth'; required (the mode for paper data is the owner's decision D17). */
  mode: DisplayMode
  /** The motion device's sample period T, µs (its hello's period). */
  samplePeriodUs: number
  /** The smooth mode's delay D, µs; default T + 1,000 (the rig file's motion.displayDelayUs). */
  delayUs?: number
  /** Records kept, oldest overwritten first; default 2,048 (about 2 s at 1,000 samples/s). */
  capacity?: number
  /** How fast devToLocal may rise without a lower offset, ms per s of local time; default 0.2. */
  envelopeLeakPerS?: number
}

/** The pose to draw in a frame, and what the frame log records about it. */
export interface ShownPose {
  x: number
  feetY: number
  z: number
  yaw: number
  epoch: number
  /**
   * Device time of what is shown, µs: the record's own when one record is shown as it is, the
   * interpolation time (fractional) otherwise. It never decreases from one frame to the next.
   */
  t_dev_us: number
  /** The newest record at or before the shown device time: the frame log's seq_shown. */
  seq_shown: number
  /** The records the pose is drawn from: seq_shown and the next record of its epoch, or null. */
  seq_before: number
  seq_after: number | null
  /** Weight of seq_after's record, 0 to 1 (0 when there is none). */
  alpha: number
}

export interface PoseHistory {
  readonly mode: DisplayMode
  readonly samplePeriodUs: number
  /** D of the smooth mode, µs (recorded per session; the latest mode does not use it). */
  readonly delayUs: number
  /** The current lower envelope of local minus device time, ms; null before the first record. */
  readonly devToLocalMs: number | null
  /** Records held. */
  readonly size: number
  /**
   * Adds the pose record of a sample (or of a teleport), arrived at local time tLocalMs. Records
   * come in seq order: device time never decreases, and neither does the epoch.
   */
  push(pose: HistoryPose, tLocalMs: number): void
  /** The pose to show at local time tLocalMs (a frame's time); null before the first record. */
  at(tLocalMs: number): ShownPose | null
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Creates an empty pose history. */
export function createPoseHistory(options: PoseHistoryOptions): PoseHistory {
  const { mode, samplePeriodUs } = options
  if (mode !== 'latest' && mode !== 'smooth') {
    throw new TypeError(`pose history: mode must be 'latest' or 'smooth', not ${String(mode)}`)
  }
  if (!Number.isSafeInteger(samplePeriodUs) || samplePeriodUs <= 0) {
    throw new RangeError('pose history: samplePeriodUs must be a whole number of µs above 0')
  }
  const delayUs = options.delayUs ?? samplePeriodUs + 1000
  if (!Number.isSafeInteger(delayUs) || delayUs < 0) {
    throw new RangeError('pose history: delayUs must be a whole number of µs, 0 or more')
  }
  const capacity = options.capacity ?? 2048
  if (!Number.isSafeInteger(capacity) || capacity < 2) {
    throw new RangeError('pose history: capacity must be a whole number, 2 or more')
  }
  const leak = options.envelopeLeakPerS ?? 0.2
  if (!finite(leak) || leak < 0) throw new RangeError('pose history: envelopeLeakPerS must be >= 0')

  // Ring buffer of records in arrival (seq) order: ring[(head + i) % capacity], i < size
  const ring: HistoryPose[] = new Array(capacity)
  let head = 0, size = 0
  let envelope: number | null = null, lastLocal = 0
  // the shown device time never decreases (see at())
  let shownUs = -Infinity

  const get = (i: number) => ring[(head + i) % capacity]

  function push(pose: HistoryPose, tLocalMs: number): void {
    const { seq, epoch, t_dev_us } = pose
    if (![seq, epoch, t_dev_us, pose.x, pose.feetY, pose.z, pose.yaw, tLocalMs].every(finite)) {
      throw new TypeError(`pose history: record ${JSON.stringify(pose)} at ${tLocalMs}: not finite`)
    }
    if (size > 0) {
      const last = get(size - 1)
      if (t_dev_us < last.t_dev_us) {
        throw new RangeError(`pose history: record ${seq} at device time ${t_dev_us} µs is before `
          + `the last one (${last.seq}, ${last.t_dev_us} µs)`)
      }
      if (epoch < last.epoch) {
        throw new RangeError(
          `pose history: record ${seq} has epoch ${epoch}, the last one ${last.epoch}`)
      }
    }
    const offset = tLocalMs - t_dev_us / 1000
    if (envelope === null) envelope = offset
    else envelope = Math.min(offset, envelope + (leak * Math.max(0, tLocalMs - lastLocal)) / 1000)
    lastLocal = Math.max(lastLocal, tLocalMs)
    const record: HistoryPose = {
      seq, epoch, t_dev_us, x: pose.x, feetY: pose.feetY, z: pose.z, yaw: pose.yaw,
    }
    if (size < capacity) {
      ring[(head + size) % capacity] = record
      size++
    } else {
      ring[head] = record
      head = (head + 1) % capacity
    }
  }

  // a record shown as it is, at its own device time
  const held = (r: HistoryPose): ShownPose => ({
    x: r.x, feetY: r.feetY, z: r.z, yaw: r.yaw, epoch: r.epoch, t_dev_us: r.t_dev_us,
    seq_shown: r.seq, seq_before: r.seq, seq_after: null, alpha: 0,
  })

  function at(tLocalMs: number): ShownPose | null {
    if (!finite(tLocalMs)) throw new TypeError('pose history: at() needs a finite local time')
    if (size === 0 || envelope === null) return null
    if (mode === 'latest') return held(get(size - 1))
    // the device time to show: never earlier than the last one shown, never extrapolated
    const target = (tLocalMs - envelope) * 1000 - delayUs
    const t = Math.max(target, shownUs)
    shownUs = t
    // the newest record at or before t (binary search over arrival order, device time ascending)
    let lo = 0, hi = size - 1
    if (get(0).t_dev_us > t) return held(get(0))
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (get(mid).t_dev_us <= t) lo = mid
      else hi = mid - 1
    }
    const a = get(lo)
    if (lo === size - 1) return held(a)
    const b = get(lo + 1)
    // never across an epoch: hold the old epoch's last pose until the new epoch's first record
    if (b.epoch !== a.epoch) return held(a)
    const alpha = (t - a.t_dev_us) / (b.t_dev_us - a.t_dev_us)
    return {
      x: a.x + alpha * (b.x - a.x), feetY: a.feetY + alpha * (b.feetY - a.feetY),
      z: a.z + alpha * (b.z - a.z), yaw: a.yaw + alpha * (b.yaw - a.yaw), epoch: a.epoch,
      t_dev_us: t, seq_shown: a.seq, seq_before: a.seq, seq_after: b.seq, alpha,
    }
  }

  return {
    mode,
    samplePeriodUs,
    delayUs,
    get devToLocalMs() { return envelope },
    get size() { return size },
    push,
    at,
  }
}
