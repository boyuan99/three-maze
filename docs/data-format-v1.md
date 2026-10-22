# Data format v1

- Status: **draft**, `format_version` `1.0.0-draft.1` (2026-10-22). Plan item DPR-26 freezes it as `1.0.0` before v1.0-rc; until then later plan items add to it (section 12), and every change raises the draft number.
- Written by: the rig runtime's recorder, [`threemaze/record/`](../threemaze/record/) (plan items DPR-07 and DPR-08a). The tables and logs below are those of `threemaze/record/formats.py`, and `session.json` is that of [`schema/session-v1.schema.json`](../schema/session-v1.schema.json); `test/backend/runtime/test_data_format.py` fails when this page and the code or the schema list different columns or fields.
- Related: [device protocol v1](protocol/device-v1.md) (section 7.2: the device sample, which is one row of `samples.tsv`), [link protocol v1](../protocol/v1/SPEC.md) (the messages that most rows come from), [ADR-0002](adr/0002-task-engine-location.md) (Rig runtime: the runtime owns all persistence; Stamps), [ADR-0003](adr/0003-render-worker-priority.md) (1d: the frame log), [gate analysis](timing/gate-analysis.md) (reads `frames.tsv` and `longtasks.jsonl`).

A v1 session folder holds what happened in a session as plain text: tables (`.tsv`) for records that come in streams and logs (`.jsonl`) for everything else, written while the session runs. Every device sample gets its row in `samples.tsv` the moment the runtime receives it, whatever the motion worker or the renderer does. In v0.3 a data row was written only when the renderer reported a position, which caused the four data-logging defects of the end-to-end bench and the stale first row (`test/e2e/README.md:85-118`, `:296-357`); the v1 recorder has no such path.

Why text: the 2026-10 experiment-data design compared formats. TSV and JSONL stayed readable after 20 of 20 random process kills during continuous writing, losing at most the last second, while Parquet was unreadable after 20 of 20 (it has no footer until it is closed), and text can be read with any tool or language. Parquet and NWB are formats to convert to after a session, never live formats (three-maze-notes `design/experiment_data.json`, section 6, "Format decision").

## Contents

1. [The session folder](#1-the-session-folder)
2. [Conventions](#2-conventions)
3. [samples.tsv](#3-samplestsv)
4. [pose.tsv](#4-posetsv)
5. [events.jsonl](#5-eventsjsonl)
6. [commands.jsonl](#6-commandsjsonl)
7. [trials.tsv](#7-trialstsv)
8. [frames.tsv](#8-framestsv)
9. [longtasks.jsonl](#9-longtasksjsonl)
10. [session.json](#10-sessionjson)
11. [Reading the files](#11-reading-the-files)
12. [What later plan items add](#12-what-later-plan-items-add)
13. [Sources](#13-sources)

## 1. The session folder

```text
<data root>/<session id>/      the rig file's dataRoot; the id is ses-<local time>_rig-<rig name>
  session.json                 the session record (section 10)
  rig.json, rig.json.sha256    the rig file as validated, and its SHA-256 (docs/rig-file-v1.md)
  samples.tsv                  one row per device sample, written on receipt
  pose.tsv                     one row per pose of the motion worker
  events.jsonl                 every non-stream event
  commands.jsonl               commands and acks, output requests and their outcomes
  trials.tsv                   one row per trial
  frames.tsv                   one row per rendered frame
  longtasks.jsonl              long tasks of the stimulus window's main thread
  raw/<device>.tsv             a device's raw-line log (the format of tools/capture_raw.py)
  sim/<device>.jsonl           a simulated device's own log (docs/rig-file-v1.md)
```

The runtime creates the folder, and every table with its header row, when it arms the session (plan item DPR-06a), so a table without rows still says what it would hold. Where the data root lies on a rig, and which subject fields every session records, are the project owner's decision D16, which is open: until then the folder is the rig file's `dataRoot` and the session record has no subject (section 10).

Where the rows come from (the recorder's input interface, `threemaze/record/recorder.py`):

| File | Rows come from | Through |
|---|---|---|
| `samples.tsv` | the device's reader thread (plan item DPR-03), once per accepted sample | `sample()` |
| `pose.tsv` | the motion worker's `pose.batch` messages, by the link server (DPR-06b) | `poses()` |
| `events.jsonl` | the motion worker's `event` messages; `render.report` ready and clock; the task's trial events (TS-13, TS-14); the runtime itself | `motion_event()`, `render_report()`, `event()` |
| `commands.jsonl` | commands and acks (DPR-05b), output requests and outcomes (DPR-09) | `command()` |
| `trials.tsv` | built by the recorder from the trial events and the reward requests and outcomes | |
| `frames.tsv`, `longtasks.jsonl` | the render host's `render.report` frames and long_tasks, forwarded by the motion worker | `render_report()` |

## 2. Conventions

**Text.** Every file of sections 3 to 10 is UTF-8, and every line ends with LF (v0.3's data files ended lines with CRLF); the raw-line log and the simulated device's log of section 1 have formats of their own. A table starts with one header row of column names; cells are separated by one TAB, with no quoting, since no value can hold a TAB or a line end: the recorder refuses a name or id with any character outside its pattern, a line end included. A log holds one JSON object per line, compact, with every character outside ASCII escaped. No table or log has comment lines.

**Values.** Integers are written in decimal. A float is written as the shortest decimal that reads back as the same double (Python's `repr`; JavaScript's `JSON.stringify` picks the same digits but writes, for example, `1e16` as `10000000000000000` where Python writes `1e+16`), so every float reads back exactly (`test/backend/runtime/test_recorder.py`, 3,000 random doubles, each written in that shortest form). A float column also takes a whole number, which JavaScript sends as an integer (`0.0` arrives as `0`), and writes it as a float (`0.0`). A table writes a boolean as `1` or `0`, a log as `true` or `false`. An empty cell means the value is absent, and only the columns whose description says so can be empty. NaN and infinity are never written: the recorder refuses them, as the link protocol does (SPEC.md, E2). Integer counts, not the floats derived from them, are the source of truth (plan item DPR-26).

**Units** are the last part of a column or field name:

| Suffix | Unit |
|---|---|
| `_ns` | nanoseconds, an integer |
| `_us` | microseconds, an integer |
| `_cm` | scene units: 1 unit = 1 cm (ADR-0001) |
| `_rad` | radians; a heading or a turn is positive counter-clockwise seen from above, and heading 0 looks down −Z (ADR-0001 R1) |
| `_counts` | raw sensor counts, before calibration |

A name without a suffix is a number without a unit (`seq`, `epoch`, `gap`, `frame`, a count of rewards), a bit field (`flags`), a boolean or an id.

**Clocks.** Each time belongs to one clock and is compared only with times of that clock (link protocol, section 4.2):

| Clock | Fields |
|---|---|
| the session clock: `time.perf_counter_ns()` of the runtime | `t_host_ns` everywhere: when the record reached the runtime (for a sample: the read that completed its line, device protocol v1 rule H1) |
| the device clock, unwrapped to 64 bits (device protocol v1, H6) | `t_dev_us` |
| the render host's `performance.now()`, named by `time_origin_us` | `raf_us`, `entry_us`, `exit_us` in `frames.tsv`; `start_us` and the other `_us` times in `longtasks.jsonl` |

Wall-clock time stamps nothing; `session.json` keeps the wall clock read together with the session clock, so that a session can be placed on the calendar. Mapping one clock onto another is plan item DPR-14.

**Order.** Rows and lines are written in the order the runtime received them; for the motion worker's events that is their dispatch order (link protocol, V2). `seq`, the device's sample number, joins `samples.tsv`, `pose.tsv`, `events.jsonl` and `frames.tsv`; a session has one stream, so a `seq` names one sample.

**Crashes.** The recorder hands every row to a writer thread (`threemaze/record/writer.py`), which writes, flushes and fsyncs each file about once a second, and fsyncs each header when it creates the file. A crash of the runtime therefore loses at most about the last second, and every file stays readable, except that its last line may be cut off; readers drop a last line that has no line end (section 11). In `test/backend/runtime/test_recorder_crash.py` a process recording at 1,000 samples per second is killed 20 times: every file of every run read back, and the newest sample on disk was 0.16 to 0.94 s older than the kill (development PC, 2026-10-22, measured under the bench lock of `test/e2e/README.md` with the CPU 1.4 % busy at the start). Rows of `trials.tsv` wait in memory until their trial is complete (section 7), and the events and commands they are built from are on disk.

**Free disk.** The runtime arms a session only if the data root has room for an hour of its data, which covers the 30-minute sessions of the week-6 gate (ADR-0003, Decision 2) and of plan item REN-25 twice over; a longer run, such as ADR-0003's phase-3 soak of 4 to 8 hours, needs its room checked before it starts, from the hours the free space holds, which `session.json` records (`preflight`). A motion device that states no sample period (neither in its description nor in its hello) cannot be checked: the runtime then logs a warning and `preflight` is null. The volume is estimated from rows of the session's own formats holding the long values of a long session (`estimate_bytes_per_hour` in `threemaze/record/recorder.py`): per sample a `samples.tsv` row, a `pose.tsv` row and a raw-line log line, plus `frames.tsv` rows at 144 frames per second, the rate at which the experiment-data design measured its frame table. That is 1.35 GB per hour at 1,000 samples per second with 3 axes, 0.07 GB of it frames, and 0.10 GB per hour at 20 samples per second (`rigs/sim.json`), most of it frames; the design's narrower samples table alone was 189 MB per hour at 1,000 samples per second.

## 3. samples.tsv

One row per device sample that the runtime accepted (device protocol v1, rules H3 and H4), written when it was received. It is the device sample of device protocol v1, section 7.2, as the link protocol sends it to the motion worker (SPEC.md, section 8), plus its receive time. A sample that the device produced but the runtime never received has no row; the `gap` of the next row counts it. When it knows who numbered the samples (`seq_source`), the recorder checks that each `seq` follows the previous one and its `gap`, and writes a `warning` event (`sample_seq`) when one does not, which can only mean that a sample was handed to it twice or not at all; the row is written all the same.

| Column | Type | Meaning |
|---|---|---|
| `seq` | int | Sample number, uint32: the device's own (`seq_source` `device`), or numbered by the runtime from 0 (`seq_source` `host`, profile legacy-v0.3); the session record says which. |
| `t_dev_us` | int | End of the sample's window on the device clock, unwrapped to 64 bits (device protocol v1, H6); for a device without a clock (`time_source` `host`), the session clock at receipt in µs. |
| `t_host_ns` | int | Session clock at the read that completed the sample's line (device protocol v1, H1): when the runtime received it. |
| `dt_us` | int | Time the displacement covers: `t_dev_us` minus the previous sample's, so longer than one period after a gap; an estimate for a stream's first sample when `flags` bit 8 is set. |
| `gap` | int | Samples lost just before this one: counted from `seq` (`seq_source` `device`) or inferred from the device clock (`host`); 0 when none. |
| `flags` | int | Bits 0-7: the device's flags byte (bit 0 `count_incomplete`, bit 1 `no_tracking`); bit 8 (256): `dt_estimated`; bit 9 (512): `dt_mismatch`. The link protocol's sample flags. |
| `raw_<j>_counts` | number | One column per sensor axis j = 0 … n − 1 (n from the device's hello, at most 16): counts of that axis since the previous sample, before calibration. Integers from a v1 device (the difference of its running totals, device protocol v1, D6); a legacy-v0.3 device's counts are written as they were parsed. |
| `d_fwd_cm` | float | Forward displacement: row 0 of C × raw, with C the rig file's calibration matrix, summed over the axes in ascending order in double precision (device protocol v1, section 7.2). |
| `d_left_cm` | float | Leftward displacement, left positive: row 1 of C × raw. |
| `d_yaw_rad` | float | Heading change, counter-clockwise seen from above positive: row 2 of C × raw. |

## 4. pose.tsv

One row per pose the motion worker sent (`pose.batch`, link protocol section 9), in the order received: the motion core's pose after it processed sample `seq`. The motion worker sends exactly one pose per sample (rule P1), so `pose.tsv` has a row for every row of `samples.tsv` whose sample the worker processed; `seq` joins the two.

| Column | Type | Meaning |
|---|---|---|
| `seq` | int | The sample this pose follows. |
| `epoch` | int | Teleport and reset counter in force after the sample (ADR-0002). |
| `t_dev_us` | int | `t_dev_us` of sample `seq`. |
| `x_cm` | float | Agent position x. |
| `feet_y_cm` | float | Height of the agent's feet; the eye is at `feet_y_cm` plus the rig file's eye height (ADR-0001 R3). |
| `z_cm` | float | Agent position z. |
| `yaw_rad` | float | Heading as the motion core integrated it (ADR-0001 R1). |
| `contact` | bool | The mover met a wall during this sample. |
| `airborne` | bool | No floor under the agent after this sample (falling). |
| `world` | token | The world of the pose (phase 1: the experiment's only world). |
| `t_host_ns` | int | Session clock when the pose's batch reached the runtime. |

## 5. events.jsonl

Every non-stream event, one JSON object per line, in the order the runtime received them. An event that belongs to a sample carries that sample's stamp (ADR-0002, Stamps); the event log is compared between runs and hosts on `seq`, `epoch`, `t_dev_us`, `kind` and `data`, never on `t_host_ns` (ADR-0002, Validation).

| Field | Present | Meaning |
|---|---|---|
| `t_host_ns` | always | Session clock when the event reached the runtime, or happened in it. |
| `src` | always | Who reported it: `motion`, `task`, `render`, `runtime`, `device`, `operator`. |
| `kind` | always | What happened (table below). |
| `seq` | with a stamp | The sample the event belongs to. |
| `epoch` | with a stamp | The epoch after the event. |
| `t_dev_us` | with a stamp | `t_dev_us` of sample `seq`. |
| `world` | with a stamp | The world the event happened in. |
| `stale` | sometimes | `true`: the event carries an epoch older than the runtime's, so it was logged and not acted on (plan item DPR-06b). |
| `data` | when it has more | Every other field of the event, as reported. |

| `src` | `kind` | `data` |
|---|---|---|
| `motion` | `zone`, `fall`, `land`, `teleport_applied`, `seq_gap`, `guard` | the event's own fields in the link protocol (SPEC.md, section 10): for example `zone`, `edge`, `cause` |
| `task` | `trial_start` | `trial`: the task's trial index |
| `task` | `trial_end` | `trial`, `outcome`: a name from the experiment file |
| `render` | `ready`, `clock` (and any render-report kind a later minor version adds) | the report's fields, `time_origin_us` included (SPEC.md, section 11) |
| `runtime` | `state` | `state`: the session state entered (from `armed` on), `reason` for `aborted` |
| `runtime` | `warning` | `code`, `message` and what the warning is about; `sample_seq`: a sample that does not follow the previous one (section 3) |

`trial_start` and `trial_end` must carry a stamp; the plan items that add the task's events to the link protocol (TS-13, TS-14, DPR-05b) map them onto these kinds.

## 6. commands.jsonl

Every command and acknowledgement and every output request and its outcome, one JSON object per line, in the order the runtime received or sent them: what a replay needs besides the samples (plan item DPR-26). Plan items DPR-05b and DPR-09 define the messages; each becomes one line with these fields:

| Field | Present | Meaning |
|---|---|---|
| `t_host_ns` | always | Session clock when the record reached the runtime, or was sent by it. |
| `src` | always | Who sent it: `motion` (the motion worker), `runtime`, `device` or `operator`. |
| `kind` | always | `command`: a command to the motion worker; `ack`: the motion worker's acknowledgement of one; `request`: an output request, such as a reward; `outcome`: the one terminal outcome of a request. |
| `cmd_id` | always | The command's id: unique within a session, shared by a command and its ack, and by a request and its outcome (device protocol v1, H8). |
| `action` | command, request | `reward`, `teleport`, `freeze`, `display` or `setGain`. |
| `trial` | request | The trial a reward belongs to, when the requester names it (section 7). |
| `seq` | command, request | Stamp of the sample that triggered it. |
| `epoch` | command, request, ack | The epoch; for a command, the epoch it brings in. |
| `t_dev_us` | command, request | `t_dev_us` of sample `seq`. |
| `apply_seq` | command | The sample after which it is to be applied (ADR-0002, Code tasks). |
| `applied_seq` | ack | The sample after which it was applied. |
| `width_us` | request, outcome | Request: the pulse width commanded (for a reward given in µl, after the rig's calibration). Outcome: the width the device measured or the runtime timed, when reported. |
| `outcome` | outcome | `done`, `truncated` (the session stopped during the pulse), `refused` (safety envelope or device), `failed` or `unresolved` (no acknowledgement in time, rule H8). |
| `timing` | outcome | How the width was timed: `hardware`, `software` or `unreported` (device protocol v1, section 8.4). |
| `device` | sometimes | The output device, by its name in the rig file. |
| `data` | when it has more | Any other field. |

A reward request must have `width_us`; an outcome must have `outcome`. A field outside this table goes into `data`. The first outcome of a request is its outcome; a later one, such as an acknowledgement that arrives after the request was declared unresolved, is logged and changes nothing (rule H8).

## 7. trials.tsv

One row per trial, built by the recorder from the `trial_start` and `trial_end` events and the reward requests and outcomes (ADR-0002, Rig runtime: "the trial results table built from events plus acks"), so that it states commanded against acknowledged reward.

A reward belongs to the trial its request names (`trial`); without one, to the trial that is open, or, between two trials, to the trial that ended last, so that a reward requested in the sample that ends a trial counts for that trial whichever of the two actions the task dispatched first. A reward requested before the first trial belongs to none and is only in `commands.jsonl`. A trial's row is written once the trial has ended, the next trial has started and every reward of the trial has an outcome; when the session ends, every remaining trial is written, an open one with `ended` 0, and a reward without an outcome counts as unresolved. Rows are therefore in the order their trials became complete, which is the order of the trials unless an outcome is late; sort by `trial` for analysis. An outcome counts for the request recorded before it with the same `cmd_id`, so whoever sends a request records it before sending it (plan item DPR-09); an outcome that arrives before its request was recorded stays in `commands.jsonl` only, and the request counts as unresolved.

| Column | Type | Meaning |
|---|---|---|
| `trial` | int | Trial index, as the task numbers its trials. |
| `start_seq` | int | Sample at which the trial started (the `trial_start` event's `seq`). |
| `start_epoch` | int | Epoch at the start. |
| `start_t_dev_us` | int | Device time of the start sample. |
| `start_t_host_ns` | int | Session clock when the `trial_start` event reached the runtime. |
| `end_seq` | int, may be empty | Sample at which the trial ended; empty if it had not ended when the session ended. |
| `end_epoch` | int, may be empty | Epoch at the end (before any teleport that the end causes). |
| `end_t_dev_us` | int, may be empty | Device time of the end sample. |
| `end_t_host_ns` | int, may be empty | Session clock when the `trial_end` event reached the runtime. |
| `outcome` | token, may be empty | The outcome the task gave when it ended the trial (a name from the experiment file); empty if the trial had not ended when the session ended. |
| `ended` | bool | 1 if the task ended the trial; 0 if the session ended first. |
| `rewards_requested` | int | Reward requests that belong to this trial. |
| `reward_requested_us` | int | Pulse width commanded by those requests, summed. |
| `rewards_done` | int | Requests whose outcome is `done`: delivered and acknowledged. |
| `rewards_truncated` | int | Requests whose pulse was cut short (the session stopped during it). |
| `rewards_refused` | int | Requests refused (safety envelope, or the device refused the pulse). |
| `rewards_failed` | int | Requests that failed in the output device. |
| `rewards_unresolved` | int | Requests without an acknowledgement: outcome `unresolved`, or no outcome at all when the session ended. |
| `reward_delivered_us` | int | Pulse width reported with the `done` and `truncated` outcomes, summed (outcomes that report no width add nothing). |

## 8. frames.tsv

One row per rendered frame, from the render host's frame log (`render.report` frames, link protocol section 11; ADR-0003 1d), in the order received. Its columns `frame`, `raf_us`, `entry_us`, `exit_us`, `hidden`, `context_lost` and `post_ready_rise` are the input of the gate analysis (`docs/timing/gate-analysis.md`, section 2), which reads the file as it is (`test/backend/runtime/test_recorder.py`). The frame record's `t_raf_us`, `t_start_us` and `t_end_us` are written as `raf_us`, `entry_us` and `exit_us`, the names the gate analysis reads.

| Column | Type | Meaning |
|---|---|---|
| `frame` | int | Frame index of the render host: 0 for the first requestAnimationFrame callback after ready, then +1 per callback, so a jump means that frame records were lost. |
| `raf_us` | int | The callback's requestAnimationFrame timestamp, on the render host's clock. |
| `entry_us` | int | `performance.now()` when the callback started. |
| `exit_us` | int | `performance.now()` when the callback returned. |
| `epoch` | int | The epoch of the pose drawn. |
| `seq` | int, may be empty | The sample whose pose was drawn, or the earlier of two when the frame interpolated; empty before the first pose. |
| `seq_next` | int, may be empty | The later of the two samples when the frame interpolated between poses; empty otherwise. |
| `t_dev_us` | int, may be empty | The device time the drawn pose stands for; empty before the first pose. |
| `flags` | int | The frame record's flags as sent: bit 0 blank, bit 1 frozen, bit 2 hidden, bit 3 context lost, bit 4 programs or textures rose after ready; bits 5-7 reserved. The next five columns repeat bits 0-4. |
| `blank` | bool | `flags` bit 0: the screen was blanked. |
| `frozen` | bool | `flags` bit 1: motion was frozen. |
| `hidden` | bool | `flags` bit 2: the document was hidden. |
| `context_lost` | bool | `flags` bit 3: the WebGL context was lost. |
| `post_ready_rise` | bool | `flags` bit 4: shader programs or textures rose after ready (ADR-0003 1b). |
| `world` | token | The world the frame showed. |
| `time_origin_us` | int | `performance.timeOrigin` of the render host's realm in whole µs: names the clock of `raf_us`, `entry_us` and `exit_us`; not itself a time stamp (link protocol, R1). |
| `t_host_ns` | int | Session clock when the frame's batch reached the runtime. |

## 9. longtasks.jsonl

Long tasks of the stimulus window's main thread (`render.report` long_tasks, plan item REN-12), one JSON object per line, in the order received: the second input of the gate analysis. The entry's `entry`, `t_start_us` and `duration_us` are written as `type`, `start_us` and `duration_us`, the names the gate analysis reads.

| Field | Present | Meaning |
|---|---|---|
| `type` | always | `longtask` or `long-animation-frame` (`PerformanceEntry.entryType`), or `handler` (one of the app's own timed handlers). |
| `name` | when reported | `PerformanceEntry.name`, or the handler's name. |
| `start_us` | always | Start, on the render host's clock. |
| `duration_us` | always | Duration. |
| `blocking_us` | long-animation-frame | `blockingDuration`. |
| `render_start_us` | long-animation-frame | `renderStart`. |
| `style_layout_start_us` | long-animation-frame | `styleAndLayoutStart`. |
| `time_origin_us` | always | `performance.timeOrigin` of the render host's realm, in whole µs: the clock of the times above. |
| `t_host_ns` | always | Session clock when the entry's batch reached the runtime. |

## 10. session.json

The session record (plan item DPR-08a): one JSON object, written by `threemaze/record/session.py` and valid against [`schema/session-v1.schema.json`](../schema/session-v1.schema.json) (JSON Schema 2020-12). The runtime writes it whole and atomically, to a temporary file that it fsyncs and then renames over the old one, so a reader never sees half a record: when the session folder exists, at every change of state, when the motion worker says hello, when the renderer reports ready, and a last time once the session has ended and the recorder has closed its files. The first record, the changes of state and the last record are on disk before the runtime goes on; the hello, the ready report and what the launcher passes are written by the record's own thread a moment after they arrive, so that the link server, whose event loop also carries the samples and the heartbeats, never waits for the disk (link protocol, B1 and B2). The last record includes every update that arrived before the session ended; one that arrives later is logged and not recorded.

**Status and crashes.** `status` is `running` from arming until the session has ended, and all that time the runtime holds an operating-system lock on `session.lock` in the session folder; the operating system releases it when the process ends, however it ends. The last record says `complete` or `aborted`, and the lock file goes; `recording.errors` then says whether any rows did not reach their files. A runtime that is killed or crashes leaves `running`. When the runtime next arms a session on the same data root, it looks for records that say `running` while nobody holds their lock. For each, it takes the lock and reads the record again; if it still says `running`, the runtime sets its `status` to `crashed`, adds `crash`, removes the stale lock file, lists the session in the new session's `crashed_sessions` and logs a `warning` event (`crashed_session`). Nothing else of the crashed session changes; its tables hold what the writer had flushed, which is at most about a second short (section 2). A session still open in another runtime is never taken for a crashed one, because its lock is held (on the same computer, or on a network share that passes the lock on; a folder that a sync tool copies between computers does not), and neither is one that its runtime closed after it was first read, because a runtime writes its last record before it releases the lock. `test/backend/runtime/test_session_record.py` kills a runtime during a session and checks all of this.

| Field | Meaning |
|---|---|
| `format` | `three-maze-session`. |
| `format_version` | The data format version of the folder (this page's). |
| `session` | The session id, which the motion worker's hello names too; the session folder has this name, with `-2`, `-3`, ... added if a folder of that name exists already. |
| `status` | `running`, `complete`, `aborted` or `crashed` (above). |
| `state` | The session state last entered: `configured`, `armed`, `running`, `stopping`, `complete` or `aborted` (plan item DPR-06a). |
| `abort_reason` | Why the session aborted; null otherwise. |
| `states` | Every state entered, in order: `state`, `perf_ns` (the session clock), `wall_utc` (the wall clock, read together with it, ISO 8601 in UTC) and `reason`. |
| `clock` | `session_clock`: `time.perf_counter_ns()` and what Python reports about it (implementation, resolution, monotonic, adjustable); `start` and `stop`: the anchors (`perf_ns`, `wall_utc`) of the states `running` and `complete` or `aborted`, null before. |
| `runtime` | `host` and `pid` of the runtime; `three_maze`: `version` (package.json), `runtime_version` (the `threemaze` package), `git_commit` and `git_dirty` of the checkout (dirty: a tracked file differs from the commit; null when git cannot tell); `python`: `version`, `implementation`; `packages`: every package installed in the runtime's Python environment with its version, so every package of `requirements.txt` (ADR-0004, Decision 1); `os`: `platform`, `system`, `release`, `version`, `machine`. |
| `rig` | `name`, `source` (the rig file the session was configured with), `copy` (`rig.json`), `sha256`, `data_root`, `bindings`, and `in_force`: the `motion` and `backend` sections with the schema's defaults applied, the values in force ([rig file v1](rig-file-v1.md)). |
| `task` | `kind` and `ref` of the session's task source. |
| `subject` | null. Which subject fields every session records is the project owner's decision D16, which is open; plan items DPR-08b and TS-29 add them. |
| `devices` | Every device the session opened, by its name in the rig file: its `roles`, then its driver's description. A device that speaks device protocol v1, an output device included (rule H9 names each device), adds the fields of that protocol's section 8.3: `profile`, `hello`, `guarantees`, `completeness`, `integrity`, `seq_source`, `time_source` and `counters` (rules H2 to H6, D9); an output device adds `output_timing` (section 8.4: `hardware` when its hello declares `ack=1`, `unreported` otherwise). A device read by the serial reader (plan item DPR-03) also gives `stop_report` (the line of the last stream's stop report, null without one), `raw_log` (its raw-line log, null when it is off) and `reader`: the reads, bytes, batches, read timeouts and discarded bytes of its reader thread, the `failure` that ended the thread early (null if none) and the `undelivered_records` that the runtime's event loop could not take. The simulated driver also gives its `device_id`, `period_us`, `axes`, `outputs`, `files` and `sim_log`, the serial_lines driver its `port`, `device_id`, `period_us` and `outputs`. Written when the session is armed and again when it ends, when `guarantees.stop_report` and the final counters are known (rule H9). |
| `client` | The motion worker, from its hello (link protocol, C5): `role`, `impl`, `version`, `protocol_version`, `versions` (by component: `electron`, `chromium`, `v8`, `three`, `rapier3d-compat`, `ajv`, the renderer, physics and validator versions of ADR-0004, Decision 1) and `t_host_ns`; null until it connects. The hello's session token is not written. |
| `render` | The render host's ready report (`render.report` ready): `host` (`main` or `worker`), `fallback_reason` (null unless the main thread draws although a worker was asked for, ADR-0003 Decision 3), the warm-up figures, canvas size, pixel ratio, refresh rate, renderer settings and asset hashes as reported, `time_origin_us` and `t_host_ns`; null until it arrives. |
| `rig_info` | What `npm run rig:info` found on this computer (plan item REN-1: the displays with their refresh rates and scale factors, the primary display, the GPU with its WebGL strings, the system and versions), as that probe writes it, when the launcher passes it (plan items TS-19a, DPR-15b); null until then. |
| `build` | `kind` (how the renderer was built and served, for example `rig` or `dev-server`) and `dist_sha256` (the hash of the built renderer it loaded), from the launcher (plan item REN-26); null until then. |
| `preflight` | The free-disk check made when arming: `free_bytes`, `estimate_bytes_per_hour`, `hours_required`, `hours_available` (section 2). |
| `crashed_sessions` | The folders of the sessions of the data root that this session found crashed when it was armed. |
| `recording` | The recorder's summary once it has closed its files: `flush_interval_s`, `files` (`rows` and `dropped` lines of each file), `late` (lines handed over while the files were being closed; one that arrives after the summary is logged, not counted here), `seq_mismatches` (section 3), `rewards_outside_trials`, `trial_warnings` (section 7) and `errors`; null before, and in a session that aborted before its recorder opened. |
| `crash` | Only in a crashed session's record: `detected_wall_utc`, `detected_by` (the session that found it) and `last_state`. |

The runtime sets most fields itself; `client` comes from the link server when the motion worker connects (plan item DPR-06b, `record.client_hello`), `render` from the recorder when the ready report arrives, and `rig_info` and `build` from the launcher.

## 11. Reading the files

The recorder's reader reads every table and log back with the values that were written, and drops a last line without its line end:

```python
from threemaze.record import read_log, read_table

samples = read_table("ses-20261022T101500_rig-sim/samples.tsv")
samples.rows[0]["t_dev_us"]        # int; floats come back as the same double
samples.partial                    # True if a crash cut off the last line, which was dropped
events = read_log("ses-20261022T101500_rig-sim/events.jsonl").records
```

Any other tool reads them too; two things to keep in mind:

- pandas reads a table with `pd.read_csv(path, sep="\t", float_precision="round_trip", keep_default_na=False, na_values=[""])`. Without `float_precision="round_trip"` its default float parser can return a double next to the one written; without the other two it also takes names such as `NA`, `None` or `null`, which are valid outcomes and worlds, for missing values, while only an empty cell means one.
- A file that a crash cut off may end in a line without its line end. Drop that line before reading (the Python reader does), or a reader may take it as a short row.

The gate analysis reads a session folder's `frames.tsv` and `longtasks.jsonl` directly: `npm run timing:gate -- <session folder>`.

## 12. What later plan items add

| Plan item | Adds |
|---|---|
| DPR-17 | the frame-log fields of `session.json` (frame count, frame-index gaps, post-ready rises, hidden and context-lost counts) |
| DPR-25 | `licks.tsv` (lick edges with `seq`, `t_dev_us`, `t_host_ns`, state) and a lick column in `samples.tsv` |
| DPR-14 | the clock estimates that map the render host's and the device's clocks onto the session clock |
| DPR-05b, DPR-09, TS-13, TS-14 | the link protocol's commands, output requests and outcomes and the task's trial events, mapped onto `commands.jsonl` and the `trial_start` and `trial_end` events |
| DPR-08b | the complete session record: hashes, seed, motion provenance, counters, subject |
| DPR-26 | the freeze: this page becomes version 1.0.0 |

## 13. Sources

- Plan item DPR-07 (three-maze-notes `plan/phase1-plan.json`): the tables, one row per sample on receipt, the writer thread with a flush and fsync about every second, the trailing partial line dropped on read, the free-disk preflight, `commands.jsonl`, floats in shortest round-trip form; DPR-08a: the session record and crash detection; DPR-26: integer raw counts as the source of truth, `format_version`.
- The 2026-10 experiment-data design (three-maze-notes `design/experiment_data.json`, section 6): the folder layout, the tables and the format decision with its crash measurements, from which this format departs where the link protocol fixed names and fields since (for example `samples.tsv` carries the calibrated displacement `d` of device protocol v1, section 7.2).
- [ADR-0003](adr/0003-render-worker-priority.md), Decision 3 (provenance records the render host, a fallback's reason and the versions); [ADR-0004](adr/0004-dependency-versions.md), Decision 1 (the versions every session records).
- [ADR-0002](adr/0002-task-engine-location.md): Rig runtime ("all persistence: raw samples on receipt, events, commands, acknowledgements (acks), frames, and the trial results table (`trials.tsv`) built from events plus acks"), Stamps, Gaps, Validation.
- [Device protocol v1](protocol/device-v1.md): sections 7.2 (the device sample), 8 (guarantee levels) and rules H1, H3, H4, H6, H8.
- [Link protocol v1](../protocol/v1/SPEC.md): sections 4.2 (clocks), 8 to 11 (samples, poses, events, render reports), rules E2, C5, P1, P2, V2, R1, R3.
- [Gate analysis](timing/gate-analysis.md), section 2: the input format of `frames.tsv` and `longtasks.jsonl`.
- `test/e2e/README.md:85-118`, `:296-357`: the four v0.3 data-logging defects.
