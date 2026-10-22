# Rig file v1

- Status: version 1, phase 1 (plan item DPR-06a); later phase-1 items add fields, never remove them
- Schema: [`rigs/schema/rig-v1.schema.json`](../rigs/schema/rig-v1.schema.json) (JSON Schema 2020-12)
- Read by: the rig runtime, `threemaze/config/rig.py`
- Related: [ADR-0001](adr/0001-player-mover.md) R3 (eye height belongs to the rig), [ADR-0002](adr/0002-task-engine-location.md) (Rig runtime: safety envelope in the rig file), [device protocol v1](protocol/device-v1.md) (section 7.2: the calibration matrix)

A rig file describes one rig: its devices, which device serves which role, their calibration,
where session data go, the limits on its outputs, how its backend starts, and the motion settings
that belong to the rig rather than to an experiment. Experiments name roles (`motion`,
`reward`), never ports or channels, so the same experiment runs on any rig whose file binds those
roles.

The rig runtime reads the rig file when a session is configured. Nothing is opened or written for
a file that does not validate. When the session is armed, the runtime copies the exact bytes it
validated into the session folder as `rig.json`, with `rig.json.sha256` next to it
(`sha256sum -c rig.json.sha256` checks the copy). A running session keeps that snapshot: editing
the file affects the next session only.

## Example

[`rigs/sim.json`](../rigs/sim.json), the simulated rig, which needs no hardware:

```json
{
  "$schema": "schema/rig-v1.schema.json",
  "format": "three-maze-rig",
  "version": 1,
  "name": "sim",
  "devices": {
    "ball": {
      "driver": "simulated",
      "deviceId": "sim-ball",
      "periodUs": 50000,
      "sensor": { "cmPerCount": 0.0349, "radPerCount": 0.05 },
      "trajectory": { "kind": "segments", "segments": [{ "durationS": 1, "forwardCmPerS": 11.168 }] }
    },
    "valve": { "driver": "simulated", "deviceId": "sim-valve", "outputs": 1 }
  },
  "bindings": { "motion": "ball", "reward": "valve" },
  "calibration": {
    "ball": { "matrix": [[0, 0.0349, 0], [0.0349, 0, 0], [0, 0, 0.05]] }
  },
  "dataRoot": "../data",
  "safety": {
    "reward": { "maxPulseMs": 300, "minIntervalMs": 250, "maxTotalMsPerSession": 60000 }
  },
  "motion": { "eyeHeight": 3.7 }
}
```

(The file in the repository also has a `description` and a calibration `note`.)

## Fields

Unknown fields are errors everywhere, so a misspelt field never goes unnoticed. Defaults come from
the schema's `default` keywords; every session records the values in force. Integer fields take
whole numbers written without a fraction or exponent (`50000`, not `50000.0` or `5e4`).

| Field | Required | Default | Meaning |
|---|---|---|---|
| `format` | yes | | `"three-maze-rig"` |
| `version` | yes | | `1`. A later minor change only adds optional fields. |
| `name` | yes | | Rig name, part of every session folder name: letters, digits, `.`, `_`, `-`. |
| `description` | no | | Free text. |
| `devices` | yes | | Devices by name (`a-z`, digits, `_`). Each has a `driver` and that driver's fields. Only devices bound to a role are opened. |
| `bindings.motion` | yes | | Device whose samples move the avatar. |
| `bindings.reward` | no | | Output device for rewards; without it the rig gives none. |
| `calibration.<device>` | for the motion device | | `matrix`: the calibration matrix C of device protocol v1 (section 7.2), 3 rows (forward cm, left cm, counter-clockwise yaw rad) by one column per sensor axis of the device. Entry [r][j] is what one count of axis j adds to row r, so the entries hold the cm per count, the axis signs and the yaw factor. Optional `date` (YYYY-MM-DD) and `note`. |
| `dataRoot` | yes | | Folder for the session folders ([data format v1](data-format-v1.md) lists what each holds). A relative path is relative to the rig file's folder. |
| `safety.reward` | if `reward` is bound | none: each rig states its own | `maxPulseMs` (longest pulse), `minIntervalMs` (end of one pulse to start of the next), `maxTotalMsPerSession` (open time summed over a session). Enforced from plan item DPR-09 on. |
| `backend.mode` | no | `"spawn"` | How the Electron app starts the backend: `spawn`, `external` (already running) or `none`. With `command`, `cwd`, `env`, `startupTimeoutS`, `shutdownGraceS` (no defaults). Read by the launcher from plan item DPR-15b on; the runtime ignores it. |
| `motion.eyeHeight` | no | `3.7` | Eye above the avatar's feet, in scene units (cm): the height v0.3 sessions used (ADR-0001 R3, owner 2026-10-07). ADR-0001's validation covers 3.7; another value needs its suite re-run. |
| `motion.maxSpeed` | no | `141` | Fastest running speed, in cm/s, that checks of a scene against this rig assume, such as the zone-thickness lint (ADR-0001 R1). 141 is the speed up to which ADR-0001 validates the mover (Decision driver 2). **Not a clamp**: the runtime never limits the speed and every session records the fastest speed it saw (D10, owner 2026-10-09). There is no clamp field. |
| `motion.displayMode` | no | chosen by the motion core | `smooth` (interpolate with a delay D) or `latest` (newest pose), plan item MOT-13. Absent, the motion core chooses from the sample period (`latest` when a sample period is at most half a frame, MOT-13); the mode for paper data is open (D17). |
| `motion.displayDelayUs` | no | chosen by the motion core | D of the smooth mode, in µs. |

The sample rate is not a separate field: it is the motion device's own setting (`periodUs` of the
`simulated` and `serial_lines` drivers), which the device's hello is checked against.

### Driver `simulated`

The reference simulated device of device protocol v1 (`threemaze/devices/sim`), in the rig
runtime's own process: no serial port and no hardware. It answers `hello`, streams between `start`
and `stop`, answers pulses and keeps to every device rule of the protocol, unless told to break
the transport with `faults`. The same device runs behind the end-to-end bench's simulated serial
port (`THREEMAZE_SIM_PROTOCOL=v1`, [test/e2e/README.md](../test/e2e/README.md)).

| Field | Default | Meaning |
|---|---|---|
| `deviceId` | required | 1 to 32 characters `A-Z a-z 0-9 . _ -`, sent in its hello. |
| `periodUs` | | Sample period in µs. Present: it streams samples of three axes, in the order of the v0.3 stream's fields 7, 8 and 9 (lateral, forward and yaw counts), and can serve `motion`. |
| `sensor` | | `cmPerCount` and `radPerCount`: what one count is. Needed by `segments` and `samples` trajectories. |
| `trajectory` | none: it stands still, still sending a sample every period | `{"kind": "segments", "segments": [...], "loop": true}`: piecewise-constant motion, each segment `durationS` with `forwardCmPerS`, `leftCmPerS`, `yawDegPerS` (counter-clockwise) and `lick` (0 or 1), rounded to whole samples. `{"kind": "samples", "file": ...}`: one row per sample with the columns `forward_cm`, `left_cm`, `dyaw_rad` and optionally `lick`. `{"kind": "replay", "file": ...}`: the counts of a recorded stream, one sample per recorded sample, at this device's own period: a raw capture (`tools/capture_raw.py`) or a file of device lines, either v1 `S` lines with three axes or v0.3 13-field lines. Files play once unless `"loop": true`; segments loop unless `"loop": false`. File names are relative to the rig file; a file that cannot be read or used is an error of the rig file, reported with its pointer before the session is armed. |
| `lick` | `0` | `1`: its hello declares `lick=1`, and it reports the trajectory's lick level as `L` lines on channel 0. With `0` it sends no `L` lines (device-v1.md section 4.4). It has no frame-clock input: it never declares `fclk` and sends no `F` lines. |
| `outputs` | `0` | Output channels. At least 1: it can serve `reward`. |
| `ack` | `true` | Answer every pulse with one `A` (device-measured on and off times) or `X` line. |
| `maxPulseUs` | none | Its own longest pulse; longer ones get `X,<cmd_id>,range`. |
| `onLatencyUs` | `0` | Time from a pulse command to the output going on. |
| `hbMs` | none | Heartbeat timeout it declares: once it has had a `beat`, it closes an open output, and refuses pulses, when no `beat` came for this long. Below 300 the session refuses to arm (rule H5), so a lower value simulates a device that breaks that rule. |
| `fw` | none | Firmware version in its hello. |
| `clockStartUs` | `0` | Its microsecond clock when it is opened. |
| `lineEnding` | `"lf"` | `"crlf"` writes lines as `Serial.println()` does. |
| `faults` | none | Faults at sample numbers of every stream, each written to its log with that number: `drop` (`count` samples produced, never sent), `badCrc` (a digit corrupted under the original checksum), `truncate` (only the first `keepBytes` bytes; the next line follows them), `split` (`pieces` pieces `gapUs` apart, within one period), `burst` (`count` lines held and sent together), `silence` (no sample or lick line for `durationMs`; outputs still answer), `wrap` (its clock wraps from 4294967295 to 0 between `seq` − 1 and `seq`, first stream). |

The simulated device is read as a device on a serial port is, by the reader and the host's side of
the protocol that the `serial_lines` driver below uses (plan item DPR-03,
`threemaze/devices/serial_lines.py`): it gets `stop` and `hello` when the session is armed, and the
session refuses to arm if the hello's device id, period or axes differ from the rig file or from
the calibration's columns, or if it declares a heartbeat timeout below 300 ms (rule H5); from then
on a device that declares a heartbeat timeout gets a `beat` every 50 ms (rule H7); it gets `start`
and `stop` with the session; and a device with outputs gets `stop`, which closes them, whenever
outputs are made safe (a device that also streams then sends its stop report). Each device writes
two files into the session folder:

- `raw/<device>.tsv`: every line the device sent, stamped with the session clock at the read that
  completed it, and every command, in the raw capture format of `tools/capture_raw.py` ("three-maze
  raw capture 1"); `test/e2e/sim/threemaze_sim/conformance.py` checks it;
- `sim/<device>.jsonl`: the device's own log: every command, stream start and stop, lick edge and
  fault, and every pulse with its commanded and actual on and off times; and the runtime's calls
  (open, start, safe_state, stop, close) with the hello it received.

### Driver `serial_lines`

A device on a serial port of this computer (USB CDC or a UART), read line by line in the profile
its entry names: in phase 1 `v1`, [device protocol v1](protocol/device-v1.md); plan item DPR-04
adds `legacy-v0.3`. One reader thread per device blocks in the port's read (with a 50 ms timeout,
so that it can be stopped; it never polls the runtime's event loop), reassembles the lines however
their bytes arrive, stamps each with the session clock at the read that completed it, checks it
(framing, checksum, fields, sequence numbers and device time: device-v1.md section 7), counts every
rejected line by cause, writes every line to the raw-line log, and hands the device samples, with
the device's other records, to the runtime. The host's side of the session sequence runs as for
the simulated device above (section 6). The waits are the protocol's proposed defaults.

| Field | Default | Meaning |
|---|---|---|
| `port` | required | The port: its name (`COM5` on Windows, `/dev/ttyACM0` on Linux) or a pySerial URL (`loop://` is a loopback port for tests). |
| `profile` | required | `v1`: device protocol v1. |
| `baud` | `115200` | Baud rate; a native USB device ignores it. |
| `deviceId` | none | When given, the hello must report this id (rule H5). |
| `periodUs` | | The sample period, in µs, that the hello must declare. Present: the device streams samples and can serve `motion`. Absent: its hello must declare 0. |
| `outputs` | `0` | Output channels the rig uses. At least 1: the device can serve `reward`, and its hello must declare at least as many (key `out`). |
| `openDelayMs` | `0` | Wait after opening the port, for boards that reset when it opens (section 6, step 1). |
| `helloIntervalMs` | `500` | Send `hello` again this often until the device answers (step 3). |
| `helloTimeoutMs` | `5000` | Refuse to arm the session when no hello came within this time (step 3). |
| `stopTimeoutMs` | `500` | Wait this long for the stop report after `stop` (step 7). |
| `rawLog` | `true` | Write the raw-line log `raw/<device>.tsv` in the session folder. |

The number of sensor axes is not a field: the hello reports it, and it must equal the number of
columns of the device's calibration matrix.

## Validation

The runtime checks a rig file in two steps and reports every problem of a step at once, each with
the JSON pointer (RFC 6901) of the field it concerns:

1. the schema: types, ranges, required and unknown fields, and each driver's fields;
2. what the schema cannot express: each binding names an existing device that can serve the role,
   the motion device has a calibration whose matrix has one column per sensor axis, every
   calibration names an existing device, a bound reward device has a safety envelope.

A file that fails step 1 is not checked by step 2. JSON that cannot be parsed, a key given twice
in one object, `NaN` or `Infinity`, and a number too large for a double (such as `1e400`) are
errors too. For example:

```text
invalid rig file rigs/my-rig.json:
  /devices/ball/periodUs: 0 is less than the minimum of 1
  /devices/ball/port: unknown field; allowed here: driver, deviceId, periodUs, sensor, trajectory, lick, outputs, ack, maxPulseUs, onLatencyUs, hbMs, fw, clockStartUs, lineEnding, faults
  /motion/speedClamp: unknown field; allowed here: eyeHeight, maxSpeed, displayMode, displayDelayUs
```

## What it replaces

In v0.3 these values are constants in each experiment file, and they already disagree between
files:

| v0.3 | Where | Rig file v1 |
|---|---|---|
| serial port `COM3`, 115200 baud | `experiments/hallway04_experiment.py:156-157` | the motion device's entry: `port` and `baud` of the `serial_lines` driver (its legacy-v0.3 profile: plan item DPR-04) |
| NI-DAQ channel `Dev1/ao0` | `experiments/hallway04_experiment.py:190-191` | the reward device's entry (NI driver: plan item DPR-10) |
| data folder `D:\VirmenData` | `experiments/hallway04_experiment.py:214` | `dataRoot` |
| `ENCODER_TO_CM` 0.0349, yaw 0.05 rad per count | `experiments/hallway04_experiment.py:84`, `:287-288`; 0.0364 in `hallway_experiment.py:75` | `calibration.<device>.matrix` |
| eye height 3.7 (ball centre + 1.6, camera + 1.6) | `src/scenes/serial/PythonCustomScene.vue:235`, `:574` (ADR-0001, Context) | `motion.eyeHeight` |
| speed clip ±100 units/s per axis | `experiments/hallway04_experiment.py:80`, `:531-541` | none (D10) |

A test (`test/backend/runtime/test_no_rig_constants.py`) fails if a port name, baud rate, the v0.3
init line, an NI-DAQ channel, a drive path or a v0.3 cm-per-count value appears in the runtime's
code.

## The simulated rigs

`rigs/sim.json` binds a simulated ball at 20 samples per second (the rate of v0.3's simulated
Teensy, `test/e2e/sim`) and a simulated valve. The ball runs straight ahead at 11.168 cm/s, which
is 16 counts per sample, as v0.3's simulated Teensy does. Its calibration is v0.3's mapping, as the legacy
profile of device protocol v1 states it (section 10.4): forward = axis 1 × 0.0349 cm, left = axis
0 × 0.0349 cm, yaw = axis 2 × 0.05 rad. Its safety envelope only guards the simulated valve:
`maxPulseMs` 300 and `minIntervalMs` 250 are the illustrative values of the 2026-10 experiment-data
design's example rig file (three-maze-notes, `design/experiment_data.json`, section 5), and
`maxTotalMsPerSession` 60000 is a choice for the simulator, large enough that simulated sessions
never reach it. Its `dataRoot`, `../data`, is the folder `data/` at the repository root, which git
ignores.

`rigs/sim-gate.json` is the input of the week-6 gate (D6 = a): the same rig with the ball on a
looped, scripted B1-like trajectory at 20 samples per second (running bouts at 11.168 and
22.336 cm/s, stops with lick contact, turns at 45°/s). The speeds are v0.3's simulated speed and
twice that; the turn rate and the timing are illustrative, not measured. A recorded stream of the
owner's device replaces it if one is captured (D6): set its trajectory to `replay`.

## Later in phase 1

Plan items that extend this format: the `lick` role (DPR-25), the legacy-v0.3 profile of the
`serial_lines` driver and its settings (DPR-04), the NI-DAQ analog-output driver (DPR-10), the
µL-to-pulse-width calibration of the reward device (DPR-09) and the launcher's use of `backend`
(DPR-15b). The data root and the subject fields every session records are open (D16).
