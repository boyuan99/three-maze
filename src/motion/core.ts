// Motion core: the only code that turns device samples into the agent's pose (ADR-0001 R1, R7;
// ADR-0002 Motion worker, Stamps, Clock and order). It consumes protocol-v1 device samples
// (docs/protocol/device-v1.md section 7.2) in seq order, each once, integrates the heading (it is
// the only heading integrator: the camera takes the pose record's yaw), splits each sample into
// sub-steps turned by their midpoint heading, and hands them to an injected mover. It also applies
// gain and freeze from a requested seq, teleports between samples with reset epochs, and stamps
// every event with its sample's (seq, epoch, t_dev).
//
// No wall clock and no randomness: time is the device time carried by the samples, so the same
// samples give the same poses in the motion worker, in Node and in a replay. No DOM, no Rapier:
// the mover (./mover.ts, or createFreeMover below) brings the physics.
//
// Conventions (ADR-0001 R1): lengths in scene units (1 unit = 1 cm), +Y up. Yaw 0 looks down -Z,
// positive yaw is counter-clockwise seen from above, left is -X; a sample's displacement d is
// [forward, left, dyaw] in the body frame, so at heading h it moves the agent by
// (-forward sin h - left cos h, -forward cos h + left sin h) in X and Z (as v0.3 did,
// experiments/hallway04_experiment.py:548-549).

/** Largest horizontal sub-step, scene units (ADR-0001 R3). */
export const SUB_STEP = 0.25

const UINT32 = 0x1_0000_0000
const HALF = 0x8000_0000

export type SeqSource = 'device' | 'host'

/**
 * A device sample as the link to the motion worker carries it (docs/protocol/device-v1.md
 * section 7.2). Fields the core does not use (raw, dev_flags, gap, t_host_ns) may be present.
 */
export interface DeviceSample {
  /** uint32 sample number in stream order; the next sample after 4,294,967,295 is 0. */
  seq: number
  /**
   * Who numbered the sample: `device` (protocol v1), or `host` when the rig runtime numbers the
   * samples as they arrive (profile legacy-v0.3, rule L4).
   */
  seq_source: SeqSource
  /** Device time at the end of the sample's window, integer µs, unwrapped. */
  t_dev_us: number
  /** The time `d` covers, integer µs, at least 1 (longer than one window after a gap). */
  dt_us: number
  /** Body-frame displacement: [forward cm, left cm, dyaw rad counter-clockwise from above]. */
  d: readonly [number, number, number]
}

/** One value per axis of a device sample's displacement. */
export interface Axes<T> {
  fwd: T
  left: T
  yaw: T
}

/** The pose after one sample (ADR-0001 R1). Zones and the renderer use it. */
export interface PoseRecord {
  seq: number
  epoch: number
  t_dev_us: number
  x: number
  /** Height of the feet; the eye is at feetY + eyeHeight (eyePose). */
  feetY: number
  z: number
  /** Heading, rad, not wrapped: the initial yaw plus every applied dyaw, in sample order. */
  yaw: number
  /** The mover met an obstacle during this sample. */
  contact: boolean
  airborne: boolean
}

/** The sample an event belongs to (ADR-0002 Stamps). */
export interface Stamp {
  seq: number
  epoch: number
  t_dev_us: number
}

/** Events a mover reports during a sample; the core adds the sample's stamp. */
export type MoverEvent =
  /** The ground ray found no floor below the agent (ADR-0001 R4, `fall: "gravity"`). */
  | { type: 'fall_start' }
  /** An airborne agent reached a walkable floor (ADR-0001 R4). */
  | { type: 'land' }

export type TeleportEvent = {
  type: 'teleport'
  /** The last sample before the teleport (null before the first sample). */
  seq: number | null
  /** The new epoch. */
  epoch: number
  t_dev_us: number | null
  after_seq: number | null
  cmd_id: number | null
  cause: string | null
  x: number
  feetY: number
  z: number
  yaw: number
}

export type MotionEvent =
  /**
   * The sample's seq is more than one past the last applied one. With seq_source `device` the
   * lost samples are device samples that never reached the core, wherever they were lost. With
   * seq_source `host` the rig runtime numbered the samples as they arrived, so the lost samples
   * are samples it numbered that did not reach the core; samples lost at the device do not show
   * in seq at all (the rig runtime infers those from device time, device-v1.md rule L5).
   */
  | (Stamp & { type: 'seq_gap', prev_seq: number, lost: number, seq_source: SeqSource })
  /** A sample whose seq is not after the last applied one (a duplicate or an older sample). */
  | (Stamp & { type: 'seq_regression', last_seq: number })
  /** Gain and freeze after a parameter command took effect (the acknowledgement {cmd_id, seq}). */
  | (Stamp & {
    type: 'params', cmd_id: number, apply_seq: number, gain: Axes<number>, freeze: Axes<boolean>,
  })
  | TeleportEvent
  | (Stamp & MoverEvent)

/**
 * What the core needs from a mover: the hover mover of ADR-0001 (./mover.ts), or
 * createFreeMover() where collisions do not matter. Coordinates are world coordinates.
 */
export interface Mover {
  readonly x: number
  readonly feetY: number
  readonly z: number
  readonly airborne: boolean
  /** Whether the agent met an obstacle during the last completed sample (see endSample). */
  readonly contact: boolean
  /**
   * One horizontal sub-step of a sample: moves by (dx / n, dz / n). (dx, dz) is the whole
   * sample's horizontal displacement turned to this sub-step's midpoint heading, and n the
   * sample's number of sub-steps. A sample without rotation thus passes the same (dx, dz) to each
   * of its sub-steps, as the hover prototype's per-sample move(dx, dz) did, which keeps the
   * hover mover bit for bit equal to it (test/motion/README.md).
   */
  subStep(dx: number, dz: number, n: number, emit: (event: MoverEvent) => void): void
  /** Ends a sample after its sub-steps: the airborne sweep over dt seconds (ADR-0001 R4). */
  endSample(dt: number, emit: (event: MoverEvent) => void): void
  /** Teleport: puts the feet at (x, z) on the floor near feetY and clears the airborne state. */
  place(x: number, z: number, feetY: number): void
}

export interface TeleportCommand {
  x: number
  z: number
  /** Height near which the mover looks for the floor to put the feet on; default 0. */
  feetY?: number
  /** Heading after the teleport, rad; default: unchanged. */
  yaw?: number
  /**
   * The epoch a code task sends with its command (ADR-0002 Code tasks); it must be greater than
   * the current epoch. Default: the current epoch + 1.
   */
  epoch?: number
  cmd_id?: number
  /** Why the agent was moved, for the log (for example 'trial_end'). */
  cause?: string
}

export interface ParamsCommand {
  cmd_id: number
  /**
   * The sample after which the change takes effect: the command applies after sample
   * max(apply_seq, last processed seq) (ADR-0002 Code tasks), so the next sample is the first
   * one with the new values.
   */
  apply_seq: number
  /** Per-axis gain on the device displacement, any finite number (axes not given keep theirs). */
  gain?: Partial<Axes<number>>
  /** Per-axis freeze: a frozen axis discards its displacement (the axes not given keep theirs). */
  freeze?: Partial<Axes<boolean>>
}

export interface MotionStats {
  /** Samples applied. */
  samples: number
  /** seq_source of the stream (null before the first sample). */
  seqSource: SeqSource | null
  /** Jumps in seq and the samples they skipped (see the seq_gap event for their meaning). */
  seqGaps: number
  seqLost: number
  /** Samples rejected because their seq was not after the last applied one. */
  seqRegressions: number
  /** Samples applied while at least one axis was frozen. */
  frozenSamples: number
  teleports: number
  /** Parameter commands that took effect. */
  paramChanges: number
  subSteps: number
  maxSubSteps: number
  /**
   * Fastest sample of the session: horizontal device displacement (before gain and freeze) over
   * its dt, in units per second, and that sample's seq. Not clamped (owner decision D10, a).
   */
  maxSpeed: number
  maxSpeedSeq: number | null
  /** Largest horizontal device displacement of one sample, units. */
  maxDisplacement: number
}

export interface MotionCoreOptions {
  mover: Mover
  /** Heading at the start, rad (yaw 0 looks down -Z); default 0. */
  yaw?: number
  /** Per-axis gain at the start; default 1 on every axis. */
  gain?: Partial<Axes<number>>
  /** Epoch at the start; default 0. */
  epoch?: number
  /** Receives every event, in the order it happens. */
  onEvent?: (event: MotionEvent) => void
}

export interface MotionCore {
  /**
   * Applies one sample and returns its pose record, or returns null for a sample whose seq is not
   * after the last applied one (counted, and reported as a seq_regression event). Throws on a
   * malformed sample: the link must never deliver one, and a pose built from it would be wrong.
   * Also throws when an event handler calls it while it runs.
   */
  apply(sample: DeviceSample): PoseRecord | null
  /**
   * Moves the agent between two samples and starts a new epoch; returns the teleport event.
   * Throws when an event handler calls it during apply(): the mover would then commit the rest of
   * that sample over the teleport, and the teleport event would name a pose the agent never had.
   */
  teleport(command: TeleportCommand): TeleportEvent
  /** Queues a gain or freeze change for after sample apply_seq (at once if that has passed). */
  setParams(command: ParamsCommand): void
  readonly yaw: number
  readonly epoch: number
  /** seq of the last applied sample, or null. */
  readonly lastSeq: number | null
  readonly gain: Readonly<Axes<number>>
  readonly freeze: Readonly<Axes<boolean>>
  /** Parameter commands waiting for their apply_seq. */
  readonly pending: number
  readonly stats: Readonly<MotionStats>
}

/** The camera pose for a record: the eye on the agent's axis at feet + eyeHeight, heading yaw. */
export function eyePose(record: PoseRecord, eyeHeight: number) {
  return { x: record.x, y: record.feetY + eyeHeight, z: record.z, yaw: record.yaw }
}

const isUint32 = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
  && (value as number) < UINT32
const finite = (value: unknown): value is number => typeof value === 'number'
  && Number.isFinite(value)

function checkSample(s: DeviceSample): void {
  const fail = (what: string) => {
    throw new TypeError(`device sample ${JSON.stringify(s)}: ${what}`)
  }
  if (typeof s !== 'object' || s === null) fail('must be an object')
  if (!isUint32(s.seq)) fail('seq must be an integer from 0 to 4294967295')
  if (s.seq_source !== 'device' && s.seq_source !== 'host') {
    fail("seq_source must be 'device' or 'host'")
  }
  if (!Number.isSafeInteger(s.t_dev_us) || s.t_dev_us < 0) fail('t_dev_us must be an integer >= 0')
  if (!Number.isSafeInteger(s.dt_us) || s.dt_us < 1) fail('dt_us must be an integer >= 1')
  if (!Array.isArray(s.d) || s.d.length !== 3 || !s.d.every(finite)) {
    fail('d must be three finite numbers')
  }
}

// seq is at or after target in uint32 order (within half the number range)
const reached = (seq: number, target: number) => ((seq - target) >>> 0) < HALF

/** Creates a motion core around a mover. */
export function createMotionCore(options: MotionCoreOptions): MotionCore {
  const { mover } = options
  const emit = options.onEvent ?? (() => {})
  let yaw = options.yaw ?? 0
  let epoch = options.epoch ?? 0
  if (!finite(yaw)) throw new TypeError('yaw must be a finite number')
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new TypeError('epoch must be an integer >= 0')
  }
  const gain: Axes<number> = { fwd: 1, left: 1, yaw: 1 }
  const freeze: Axes<boolean> = { fwd: false, left: false, yaw: false }
  setAxes(gain, options.gain, finite, 'gain')
  let lastSeq: number | null = null
  let lastTDev: number | null = null
  let pending: ParamsCommand[] = []
  // apply() is running: its events reach onEvent while the sample is only partly applied
  let applying = false
  const stats: MotionStats = {
    samples: 0, seqSource: null, seqGaps: 0, seqLost: 0, seqRegressions: 0, frozenSamples: 0,
    teleports: 0, paramChanges: 0, subSteps: 0, maxSubSteps: 0,
    maxSpeed: 0, maxSpeedSeq: null, maxDisplacement: 0,
  }

  function setAxes<T>(
    target: Axes<T>, values: Partial<Axes<T>> | undefined, valid: (v: unknown) => boolean,
    what: string,
  ): void {
    if (values === undefined) return
    for (const axis of Object.keys(values) as Array<keyof Axes<T>>) {
      if (!Object.hasOwn(target, axis)) {
        throw new TypeError(`${what}: unknown axis '${String(axis)}'`)
      }
      if (!valid(values[axis])) throw new TypeError(`${what}.${axis}: invalid value`)
    }
    Object.assign(target, values)
  }

  // Applies a parameter command after sample `seq` (stamped with that sample)
  function applyParams(command: ParamsCommand, seq: number): void {
    setAxes(gain, command.gain, finite, 'gain')
    setAxes(freeze, command.freeze, (v) => typeof v === 'boolean', 'freeze')
    stats.paramChanges++
    emit({
      type: 'params', seq, epoch, t_dev_us: lastTDev as number, cmd_id: command.cmd_id,
      apply_seq: command.apply_seq, gain: { ...gain }, freeze: { ...freeze },
    })
  }

  function apply(sample: DeviceSample): PoseRecord | null {
    if (applying) throw new Error('apply() called from an event handler during apply()')
    checkSample(sample)
    applying = true
    try {
      return applySample(sample)
    } finally {
      applying = false
    }
  }

  function applySample(sample: DeviceSample): PoseRecord | null {
    const { seq, t_dev_us, dt_us } = sample
    if (stats.seqSource === null) stats.seqSource = sample.seq_source
    else if (sample.seq_source !== stats.seqSource) {
      throw new TypeError(`device sample ${seq}: seq_source changed from '${stats.seqSource}' `
        + `to '${sample.seq_source}' within one stream`)
    }
    if (lastSeq !== null) {
      const step = (seq - lastSeq) >>> 0
      if (step === 0 || step >= HALF) {
        stats.seqRegressions++
        emit({ type: 'seq_regression', seq, epoch, t_dev_us, last_seq: lastSeq })
        return null
      }
      if (step > 1) {
        stats.seqGaps++
        stats.seqLost += step - 1
        emit({
          type: 'seq_gap', seq, epoch, t_dev_us, prev_seq: lastSeq, lost: step - 1,
          seq_source: sample.seq_source,
        })
      }
    }
    lastSeq = seq
    lastTDev = t_dev_us
    const stamp: Stamp = { seq, epoch, t_dev_us }
    const sink = (event: MoverEvent) => emit({ ...event, ...stamp })

    // The animal's own speed, before gain and freeze (D10: not clamped, the maximum is recorded)
    const [d0, d1, d2] = sample.d
    const displacement = Math.hypot(d0, d1)
    const speed = displacement / (dt_us / 1e6)
    if (speed > stats.maxSpeed) {
      stats.maxSpeed = speed
      stats.maxSpeedSeq = seq
    }
    if (displacement > stats.maxDisplacement) stats.maxDisplacement = displacement
    if (freeze.fwd || freeze.left || freeze.yaw) stats.frozenSamples++

    const f = freeze.fwd ? 0 : d0 * gain.fwd
    const l = freeze.left ? 0 : d1 * gain.left
    const dyaw = freeze.yaw ? 0 : d2 * gain.yaw
    const n = Math.max(1, Math.ceil(Math.hypot(f, l) / SUB_STEP))
    const yaw0 = yaw
    for (let i = 0; i < n; i++) {
      // the heading at the sub-step's midpoint; the whole sample's displacement turned to it
      const h = yaw0 + (dyaw * (i + 0.5)) / n
      const sin = Math.sin(h), cos = Math.cos(h)
      mover.subStep(-f * sin - l * cos, -f * cos + l * sin, n, sink)
    }
    yaw = yaw0 + dyaw
    mover.endSample(dt_us / 1e6, sink)
    stats.samples++
    stats.subSteps += n
    if (n > stats.maxSubSteps) stats.maxSubSteps = n

    const record: PoseRecord = {
      seq, epoch, t_dev_us, x: mover.x, feetY: mover.feetY, z: mover.z, yaw,
      contact: mover.contact, airborne: mover.airborne,
    }
    if (pending.length) {
      const waiting: ParamsCommand[] = []
      for (const command of pending) {
        if (reached(seq, command.apply_seq)) applyParams(command, seq)
        else waiting.push(command)
      }
      pending = waiting
    }
    return record
  }

  function teleport(command: TeleportCommand): TeleportEvent {
    if (applying) {
      throw new Error('teleport() called from an event handler during apply(): teleports run '
        + 'between samples')
    }
    const { x, z, feetY = 0 } = command
    if (![x, z, feetY].every(finite)) throw new TypeError('teleport: x, z and feetY must be finite')
    if (command.yaw !== undefined && !finite(command.yaw)) {
      throw new TypeError('teleport: yaw must be finite')
    }
    if (command.epoch !== undefined
      && (!Number.isSafeInteger(command.epoch) || command.epoch <= epoch)) {
      throw new TypeError(`teleport: epoch ${command.epoch} is not after the current one, ${epoch}`)
    }
    epoch = command.epoch ?? epoch + 1
    if (command.yaw !== undefined) yaw = command.yaw
    mover.place(x, z, feetY)
    stats.teleports++
    const event: TeleportEvent = {
      type: 'teleport', seq: lastSeq, epoch, t_dev_us: lastTDev, after_seq: lastSeq,
      cmd_id: command.cmd_id ?? null, cause: command.cause ?? null,
      x: mover.x, feetY: mover.feetY, z: mover.z, yaw,
    }
    emit(event)
    return event
  }

  function setParams(command: ParamsCommand): void {
    if (!finite(command.cmd_id)) throw new TypeError('setParams: cmd_id must be a number')
    if (!isUint32(command.apply_seq)) {
      throw new TypeError('setParams: apply_seq must be an integer from 0 to 4294967295')
    }
    // Check the values now, so that a bad command fails when it is sent, not samples later
    setAxes({ ...gain }, command.gain, finite, 'gain')
    setAxes({ ...freeze }, command.freeze, (v) => typeof v === 'boolean', 'freeze')
    const copy = { ...command, gain: { ...command.gain }, freeze: { ...command.freeze } }
    if (lastSeq !== null && reached(lastSeq, command.apply_seq)) applyParams(copy, lastSeq)
    else pending.push(copy)
  }

  return {
    apply,
    teleport,
    setParams,
    get yaw() { return yaw },
    get epoch() { return epoch },
    get lastSeq() { return lastSeq },
    get gain() { return gain },
    get freeze() { return freeze },
    get pending() { return pending.length },
    get stats() { return stats },
  }
}

/**
 * A mover without collisions: the agent moves exactly as commanded, on a floor at feetY, and
 * never falls. For tests of the core and for anything where geometry does not matter.
 */
export function createFreeMover(start: { x?: number, z?: number, feetY?: number } = {}): Mover {
  let x = start.x ?? 0
  let z = start.z ?? 0
  let feetY = start.feetY ?? 0
  return {
    get x() { return x },
    get feetY() { return feetY },
    get z() { return z },
    airborne: false,
    contact: false,
    subStep(dx, dz, n) {
      x += dx / n
      z += dz / n
    },
    endSample() {},
    place(nx, nz, fy) {
      x = nx
      z = nz
      feetY = fy
    },
  }
}
