# ADR-0002: Interpret declarative tasks in the motion worker; the Python rig runtime serves devices, supervises and hosts code tasks

- Status: Accepted (2026-10-08)
- Date: 2026-10-07
- Deciders: project owner
- Related: [0001-player-mover.md](0001-player-mover.md), [0003-render-worker-priority.md](0003-render-worker-priority.md)
- Roadmap: phase 0, "write 3 architecture decision records (ADRs)". Unblocks the phase-1 rig runtime, protocol v1, minimal declarative FSM and hallway ports, and the phase-2 task layer and conformance suite.

## Context

In v0.3 (HEAD a81fd77) Python task code reacts to the renderer's pose messages:

- The scene's requestAnimationFrame (rAF) loop keeps only the newest motion message (`src/scenes/serial/PythonCustomScene.vue:143-173`, `:299-300`), steps Rapier once (`:222`) and sends `position_update` only from that loop (`:244-255`): zone crossings reach the backend only when a frame reports a pose.
- `process_position_update` (`experiments/hallway02_experiment.py:407`) tests a default `TRIAL_END_Y = 70.0` (`:84`, `:480`) that only a never-sent config could change (`:147`; the scene registers with `config: {}`, `PythonCustomScene.vue:715-718`), awaits the valve pulse (`:496` → `:700` → `:728-734`), then returns a `set` teleport (`:522-530`); the client's later messages wait (`backend/src/main.py:954-955`). In a simulation (not re-verified) the teleport came 83–139 ms after the crossing, mostly the awaited pulse (about 77 ms). The fall timer reads the wall clock only when a pose arrives (`:472`).
- After any `set` the server drops every pose with |z| ≥ 10 scene units (`main.py:625-638`, `:644-645`): a spawn away from the origin, such as a T-maze arm, silently stops trial logic and logging.

Step 0 already ends every pulse at 0 V and releases the session when Electron exits (`main.py:998-1027`, forced exit after 10 s) or the last client disconnects (`:964-967`), but cannot detect a hung renderer; the worker heartbeat below adds that. Phase 1 needs the owner of task state fixed first.

## Decision drivers

1. Determinism: identical events in simulation, continuous integration (CI), agent tools and on the rig, as the paper's planned one-sentence contribution ("a single web-native engine that runs identically") requires.
2. Renderer actions at the triggering sample; reward one hop from the zone event.
3. A small device-server contract for non-Python backends.
4. Safety independent of task code and renderer health.
5. A small user surface, for one developer in about six months.

## Considered options

In every option zones are detected renderer-side, zone→valve is one hop, safety lives in the device server (and in the rig's own firmware or hardware, where the rig provides it), a Python rig runtime is needed, and task code in any language works through the task protocol `threemaze.task`.

**A. One engine next to physics.** The finite-state machine (FSM) interpreter runs in the renderer and, unchanged, in Node; backends become thin device servers. *Pros:* one interpreter; no network hop for renderer actions. *Cons:* a renderer crash loses FSM state; the sketch runs the engine in the renderer's fixed-step loop, naming a worker and a watchdog only as risk mitigations.

**B. The Python rig runtime interprets declarative tasks** (the paper strategy's earlier sketch). *Pros:* task state survives a renderer crash; one host for all task forms. *Cons:* renderer actions wait for the zone event to reach Python and the command to return, about 2 ms after the crossing sample or 0–2 samples at 1 kHz (adjudication estimate; the loopback round trip alone is 0.1–0.2 ms), and are deterministic only in lockstep (the worker awaiting each reply before its next sample); parity needs a Python↔Node lockstep harness; non-Python rigs must re-implement the interpreter.

**C. Hybrid.** A's engine in a dedicated motion worker off the renderer's main thread, plus a Python rig runtime as device server, supervisor and code-task host. *Pros:* one engine and sample-exact actions for declarative tasks; a defined supervisor. *Cons:* two task hosts to keep at parity; a renderer crash loses FSM state; code tasks are deterministic only in lockstep, as in B, and need the same harness (declarative dry runs stay pure Node).

Prototypes exist for A's engine and B's runtime, not C (Evidence). The 2 ms difference is behaviourally negligible; determinism of declarative tasks decides, as the review's adjudication (2026-10-06) found.

## Decision

Adopt option C. † marks rules beyond the adjudication, with their source ("new" if none); the owner must confirm them.

**Motion worker**: a dedicated Web Worker in the scene window, never the Vue main thread; the same module (ADR-0001 R7) runs headless in Node for simulation, CI and agent tools. It owns:
- the sample WebSocket and the motion core (ADR-0001), which consumes device samples (sequence number seq, device timestamp t_dev, body-frame displacement) in seq order, each once;
- the declarative FSM, read from a schema-validated JSON (JavaScript Object Notation) task file, with no indentation-based YAML twin in v1.0 (†backend-modules design): states, guards, timers and the planned trial list, which the scene compiler expands from the file's `trials.seed` (seed and list hash logged);
- renderer actions (teleport; setCue, switching a cue object's state; freeze; setGain; display, blanking or showing the screen), applied after the triggering sample and before the next;
- in declarative sessions, the epoch (a teleport/reset counter replacing the |z| < 10 filter), incremented when it applies a teleport, reset or (phase 2) world switch (†owner's glossary).

**Clock and order** (†scene-format design, applied per sample). A timer due at device time T fires on the first sample with t_dev ≥ T. Per sample the worker moves the agent, then dispatches, each to completion: non-motion inputs (e.g. licks) in arrival order, each logged with its dispatch seq (†new); zone exits; zone entries by id; due timers by due time, then id. Other FSM semantics follow that design, fixed with the task schema: the minimal subset in phase 1, the rest in phase 2.

**Rig runtime**: Python, the reference device server and supervisor. It owns:
- the serial reader thread, hardware-timed outputs and the session clock;
- all persistence: raw samples on receipt, events, commands, acknowledgements (acks), frames, and the trial results table (`trials.tsv`) built from events plus acks;
- the safety envelope: runtime caps per pulse, minimum interval and per session, set in the rig file (†example rig files in the designs); a watchdog that closes the valve, zeroes outputs and invalidates the open trial if no worker heartbeat arrives for over 100 ms or the renderer exits. Protection against the rig runtime process itself dying (a firmware pulse limit or a hardware watchdog) belongs to the rig builder and is outside three-maze's scope (owner, 2026-10-07);
- the session lifecycle, with resume at a trial boundary: a restarted worker starts the next planned trial with the trial index and FSM variables logged at the last boundary (†new);
- code tasks: Python `Task` classes in-process (†experiment-data design), or separate processes in any language over `threemaze.task`.

A runtime in another language must pass the conformance suite (black-box tests against a mock renderer) for samples, commands with acks, logging, safety envelope and watchdog; code-task hosting and resume are optional profiles (†new).

**Stamps.** Every event and device command carries its sample's (seq, epoch, t_dev); a teleport's zone exits carry cause "teleport" and the new epoch (†protocol design).

**One task source per session**, declarative or code, so each session has one epoch writer.

**Code tasks** get the same events, action names and timer clock (in lockstep, the same order). They may not sleep, read the wall clock, do input/output or use randomness except the session-seeded `ctx.rng` (seed logged); an abstract-syntax-tree (AST) lint rejects violating Python tasks at load. Reader, writer and watchdog run on their own threads (†new). Each teleport or reset command carries the next epoch, which the worker adopts on applying it; from issuing it, the runtime logs lower-epoch events as stale and never delivers them (†protocol design). Renderer commands carry apply_seq, which the runtime sets to the answered event's seq (†new); the worker applies each after sample max(apply_seq, last processed seq) and logs the seq used.

**Gaps** (†new). Every seq gap is logged (`gap` column of `samples.tsv`, warning event). With no sample for over T_fault (open), timers stop by construction, the open trial is invalidated and the session faults.

## Consequences

*Positive:* zone events and renderer actions stop waiting for frames; one short task plus scene and rig files replaces the three hallway experiments (a 24-line prototype replaces the 880-line `hallway02_experiment.py`); the backend loses all scene geometry.

*Negative:*
- Two task hosts must stay equivalent; declarative task state dies with the scene window's process (the watchdog, resume and offline regeneration from logged samples limit the loss); protocol v1 breaks wire compatibility with v0.3.
- Code tasks get only the live-mode guarantee (commands applied on arrival, applied seq logged), so the one-engine claim covers declarative sessions only. The first paper-data experiment (linear track with probe trials, from week 11 on v1.0-rc) therefore runs as a declarative task, which pulls a minimal FSM into phase 1, the busiest phase.

*Risk:* the format may grow into a language. Keep a flat FSM within the budget of 12 declarative actions and 6 task-event categories, which the prototype task API (16 and 10) exceeds; a CI check fails over budget, and raising it needs an ADR.

*Decided by the owner (2026-10-07):* the roadmap had scheduled the declarative layer (a P0, pre-submission item) in phase 2 (weeks 8–15), after the week-10 v1.0-rc freeze that starts paper data. A minimal declarative FSM (zone and timer events; reward, teleport, freeze, display) moves into phase 1 instead; the rest of the declarative layer stays in phase 2.

*Follow-up:* phase 0 (done 2026-10-08): `*.md` no longer ignored. Phase 1: motion worker with zones and epochs; the minimal declarative FSM; rig runtime with Python task host and lockstep harness; hallway ports as declarative tasks, with Python versions kept for the parity test; protocol v1 with apply_seq. Phase 2: the full declarative layer, `threemaze.task` adapter, MATLAB client, conformance suite, world switching.

## Validation

CI on Windows unless stated; event logs are compared on seq, epoch, t_dev, type and data, never host timestamps.

1. **Declarative path, phase-1 gate** (what v1.0-rc ships): the hallway04 task as JSON in the Node motion-worker module on recorded streams, under ADR-0001 test 7's 8 frame schedules. Pass: identical event logs.
2. **Cross-host parity, phase 1:** golden sessions with the JSON task in Node and its Python version in lockstep. Pass: identical event logs and trial results tables on one pinned Rapier build. Live simulated-rig runs of the Python version report applied seq minus apply_seq per command.
3. **Rig replay, phase 3:** a rig session's samples and inputs through the Node build, code-task commands at their logged applied seq. Pass: byte-identical event logs and pose records if the Rapier and V8 (JavaScript engine) builds match the rig's; otherwise identical events, pose differences reported.
4. **Contracts:** with a code-task teleport applied 3 samples late, the events in between are logged as stale and never reach the task; two task sources are rejected before start; fixture tasks calling `time.sleep`, `time.time`, `datetime.now`, `open()` or `random.random` fail to load; a 13th action fails the budget check.
5. **Watchdog and resume** (simulated rig): stop the worker heartbeat, once while a Python task handler blocks for 1 s. Pass: valve closed and outputs zero within 100 ms plus one heartbeat interval (open, set with protocol v1) of the last heartbeat; open trial invalidated; no seq gap; a restarted worker resumes at the next planned trial with the logged index and variables. Not tested here: a runtime process that dies mid-pulse leaves today's analog output at 5 V (commit f706a94); guarding against that is the rig builder's job (owner, 2026-10-07).
6. **Rig timing** (around week 6, then phase 3). Pass: every declarative renderer action logs applied seq = triggering seq. Report zone-entry→valve-open latency, median and 99th percentile, n ≥ 1000 (the experiment-data validation plan's sample size).

## When to revisit

- Tests 1–3 fail for reasons a shared mover and pinned builds cannot fix.
- Normal rig sessions show heartbeat gaps over 100 ms, or renderer crashes cost trials.
- The planned paradigms (linear track, gain change, flow halt, no-reward block, T-maze) exceed the declarative budget, or a non-Python runtime needs more than its profile.

## Evidence

One Windows 11 workstation (Node 22.16.0, rapier3d-compat 0.14.0, Python 3.12); confidence medium. Prototypes and raw outputs live outside the repository, in the gitignored design-review workspace (`.claude/paper-review/proto/`); the Validation tests will bring the relevant cases in.

| What and method | Result | Caveats |
|---|---|---|
| A's engine: JavaScript FSM with Rapier sensors, `scene_dsl/tm.mjs simulate`, scripted alternation | 15 T-maze trials, 170 s simulated, 182 events, 0.34–0.35 s (re-run 2026-10-07) | fixed 1/120 s step; teleports mid-dispatch (`tm.mjs:310`); zone events in Rapier's drain order (`:333-337`); wall-penetrating stock controller |
| B's runtime: `experiment_data/rig/`, pytest, virtual time | 10/10 pass in 0.82–0.94 s (0.84 s re-run); Python, YAML and Node task forms byte-identical; two runs with one seed identical | YAML interpreted in Python; FakeRenderer, a Python axis-aligned-box stand-in that applies teleports at the next sample (`shell.py:49-52`); timers on virtual host time (`core.py:112-117`); epoch set at command (`:62-64`) |
| Latency, quoted | zone event to backend 1.4–1.8 ms after the crossing sample (motion-core simulation); loopback WebSocket round trip 0.1–0.2 ms median (0.094 ms re-measured); stdio task round trip 31 µs median | |

No prototype runs the decided combination (FSM in a motion worker plus a Python code-task host); its parity is untested, and no equivalence is claimed until tests 1–3 pass against the real worker.
