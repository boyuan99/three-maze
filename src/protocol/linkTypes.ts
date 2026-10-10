// Generated from protocol/v1/*.schema.json by scripts/gen-link-types.mjs: do not edit.
// Regenerate with `npm run protocol:types`; test/frontend/protocol/linkTypes.test.ts fails
// when this file is stale. The schemas are normative (protocol/v1/SPEC.md); these types
// do not express their patterns and ranges, so validate with src/protocol/validate.js.

/**
 * Identifier of a world, zone, spawn, asset, experiment or software component: the scene-file id
 * grammar. No slash, no backslash, no .py name.
 */
export type Id = string

/**
 * The id of a request and the re of its reply: chosen by the requester, unique among its open
 * requests on one connection.
 */
export type RequestId = string

/**
 * Opaque session name chosen by the rig runtime, for example 2026-10-23T14-03-11Z_m12. It is a
 * name, not a folder: the runtime alone maps it to files.
 */
export type SessionId = string

/** A device's own id as its hello line reports it (device protocol v1, section 4.1). */
export type DeviceId = string

/** <major>.<minor> of this protocol, for example 1.0. */
export type ProtocolVersion = string

/**
 * Version of a program or library as it reports itself, for example 0.169.0, 44.7.0 or
 * 152.0.7444.59.
 */
export type SoftwareVersion = string

/**
 * 128-bit session token as 32 lower-case hexadecimal digits (reserved; checked from DPR-16a on).
 */
export type Token = string

/** SHA-256 digest as 64 lower-case hexadecimal digits. */
export type Sha256 = string

/**
 * JSON Pointer (RFC 6901) into a message, for example /data/samples/3/seq. Segments are property
 * names or array indices; no dot, colon or backslash, so a file path cannot pass as a pointer.
 */
export type Pointer = string

/**
 * Short human-readable text in one line: no control characters (U+0000 to U+001F, U+007F to
 * U+009F), no line or paragraph separator (U+2028, U+2029), no slash and no backslash (so no path
 * or URL), no .py name.
 */
export type Text = string

/**
 * A time in whole microseconds on a monotonic clock: perf_counter_ns() // 1000 in the rig runtime,
 * Math.round(performance.now() * 1000) in JavaScript, the unwrapped device clock for t_dev_us.
 * Never a wall-clock time.
 */
export type TimeUs = number

/** The envelope's t: when the sender sent the message, on the sender's own monotonic clock. */
export type MessageTime = TimeUs

/** A duration in whole microseconds. */
export type DurationUs = number

/** A non-negative integer that JSON carries exactly in every language (at most 2^53 - 1). */
export type Count = number

/**
 * Device-sample sequence number: uint32, wrapping from 4294967295 to 0 (device protocol v1, D3 and
 * section 7.2).
 */
export type Seq = number

/**
 * Teleport and reset counter (ADR-0002, Motion worker): 0 at session start, +1 at every teleport or
 * reset the motion worker applies.
 */
export type Epoch = number

/**
 * Id of the world a record belongs to. Phase 1 sessions have exactly one world; the field is there
 * so that world switching (phase 2) needs no new field (plan item TS-09).
 */
export type WorldId = Id

/** A program and its version. */
export interface Software {
  impl: Id
  version: SoftwareVersion
}

/**
 * Versions of the components a client runs, by component id, for example {"electron": "44.7.0",
 * "three": "0.169.0", "rapier3d-compat": "0.14.0"} (the session record keeps them, plan item
 * DPR-08a).
 */
export type Versions = Record<string, SoftwareVersion>

/**
 * The motion device's profile and guarantee level, as the session record states them (device
 * protocol v1, sections 8.2 and 8.3).
 */
export interface MotionDevice {
  /** How the runtime reads the device: v1 or legacy-v0.3. */
  profile: 'v1' | 'legacy-v0.3'
  /** What the session can claim about lost samples. */
  completeness: 'counted' | 'inferred' | 'received'
  /** What the session can claim about corrupted samples. */
  integrity: 'crc8' | 'parse-only'
  /** Who numbered the samples: the device, or the runtime as they arrived. */
  seq_source: 'device' | 'host'
  /** Whose clock t_dev_us is: the device's, or the runtime's at receipt. */
  time_source: 'device' | 'host'
  /** Declared sample period. */
  period_us: number
  /** Number of raw count axes per sample. */
  n_axes?: number
  /** The device's own id, when its hello line gave one. */
  device_id?: DeviceId
}

export interface HelloDataBase {
  /** Protocol name. */
  protocol: 'three-maze/link'
  /** The highest version of this protocol the client speaks, for example 1.0. */
  version: ProtocolVersion
  /**
   * motion: the motion worker of the scene window (at most one per session). monitor: an observer
   * such as the control window.
   */
  role: 'motion' | 'monitor'
  /** The client program and its version. */
  client: Software
  /**
   * The session the client was started for. Required for role motion: the runtime refuses a motion
   * client of another session.
   */
  session?: SessionId
  /**
   * Versions of the components the client runs (renderer, physics, browser engine), for the session
   * record. Required for role motion.
   */
  versions?: Versions
  /**
   * Reserved for plan item DPR-16a: the session token the runtime handed to the client. Runtimes
   * before DPR-16a ignore it.
   */
  token?: Token
}

export type HelloData = HelloDataBase & (
  | {
      role: 'motion'
      session: SessionId
      versions: Versions
    }
  | { role: 'monitor' }
)

/**
 * Client to runtime, the first message on a connection (SPEC.md section 5). A request: the runtime
 * answers with welcome or error.
 */
export interface HelloMessage {
  type: 'hello'
  t: MessageTime
  id: RequestId
  data: HelloData
}

export interface WelcomeDataBase {
  protocol: 'three-maze/link'
  /**
   * The version both sides use from now on: the hello's major version with the lower of the two
   * minor versions.
   */
  version: string
  /** The role granted, the one the hello asked for. */
  role: 'motion' | 'monitor'
  /** Name the runtime gives this connection in its logs. */
  client_id: Id
  /** The rig runtime program and its version. */
  runtime: Software
  /**
   * Heartbeat interval: each side sends a heartbeat on a timer of this period (SPEC.md section 6).
   */
  heartbeat_ms: 20
  /**
   * The runtime's watchdog acts when no heartbeat from the motion client has arrived for longer
   * than this (ADR-0002, Rig runtime).
   */
  watchdog_ms: 100
  /** The epoch the client starts with: 0 for a new session. */
  epoch: Epoch
  /** The current session, if one is configured. Required for role motion. */
  session?: SessionId
  /** The world the session starts in (phase 1: its only world). Required for role motion. */
  world?: WorldId
  /** The motion device and the guarantees its samples carry. Required for role motion. */
  device?: MotionDevice
}

export type WelcomeData = WelcomeDataBase & (
  | {
      role: 'motion'
      session: SessionId
      world: WorldId
      device: MotionDevice
    }
  | { role: 'monitor' }
)

/** Runtime to client: the reply to an accepted hello (SPEC.md section 5). */
export interface WelcomeMessage {
  type: 'welcome'
  t: MessageTime
  re: RequestId
  data: WelcomeData
}

export interface HeartbeatData {
  /**
   * Heartbeat number on this connection and in this direction: 0 for the first, then +1 for each,
   * so a receiver can count missing heartbeats.
   */
  n: Count
  /**
   * From the motion client: the last sample it has processed. From the runtime: the last sample it
   * has sent. Absent before the first sample.
   */
  last_seq?: Seq
  /** From the motion client: its current epoch. */
  epoch?: Epoch
}

/**
 * Both directions, on a timer of period heartbeat_ms (20 ms) from welcome until the connection
 * closes (SPEC.md section 6). The runtime's watchdog listens to the motion client's heartbeats.
 */
export interface HeartbeatMessage {
  type: 'heartbeat'
  t: MessageTime
  data: HeartbeatData
}

export type AckData = Record<string, never>

/**
 * Either direction: the reply to a request that was carried out (SPEC.md section 12). The requests
 * that 1.0 adds with plan item DPR-05b define the fields an ack carries; the core subset defines
 * none.
 */
export interface AckMessage {
  type: 'ack'
  t: MessageTime
  re: RequestId
  data: AckData
}

export interface ErrorData {
  /** What went wrong; SPEC.md section 12 lists the codes and what the receiver does. */
  code:
    | 'bad_json'
    | 'bad_message'
    | 'unknown_type'
    | 'version_mismatch'
    | 'unauthorized'
    | 'role_conflict'
    | 'session_mismatch'
    | 'not_permitted'
    | 'internal'
  /** One line for people and agents, without paths. */
  message: Text
  /** For bad_message: where in the offending message the first problem is. */
  path?: Pointer
}

/**
 * Either direction: the reply to a request that was refused (with re), or a report about a message
 * that had no id (without re) (SPEC.md section 12).
 */
export interface ErrorMessage {
  type: 'error'
  t: MessageTime
  re?: RequestId
  data: ErrorData
}

/** The latest pose the runtime received, for display only. */
export interface TelemetryPose {
  seq: Seq
  x: number
  z: number
  yaw: number
}

/**
 * Numbers for the control window (plan items DPR-20, REN-6), about every 100 ms. Every field is
 * optional: a runtime sends what it has. Counters count from the start of the session.
 */
export interface Telemetry {
  /** Device samples received. */
  samples?: Count
  /** Samples received per second over the last second. */
  sample_rate_hz?: number
  /** Sequence gaps (device protocol v1, H3). */
  seq_gaps?: Count
  /** Samples counted or inferred as lost. */
  samples_lost?: Count
  /** Device lines rejected by their checksum. */
  crc_errors?: Count
  /** Device lines rejected for any other reason. */
  parse_errors?: Count
  /** idle: not streaming; streaming: samples arrive; fault: the stream failed. */
  device_state?: 'idle' | 'streaming' | 'fault'
  /** Trials ended. */
  trials?: Count
  /** Reward pulses commanded. */
  rewards_commanded?: Count
  /** Reward pulses with a done outcome. */
  rewards_acknowledged?: Count
  /** Frames in the render host's frame log. */
  frames?: Count
  /** Late frame intervals so far (ADR-0003, Decision 2 counting rule). */
  late_frames?: Count
  /** The display-based frame-clock check (ADR-0003 1d): pending until its 5 s self-test ends. */
  clock_check?: 'pending' | 'pass' | 'fail'
  pose?: TelemetryPose
}

export interface SessionStateDataBase {
  /**
   * The rig runtime's session state (plan item DPR-06a): idle -> configured -> armed -> running ->
   * stopping -> complete or aborted.
   */
  state:
    | 'idle'
    | 'configured'
    | 'armed'
    | 'running'
    | 'stopping'
    | 'complete'
    | 'aborted'
  /** The session; present in every state but idle. */
  session?: SessionId
  /** The experiment's registry id, never a file name. */
  experiment?: Id
  /** Why the session is stopping or was aborted. */
  reason?: Text
  /**
   * The motion device's profile and guarantee level, as welcome gives it to the motion client; sent
   * from armed on, so that monitors show what the session can claim about lost samples (plan item
   * DPR-20).
   */
  device?: MotionDevice
  telemetry?: Telemetry
}

export type SessionStateData = SessionStateDataBase & (
  | { state: 'idle' }
  | {
      state: 'configured' | 'armed' | 'running' | 'stopping' | 'complete' | 'aborted'
      session: SessionId
    }
)

/**
 * Runtime to every client: the session's state, sent after welcome, on every change, and with
 * telemetry about every 100 ms while a session is configured (SPEC.md section 7).
 */
export interface SessionStateMessage {
  type: 'session.state'
  t: MessageTime
  data: SessionStateData
}

/** One device sample. */
export interface Sample {
  seq: Seq
  /**
   * End of the sample's window on the unwrapped device clock (device protocol v1, H6), or the
   * runtime's clock at receipt when the device has none.
   */
  t_dev_us: TimeUs
  /**
   * The time d covers: t_dev_us minus the previous sample's, so longer than one period after a gap.
   */
  dt_us: number
  /**
   * Body-frame displacement [forward cm, left cm, dyaw rad] = C * raw, with the rig file's
   * calibration C; yaw positive counter-clockwise seen from above.
   */
  d: [number, number, number]
  /** Counts per sensor axis since the previous sample, before calibration. */
  raw: number[]
  /**
   * Bits 0-7: the device's flags byte, unchanged (bit 0 count_incomplete, bit 1 no_tracking). Bit 8
   * (256): dt_estimated, dt_us is an estimate, not a measured window: for a stream's first sample,
   * the declared period, or (seq + 1) times it when the first seq is above 0 (device protocol v1,
   * section 7.2). Bit 9 (512): dt_mismatch, the device's window length disagreed with its clock
   * (device protocol v1, H6). Bits 10-15: reserved, 0.
   */
  flags: number
  /** Samples lost just before this one (counted or inferred): 0 when none. */
  gap: number
}

export interface SampleBatchData {
  /**
   * device: seq is the device's own number, so a gap is a counted loss. host: the runtime numbered
   * the samples as they arrived (legacy-v0.3), so a gap can only be inferred from the device clock.
   */
  seq_source: 'device' | 'host'
  samples: Sample[]
}

/**
 * Runtime to the motion client: device samples in sequence order, each sent once (SPEC.md section
 * 8). One sample is the device sample of device protocol v1, section 7.2.
 */
export interface SampleBatchMessage {
  type: 'sample.batch'
  t: MessageTime
  data: SampleBatchData
}

/**
 * The agent after the motion core processed sample seq (ADR-0001 R1). Lengths in scene units (1
 * unit = 1 cm), +Y up; yaw 0 looks down -Z, positive counter-clockwise seen from above.
 */
export interface Pose {
  seq: Seq
  epoch: Epoch
  t_dev_us: TimeUs
  x: number
  /** Height of the agent's feet; the eye is at feet_y + eyeHeight (ADR-0001 R3). */
  feet_y: number
  z: number
  /** Heading in radians, as the motion core integrated it. */
  yaw: number
  /** The mover met a wall during this sample. */
  contact: boolean
  /** No floor under the agent after this sample (falling). */
  airborne: boolean
}

export interface PoseBatchData {
  /** The world of every pose in the batch: a batch never spans a world switch. */
  world: WorldId
  poses: Pose[]
}

/**
 * Motion client to runtime: one pose record per sample, in sequence order, about every 20 ms and
 * before any event of a later sample (SPEC.md section 9).
 */
export interface PoseBatchMessage {
  type: 'pose.batch'
  t: MessageTime
  data: PoseBatchData
}

export interface EventDataBase {
  /**
   * zone: the agent's centre crossed a zone boundary. fall: no floor under the agent. land: back on
   * a floor. teleport_applied: a teleport or reset took effect. seq_gap: samples were lost before
   * this one. guard: the overlap guard of ADR-0001 R6 recovered or undid a move.
   */
  kind: 'zone' | 'fall' | 'land' | 'teleport_applied' | 'seq_gap' | 'guard'
  /**
   * The sample the event belongs to; for teleport_applied, the last sample processed before the
   * teleport.
   */
  seq: Seq
  /** The epoch after the event; for teleport_applied the new epoch. */
  epoch: Epoch
  /** t_dev_us of sample seq. */
  t_dev_us: TimeUs
  world: WorldId
}

export type EventData = EventDataBase & (
  | {
      kind: 'zone'
      /** The zone's id. */
      zone: Id
      /** enter or exit. */
      edge: 'enter' | 'exit'
      /**
       * move: the agent's own motion. teleport: a teleport moved the agent across the boundary;
       * such events carry the new epoch and are not behaviour (ADR-0002, Stamps).
       */
      cause: 'move' | 'teleport'
    }
  | { kind: 'fall' | 'land' }
  | {
      kind: 'teleport_applied'
      /** The spawn point teleported to, if the teleport named one. */
      spawn?: Id
      x: number
      feet_y: number
      z: number
      yaw: number
    }
  | {
      kind: 'seq_gap'
      /** Samples lost between the previous sample and this one (the sample's gap). */
      lost: number
    }
  | {
      kind: 'guard'
      /**
       * recovered: the move was redone and the agent moved; undone: the move was dropped (ADR-0001
       * R6).
       */
      result: 'recovered' | 'undone'
    }
)

/**
 * Motion client to runtime: one motion event, stamped with the sample it belongs to (SPEC.md
 * section 10; ADR-0002, Stamps).
 */
export interface EventMessage {
  type: 'event'
  t: MessageTime
  data: EventData
}

export interface RenderReportDataBase {
  kind: 'ready' | 'frames' | 'long_tasks' | 'clock'
  /**
   * performance.timeOrigin of the render host's realm, in whole microseconds. It names the clock
   * domain of every *_us time in the report (the render host's performance.now()), which differs
   * from the motion worker's; it is not itself a timestamp.
   */
  time_origin_us: Count
}

/** A setting's value: a boolean, a number or a constant's name. */
export type RenderSetting = boolean | number | Id

export interface AssetHash {
  id: Id
  sha256: Sha256
}

/**
 * Sent once, after every world, material and texture is warmed up and before any trial (ADR-0003
 * 1b): from then on a rise in programs or textures is a fault the frame log flags.
 */
export interface RenderReady {
  /**
   * Which render host draws the stimulus: main (the scene window's main thread) or worker (an
   * OffscreenCanvas worker, ADR-0003 Decision 3).
   */
  host: 'main' | 'worker'
  /** Why the main-thread host is used although a worker host was asked for. */
  fallback_reason?: Text
  /** How long loading and warm-up took. */
  warmup_us: DurationUs
  /** renderer.info.programs.length after warm-up. */
  programs: Count
  /** renderer.info.memory.textures after warm-up. */
  textures: Count
  /** renderer.info.memory.geometries after warm-up. */
  geometries?: Count
  /** Drawing-buffer width in pixels. */
  canvas_width: number
  /** Drawing-buffer height in pixels. */
  canvas_height: number
  /** The renderer's pixel ratio. */
  pixel_ratio: number
  /** Refresh rate of the display the scene window is on, as Electron reports it. */
  refresh_hz?: number
  /**
   * Effective renderer settings by name, for example {"shadows": false, "toneMapping":
   * "NoToneMapping"} (plan item REN-3).
   */
  settings?: Record<string, RenderSetting>
  /** Every asset the scene loaded, by id, with the SHA-256 of its bytes. */
  assets?: AssetHash[]
}

/**
 * One requestAnimationFrame callback of the render host (ADR-0003 1d). Times are on the render
 * host's clock.
 */
export interface FrameRecord {
  /** Frame index: 0 for the first callback after ready, then +1 per callback. */
  frame: Count
  /** The callback's requestAnimationFrame timestamp. */
  t_raf_us: TimeUs
  /** performance.now() when the callback started. */
  t_start_us: TimeUs
  /** performance.now() when the callback returned. */
  t_end_us: TimeUs
  epoch: Epoch
  /**
   * The sample whose pose was drawn, or the earlier of two when the frame interpolated between
   * poses. Absent before the first pose.
   */
  seq?: Seq
  /** The later of the two samples when the frame interpolated between poses. */
  seq_next?: Seq
  /** The device time the drawn pose stands for. Absent before the first pose. */
  t_dev_us?: TimeUs
  /**
   * Bit 0 (1): screen blanked. Bit 1 (2): motion frozen. Bit 2 (4): document hidden. Bit 3 (8):
   * WebGL context lost. Bit 4 (16): shader programs or textures rose after ready. Bits 5-7:
   * reserved, 0.
   */
  flags: number
}

/** Frame-log records in frame order, at most 1 s of frames per batch (plan item REN-11). */
export interface RenderFrames {
  /** The world every frame in the batch showed: a batch never spans a world switch. */
  world: WorldId
  frames: FrameRecord[]
}

/**
 * One PerformanceObserver entry, or one of the app's own timed handlers above the threshold. Script
 * attribution is left out, because it holds file URLs.
 */
export interface LongTaskEntry {
  /**
   * longtask or long-animation-frame (PerformanceEntry.entryType), or handler (timed by the app).
   */
  entry: 'longtask' | 'long-animation-frame' | 'handler'
  /** PerformanceEntry.name, or the handler's name. */
  name?: Id
  t_start_us: TimeUs
  duration_us: DurationUs
  /** long-animation-frame: blockingDuration. */
  blocking_us?: DurationUs
  /** long-animation-frame: renderStart. */
  render_start_us?: TimeUs
  /** long-animation-frame: styleAndLayoutStart. */
  style_layout_start_us?: TimeUs
}

/** Long tasks the render host's main thread observed (plan item REN-12), in the order observed. */
export interface RenderLongTasks {
  entries: LongTaskEntry[]
}

/**
 * A result of the display-based frame-clock check (ADR-0003 1d; plan item REN-4): the 5 s self-test
 * after ready, then rolling results. It has no gain field.
 */
export interface RenderClockCheck {
  phase: 'self_test' | 'rolling'
  /**
   * Median frame rate within 1 % (at least 1 Hz) of the display's refresh rate, and spread under
   * 0.5 ms.
   */
  pass: boolean
  /** Frame intervals the result is based on. */
  intervals: Count
  /** 1 / median frame interval. */
  median_hz: number
  /** The display's refresh rate the median was compared with. */
  display_hz?: number
  /** 95th minus 5th percentile of the frame intervals. */
  spread_us: number
  /** Warning codes, for example not_primary_display. */
  warnings?: Id[]
}

export type RenderReportData = RenderReportDataBase & (
  | { kind: 'ready' } & RenderReady
  | { kind: 'frames' } & RenderFrames
  | { kind: 'long_tasks' } & RenderLongTasks
  | { kind: 'clock' } & RenderClockCheck
)

/**
 * Motion client to runtime: a report of the render host, which the motion worker forwards unchanged
 * (SPEC.md section 11; ADR-0003 1a: the stimulus window's main thread returns only its frame log
 * and clock reports). kind ready: the warm-up report; frames: a batch of the frame log; long_tasks:
 * long-task and long-animation-frame entries; clock: a frame-clock check result.
 */
export interface RenderReportMessage {
  type: 'render.report'
  t: MessageTime
  data: RenderReportData
}

/**
 * Any message of the three-maze/link protocol, version 1 (SPEC.md). Validate a received or sent
 * message against this schema; type selects the message's own schema.
 */
export type LinkMessage =
  | HelloMessage
  | WelcomeMessage
  | HeartbeatMessage
  | AckMessage
  | ErrorMessage
  | SessionStateMessage
  | SampleBatchMessage
  | PoseBatchMessage
  | EventMessage
  | RenderReportMessage

/** The message types of version 1. */
export type LinkMessageType = LinkMessage['type']

/** The message of one type, for example MessageOfType<'event'>. */
export type MessageOfType<T extends LinkMessageType> =
  Extract<LinkMessage, { type: T }>
