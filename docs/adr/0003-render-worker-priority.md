# ADR-0003: OffscreenCanvas rendering is P1 behind a week-6 promotion gate; everything that protects data is P0

- Status: Accepted (2026-10-08); amended 2026-10-09, 2026-10-22
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

*Follow-up:* phase 0 (done 2026-10-08): `*.md` no longer ignored; the step-0 test bench is in `test/e2e/`; the end-of-life Electron 33 is replaced by Electron 44.7.0 (Chromium 152), pinned exactly, on which tests 1 and 5 and the gate run (Evidence 1 is from 33.4.11; test 5 has re-run it on 44.7.0, see the Evidence amendment of 2026-10-22) (amended 2026-10-22). Phase 1: 1a–1d, test 5. Week 6: the gate. Phase 2: the render worker unless promoted; other scenes on the render host. Phase 3: the 4–8 h soak (photodiode-referenced if the photodiode exists by then) and, if the worker landed, both builds under the stall suite. To-do, deferred until the rig supports it: the photodiode of 1d, which the paper needs for a measured motion-to-photon latency. Roadmap updated (2026-10-07): warm-up before ready (was phase 2), thumbnail caching (a rendering-study P1 item), the worker-hosted socket and the experiment scene's render host join phase 1; phase 2's "closed loop in one worker" becomes a separate render worker.

**Amendment 2026-10-22.** In Follow-up, "(Evidence 1 is still from 33.4.11)" is replaced by "(Evidence 1 is from 33.4.11; test 5 has re-run it on 44.7.0, see the Evidence amendment of 2026-10-22)". Test 5's suite is now in the repository (`test/perf/stall/`, plan item REN-16) and has run on Electron 44.7.0; its numbers are in the amendment at the end of Evidence. The project owner approves it by merging this amendment and may overturn it before; no decision changes.

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

Prototypes and raw outputs live outside this repository, in the design-review workspace, the separate three-maze-notes repository (amended 2026-10-09); tests 1–5 bring the relevant cases in.

**1. Synthetic stall test** (amended 2026-10-22) (`proto/rendering/bench.mjs`, `render-worker.mjs`, `results/worker-high*.json`): Electron 33.4.11 (Chromium 130), three.js r169, RTX 5070; an unlit HallwaySerialMigrated replica, 1920×1080 buffer, windowed unfocused page; 1,200 frames per condition (nominally 20 s, about 22 s on the fallback clock); 50 or 100 ms main-thread busy-waits once per second; rendering only. Decision 2's rule, on rAF timestamps (both rows) and callback entries (100 ms row):

| Stall | Main thread: missed frames; max interval | Worker: missed; max interval |
|---|---|---|
| 50 ms/s | 20 (1.639%, rAF); 36 ms | 0; 18.9 ms |
| 100 ms/s | 84 (6.542%, rAF), 121 (9.16%, entry); 89.2 ms (rAF), 118.1 ms (entry) | 0; 18.8 ms |

Both 100 ms series had 22 late intervals. The rAF count matches the net frame deficit (elapsed time / P minus intervals, about 83); the entry count exceeds it, because the short intervals that follow a stall are not credited. rAF timestamps under-read stall length (89.2 against 118.1 ms; a 45 ms stall read as 31 ms in the scene-switch benchmark), and the step-0 monitor uses them (`frameClock.js:102-111`). Limits: synthetic stalls (5–10% of the main thread); one run per condition ("6.5–9.2%" is two metrics of one run); one GPU; Chromium's fallback clock (17.6–17.7 ms period, about 56.5 Hz); no photodiode; end-of-life Electron, replaced in phase 0. Confidence: medium.

**2. Data integrity without a render worker** (headless Node, with the review's collide-and-slide mover rather than ADR-0001's hover kinematic character controller (KCC); not re-verified; ADR-0001's test 7 repeats it): per-sample gain 1.0000 at 56.5–144 Hz and identical trial events across 8 frame schedules, including 2% long frames, a 250 ms stall and a 2 s hidden window.

**3. Compile stalls** (scene-switch benchmark: remote-desktop session, fallback clock, 24 switches per condition; worst case, with salted programs and an empty program cache, while a cache hit still cost 14–45 ms): an unwarmed switch to new shader programs froze rendering for a median 356 ms (RTX 5070, lit materials). After the 1b warm-up, switch frames took 0.1–0.3 ms of main-thread CPU (completion 1.1–9.5 ms).

**Amendment 2026-10-09 (evidence location).** "outside the repository, in the gitignored design-review workspace (`.claude/paper-review/`)" is replaced by "outside this repository, in the design-review workspace, the separate three-maze-notes repository". The project owner moved the design-review workspace on 2026-10-09 from a folder of the development checkout that git ignored into a repository of its own, three-maze-notes, so that the evidence has a version history. The files moved unchanged, so paths such as `proto/rendering/bench.mjs` above are relative to that repository's root. This corrects where the evidence lives; no decision changes.

**Amendment 2026-10-22 (Evidence 1 on Electron 44.7.0).** Evidence 1 keeps its words; this note adds its re-run on the pinned Electron, which Validation 5 and the Follow-up ask for. The stall suite is in the repository (`test/perf/stall/`, plan item REN-16): the worker suite of `proto/rendering/bench.mjs` and `render-worker.mjs` with Evidence 1's scene, buffer, walk, stalls and 1,200 counted frames per run, each run in an Electron process of its own with a fresh profile, counted by the gate's code (`tools/timing/gateCounting.ts`: P is the median rAF interval, for both estimates). On 2026-10-22 it ran on Electron 44.7.0 (Chromium 152.0.7977.130) on Evidence 1's machine (RTX 5070 through ANGLE and Direct3D 11), which Windows then reported with one 1440×900 display at 60 Hz (Evidence 1's files record two 4K displays at 175% scaling), three runs per condition in turns, under the bench lock. The window was offscreen, hidden and painted by Electron's frame timer at 60 Hz and pixel ratio 1, because no window was to be shown on the shared development machine; a window that is only hidden cannot be used, since in 44.7.0 its main-thread WebGL loop gets only one or two rAF callbacks a second. Every run is therefore labelled fallback clock (median 59.88 Hz, that is 16.7 ms at Chromium's 0.1 ms clock resolution). Median of the three runs [range]:

| Stall | Main thread: missed frames; max interval | Worker: missed; max interval |
|---|---|---|
| 50 ms/s | 23 [21–23] (1.88%, rAF), 47 [43–48] (3.77%, entry); 50.0 ms (rAF), 67.1 ms (entry) | 0; 16.8 ms (rAF), 18.7 ms (entry) |
| 100 ms/s | 89 [89–89] (6.91%, rAF), 120 [117–123] (9.09%, entry); 100.1 ms (rAF), 116.3 ms (entry) | 0; 16.8 ms (rAF), 18.6 ms (entry) |

Every main-thread run had one late interval per stall among its counted frames (21 or 22), and the worker drew every frame of every run. The rAF count equals the net frame deficit taken with the timer's true period, 1000/60 ms (with P = 16.7 ms the clock's resolution lowers the deficit by 2.4 frames per 1,200 intervals); the entry count exceeds it, as above. So Evidence 1's finding holds on the pinned Electron: main-thread stalls cost a main-thread render loop about 1.9% (rAF) to 3.8% (entry) of its frames at 50 ms and 6.9% to 9.1% at 100 ms, and an OffscreenCanvas worker loop none. Limits: those of Evidence 1, except that the Electron is the pinned one and each condition has three runs; the window drew at pixel ratio 1, where Evidence 1's visible window had 1.75; and the frames followed Electron's offscreen timer, not a display, so a re-run in a visible window with the displays awake (`npm run test:stall -- --window visible`, which labels each run vsync-locked or fallback clock) remains for the rig, for example during the gate visit. Results: `test/perf/stall/results/electron-44.7.0/2026-10-22-offscreen/` (the summary, and one file per run with the raw frame times, the machine load and the bench lock); Evidence 1's own files are archived beside them (`results/electron-33.4.11/`). The project owner approves this amendment by merging it and may overturn it before; no decision changes.
