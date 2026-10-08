# ADR-0003: OffscreenCanvas rendering is P1 behind a week-6 promotion gate; everything that protects data is P0

- Status: Accepted (2026-10-08)
- Date: 2026-10-07
- Deciders: project owner
- Related: [0001-player-mover.md](0001-player-mover.md) (mover), [0002-task-engine-location.md](0002-task-engine-location.md) (motion worker, rig runtime)
- Roadmap: phase 0 ("write 3 ADRs"); phase-1 motion core, timing instrumentation and rendering fixes; the week-6 gate; phase-2 worker rendering.

Priorities (project glossary): **P0** must be done before submission, **P1** strongly recommended, **P2** future work. Decision 1's P0 bundle is in phase 1, so it ships in the v1.0 release candidate (v1.0-rc, week 10).

## Context

This architecture decision record (ADR) decides where the stimulus is rendered. In v0.3 the closed loop runs on the stimulus window's main thread, shared with Vue, inter-process communication (IPC) and garbage collection (GC). At HEAD a81fd77:

- `animate()` (`src/scenes/serial/PythonCustomScene.vue:128-259`), a requestAnimationFrame (rAF) callback, applies the newest serial message (`:143-173`), steps physics once (`:222`), sends `position_update` only if a message was consumed (`:244-255`) and renders (`:258`).
- The WebSocket is dispatched on the same thread (`src/services/MinimalBackendClient.js:103-104`); each message overwrites one reactive slot (`PythonCustomScene.vue:299-301`).
- The backend writes data rows only when a `position_update` arrives (`experiments/hallway02_experiment.py:407`, `:485-503`, `:517-518`).

So frames drive the data. The gain is (rAF rate/60)·(T_dev/50 ms), with T_dev the device sample period: with 50 ms samples it is 1.00 at 60 Hz and 2.40 at 144 Hz (ADR-0001). Messages arriving during a stall collapse to the newest, losing heading increments.

Vue re-renders a semi-opaque panel, at least 250 px wide, over the virtual-reality (VR) image on every frame and message (`:12-52`, stylesheet `:847-865`; writes at `:159`, `:227-228`, `:300-301`). First-use shader compiles stall rendering for hundreds of milliseconds (Evidence 3). Control-window list pages regenerate every thumbnail on mount (`src/stores/scenes.js:363-376`), competing for Chromium's single graphics-processing-unit (GPU) process.

An OffscreenCanvas hands a canvas's drawing to a Web Worker, so rendering runs off the main thread. The review's studies disagreed on workers (motion worker P0, worker-hosted socket P2, OffscreenCanvas rendering P1), and the paper outline lists "worker isolation" as a result. This ADR records the review's 2026-10-06 adjudication of that conflict.

## Decision drivers

1. Behavioural data must not depend on frame timing or the main thread.
2. Missed frames must be measured in every session.
3. Six months, with animal time critical; a render worker touches every scene path.
4. The isolation evidence is synthetic; claim only what is built.

## Considered options

**A. P0 now:** rendering moves into its own OffscreenCanvas worker before v1.0-rc. *Pros:* isolation from main-thread stalls; no gate or mid-campaign renderer swap; an assured worker-isolation result. *Cons:* a large item in the busiest phase; real-app benefit unmeasured; no data-integrity gain over the motion worker; no frame-clock fix. *Evidence:* Evidence 1–2.

**B. P1 with a promotion gate, plus a P0 bundle that protects data (chosen).** *Pros:* data are protected whatever the gate says; the large item is spent only if real stalls warrant it. *Cons:* stalls can drop frames until a worker lands; a promotion must fit between weeks 6 and 10 (Decision 3). *Evidence:* Evidence 1–2; the adjudicated gate.

**C. P2, defer:** the same P0 bundle, but no render worker before submission and no gate. *Pros:* least work. *Cons:* no remedy if real stalls appear; no worker-isolation claim. *Evidence:* none from the real app.

## Decision

**1. OffscreenCanvas rendering is P1. These are P0:**

a. **The motion worker owns the sample socket** (the protocol study's P2 item, now P0). The motion worker is ADR-0002's dedicated Web Worker that runs the per-sample motion core. No device sample, zone event, task decision or device command crosses the stimulus window's main thread, which only renders: it receives poses and render-state changes (cue visibility, display blanking, freeze), each stamped with the sample's sequence number (seq), the teleport/reset counter (epoch) and the device timestamp (t_dev), and returns only its frame log and clock reports.

b. **Stimulus-window hygiene.** No Vue reactivity on the frame or message path; during a session, no cursor and nothing over the stimulus but the error screen (`PythonCustomScene.vue:5-10`); the control window shows telemetry at about 10 Hz. No thumbnail rendering during a session; cache thumbnails by the maze file's content hash. No shader compiles or texture uploads after the renderer reports ready: warm every world, material and texture first (`compileAsync`, `initTexture`, one frame into a 1×1 scissored viewport of the real canvas); log any later rise in `renderer.info` program or texture counts. Background throttling off, display sleep blocked (done in step 0).

c. **A render host free of the Document Object Model (DOM)** (proposed `src/render/`), so the later move takes days (adjudication estimate). It takes its canvas (`HTMLCanvasElement` or `OffscreenCanvas`), size, pixel ratio, poses and render-state changes as arguments or messages, and never touches `window`, `document`, DOM events or Vue. Workers have no `<img>` for `TextureLoader` (`node_modules/three/src/loaders/ImageLoader.js:39`), so textures load through `ImageBitmapLoader` with explicit `imageOrientation: 'flipY'` (`Texture.flipY` does not apply to ImageBitmaps) and `premultiplyAlpha: 'none'` (`setOptions` replaces that default; `ImageBitmapLoader.js:24-30`). Phase 1 covers the experiment scene, phase 2 the others (`src/worlds/BaseWorld.js`, `src/scenes/physics/HallwayControlScene*.vue`).

d. **Frame log and long-task observation; photodiode deferred.** Per frame the render host logs the index, rAF timestamp, callback entry and exit times, the device time t_dev shown (with the two bracketing seqs when interpolating) and the epoch, batched to the rig runtime (ADR-0002's Python device server and recorder). A `PerformanceObserver` adds long-task and long-animation-frame entries (from 50 ms; MDN Web Docs, the Mozilla Developer Network), an addition to the adjudicated bundle for the gate. A photodiode on each stimulus display (a patch hidden from the animal and toggled every frame, recorded at 10 kHz or more on a spare analog input of the National Instruments data-acquisition device, NI-DAQ, which the rig has) would measure when frames actually appear and the true motion-to-photon latency. It is deferred (owner, 2026-10-07): the current rig cannot support the measurement yet. It stays on the to-do list, and until then frame timing rests on the frame log. The step-0 monitor (60 Hz assumed, `src/utils/frameClock.js:9`; gain reported, `:25-27`) becomes a display-based clock check without the gain report, a 5 s self-test and then rolling: median frame rate within ±1% of the display's refresh rate (at least ±1 Hz; Electron reports whole hertz, `:48-50`), a 95th-minus-5th-percentile interval spread under 0.5 ms, and the primary-display warning kept (`:57-64`).

**2. Promotion gate: the first rig measurement, about week 6.** Rig computer, displays awake, no 1d warning (clock, display, primary display), items (a), (b) and the frame log and long-task observation of (d) in place (the gate waits for them); at least 3 sessions of at least 30 min (about 108,000 frames each at 60 Hz, as in the rendering validation plan), at least one with normal control-window use.
- *Counting:* P = median rAF interval; an interval over 1.5 P is late and counts round(interval/P) − 1 missed frames, per 1,000 expected (rendered plus missed) frames; rAF timestamps give the low estimate, callback entry times the high one (Evidence 1).
- *Attribution:* main-thread work is any task on the stimulus window's main thread from ready to session end, found in a Chromium trace of each session (Electron `contentTracing`), long-task and long-animation-frame entries and the app's timed handlers; late intervals traced to the GPU process or the frame clock do not count.
- *Rule:* **promote the render worker to P0 if (G1) missed frames in late intervals attributed to main-thread work reach 1 per 1,000, or (G2) any main-thread task lasts 50 ms or more (a browser long task).** The owner narrowed G2 from the adjudication's "longer than one frame" (2026-10-07), so that a single 17 ms garbage-collection pause cannot promote the worker; tasks between one frame and 50 ms count through G1. For G1, promote if the low estimate reaches 1 per 1,000 and keep P1 if the high estimate is below it; in between, the owner decides from the traces and records why (photodiode-confirmed missed frames would decide, once the deferred photodiode exists). If the 95% confidence interval of the deciding rate spans 1 per 1,000, the owner decides and records why. Render-callback overruns count like any task and are listed separately; a compile or upload after ready violates 1b and must be fixed before repeating the gate. Results amend this ADR.

**3. Afterwards.** If promoted, the render worker becomes P0 and lands before the v1.0-rc freeze, so that paper data come from one renderer (owner, 2026-10-07); if it slips, the owner chooses between moving the freeze and the version-split mitigation (Risks). It is a second dedicated worker (owner, 2026-10-07, replacing the roadmap's "closed loop in one worker"), fed the stamped poses and render-state changes by the motion worker over a `MessageChannel`; the motion worker never renders, so render stalls (Evidence 3) cannot delay samples, zone events or the heartbeat whose absence for over 100 ms trips ADR-0002's watchdog. The main-thread host stays as a feature-detected fallback; provenance records which host rendered, any fallback's reason and the Electron, Chromium and three.js versions, and a fallback in a paper-data session is a session fault. If the worker never lands, "worker isolation" leaves the paper's Results 2.4, its architecture section 2.1 describes main-thread rendering, and the stall test goes to the supplement.

## Consequences

*Positive:* with the per-sample motion core (ADR-0001, ADR-0002), stalls can cost frames but not change pose, zone events or logs; no uncontrolled overlay covers the stimulus; the gate yields real-app numbers for the paper.

*Negative:* until a worker lands, stalls can drop or repeat frames (logged, not prevented); the render host needs tests with both canvas kinds.

*Risks and mitigations:*
- Promotion squeezes weeks 6–10: build the render host first; decide the gate before freezing v1.0-rc.
- Version split: a mid-campaign renderer swap splits data; a late worker serves only new campaigns, or both builds are validated.
- Wrong cure: a worker cannot fix Chromium's frame clock, which falls back to a timer (about 56.5 Hz with a 60 Hz primary display) when that display sleeps or the rendering GPU does not drive it; the clock check stays (and the photodiode, once added).

*Follow-up:* phase 0 (done 2026-10-08): `*.md` no longer ignored; the step-0 test bench is in `test/e2e/`. Phase 1: 1a–1d, test 5. Week 6: the gate. Phase 2: the render worker unless promoted; other scenes on the render host. Phase 3: the 4–8 h soak (photodiode-referenced if the photodiode exists by then) and, if the worker landed, both builds under the stall suite. To-do, deferred until the rig supports it: the photodiode of 1d, which the paper needs for a measured motion-to-photon latency. Roadmap updated (2026-10-07): warm-up before ready (was phase 2), thumbnail caching (a rendering-study P1 item), the worker-hosted socket and the experiment scene's render host join phase 1; phase 2's "closed loop in one worker" becomes a separate render worker.

## Validation

Continuous integration (CI) on Windows; "simulated rig" means the hardware-free test bench built for step 0 (emulated sensor and outputs; to be committed in phase 0).

1. **Data survive stalls.** Replay one recorded sample stream through the simulated rig with and without 100 ms main-thread busy-waits every second in the stimulus window. Pass: identical per-seq pose and event records, no seq gaps, each stall logged as a late interval and a long-task entry.
2. **Hygiene.** A scripted session on the simulated rig: no DOM mutations in the stimulus window from ready to end (`MutationObserver`), constant `renderer.info` program and texture counts, no thumbnail rendering.
3. **DOM-free host.** A lint rule bans DOM globals in the render host. An Electron smoke test renders 20 canonical poses per shipped maze (rendering validation plan) in both hosts and through v0.3's `TextureLoader` path at equal renderer settings. Pass: no errors; equal draw-call and program counts; identical `readPixels` hashes, or a structural-similarity (SSIM) index above a threshold fixed in the test.
4. **Counting rules:** unit tests of the late, missed and attribution rules, including a fixture with known 100 ms stalls that checks both estimates against its net frame deficit.
5. **Stall suite** (phase 1, before the gate): the worker suite of `proto/rendering/bench.mjs` and `render-worker.mjs`, ported into the repository and re-run with 50 and 100 ms stalls on the pinned Electron; the gate and the supplement use that version.

On the rig: 6. **the gate** (week 6), as specified in Decision 2.

## When to revisit

- The gate result, either way.
- New main-thread work in the stimulus window (an observer view, mid-session asset loads).
- An Electron upgrade after the phase-0 pin: re-run tests 1 and 5 and the gate.
- 144 Hz displays (6.94 ms frame budget) or a multi-display canvas.
- Late frames traced to the GPU process or the frame clock.

## Evidence

Prototypes and raw outputs live outside the repository, in the gitignored design-review workspace (`.claude/paper-review/`); tests 1–5 bring the relevant cases in.

**1. Synthetic stall test** (`proto/rendering/bench.mjs`, `render-worker.mjs`, `results/worker-high*.json`): Electron 33.4.11 (Chromium 130), three.js r169, RTX 5070; an unlit HallwaySerialMigrated replica, 1920×1080 buffer, windowed unfocused page; 1,200 frames per condition (nominally 20 s, about 22 s on the fallback clock); 50 or 100 ms main-thread busy-waits once per second; rendering only. Decision 2's rule, on rAF timestamps (both rows) and callback entries (100 ms row):

| Stall | Main thread: missed frames; max interval | Worker: missed; max interval |
|---|---|---|
| 50 ms/s | 20 (1.639%, rAF); 36 ms | 0; 18.9 ms |
| 100 ms/s | 84 (6.542%, rAF), 121 (9.16%, entry); 89.2 ms (rAF), 118.1 ms (entry) | 0; 18.8 ms |

Both 100 ms series had 22 late intervals. The rAF count matches the net frame deficit (elapsed time / P minus intervals, about 83); the entry count exceeds it, because the short intervals that follow a stall are not credited. rAF timestamps under-read stall length (89.2 against 118.1 ms; a 45 ms stall read as 31 ms in the scene-switch benchmark), and the step-0 monitor uses them (`frameClock.js:102-111`). Limits: synthetic stalls (5–10% of the main thread); one run per condition ("6.5–9.2%" is two metrics of one run); one GPU; Chromium's fallback clock (17.6–17.7 ms period, about 56.5 Hz); no photodiode; end-of-life Electron, replaced in phase 0. Confidence: medium.

**2. Data integrity without a render worker** (headless Node, with the review's collide-and-slide mover rather than ADR-0001's hover kinematic character controller (KCC); not re-verified; ADR-0001's test 7 repeats it): per-sample gain 1.0000 at 56.5–144 Hz and identical trial events across 8 frame schedules, including 2% long frames, a 250 ms stall and a 2 s hidden window.

**3. Compile stalls** (scene-switch benchmark: remote-desktop session, fallback clock, 24 switches per condition; worst case, with salted programs and an empty program cache, while a cache hit still cost 14–45 ms): an unwarmed switch to new shader programs froze rendering for a median 356 ms (RTX 5070, lit materials). After the 1b warm-up, switch frames took 0.1–0.3 ms of main-thread CPU (completion 1.1–9.5 ms).
