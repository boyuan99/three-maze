# Hardware-free end-to-end bench (`test/e2e`)

Runs the real three-maze renderer scene and the real Python backend together, without a Teensy, an
NI-DAQ device or a `D:` drive, and without a visible window. A simulated rig stands in for the
devices; the Electron, renderer, backend and experiment code are the repository's own.

This is the step-0 test bench (ADR-0001 follow-up, ADR-0003 follow-up "commit the step-0 test
bench"), brought into the repository. It runs on Windows only.

```sh
npm run test:e2e                         # = node test/e2e/run.mjs: sim, s1, s2, lifecycle
node test/e2e/run.mjs --only s1,lifecycle
node test/e2e/run.mjs --only all         # also close, crash, t35
node test/e2e/run.mjs --list
```

## What it checks

| Scenario | Default | What happens | Checks |
|---|---|---|---|
| `sim` | yes | Self-test of the simulated rig, without the backend: 10 cases, each in its own `python.exe`/`pythonw.exe` process | serial stream format and rate, missing/busy/silent COM port errors as pyserial reports them, DAQ errors and close semantics, `D:\VirmenData` redirect, missing `D:`, the rig fails closed (exit 86) when misconfigured |
| `s1` | yes | `hallway04_experiment.py` in the Hallway04 scene with a simulated Teensy (20 Hz, constant running) and NI-DAQ; the app quits like ESC (`app.quit()`) | backend started detached under `pythonw.exe` with a stdin pipe; the rig is active in the backend; registration OK and `experiment_start` sent after it; scene rendered (`PythonCustomScene`); closed loop (serial samples reach the renderer without gaps, positions advance); at least 2 trials, and trials = rewards = DAQ pulses = trial-end rows of the data file, each reward following its own trial end (`trials_and_rewards_match`: only the final trial may lack its reward, and only if it ended less than 1 s before the quit); every pulse ends at 0 V and the DAQ task is closed at 0 V; serial port closed; data file complete (well-formed rows, CRLF, at most 3 samples short of the last sample read) and closed by the backend; one data row per serial sample, counted from the first sample read, not from the first row: the samples read before `experiment_start` (`data_rows_session_start_backlog`) and those read after it (`data_rows_one_per_sample`), no sample lost in the renderer (`data_rows_reset_frame_loss`, `data_rows_overwritten_between_frames`), and every row except the reset rows logged by a `position_update` the renderer sent (`data_rows_match_position_updates`), see below; renderer-status sidecar written; graceful quit (shutdown requested, cleanup complete, backend exited before Electron, no stop timeout, no watchdog); no traceback or error in backend, renderer or main process |
| `s2` | yes | Same, but COM3 does not exist | registration fails with the port error; the error overlay ("Failed to load experiment: could not open port 'COM3' ...") is shown; no `experiment_start`; no pulse, no data rows; only the expected errors; graceful quit |
| `lifecycle` | yes | Five Electron runs of `lifecycle/harness.cjs` with the real `getBackendLaunch`, `stopPythonBackend` and `before-quit` code of `electron/main.js` and the real `BackendServer` (with a fake experiment) | `quit`: graceful stop, backend exits before Electron. `double`: a second `app.quit()` during the stop is deferred, one terminate only. `crash`: Electron killed, the detached `pythonw` backend cleans up by itself within 3 s. `crash_hang`: cleanup hangs, the watchdog ends the backend 10 s after the pipe broke (exit code 1). `quit_hang`: cleanup hangs, `stopPythonBackend` kills the backend after 4 s (kill path) |
| `close` | no | S1, quit by closing the scene window (`window-all-closed`) | as S1, at least 1 trial |
| `crash` | no | S1, Electron's main process killed at 18 s (like `taskkill /F` without `/T`) | the backend exits by itself within 3 s; pulses end at 0 V, DAQ and serial port closed, data file complete with one row per sample (the five data-row checks), all from the rig's own logs |
| `t35` | no | Opening COM3 blocks 35 s, so registration outlasts the renderer's 30 s timeout | timeout overlay; the late registration is stopped (`experiment_stop`), serial, DAQ and data file released before the quit; no pulse |

Every session and lifecycle run also checks: no visible window of the process tree, no new console
window (a monitor polls all top-level windows; a probe lists console windows before and during the
run), and nothing left running. Every session also checks `harness_matches_main_js`: the harness
opens the scene window with its own copy of `createSceneWindow` (route, display choice, web
preferences, load order), and records whether `electron/main.js` still does each of these
(`summary.json`, `main_js.scene_window`). Every flag must be true, so a change to
`createSceneWindow` fails the bench until `harness/main.cjs` is updated to match. At the end,
`no_process_left_by_this_run` checks every process the run started or saw in its trees, by PID and
creation time.

Data rows (S1, `close`, `crash`): every data row carries the Teensy timestamp of the sample it was
logged with (the simulated Teensy sets it to sample number x period), so each row names its sample.
Counting starts at the first sample the backend read (sample 1), not at the first row, and is split
at `experiment_start`:

- `data_rows_session_start_backlog`: every sample read before `experiment_start` (while the backend
  was still registering the experiment, about 9 samples) has its own row.
- `data_rows_one_per_sample`: from the first sample read after `experiment_start` to the last row,
  every sample has exactly one row: no sample without a row, no sample with two. Allowed around
  each trial end: the reset row (written after the reward pulse, with the newest sample) may share
  the trial-end row's sample, and the one or two samples read during the pulse have no row of their
  own (the backend drops the renderer's stale updates until the reset reaches it).
- `data_rows_reset_frame_loss` and `data_rows_overwritten_between_frames`: no sample of either range
  was lost in the renderer by one of its two v0.3 losses (Known limits). A sample lost this way has
  no `position_update`, so it can have no row; these two checks judge such samples, and the two
  checks above judge every other sample.
- `data_rows_match_position_updates`: every row except the reset rows has the x, y and theta of a
  `position_update` the renderer sent (matched in order), because the backend writes rows only for
  updates and for the reset. One exception, after a crash only: the rows after the last row that
  matched, each with a sample newer than the last update in `ws.jsonl`, are not judged. `ws.jsonl`
  is recorded in Electron, and its last few hundred milliseconds are lost with it, while the
  backend still logs those updates (2 to 9 rows in each of the 4 `crash` outputs on disk).

Each row is also matched to the `position_update` it logged, so every sample without a row is put
in one class, by what happened to its update. For a sample the renderer sent no update for, the
bench reads the signature in `ws.jsonl`, where every frame is in the page's own order with its time
(`t_ms`). Such a sample qualifies only if the page received its `serial_data` once and in order,
and the first update the page sent after that `serial_data` is for a newer sample; its window runs
from the last `position_update` before its `serial_data` to that next update. Each check counts
every class in its evidence:

| Class | What happened to the sample's update |
|---|---|
| `session_start_backlog` | (before `experiment_start` only) the backlog's signature: the first row was logged by the session's first update, which the renderer sent before `experiment_start`, with a newer sample's timestamp than its own; the sample comes before the first row's. The v0.3 session-start backlog (Known limits) |
| `logged_with_newer_sample` | it was logged, but with a newer sample's timestamp: the first signature of the v0.3 low-frame-rate defect (Known limits) |
| `skipped_after_late_update` | it was skipped as a duplicate after an older update had been logged two or more samples late: the low-frame-rate defect's second signature. Exactly: the sample has updates and no row has any of them; an older update, sent before them, was logged with a sample newer than this one; and the page sent each of this sample's updates before it had received any sample newer than that row's |
| `reset_frame_loss` | the renderer sent none, and it is the sample the frame that applied a reset (`position_confirm` with action `set`) took: the first `serial_data` after the reset, or, if that one was overwritten in a burst (`overwritten_between_frames`), the burst's last sample. It arrived at most 20 ms after the reset, with no update in between. At most one sample per reset. The signature of the v0.3 reset-frame loss (Known limits) |
| `overwritten_between_frames` | the renderer sent none, and the next `serial_data`, a newer sample, arrived at most 5 ms after it (in the same burst) and before the next update: the signature of the v0.3 overwrite between frames (Known limits) |
| `no_position_update` | the renderer sent none, without either signature (for example a second sample after a reset that was not overwritten in a burst, or a sample whose next `serial_data` came 6 ms or more later) |
| `update_without_row` | it reached the backend, but no row has it, and it is not `skipped_after_late_update`: a lost row |
| `logged_with_older_sample` | it was logged with an older sample's timestamp |

The facts line shows the counts, for example `before experiment_start: 8 of 9 samples without a row
(8 session-start backlog); from sample 10: 1 of 330 samples without a row (1 reset_frame_loss)`,
and the number of rows without a `position_update` in `ws.jsonl` when there are any.

### Known failures

A check that fails on a known product defect, in a run where that defect is expected, and only with
that defect's signature, is a known failure. The console prints it on its own
`KNOWN FAILURE <check>: <reason>` line, followed by its evidence; the scenario line says
`N known failure(s)`; `results.json` lists it (`known_failures`, and `known_failure` on the check);
and the final line says `PASSED ..., with N KNOWN FAILURE(S) (<scenario>: <check>, ...)`. A known
failure does not fail the scenario or the exit code; every other failing check does. If the check
also finds anything outside the defect's signature, it is an ordinary failure.

There are four today, the four v0.3 data-logging defects under Known limits: two in the backend
(`hallway04_experiment.py`) and two in the renderer (`PythonCustomScene.vue`). Each has its own
check, so a change in any of them shows on its own. Phase 1 (protocol v1, per-sample motion core)
removes all four code paths; all four checks must then pass.

| Check | Known failure when | The reason line gives |
|---|---|---|
| `data_rows_session_start_backlog` | in every run, GPU or not, if every sample without a row among those read before `experiment_start` is `session_start_backlog` (or a renderer loss, judged by the two checks below) and none has two rows | the backlog's size: `session-start backlog of 8 samples (1-8) without a row, of 9 read before experiment_start; the first row is update 1 logged with sample 9's timestamp: ...` |
| `data_rows_one_per_sample` | with software rendering only (`--software-gl`, or a WebGL renderer that reports SwiftShader), if every sample without a row is `logged_with_newer_sample` or `skipped_after_late_update` (or a renderer loss, judged by the two checks below), none has two rows, and every reset row follows a trial-end row | the count, split by signature when both occur: `26 of 921 samples from sample 10 on have no row, each with the defect's signature: 25 logged_with_newer_sample (...) and 1 skipped_after_late_update (...: 872: update 871 logged as sample 873) (not counting 157 samples lost in the renderer, judged by their own checks): ...` |
| `data_rows_reset_frame_loss` | in every rendering mode, if a sample of either range is `reset_frame_loss` | the count, every sample number and each one's window: `1 sample (257) without a position_update or a row, with this loss's signature (257: 16 ms after a reset, between updates 256 and 258): ...` |
| `data_rows_overwritten_between_frames` | in every rendering mode, if a sample of either range is `overwritten_between_frames` | the count, every sample number and each one's window (the first 12): `2 samples (607-608) without a position_update or a row, each with this loss's signature (607: replaced by 608 0 ms later, before update 609; 608: replaced by 609 0 ms later, before update 609): ...` |

The two renderer checks find only samples with their own signature, so they are a known failure
whenever they find one; like every data-row check, they fail as an ordinary failure if the data
file cannot be read (no rows, or a timestamp that names no sample).
`data_rows_match_position_updates` has no known failure. With a GPU, a `logged_with_newer_sample`
or `skipped_after_late_update` sample makes `data_rows_one_per_sample` an ordinary failure (its
evidence then notes the defect). In every rendering mode, a sample of any other class
(`no_position_update`, `update_without_row`, `logged_with_older_sample`), a sample with two rows,
or a row without a `position_update` makes its check an ordinary failure. So does a renderer or
backend that loses samples in a way of its own: a renderer changed to drop every 40th
`position_update` failed `data_rows_one_per_sample` (`no_position_update`) with a GPU and with
software rendering, and a backend changed to drop or to duplicate every 40th row failed in both
modes too (Known limits has the cases software rendering can hide).

## Requirements

- Windows 10 or 11, in a desktop session. A GitHub Actions `windows-latest` runner (Windows
  Server, no GPU) should work but has not been tried yet; CI runs the bench only when started by
  hand (`.github/workflows/ci.yml`, job `e2e`, with `--software-gl --ci` and the scenarios
  `sim,s2,lifecycle` by default; see Known limits for S1).
- `npm ci` (Electron 33 and vite from `package.json`).
- The repository venv `.venv` with `python.exe` and `pythonw.exe` (`.venv/Scripts`) and the backend
  packages of `requirements.txt` (websockets, pyserial, nidaqmx, numpy). `npm ci` creates it
  through `setup/setup-python.js`; the NI-DAQmx driver is not needed.
- No Teensy, no NI-DAQ device, no `D:` drive. If `D:` exists (as on GitHub runners) it is not
  written: the rig redirects only `D:\VirmenData`. The output folder must not be on `D:`.
- Ports 8765 (the session backend) and 8795 (the lifecycle backend) free: close three-maze first.
  The runner checks them before it starts anything and exits with code 2 if one is taken, because
  on Windows a second backend on a taken port crashes on bind instead of moving to the next port.
- A GPU is optional: without one, Chromium renders with SwiftShader (the harness allows that
  fallback); `--software-gl` forces it.

## How long

Measured on the development machine (Windows 11, RTX 5070): the renderer build 2 s, `sim` 6 s,
`s1` 21 s, `s2` 11 s, `lifecycle` 19 s: about 60 s for the default run. `--only all` adds `close`
18 s, `crash` 19 s and `t35` 49 s: about 150 s in all.

S1 runs its scene for at least 20 s and on (up to 90 s) until two rewards have been given. With
software rendering (`--software-gl`) trials take longer, and how much depends on the frame rate
SwiftShader reaches. On the development machine the first 11 software runs (2026-10-08) ran at
25-26 frames/s: with the current S1 the scene ran about 34 s and S1 took about 36 s (the scene
ran 48-64 s when a reward was lost, see Known limits). Six of the 7 runs after them ran at 16
frames/s (cause not found): the renderer then overwrites 14-20 % of the samples before a frame
takes them, so the player moves more slowly, the scene ran 46-51 s, and S1 took about 52 s (55 s
with the build).
Expect a CI runner without a GPU to be slower still.

## Options

| Option | Meaning |
|---|---|
| `--only a,b` | scenarios to run (`default`, `all`, or names from `--list`) |
| `--duration S` | minimum S1 scene time in seconds (default 20) |
| `--out DIR` | output folder (default: a new `three-maze-e2e-*` folder in the system temp folder). Not on `D:` (refused before anything is created). It must be new, empty, or the output folder of an earlier run (marked by a `.three-maze-e2e` file); anything else is refused with exit code 2. When an earlier run's folder is reused, each scenario's folder `<DIR>/<scenario>` is deleted before that scenario runs, so the simulated rig's appended logs never mix two runs; folders of scenarios not run this time are left as they were, and `results.json` covers only this run |
| `--renderer DIR` | reuse a vite build instead of building one |
| `--software-gl` | render with SwiftShader (`app.disableHardwareAcceleration()`) |
| `--ci` | for shared CI runners: the `sim` self-test measures its tight timing tolerances (first line 45-80 ms after init, median gap 48-52 ms, 24-27 lines in 1.32 s, test pulse 69-90 ms) and reports them in its facts line and `summary.json` instead of asserting them. Its functional checks still run |
| `--keep` | keep the renderer build and the Electron profiles in the output folder |

Exit code: 0 all checks passed (known failures do not count, see above), 1 a check failed, 2 the
bench could not run (missing venv, Electron or packages, not Windows, bad arguments, an unusable
`--out` folder, port 8765 or 8795 in use). Ctrl+C stops the processes the run started.

## Reading the output

The console shows one block per scenario:

```
  ---- s1: simulated Teensy: hallway04 runs, ...
  PASS s1          21.5 s  21/23 checks, 2 known failures
             scene 20 s; 60 frames/s; WebGL ANGLE (...); serial 339 sent/339 read; registered at 4.2 s; trials 2, rewards 2, pulses 2 (54.1/65.4 ms); data 330 rows (0 samples short; before experiment_start: 8 of 9 samples without a row (8 session-start backlog); from sample 10: 1 of 330 samples without a row (1 reset_frame_loss)); sidecar 3 lines; quit 131 ms; backend exit -0.058 s after Electron
       FAILED <check>: <the evidence, as JSON>
       KNOWN FAILURE data_rows_session_start_backlog: session-start backlog of 8 samples (1-8) without a row, ...: <the known defect>
         evidence: <the evidence, as JSON>
       KNOWN FAILURE data_rows_reset_frame_loss: 1 sample (257) without a position_update or a row, with this loss's signature (257: 16 ms after a reset, between updates 256 and 258): <the known defect>
         evidence: <the evidence, as JSON>
  ...
PASSED: 4/4 scenarios in 61.8 s, with 2 KNOWN FAILURES (s1: data_rows_session_start_backlog, s1: data_rows_reset_frame_loss); details in <out>\results.json
```

The facts line is for orientation; a `FAILED` line names the check and shows the numbers it used.
Everything is also in `results.json` in the output folder, whose path is printed first. Per
scenario (`<out>/<scenario>/`):

| File | Content |
|---|---|
| `summary.json` | the harness's record: backend spawn options, markers in the backend output (ms since Electron started), quit events, renderer console counts, screenshots, page text |
| `analysis.json` | the numbers the checks use (serial, DAQ pulses, WebSocket counts, data file, sidecar, processes) |
| `backend.log` | backend stdout/stderr, each line with the harness time (`+NNNNNms`) |
| `renderer.log`, `main.log`, `network.log`, `ipc.log` | renderer console, Electron main process (including `electron/main.js`'s own messages), requests, IPC calls |
| `ws.jsonl` | every WebSocket frame the page sent or received (captured through the DevTools protocol) |
| `shot-05s.png`, `shot-mid.png`, `shot-final.png` | screenshots of the offscreen page |
| `sim/serial.jsonl`, `sim/daq.jsonl`, `sim/sim.jsonl` | the simulated rig's logs: every serial line and write, every DAQ write and close (written by the backend process itself, so they survive a crash) |
| `sim/VirmenData/` | the experiment's data file and its `.renderer.jsonl` sidecar (redirected from `D:\VirmenData`) |
| `monitor.json`, `monitor.log` | every process of Electron's tree with exact exit codes and times, visible windows, new console windows |
| `probe_console.*.log` | console windows before and during the run |
| `main-js.extracted.js` | the exact `electron/main.js` code the harness ran |

Lifecycle cases are in `<out>/lifecycle/<case>/`: `lifecycle.log` (Electron side), `marker.txt`
(backend side), `monitor.json`.

## How it works

- `sim/` (`threemaze_sim`): a `sitecustomize.py` that, in a Python process started with
  `THREEMAZE_SIM=1` and `test/e2e/sim` on `PYTHONPATH`, replaces `serial.Serial` with a simulated
  Teensy (the hallway firmware's 13-field CSV at the period of the init line, 16 forward counts per
  sample), `nidaqmx.Task` with a logged analog output, and redirects `D:\VirmenData` to
  `$THREEMAZE_SIM_DIR/VirmenData`. The modules are patched right after their first import, so the
  backend's import order is unchanged. If the rig cannot be set up the process exits with code 86,
  so a run can never fall through to real hardware. See `sim/threemaze_sim/__init__.py`.
- `harness/main.cjs`: the Electron main process of a session. It evaluates the backend and quit
  code of `electron/main.js` by source text (`harness/mainjs.cjs`; it stops with an error naming
  the block if `main.js` is restructured), spawns the backend through it (so the backend gets the
  app's own spawn options and the rig's environment), and opens the scene window like
  `createSceneWindow`, but hidden and offscreen, with a fixture scene (`public/mazes/Hallway04`
  as the Serial Control tab stores it) in its own user-data folder. The owner's profile is never
  read or written.
- `harness/monitor.py` (run with `pythonw.exe`): tracks Electron's process tree by handle, polls the
  visible windows, and terminates what is left of that tree only. `harness/probe_console.py` lists
  visible console windows.
- `lifecycle/`: the lifecycle harness and its backend (`child_backend.py`).
- `lib/`: the renderer build (vite with the repository's `vite.config.js`, into the output folder,
  cache included; `dist/` and `node_modules/.vite` are not touched), a static server for it inside
  the runner's process, process helpers and the checks.
- Python bytecode of every child goes to `<out>/pycache` (`PYTHONPYCACHEPREFIX`), not into the
  repository.

The runner stops only processes it started, by PID (and their descendants, `taskkill /T`), never by
image name, so other Node or Python programs are never touched. Three-maze itself must be closed
first, because the bench's backend needs its port 8765 (see Requirements).

## Known limits

- Offscreen frames are painted at a fixed 60 Hz (`setFrameRate(60)`), not at the display's
  refresh. Frame pacing, full-screen display, display choice, display sleep and the photodiode
  question are not exercised. With software rendering the frame rate is lower and the renderer's
  frame-clock warning appears (expected; not a failure).
- Four known v0.3 data-logging defects, reported as known failures until phase 1 removes their code
  paths (see Known failures). The frequencies below are from every unmodified bench output on the
  development machine (Windows 11, RTX 5070) as of 2026-10-08: 39 GPU sessions (28 `s1`, 7
  `close`, 4 `crash`) and 18 software-rendering S1 runs, 12 at 25-26 frames/s and 6 at 16
  frames/s (see How long).
- Two of them are in `hallway04_experiment.py` (lines 447-486). Both come from the same rule: a
  `position_update` is logged with the timestamp of the newest sample the backend has read, and an
  update that arrives while that sample is already logged is skipped as a duplicate
  (`_last_logged_timestamp`).
  - Session-start backlog, in every run, GPU or not (`data_rows_session_start_backlog`). The
    backend reads samples while it registers the experiment (about 0.45 s), and the renderer
    answers each with a `position_update`. These updates wait until registration ends and then
    reach the experiment together: the first is logged with the newest sample's timestamp (the
    first row has update 1's position with sample 9's timestamp) and the others are skipped. So
    the samples read before `experiment_start` have no row, except the one the first row names:
    8 samples (1-8) in 50 of the 57 sessions, 9 (1-9) in the other 7.
  - Low-frame-rate defect (`data_rows_one_per_sample`), shown with software rendering, and expected
    on the rig whenever the renderer's main thread stalls for longer than about one sample period
    (50 ms). The renderer sends a `position_update` only after a frame, so at 25 frames/s it often
    reaches the backend after the next serial sample has been read; it is then logged with that
    newer sample's timestamp, and the following update is skipped as a duplicate
    (`logged_with_newer_sample`). About a quarter of the samples get no row: 25-28 % in each of
    the 12 runs at 25-26 frames/s. At 16 frames/s it was 3-4 % in 5 runs and 8 % in 1, because
    most of the samples were then overwritten in the renderer first (below).
  - When frames take longer than a sample period (16 frames/s), an update can be logged two
    samples late: update 871 logged with sample 873's timestamp, then update 872 skipped as a
    duplicate, so sample 872 has no row although its update reached the backend. This is the
    defect's second signature (`skipped_after_late_update`, exact conditions in the class table),
    a known failure in the same check. Seen in 4 of the 6 runs at 16 frames/s (1 to 3 samples
    each); not at 25-26 frames/s or with a GPU.
  - When the skipped update is the one that crosses the trial end, the player is reset without a
    reward, a trial count or a trial-end row: `trials_and_rewards_match` and
    `data_rows_one_per_sample` then fail as ordinary failures (3 of the 11 runs at 25-26 frames/s
    with the current S1, none at 16 frames/s), with a note in `trials_and_rewards_match`'s
    evidence that names this defect. A lost reward stays an ordinary failure. With a GPU at 60
    frames/s the defect has not shown (0 of 39).
- The other two are in the renderer, `src/scenes/serial/PythonCustomScene.vue`. Each loses a
  sample before the renderer sends its `position_update`, so the backend never sees it. Both are
  known failures in every rendering mode, each with its own check. Their signatures use the order
  and the times of the frames in `ws.jsonl` (exact conditions in the class table).
  - Reset-frame loss (`data_rows_reset_frame_loss`). When the reset (`position_confirm`, action
    `set`) reaches the renderer in the same frame as a new `serial_data`, the reset branch clears
    that sample (`pendingSerialData = null`, line 214): it gets no update and no row, and its
    velocity is dropped. A reset clears one sample at most, so the bench counts one at most: the
    sample that frame took, which arrived 0-16 ms after the reset in all 20 cases on disk (limit
    20 ms). Seen in 4 of the 39 GPU sessions (about 1 in 10; 1 sample each, the sample right after
    a trial's reset) and in 12 of the 18 software S1 runs (1 or 2 samples each). Before this check
    existed, it made the default GPU bench fail now and then.
  - Overwrite between frames (`data_rows_overwritten_between_frames`). When two `serial_data`
    arrive between two frames, `handleSerialData` (line 300) replaces the older one before a frame
    takes it: it gets no update and no row, and its rotation step (`deltaTheta`) is never applied
    (S1 runs straight, so the path does not show it). The two arrive in one burst after a long
    frame: in all 996 cases on disk the newer one came 0-1 ms after the lost one (limit 5 ms),
    while samples otherwise arrive about 50 ms apart. Seen in 13 of the 18 software S1 runs: 2 to
    6 samples in 7 of the 12 runs at 25-26 frames/s, and 115 to 186 samples (14-20 %) in each of
    the 6 runs at 16 frames/s. Not yet seen with a GPU (0 of 39), but any main-thread stall longer
    than about one sample period causes it.
  - A sample without an update that has neither signature is `no_position_update`, an ordinary
    failure; none of the outputs above has one. None has an `update_without_row` sample or a row
    without a `position_update` either (apart from the `crash` rows after the end of `ws.jsonl`,
    see `data_rows_match_position_updates`).
- Software-rendering S1 therefore reports two to four known failures. Of the 17 runs made with the
  current S1 (the 18th is an older 20 s run with one trial), 14 passed with known failures only
  and 3 failed on a lost reward (the trial-end skip above). The manual CI job runs
  `sim,s2,lifecycle` by default; add `s1` by hand to see these defects.
- With software rendering, a lost row or a dropped `position_update` can look exactly like the
  low-frame-rate defect: where updates are logged one sample late, one after another, the sample
  whose row is gone is classed `logged_with_newer_sample`, and a sample whose update is gone may
  still have a row, logged by the update before it. A dropped update whose next sample came in the
  same burst looks exactly like the overwrite. Such a loss is caught only where the defect is not
  active at that moment. Deleting single rows from software outputs (each of about 60 positions in
  turn), the bench caught 44 of 61 and 46 of 67 at 25-26 frames/s and 9 of 62 at 16 frames/s;
  deleting one `position_update` and its row, 38 of 70, 52 of 66 and 11 of 62. With a GPU it
  caught all of them (62 of 62 rows, 73 of 73 updates), and every duplicated row in both modes.
  Live, a renderer changed to drop every 40th `position_update` failed the bench with a GPU (8
  samples `no_position_update`) and with software rendering at 16 frames/s, but there only through
  1 of its 23 dropped updates: 15 samples kept a row through the lag and 7 fell in a burst. A
  backend changed to drop or to duplicate every 40th row failed in both modes.
- The renderer losses are judged from the WebSocket frames (`ws.jsonl`), not from the renderer's
  animation frames, which the bench does not see. Every real case on disk is inside the time
  limits (5 ms, 20 ms), but GPU reset-frame losses arrived 15-16 ms after the reset, so a frame
  delayed by more than about 4 ms turns a real one into an ordinary failure (a false red, never a
  hidden fault). A renderer fault that drops an update outside a burst or later than
  20 ms after a reset fails as an ordinary failure; one that drops the update of a sample inside a
  burst, or of the first sample after a reset, looks exactly like the known loss and is reported as
  it. A sample whose `serial_data` reached the page twice, out of order, or never, or with no
  update after it, is `no_position_update`, an ordinary failure.
- No real devices: the Teensy and the NI-DAQ are models of what the repository's code expects (the
  firmware source is not in the repository). USB-serial and DAQ driver timing are not modelled.
  Pulse widths (about 50 to 80 ms for 70 ms) are reported, not checked.
- The lifecycle cases use a fake experiment; `crash` and `t35` cover the real one.
- The ESC key, the quit dialog, the gallery window and Windows session end are not covered.
- The session backend needs port 8765 and the lifecycle backend 8795, so the bench cannot run
  while three-maze (or another bench run) is open: the runner refuses with exit code 2 and
  "close three-maze first". It never stops another program's backend.
- Windows only (pythonw, Windows process and window APIs).
