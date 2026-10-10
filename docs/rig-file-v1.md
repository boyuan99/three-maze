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
    "ball": { "driver": "simulated", "deviceId": "sim-ball", "periodUs": 50000 },
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
| `dataRoot` | yes | | Folder for the session folders. A relative path is relative to the rig file's folder. |
| `safety.reward` | if `reward` is bound | none: each rig states its own | `maxPulseMs` (longest pulse), `minIntervalMs` (end of one pulse to start of the next), `maxTotalMsPerSession` (open time summed over a session). Enforced from plan item DPR-09 on. |
| `backend.mode` | no | `"spawn"` | How the Electron app starts the backend: `spawn`, `external` (already running) or `none`. With `command`, `cwd`, `env`, `startupTimeoutS`, `shutdownGraceS` (no defaults). Read by the launcher from plan item DPR-15b on; the runtime ignores it. |
| `motion.eyeHeight` | no | `3.7` | Eye above the avatar's feet, in scene units (cm): the height v0.3 sessions used (ADR-0001 R3, owner 2026-10-07). ADR-0001's validation covers 3.7; another value needs its suite re-run. |
| `motion.maxSpeed` | no | `141` | Fastest running speed, in cm/s, that checks of a scene against this rig assume, such as the zone-thickness lint (ADR-0001 R1). 141 is the speed up to which ADR-0001 validates the mover (Decision driver 2). **Not a clamp**: the runtime never limits the speed and every session records the fastest speed it saw (D10, owner 2026-10-09). There is no clamp field. |
| `motion.displayMode` | no | chosen by the motion core | `smooth` (interpolate with a delay D) or `latest` (newest pose), plan item MOT-13. Absent, the motion core chooses from the sample period (`latest` when a sample period is at most half a frame, MOT-13); the mode for paper data is open (D17). |
| `motion.displayDelayUs` | no | chosen by the motion core | D of the smooth mode, in µs. |

The sample rate is not a separate field: it is the motion device's own setting (`periodUs` for the
simulated device), which the device's hello is checked against.

### Driver `simulated`

The reference simulated device of device protocol v1, in the rig runtime's own process: no serial
port and no hardware. `deviceId` (1 to 32 characters `A-Z a-z 0-9 . _ -`) is required.
`periodUs` makes it stream samples of three axes, in the order of the v0.3 stream's fields 7, 8
and 9 (lateral, forward and yaw counts), so it can serve `motion`; `outputs` (at least 1) gives it
output channels, so it can serve `reward`.

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
  /devices/ball/port: unknown field; allowed here: driver, deviceId, periodUs, outputs
  /motion/speedClamp: unknown field; allowed here: eyeHeight, maxSpeed, displayMode, displayDelayUs
```

## What it replaces

In v0.3 these values are constants in each experiment file, and they already disagree between
files:

| v0.3 | Where | Rig file v1 |
|---|---|---|
| serial port `COM3`, 115200 baud | `experiments/hallway04_experiment.py:156-157` | the motion device's entry (serial drivers: plan items DPR-03, DPR-04) |
| NI-DAQ channel `Dev1/ao0` | `experiments/hallway04_experiment.py:190-191` | the reward device's entry (NI driver: plan item DPR-10) |
| data folder `D:\VirmenData` | `experiments/hallway04_experiment.py:214` | `dataRoot` |
| `ENCODER_TO_CM` 0.0349, yaw 0.05 rad per count | `experiments/hallway04_experiment.py:84`, `:287-288`; 0.0364 in `hallway_experiment.py:75` | `calibration.<device>.matrix` |
| eye height 3.7 (ball centre + 1.6, camera + 1.6) | `src/scenes/serial/PythonCustomScene.vue:235`, `:574` (ADR-0001, Context) | `motion.eyeHeight` |
| speed clip ±100 units/s per axis | `experiments/hallway04_experiment.py:80`, `:531-541` | none (D10) |

A test (`test/backend/runtime/test_no_rig_constants.py`) fails if a port name, baud rate, the v0.3
init line, an NI-DAQ channel, a drive path or a v0.3 cm-per-count value appears in the runtime's
code.

## The simulated rig

`rigs/sim.json` binds a simulated ball at 20 samples per second (the rate of v0.3's simulated
Teensy, `test/e2e/sim`) and a simulated valve. Its calibration is v0.3's mapping, as the legacy
profile of device protocol v1 states it (section 10.4): forward = axis 1 × 0.0349 cm, left = axis
0 × 0.0349 cm, yaw = axis 2 × 0.05 rad. Its safety envelope only guards the simulated valve:
`maxPulseMs` 300 and `minIntervalMs` 250 are the illustrative values of the 2026-10 experiment-data
design's example rig file (three-maze-notes, `design/experiment_data.json`, section 5), and
`maxTotalMsPerSession` 60000 is a choice for the simulator, large enough that simulated sessions
never reach it. Its `dataRoot`, `../data`, is the folder `data/` at the repository root, which git
ignores.

## Later in phase 1

Plan items that extend this format: the `lick` role (DPR-25), a serial driver for device protocol
v1 (DPR-03) and its legacy-v0.3 profile settings (DPR-04), the NI-DAQ analog-output driver
(DPR-10), the µL-to-pulse-width calibration of the reward device (DPR-09) and the launcher's use
of `backend` (DPR-15b). The data root and the subject fields every session records are open (D16).
