# Link protocol v1 (three-maze/link)

- Status: **core subset frozen on 2026-10-22**, when the project owner accepted it by pushing it to `main` (phase-1 plan item DPR-05a; planned freeze: 2026-10-23). Later changes only add to it ([section 14](#14-versioning)).
- Applies to: the WebSocket connection between the three-maze rig runtime (Python) and its clients: the motion worker of the scene window and monitors such as the control window.
- Related: [device protocol v1](../../docs/protocol/device-v1.md) is the other side of the rig runtime, between the runtime and the devices on its serial ports; this protocol carries what the runtime derives from it and never the device lines themselves. [ADR-0001](../../docs/adr/0001-player-mover.md) (per-sample motion), [ADR-0002](../../docs/adr/0002-task-engine-location.md) (motion worker, rig runtime, stamps, epochs, watchdog), [ADR-0003](../../docs/adr/0003-render-worker-priority.md) (the motion worker owns the sample socket; frame log).
- Normative files: the JSON Schemas (draft 2020-12) in this folder fix the shape of every message; this document gives their meaning and the rules a schema cannot express. The examples, the validators and the generated TypeScript types follow the schemas ([section 15](#15-files-validators-and-tests)).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119 and RFC 8174 when they appear in capitals. Every MUST has a rule id and a reason; [section 16](#16-rules-reasons-and-tests) lists them with the check that covers each.

## Contents

1. [Terms](#1-terms)
2. [Overview](#2-overview)
3. [Message types and the budget](#3-message-types-and-the-budget)
4. [Envelope and conventions](#4-envelope-and-conventions)
5. [Connection and handshake](#5-connection-and-handshake)
6. [Heartbeat](#6-heartbeat)
7. [Session state and telemetry](#7-session-state-and-telemetry)
8. [Samples](#8-samples)
9. [Poses](#9-poses)
10. [Events](#10-events)
11. [Render reports](#11-render-reports)
12. [Replies and errors](#12-replies-and-errors)
13. [What plan item DPR-05b adds](#13-what-plan-item-dpr-05b-adds)
14. [Versioning](#14-versioning)
15. [Files, validators and tests](#15-files-validators-and-tests)
16. [Rules, reasons and tests](#16-rules-reasons-and-tests)
17. [Sources](#17-sources)

## 1. Terms

- **Rig runtime** (runtime): the Python process that reads the devices, records the session and supervises it (ADR-0002, Rig runtime; package `threemaze/`, plan item DPR-06a). It is the WebSocket server of this protocol.
- **Client**: a program connected to the runtime, with one of two roles.
- **Motion client**: the motion worker, a dedicated Web Worker in the scene window that runs the motion core (ADR-0002, Motion worker) and owns the sample socket (ADR-0003 1a). Role `motion`; at most one per session. The same module runs headless in Node for simulation and tests (ADR-0001 R7).
- **Monitor**: a client that observes, such as the control window. Role `monitor`.
- **Render host**: the code that draws the stimulus (ADR-0003 1c). It never connects to the runtime; its reports reach the runtime through the motion worker ([section 11](#11-render-reports)).
- **Device sample**: what the runtime derives from one device sample line: sequence number seq, device time t_dev, body-frame displacement and more ([device protocol v1, section 7.2](../../docs/protocol/device-v1.md#72-the-device-sample-the-host-derives)).
- **Epoch**: the teleport and reset counter (ADR-0001, Terms; ADR-0002, Motion worker): 0 at session start, +1 whenever the motion worker applies a teleport or reset.
- **Stamp**: the (seq, epoch, t_dev) of the sample an event belongs to (ADR-0002, Stamps).
- **Request**: a message with an `id`; its **reply** carries the same value in `re`.

## 2. Overview

```text
 device ──serial lines (device protocol v1)──▶ rig runtime ◀──WebSocket (this protocol)──▶ motion worker ◀──MessagePort──▶ render host
                                                  ▲
                                                  └──────WebSocket (this protocol)──────▶ monitors (control window)
```

| From → to | Messages |
|---|---|
| runtime → motion client | `welcome`, `heartbeat`, `session.state`, `sample.batch`, `error` |
| motion client → runtime | `hello`, `heartbeat`, `pose.batch`, `event`, `render.report`, `error` |
| runtime → monitor | `welcome`, `heartbeat`, `session.state`, `error` |
| monitor → runtime | `hello`, `heartbeat` (optional), `error` |

A session, as phase 1 runs it:

1. The control window connects as a monitor (`hello`, `welcome`) and receives `session.state` (`idle`).
2. The runtime configures and arms a session. In phase 1 a session is started from the command line and the rig file (plan items TS-19a, DPR-15b), not through this protocol.
3. The scene window starts the motion worker, which connects with `hello` (role `motion`, its session, its versions). The `welcome` names the epoch to start with (0), the world, and the motion device's guarantee level.
4. The render host warms up and reports `render.report` `ready`, then the result of its frame-clock self-test (`render.report` `clock`).
5. The runtime runs the session: it streams `sample.batch`; the motion worker answers with `pose.batch` and `event`; both send `heartbeat` every 20 ms; monitors get `session.state` with telemetry about every 100 ms.
6. The runtime stops the session, reports `complete` or `aborted`, and closes the motion client's connection.

## 3. Message types and the budget

The three-maze design caps this protocol at 12 core message types for v1.0, so that someone porting a runtime or a renderer to another language learns a small protocol (three-maze-notes `docs-site/docs/design/backend-modules.md:351`; plan reconciliation R16). The 2026-10 protocol design sketch had 42 (three-maze-notes `design/protocol.json`, design sketch section 4). This core subset defines 10; plan item DPR-05b adds at most 2 more ([section 13](#13-what-plan-item-dpr-05b-adds)) and makes the budget a CI check.

| Type | Direction | Request or reply | When | Section |
|---|---|---|---|---|
| `hello` | client → runtime | request | first message of every connection | [5](#5-connection-and-handshake) |
| `welcome` | runtime → client | reply to `hello` | once | [5](#5-connection-and-handshake) |
| `heartbeat` | both | | every 20 ms | [6](#6-heartbeat) |
| `ack` | both | reply | to a request that was carried out | [12](#12-replies-and-errors) |
| `error` | both | reply, or report | to a refused request, or about a faulty message | [12](#12-replies-and-errors) |
| `session.state` | runtime → client | | after `welcome`, on every change, about every 100 ms with telemetry | [7](#7-session-state-and-telemetry) |
| `sample.batch` | runtime → motion | | as samples arrive | [8](#8-samples) |
| `pose.batch` | motion → runtime | | about every 20 ms, and before every event | [9](#9-poses) |
| `event` | motion → runtime | | as events happen | [10](#10-events) |
| `render.report` | motion → runtime | | as the render host reports | [11](#11-render-reports) |

To stay in the budget, related payloads share one type and are told apart by a `kind` field: the six motion events share `event`, and the render host's warm-up report, frame log, long-task entries and frame-clock results share `render.report`. Telemetry rides on `session.state`.

## 4. Envelope and conventions

### 4.1 Envelope

Every message is one JSON object:

```json
{"type": "event", "t": 9310415, "data": {"kind": "zone", "seq": 2028, "epoch": 3, "t_dev_us": 9112000, "world": "hallway", "zone": "reward", "edge": "enter", "cause": "move"}}
```

| Field | Present | Meaning |
|---|---|---|
| `type` | always | the message type ([section 3](#3-message-types-and-the-budget)) |
| `t` | always | when the sender sent the message: integer µs on the sender's monotonic clock ([4.2](#42-numbers-time-and-units)) |
| `id` | requests only (`hello` in the core subset) | chosen by the requester; 1 to 64 characters `A-Z a-z 0-9 _ . : -` |
| `re` | replies only (`welcome`, `ack`; `error` when it answers a request) | the `id` of the request answered |
| `data` | always | the payload; its schema depends on `type` |

Each type's schema fixes which of `id` and `re` it has; any other envelope field is an error.

### 4.2 Numbers, time and units

**E1. Times are integer microseconds on monotonic clocks.** Every time field (`t`, every `*_us` field) MUST be a whole number of microseconds on a monotonic clock: `time.perf_counter_ns() // 1000` in the rig runtime, `Math.round(performance.now() * 1000)` in JavaScript, and, for `t_dev_us`, the unwrapped device clock (device protocol v1, H6). No field carries `Date.now()`, `time.time()` or another wall-clock time. *Reason:* wall clocks jump (time synchronisation, daylight saving); integers compare and subtract exactly in every language. Durations end in `_us` too.

There are four clock domains, and a time is only compared with times of its own domain:

| Domain | Fields |
|---|---|
| the runtime's session clock | `t` of messages the runtime sends |
| the motion worker's `performance.now()` | `t` of messages the motion worker sends |
| the render host's `performance.now()` | the `*_us` times inside `render.report` (named by `time_origin_us`, [section 11](#11-render-reports)) |
| the device clock | `t_dev_us` |

Mapping one domain onto another is plan item DPR-14 (with `time.sync`, DPR-05b); the device clock is mapped offline from the runtime's receive times.

**E2. Finite numbers within 2^53 − 1.** Every number MUST be finite; every integer MUST lie between 0 (or its schema's minimum) and 2^53 − 1 = 9007199254740991. A Python sender MUST serialise with `json.dumps(..., allow_nan=False)`. *Reason:* JSON has no NaN or Infinity, but Python's `json.dumps` writes them unless told not to and `json.loads` reads them, while JavaScript's `JSON.parse` rejects them (the protocol design sketch verified both, design sketch section 2); integers above 2^53 − 1 lose precision in JavaScript. 2^53 − 1 µs is about 285 years, so no time needs more.

Lengths are in scene units (1 unit = 1 cm, ADR-0001, Decision), angles in radians. +Y is up; yaw 0 looks down −Z and is positive counter-clockwise seen from above; a body-frame displacement is `d = [forward, left, dyaw]` with left positive (ADR-0001 R1; device protocol v1, section 7.2).

### 4.3 Strings: ids, text, and no file paths

Every string a message may hold is an enumerated value, a constant, or one of these patterned types (common.schema.json):

| Type | Pattern, in short | Used for |
|---|---|---|
| `Id` | a letter, then up to 63 of `A-Z a-z 0-9 _ . : -` (the scene-file id grammar) | worlds, zones, spawns, assets, experiments, component and program names |
| `RequestId` | as `Id`, may start with a digit | `id`, `re` |
| `SessionId` | up to 128 of `A-Z a-z 0-9 _ . : -` | sessions |
| `Text` | one line of up to 500 characters: no control character (U+0000 to U+001F, U+007F to U+009F) and no line or paragraph separator (U+2028, U+2029), which JavaScript and Python's `str.splitlines` treat as line ends; no `/` and no `\` | error messages, reasons |
| `Pointer` | a JSON Pointer whose segments are `A-Z a-z 0-9 _ -` | the place of a problem in a message |
| others | version numbers, a 32-digit hex token, a 64-digit hex SHA-256 | |

None of them admits a `.py`, `.pyc`, `.pyd`, `.pyo` or `.pyw` name, in any letter case.

**E3. No file paths and no .py names on the wire.** No message carries a file path, a URL to a file or the name of a Python file. Experiments are named by registry id, sessions by an opaque session id, assets by id and SHA-256. The runtime alone turns a session id into files under the data root of its rig file. *Reason:* v0.3 let a client name the files the backend wrote and read (the 2026-10 design sketch, section 11, rule 5); paths in messages also tie a protocol log to one computer. The schemas enforce the rule: no string type admits `/` or `\` except the protocol name and a JSON Pointer, whose segments cannot hold a dot or a colon (so neither `C:/...` nor a file name fits; a dotless directory path such as `/home/data` would, which is why `path` is only ever filled from a validator's report), and none admits a `.py` name. A test checks that every string the schemas allow is constrained this way ([section 15](#15-files-validators-and-tests)).

### 4.4 Strict senders, tolerant receivers

**E4. Strict senders.** A sender MUST send only messages that validate against the schemas of the version agreed in `welcome`. three-maze's own senders are checked by their tests, and every message the runtime and the motion worker send in the end-to-end runs is validated by plan item DPR-18a. *Reason:* a receiver can then trust what it reads, and a fault shows up at its source.

**E5. Tolerant receivers.** A receiver MUST ignore properties it does not know, at any depth, because a later minor version may add optional ones ([section 14](#14-versioning)). A receiver that meets a message type, an event kind or a render-report kind it does not know MUST log it and otherwise ignore it; if the message carried an `id`, it answers with `error` `unknown_type`. *Reason:* a 1.1 runtime can then talk to a 1.0 worker and the reverse. The validators' `tolerant` option ignores unknown properties ([section 15](#15-files-validators-and-tests)).

## 5. Connection and handshake

The runtime is a WebSocket (RFC 6455) server on the loopback interface; Electron gives it the port and gives the clients the URL (plan item DPR-15b). Every WebSocket message is a text frame holding exactly one message of this protocol, in UTF-8. Who may connect (token, Origin allow-list, loopback only) is plan item DPR-16a; the `hello` field `token` is reserved for it.

**C1. Hello first.** A client MUST send `hello` as its first message and nothing else before it receives `welcome`. The runtime MUST close a connection that has sent no `hello` within 2 s of opening (close code 4000), and MUST answer anything before `hello` with `error` `bad_message` and close (4000). *Reason:* the runtime learns the role, version and session before it sends any data; a stray connection cannot linger.

**C2. Versions.** `hello.version` is the highest version the client speaks. If its major version is not 1, the runtime MUST answer `error` `version_mismatch` with `re` and close (4002). Otherwise it answers `welcome` with `version` = 1 and the lower of the two minor versions, and both sides use that version from then on. *Reason:* both sides know which fields to expect; optional additions within a major version never break the other side (E5).

**C3. One motion client per session.** A `hello` with role `motion` MUST name the session the worker was started for. The runtime MUST refuse it with `error` `session_mismatch` and close (4005) if no session is configured or the session differs, and with `error` `role_conflict` and close (4003) if the session already has a motion client. *Reason:* a worker left over from an earlier session, or a second scene window, must never feed poses and events into the running session (ADR-0002: one epoch writer per session).

**C4. Welcome.** The `welcome` to a motion client MUST carry the session, the epoch to start with (0 for a new session), the world it starts in, and the motion device's profile and guarantee level (device protocol v1, sections 8.2 and 8.3). Right after `welcome`, the runtime MUST send `session.state`, and both sides start their heartbeats. *Reason:* the motion worker needs the starting epoch and world; the device's guarantee level tells it, and every record it shapes, what a sequence gap means ([section 8](#8-samples)).

**C5. Versions for the session record.** A `hello` with role `motion` MUST give `versions`: the renderer, physics and browser-engine versions the motion client runs, for example `electron`, `three` and `rapier3d-compat`. The runtime records them with the `client` in the session record (plan item DPR-08a). Which render host draws, and why it fell back if it did, follows in `render.report` `ready` ([section 11](#11-render-reports)), because the host is certain only after warm-up. *Reason:* every session record names its renderer and physics versions (ADR-0004, Decision 1; ADR-0003, Decision 3), and a hello without them would leave a session without its provenance.

Close codes (RFC 6455 private range):

| Code | Meaning |
|---|---|
| 1000 | normal close |
| 4000 | protocol error: no `hello` within 2 s, or a message before `welcome` |
| 4001 | unauthorized (plan item DPR-16a) |
| 4002 | version mismatch |
| 4003 | role conflict: the session already has a motion client |
| 4004 | session ended: sent to the motion client after `complete` or `aborted` |
| 4005 | session mismatch: no session, or another session |
| 4008 | heartbeat timeout (whether and when the runtime sends it is plan item DPR-11's, with the watchdog of B2) |

Example handshake (from `examples/`):

```json
{"type": "hello", "t": 1203411, "id": "h1", "data": {"protocol": "three-maze/link", "version": "1.0", "role": "motion", "client": {"impl": "three-maze-motion-worker", "version": "0.3.0"}, "session": "2026-10-23T14-03-11Z_m12", "versions": {"electron": "44.7.0", "three": "0.169.0", "rapier3d-compat": "0.14.0"}}}
{"type": "welcome", "t": 512334012, "re": "h1", "data": {"protocol": "three-maze/link", "version": "1.0", "role": "motion", "client_id": "motion-1", "runtime": {"impl": "threemaze", "version": "0.3.0"}, "heartbeat_ms": 20, "watchdog_ms": 100, "epoch": 0, "session": "2026-10-23T14-03-11Z_m12", "world": "hallway", "device": {"profile": "v1", "completeness": "counted", "integrity": "crc8", "seq_source": "device", "time_source": "device", "period_us": 4000, "n_axes": 4, "device_id": "ball-01"}}}
```

## 6. Heartbeat

**B1. Heartbeat interval: 20 ms.** From `welcome` until the connection closes, the runtime and every motion client MUST send `heartbeat` from a timer with a period of `heartbeat_ms` = 20 ms, whether or not other messages flow. A coarse system timer may stretch single intervals (reason 3 below); the property that counts, and that the tests measure, is that the gap between two heartbeats stays well under `watchdog_ms`. Monitors MAY send heartbeats; the runtime ignores their absence. `data.n` counts a connection's heartbeats in one direction from 0, so a receiver can count missing ones; a motion client adds the last sample it processed (`last_seq`) and its epoch, the runtime the last sample it sent.

**B2. Watchdog: 100 ms.** The runtime MUST act on the motion client's silence when no heartbeat from it has arrived for longer than `watchdog_ms` = 100 ms, measured on its own clock at receipt: it closes the valve, sets every output to its safe state and invalidates the open trial (ADR-0002, Rig runtime; the action is plan item DPR-11). A motion client that receives no runtime heartbeat for longer than 100 ms MUST treat the runtime as unresponsive; what it then shows is plan item MOT-12's (freeze and the error screen). *Reason:* see below. Heartbeats are separate from samples and poses, so that the runtime can tell a dead worker (no heartbeat) from a silent device (no sample for longer than T_fault, which DPR-05b sets).

Why 20 ms (plan reconciliation R15: the 2026-10 design sketch's 1 s heartbeat with three misses cannot serve ADR-0002's 100 ms watchdog):

1. **The interval adds to the worst case.** ADR-0002's Validation 5 requires the outputs at zero within 100 ms plus one heartbeat interval of the last heartbeat. At 20 ms that bound is 120 ms.
2. **Five heartbeats per watchdog window.** After a heartbeat, the next four are due within 80 ms and a fifth at 100 ms. The watchdog trips only when all five fail to arrive in time (four missing in a row and the fifth late), that is when the worker, the socket or the runtime's receiving loop stalls for about 80 ms beyond normal. A single late heartbeat (a garbage collection, a busy moment of the operating system) does not stop a session.
3. **Coarse timers still leave margin.** On Windows the default timer resolution is 15.6 ms: `asyncio.sleep(0.001)` took 15.3-15.4 ms on the development PC (three-maze-notes `design/protocol.json`, design sketch section 0). A 20 ms timer rounded up to the next tick fires every 31.25 ms, which still gives three heartbeats per 100 ms window. The actual gaps are measured in the end-to-end runs (plan items MOT-12 and DPR-18a: heartbeat gaps under 100 ms).
4. **One timer in the worker.** The motion worker sends its poses about every 20 ms (plan item MOT-12), so one timer can drive both.
5. **Negligible cost.** The motion client's heartbeat example is 75 bytes as compact JSON and the runtime's 49 bytes, so 50 heartbeats a second are under 4 kB/s in each direction; V8 parsed a 123-byte JSON message in 0.27 µs (design sketch section 0).

A 10 ms interval would tighten the bound by only 10 ms for twice the messages; a 50 ms interval would leave room for a single late heartbeat before the watchdog trips.

## 7. Session state and telemetry

**T1.** The runtime MUST send `session.state` to every client right after `welcome` and on every change of state, and, while a session is configured, at least every 100 ms with `telemetry`; from `armed` on, every `session.state` MUST also carry `device`, the motion device's profile and guarantee level as `welcome` gives them to the motion client (the runtime knows them once it has armed the device, device protocol v1, H9). *Reason:* the control window shows the session from these numbers at about 10 Hz (ADR-0003 1b), so the stimulus window does no extra work for them (plan items DPR-20, REN-6); a monitor connected before the session started learns the guarantee level only this way.

| State | Meaning (plan item DPR-06a) |
|---|---|
| `idle` | no session |
| `configured` | a session is set up: experiment, rig file and subject |
| `armed` | devices open and checked; waiting for the motion client's `ready` and frame-clock self-test |
| `running` | samples flow and trials run |
| `stopping` | ending: outputs safe, files closing |
| `complete` | ended normally |
| `aborted` | ended by a fault or by the operator; `reason` says why |

Every state but `idle` names its `session`. The runtime owns every transition; in the core subset no client can request one ([section 13](#13-what-plan-item-dpr-05b-adds)). After `complete` or `aborted` the runtime closes the motion client's connection with 4004; monitors stay connected.

`telemetry` fields are all optional, so a runtime sends what it has: samples received, measured sample rate, sequence gaps and lost samples, CRC and parse errors (device protocol v1, section 8.3), device state, trials ended, rewards commanded and acknowledged, frames, late frames, the frame-clock check, and the latest pose. There is no gain field: the v1 path moves the avatar by device displacement, so gain is 1 by construction (ADR-0001, Consequences; ADR-0003 1d drops the step-0 gain report).

## 8. Samples

`sample.batch` carries device samples from the runtime to the motion client. One sample is the device sample of [device protocol v1, section 7.2](../../docs/protocol/device-v1.md#72-the-device-sample-the-host-derives):

| Field | Meaning |
|---|---|
| `seq` | uint32 sample number in stream order, wrapping from 4294967295 to 0 |
| `t_dev_us` | end of the sample's window on the unwrapped device clock, or the runtime's clock at receipt when the device has none |
| `dt_us` | the time `d` covers: t_dev_us minus the previous sample's (longer than one period after a gap) |
| `d` | `[forward cm, left cm, dyaw rad]` = C · raw with the rig file's calibration C |
| `raw` | counts per sensor axis since the previous sample (1 to 16 axes) |
| `flags` | bits 0-7: the device's flags byte, unchanged (bit 0 `count_incomplete`, bit 1 `no_tracking`); bit 8 (256): `dt_estimated`, `dt_us` is an estimate, not a measured window: for a stream's first sample, the declared period, or (seq + 1) times it when the first seq is above 0 (a v1 stream that starts at seq 0 carries the device's own window, which is not flagged); bit 9 (512): `dt_mismatch` (device protocol v1, H6); bits 10-15: reserved, 0 |
| `gap` | samples lost just before this one: counted from seq (`seq_source` `device`) or inferred from the device clock (`host`); 0 when none |

The batch's `seq_source` says who numbered the samples: `device` (device protocol v1) or `host` (the runtime numbered them as they arrived; profile legacy-v0.3). The runtime keeps the receive time of every sample in its own record (`samples.tsv`, plan item DPR-07); the motion worker does not need it, so it is not sent.

**S1. In order, each once, never dropped.** The runtime MUST send every accepted device sample to the motion client exactly once, in stream order, and MUST NOT drop or merge samples: if its send queue overflows, it raises a session alarm instead (plan item DPR-06b). *Reason:* the motion core consumes samples in seq order, each once (ADR-0001 R1), and the sum of the displacements sent must equal the sum received, bit for bit (plan item DPR-06b).

**S2. Batches carry no meaning.** The runtime MUST send a sample as soon as it has it; it batches only samples that are already waiting (at most 1000 per batch). The motion client MUST give the same result however the samples are batched. *Reason:* poses and events must not depend on transport timing (ADR-0001, Validation 7: arrival independence); a batch is only a way to send a backlog in one frame.

**S3. Gaps are stamped.** For a sample with `gap` > 0 the motion client MUST emit an `event` of kind `seq_gap` stamped with that sample ([section 10](#10-events)). *Reason:* every gap is logged (ADR-0002, Gaps), and the event places it in the event log next to the trials it may affect. Whether a gap is a counted loss or an inference is the batch's `seq_source` and the device's guarantee level in `welcome`.

Example: the golden `S` lines of device protocol v1, section 11.1, with an example calibration (`examples/sample.batch--v1-device.json`, shortened):

```json
{"type": "sample.batch", "t": 513340377, "data": {"seq_source": "device", "samples": [
  {"seq": 2, "t_dev_us": 1008000, "dt_us": 4000, "d": [0.24430000000000002, -71.4752, 0.0], "raw": [-2048, 7, 0, 0], "flags": 1, "gap": 0},
  {"seq": 5, "t_dev_us": 1020000, "dt_us": 12000, "d": [0.0, 0.5584, 0.05], "raw": [16, 0, 25, 2], "flags": 0, "gap": 2}]}}
```

Floats are written as their shortest round-trip decimal (as Python's `repr` and JavaScript's `JSON.stringify` do), so the receiver gets the sender's double exactly.

## 9. Poses

`pose.batch` carries the motion core's pose records from the motion client to the runtime (plan item MOT-02): for each processed sample, the agent's `x`, `feet_y` and `z`, its heading `yaw`, whether the mover met a wall (`contact`) and whether the agent is falling (`airborne`), stamped with the sample's `seq`, `t_dev_us` and the `epoch` in force.

**P1. One pose per sample.** The motion client MUST send exactly one pose for every sample it processes, in seq order. *Reason:* the session record has a pose for every sample, whatever the frame rate (plan item MOT-12: zero samples without a pose record; v0.3 wrote rows only when a frame reported a pose, ADR-0003, Context).

**P2. Poses before events.** The motion client MUST send the poses up to and including a sample before any `event` stamped with that sample, and otherwise flush its poses about every 20 ms. *Reason:* when the runtime handles an event, it already holds the pose the event happened at, so the recorder can write both in order (plan item DPR-07).

**P3. One world per batch.** A batch MUST NOT span a world switch; `world` names the world of every pose in it. *Reason:* phase 2 adds world switching (plan item TS-09); every pose already names its world.

## 10. Events

`event` carries one motion event from the motion client to the runtime.

**V1. Stamps.** Every event MUST carry the stamp of the sample it belongs to, `seq`, `epoch` and `t_dev_us`, and the `world` (ADR-0002, Stamps; plan item TS-09). *Reason:* the event log is compared between hosts and runs on seq, epoch, t_dev, type and data, never on host time (ADR-0002, Validation), and the runtime acts only on events of the current epoch.

| Kind | When | Extra fields |
|---|---|---|
| `zone` | the agent's centre crossed a zone boundary in this sample (ADR-0001 R1) | `zone`, `edge` (`enter`, `exit`), `cause` (`move`, `teleport`) |
| `fall` | the ground ray found no floor in this sample (ADR-0001 R4, fall_start) | |
| `land` | the agent landed on a floor in this sample (ADR-0001 R4) | |
| `teleport_applied` | a teleport or reset took effect after sample `seq`; `epoch` is the new epoch | `x`, `feet_y`, `z`, `yaw` after it, `spawn` if it named one |
| `seq_gap` | samples were lost before sample `seq` ([section 8](#8-samples), S3) | `lost` |
| `guard` | the overlap guard recovered or undid a move in this sample (ADR-0001 R6) | `result` (`recovered`, `undone`) |

**V2. Dispatch order.** Within one sample the motion client MUST send events in the order the motion core dispatched them (ADR-0002, Clock and order: non-motion inputs, zone exits, zone entries by id, due timers). *Reason:* the event log is the record the hosts are compared on.

**V3. Teleports.** The zone events a teleport causes MUST carry `cause` `teleport` and the new epoch, and follow its `teleport_applied`. *Reason:* the motion core re-evaluates the zones after a teleport (plan item MOT-04), so leaving the reward zone by teleport shows up as a zone exit; such events are not behaviour, and the runtime logs them but never treats them as the animal's (ADR-0002, Stamps).

The task events of the minimal state machine (timers, trial start and end, actions) and the outcomes of output requests are added by plan items TS-13, TS-14 and DPR-05b as new kinds of `event` or as replies, within the budget.

## 11. Render reports

The render host never connects to the runtime: it posts its reports to the motion worker over a `MessagePort`, and the motion worker forwards each one unchanged as `render.report` (ADR-0003 1a; plan item MOT-12). If the render host moves into a worker of its own (ADR-0003, Decision 3), only the sender of these posts changes.

**R1. Clock domain.** Every `render.report` MUST carry `time_origin_us`, `performance.timeOrigin` of the render host's realm in whole µs, and every `*_us` time in it MUST be on that realm's `performance.now()`. *Reason:* the stimulus window's clock differs from the motion worker's (each realm has its own time origin); the field names the domain, and plan items DPR-14 and REN-15 map it onto the session clock. It is not itself used as a time stamp (E1).

| Kind | Sent | Content | Plan items |
|---|---|---|---|
| `ready` | once, after every world, material and texture is warmed up and before any trial (ADR-0003 1b) | render host (`main` or `worker`, with any fallback reason), warm-up time, shader programs, textures and geometries after warm-up, drawing-buffer size, pixel ratio, refresh rate, the effective renderer settings by name, and the SHA-256 of every loaded asset | REN-8, REN-3, REN-11 |
| `frames` | at least every second | frame-log records: frame index, rAF timestamp, callback entry and exit, epoch, the seq of the pose drawn (two when interpolating), its t_dev, and flags (blank, frozen, hidden, context lost, programs or textures rose after ready) | REN-11, DPR-17 |
| `long_tasks` | as observed | long-task and long-animation-frame entries from a `PerformanceObserver`, and the app's own timed handlers; no script attribution, which holds file URLs (E3) | REN-12, REN-15 |
| `clock` | after the 5 s self-test, then rolling | phase, pass, number of intervals, median frame rate, display refresh rate, 95th minus 5th percentile spread, warnings; no gain | REN-4 |

**R2. Ready before trials.** The runtime MUST NOT start the first trial before the `ready` report and the frame-clock self-test have arrived; what a failed self-test does is plan decision D8 (applied by default on 2026-10-09: it blocks paper sessions unless overridden by hand, and the override is recorded). *Reason:* shader compiles and texture uploads after ready stall rendering for hundreds of milliseconds (ADR-0003, Evidence 3), and a wrong frame clock spoils the session's timing.

**R3. Frame batches.** A `frames` report MUST hold the frames of at most about one second, in frame order, and MUST NOT span a world switch. *Reason:* a crash loses at most one batch (plan item REN-11), and every frame names its world (plan item TS-09).

## 12. Replies and errors

**Q1. Every request answered once.** A receiver MUST answer every request exactly once: `hello` with `welcome` or `error`, any other request with `ack` or `error`, the reply carrying `re` = the request's `id`. *Reason:* a requester can then tell a lost request from a slow one, and the logs pair every request with its outcome. In the core subset the only request is `hello`; DPR-05b adds requests that `ack` answers, and defines the fields their `ack` carries (the core `ack` carries none).

**Q2. Errors about messages.** A receiver that cannot use a message that was not a request MAY send `error` without `re`: `bad_json` for a frame that is not JSON, `bad_message` with the JSON Pointer `path` of the first problem, `unknown_type`, or `not_permitted`. Errors close the connection only as the table in [section 5](#5-connection-and-handshake) says. *Reason:* a faulty sender learns what it did wrong (the error model of the design sketch, section 7), and one bad message does not end a session.

| Code | Sent when | The connection |
|---|---|---|
| `bad_json` | a frame is not JSON, or holds NaN or Infinity | stays open |
| `bad_message` | a message does not validate (with `path`) | stays open; closes (4000) before `welcome` |
| `unknown_type` | a request of a type the receiver does not know (E5) | stays open |
| `version_mismatch` | `hello` with another major version | closes (4002) |
| `unauthorized` | `hello` without a valid token (plan item DPR-16a) | closes (4001) |
| `role_conflict` | a second motion client for the session | closes (4003) |
| `session_mismatch` | a motion client of no or another session | closes (4005) |
| `not_permitted` | a client sent a type its role may not send ([section 2](#2-overview)) | stays open |
| `internal` | the receiver failed | stays open unless the session aborts |

Examples:

```json
{"type": "error", "t": 512334020, "re": "h1", "data": {"code": "version_mismatch", "message": "hello asked for version 2.0; this runtime speaks 1.0"}}
{"type": "error", "t": 9310600, "data": {"code": "bad_message", "message": "seq must be at most 4294967295", "path": "/data/samples/0/seq"}}
```

## 13. What plan item DPR-05b adds

DPR-05b (week 6) completes version 1.0 before v1.0-rc: commands to the motion worker (teleport, freeze, setGain, display, with `apply_seq` and epoch; ADR-0002, Code tasks), output requests and their outcomes (reward with `durationMs` or `volumeUl`, `cmd_id` and stamp; done, failed, truncated, refused, unresolved), `time.sync`, the value of T_fault, and the CI check that keeps the core message types within 12. It has two of the 12 places left. A layout that fits, for DPR-05b to decide:

- `command`, a request in either direction carrying one action: the renderer actions from the runtime to the motion worker (code tasks, phase 2 by decision D20 = c) and output requests from the motion worker to the runtime (the reward of the declarative task);
- `time.sync`, a request answered by `ack` with the runtime's receive and send times;
- output outcomes as the `ack` or `error` of the output request, or as a new `event` kind.

Requests from monitors (subject fields, valve priming through the safety envelope; plan items DPR-08b, TS-29) would also be `command`s.

Two other phase-1 items report over this link and have no place in the core subset yet: the motion worker's provenance and end-of-session motion statistics (plan item MOT-14, which DPR-08b writes into the session record) and the clock-offset estimates of each client (`time.estimate` in the design sketch, section 6; plan item DPR-14). In the layout above they fit as new kinds of an existing type, which a minor version may add ([section 14](#14-versioning)), not as new types; DPR-05b places them within the budget.

## 14. Versioning

The protocol is `three-maze/link`, version `<major>.<minor>`; `hello` gives the highest version a client speaks and `welcome` the version both use (C2).

- A **minor** version only adds: optional properties, event and render-report kinds, error codes, and (within the budget) message types. Receivers of an earlier minor version ignore what they do not know (E5).
- A **major** version is needed to remove or rename anything, to make an optional property required, or to change the meaning of a field.

This document is version **1.0**, core subset. Until v1.0-rc, DPR-05b and the items that implement the protocol may only add to it in the ways a minor version may; such additions stay 1.0, because every component of a three-maze build ships from the same commit. From v1.0-rc on, every change follows the two rules above.

## 15. Files, validators and tests

| File | What it is |
|---|---|
| `protocol/v1/*.schema.json` | the schemas: `message.schema.json` validates any message and selects the type's own schema; `common.schema.json` holds the shared value types |
| `protocol/v1/examples/*.json` | one valid example of every message type, event kind and render-report kind, named `<type>--<variant>.json` |
| `protocol/v1/examples/invalid/`, `invalid-text/` | malformed messages and raw frame texts |
| `protocol/v1/examples/expected-errors.json` | for every malformed example, the problems both validators must report: exactly these (path, keyword) pairs |
| `src/protocol/validate.js` | the JavaScript validator (Ajv 8, draft 2020-12), plain JavaScript so that Node runs it directly |
| `threemaze/link/validate.py` | the Python validator (jsonschema), its twin |
| `src/protocol/linkTypes.ts` | TypeScript types generated from the schemas: `LinkMessage`, `MessageOfType<'event'>`, one type per titled schema |
| `scripts/gen-link-types.mjs` | the generator: `npm run protocol:types` |
| `test/frontend/protocol/`, `test/backend/test_link_protocol.py` | the tests (`npm test`, `.venv/Scripts/python -m pytest`) |
| `threemaze/link/server.py`, `stream.py`, `receive.py`, `log.py` | the rig runtime's end (plan item DPR-06b): handshake, heartbeats, session state, the sample stream to the motion client, and the link log of what clients send, `<session>/link.jsonl` |
| `test/backend/runtime/test_link.py` | its tests, with a mock motion worker and mock monitors |

Validating a message:

```js
import { linkErrors, parseLinkMessage } from './src/protocol/validate.js'
const { message, errors } = parseLinkMessage(frameText)          // errors: [{path, keyword, message}]
linkErrors(value, { tolerant: true })                            // a receiver's check (E5)
```

```python
from threemaze.link.validate import link_errors, parse_link_message
message, errors = parse_link_message(frame_text)                 # errors: [LinkIssue(path, keyword, message)]
link_errors(value, tolerant=True)
```

Both validators report each problem as a JSON Pointer to the offending value, the JSON Schema keyword that failed (`json` for text that is not JSON) and a message, one per path and keyword, sorted by path and keyword. Beyond the schemas they reject non-finite numbers wherever they appear and refuse NaN and Infinity in text (Python's `json.loads` would accept them); an integer too large for a double, which `JSON.parse` reads as Infinity, is not finite in Python either. When a field that only one event or report kind has is malformed, both also report that kind's fields as unevaluated at the parent; `expected-errors.json` lists this where it happens.

The tests check that:

- every valid example passes both validators, and every message type, event kind and render-report kind has one;
- every malformed example fails both, with exactly the problems in `expected-errors.json`, so the two validators agree on every case;
- tolerant validation ignores unknown properties and still rejects what the schemas forbid;
- every schema is a valid draft 2020-12 schema; every string it admits is an enum, a constant or patterned; every pattern ends at the true end of the string; every required name is defined; every type has its own schema file; the core types number 10, within the budget of 12;
- the generated types are up to date, and `npm run typecheck` compiles them together with typed examples and `@ts-expect-error` cases that the schemas also reject.

What a schema cannot check, the implementing items test: order and completeness of samples and poses (S1, P1: plan items DPR-06b, MOT-12), batching independence (S2: MOT-06), the handshake and close codes (C1-C3: DPR-06b, DPR-16a), the recording of versions (C5: DPR-08a), the heartbeat and the watchdog (B1, B2: MOT-12, DPR-11), and that every message the runtime and the motion worker send in the end-to-end runs validates (E4: DPR-18a).

## 16. Rules, reasons and tests

| Rule | MUST | Reason (short) | Checked by |
|---|---|---|---|
| E1 | integer µs on monotonic clocks | no wall-clock jumps; exact arithmetic | schemas (integers); DPR-14 (no Date.now or time.time) |
| E2 | finite numbers, integers within 2^53 − 1 | JSON has no NaN; JavaScript precision | validators; tests in both languages |
| E3 | no file paths, no .py names | the runtime alone names files | schemas; schema lint and example scan tests |
| E4 | strict senders | faults show at their source | DPR-18a (end-to-end runs) |
| E5 | tolerant receivers | minor versions interoperate | validators' tolerant option; tests |
| C1 | `hello` first, within 2 s | role, version and session known before data | DPR-06b |
| C2 | major version 1, lower minor | both sides expect the same fields | DPR-06b |
| C3 | one motion client per session, of that session | one epoch writer; no stale worker | DPR-06b, DPR-16a |
| C4 | `welcome` gives session, epoch, world, device guarantees | the worker starts in the right epoch and knows what gaps mean | schema (role motion); DPR-06b |
| C5 | a motion `hello` gives its versions | renderer and physics versions in every session record | schema (role motion); DPR-08a |
| B1 | heartbeat on a 20 ms timer from both | watchdog margin ([section 6](#6-heartbeat)) | MOT-12 (gaps under 100 ms on a mock clock); DPR-18a |
| B2 | watchdog after 100 ms without a motion heartbeat | valve closed when the worker dies (ADR-0002) | DPR-11 (ADR-0002 Validation 5) |
| T1 | `session.state` on change and every 100 ms with telemetry; `device` from `armed` on | control window at about 10 Hz; guarantee level for monitors | DPR-20 |
| S1 | samples in order, each once, never dropped | ADR-0001 R1; displacement conserved | DPR-06b |
| S2 | send at once; batching changes nothing | arrival independence | MOT-06 (ADR-0001 Validation 7) |
| S3 | a gap becomes a `seq_gap` event | ADR-0002, Gaps | MOT-02 |
| P1 | one pose per sample | a pose for every sample, whatever the frame rate | MOT-12, DPR-18a |
| P2 | poses before the events of their sample | ordered recording | MOT-12, DPR-07 |
| P3 | a pose batch never spans a world switch | worlds reserved | schema (`world` required); TS-09 |
| V1 | events stamped with seq, epoch, t_dev, world | logs compared on stamps | schema; MOT-04, TS-14 |
| V2 | events in dispatch order | the event log is the comparison record | MOT-04, TS-13 |
| V3 | teleport zone events carry `cause` teleport and the new epoch | not behaviour | MOT-04, TS-13 |
| R1 | render reports name their clock domain | two realms, two clocks | schema; REN-11 |
| R2 | no trial before `ready` and the self-test | no compile stalls; a checked clock | REN-8, REN-4 |
| R3 | frame batches of at most about 1 s, one world | bounded loss on a crash | REN-11 |
| Q1 | every request answered once, with `re` | pairs requests and outcomes | DPR-06b; DPR-05b |
| Q2 | errors report, and close only per the table | one bad message does not end a session | DPR-06b |

## 17. Sources

- [ADR-0001](../../docs/adr/0001-player-mover.md) at b96ad72: Terms (`:15`), R1 (`:38`), R3 (`:42-49`), R4 (`:51`), R6 (`:61`), R7 (`:63`), Validation 7 (`:89`).
- [ADR-0002](../../docs/adr/0002-task-engine-location.md) at b96ad72: Motion worker (`:43-47`), Clock and order (`:49`), Rig runtime and the 100 ms watchdog (`:51-56`), Stamps (`:60`), one task source (`:62`), code tasks and apply_seq (`:64`), Gaps and T_fault (`:66`), the budget of 12 actions (`:76`), Validation 5 (`:90`).
- [ADR-0003](../../docs/adr/0003-render-worker-priority.md) at b96ad72: 1a (`:44`), 1b (`:46`), 1c (`:48`), 1d (`:50`), Decision 3 (`:57`), Evidence 3 (`:107`).
- [Device protocol v1](../../docs/protocol/device-v1.md) (plan item DPR-01): sections 7.2 (the device sample), 8.2 and 8.3 (guarantee levels and session record), 11.1 and 11.3 (the golden lines behind the sample examples); rules H3 (gaps) and H6 (device time). Its heartbeat (H7, the runtime to a device every 100 ms) is a different heartbeat from this protocol's.
- The 2026-10 design review, in the separate three-maze-notes repository: `design/protocol.json`, design sketch sections 0 (measurements), 2 (envelope and conventions), 3 (roles, handshake, close codes), 5 (epochs), 6 (clocks), 7 (error model) and 10 (schema with Ajv 8.20); `docs-site/docs/design/backend-modules.md:55-60` (two protocols, the task protocol and this link protocol, named and documented apart) and `:351` (at most 12 core messages); `plan/phase1-plan.json`, items DPR-05a and DPR-05b and reconciliations R15 (heartbeat) and R16 (budget).
- Where this protocol departs from the design sketch, and why: 10 core types instead of 42 (the budget); the motion worker owns the sample socket and consumes every sample once, so there is no per-frame inbox and no accumulating delta lane (ADR-0001 R1, ADR-0003 1a); a 20 ms heartbeat instead of 1 s (section 6); the protocol name `three-maze/link` instead of `three-maze/1.0` (backend-modules.md names the two protocols apart); no wall-clock anchor in `welcome` (E1; the session record keeps the start time, plan item DPR-08a); the token is reserved, not yet checked (plan item DPR-16a).
