# Stall suite (`test/perf/stall`)

ADR-0003's test 5 (Validation 5; plan item REN-16): does a render loop keep its frames while the
stimulus window's main thread is busy? The same scene is drawn by a `requestAnimationFrame` loop on
the page's main thread, and by a loop in a dedicated worker on an `OffscreenCanvas`, while the
page's main thread is blocked by a busy-wait of 50 or 100 ms once a second (a stand-in for Vue, IPC
or garbage collection). Missed frames are counted by the gate's rules. The suite is the worker suite
of the design review's prototype (`proto/rendering/bench.mjs:354-391`, `render-worker.mjs` and
`main.cjs` in three-maze-notes), ported into the repository and re-run on the pinned Electron
44.7.0, as ADR-0003 Validation 5 and its Follow-up ask.

It runs by hand, like the e2e bench: Windows, the Electron binary (`npm ci`, then
`npx --no install-electron`), a GPU or SwiftShader. It is a timing measurement, so it holds the
bench lock exclusively (`test/e2e/lib/benchLock.mjs`, DPR-27) and waits while anything else holds
it.

```sh
npm run test:stall                     # 50 and 100 ms x main thread and worker, 3 runs each, 20 s each
npm run test:stall -- --out DIR        # into DIR instead of a new temporary folder
npm run test:stall -- --software-gl --seconds 3 --repeats 1 --stalls 50    # SwiftShader smoke run
npm run test:stall -- --window visible # a visible window (below)
```

Options: `--stalls 50,100` (ms), `--modes main,worker`, `--repeats 3`, `--seconds 20` (1,200 counted
frames at 60 Hz), `--every 1000` (ms between stalls), `--warm 60` (frames before the counted ones),
`--window offscreen|visible`, `--osr-hz 60`, `--gpu high|low|default` (default high:
`force_high_performance_gpu`, as Evidence 1), `--software-gl`, `--out DIR`, `--no-wait`,
`--lock-wait S`. `npm run test:stall` is
`node --experimental-strip-types test/perf/stall/run.mjs`: the runner imports the gate's counting
code, a TypeScript file, and Node 22.16 needs the flag to strip its types (plan decision D4).

## Files

| File | Role |
|---|---|
| `run.mjs` | the runner: takes the lock, runs every condition in turn, counts, labels, writes the results |
| `main.cjs` | Electron's main process for one run: serves the page, opens the window, writes the raw result |
| `bench.html`, `bench.mjs` | the page: the main-thread loop or the worker, the stalls, the long-task observer |
| `render-worker.mjs` | the worker: the same loop on the transferred `OffscreenCanvas` |
| `scene.mjs` | the scene, the walk and the frame loop, shared by the page and the worker |
| `results/` | archived and new results (below) |

## What a run does

Each run is one condition in its own Electron process with a fresh profile (a cold shader cache).
The conditions take turns (repeat 1: 50 ms main, 50 ms worker, 100 ms main, 100 ms worker; then
repeat 2, ...), so that a change of the machine's state during the suite spreads over all of them.
Before each run the runner records the machine's load (`tools/timing/machine-load.mjs`), and the CPU
load every 2 s while it runs. Electron holds `prevent-display-sleep` while it runs.

The scene is Evidence 1's: an unlit replica of HallwaySerialMigrated (its boxes with
`MeshBasicMaterial`, the chess texture in sRGB with the GPU's maximum anisotropy, no lights, no
shadows; 7 draw calls), drawn into a 1920 × 1080 buffer at pixel ratio 1 while the camera walks the
corridor at eye height 3.7. The page starts the stalls (`setInterval`, each a busy-wait), then the
loop draws 60 warm-up frames and the counted frames, recording for every frame its rAF timestamp
and `performance.now()` at the callback's entry and exit. In the worker condition the page
transfers its canvas to the worker first, and the worker's own `requestAnimationFrame` drives the
loop, on the worker's clock.

## Counting

`tools/timing/gateCounting.ts` (`summarizeSession`), the gate's own code (ADR-0003 Decision 2;
`docs/timing/gate-analysis.md`), over the counted frames and the last warm-up frame: P is the
median rAF interval; an interval longer than 1.5 P is late and counts round(interval / P) − 1
missed frames; on rAF timestamps (the low estimate) and on callback entry times (the high
estimate), both with the same P. The missed share is missed / (intervals + missed), as in
Evidence 1. Each run also records the net frame deficit (elapsed time / P minus the intervals),
the injected stalls and the page's long tasks and long animation frames that started while the
counted frames ran, and the GPU, displays and window.

## Windows and clocks

Each run is labelled `vsync-locked` or `fallback clock`:

- `--window offscreen` (default): a hidden window painted offscreen by Electron's frame timer at
  `--osr-hz`, as the e2e bench's scene window. Nothing is shown, so it runs on the shared
  development machine at any time. Frames follow that timer, not a display: every run is a
  **fallback clock** run.
- `--window visible`: a window shown without focus (`showInactive`) on the primary display, as
  Evidence 1 ran. A run is **vsync-locked** when its median frame rate is within 1 % (at least
  1 Hz; Electron reports whole hertz) of the window's display's refresh rate (ADR-0003 1d), else
  **fallback clock** (Chromium's timer fallback, about 56.5 Hz on Evidence 1's machine). Displays
  must be awake: run it on the rig or with someone at the machine.

A window that is only hidden cannot be used: in Electron 44.7.0 a hidden window that draws WebGL on
its main thread gets only one or two `requestAnimationFrame` callbacks a second, while a worker's
`OffscreenCanvas` in the same window keeps drawing, at about 55 frames a second on Chromium's timer
(probes of 2026-10-22 on the development machine).

## Output

In the output folder: `<stall>ms-<mode>-<repeat>.json` per run (schema `three-maze/stall-run@1`:
condition, parameters, versions, clock label, counts, stalls, long tasks, WebGL context, page and
window state, displays, GPU, the bench lock's record, the machine load before the run and the CPU
load during it, and the raw times of every frame in ms from the first rAF timestamp), and
`summary.json` (every run's counts, and per condition the median, minimum and maximum over the
runs). Both are meant to be kept with the repository, which is published, so their machine-load
snapshots leave out the computer's name, the names of the busiest programs (their CPU and memory
use stay) and the other three-maze processes' command lines (`condenseLoad` in `run.mjs`), and
local paths appear nowhere (`test/frontend/stallSuite.test.ts` checks the files under `results/`);
the full machine-load snapshots stay in the output folder's `machine-load/`.

## Differences from the prototype

- One condition per Electron process, the conditions taking turns, three runs each; the prototype
  ran the main thread and then the worker in one page, one run per stall length.
- Both loops load the texture through `ImageBitmapLoader` and share one scene module; the
  prototype's main thread used `TextureLoader`. The scene and the walk are the same.
- No GPU timer queries in the main-thread loop (the prototype polled `EXT_disjoint_timer_query`
  there, not in the worker); both loops record rAF, entry and exit times.
- Counting by the gate's code: P is the median rAF interval for both estimates (the prototype took
  the median entry interval as P for the entry series), and the median of an even count is the mean
  of the middle two.
- Offscreen window by default (the prototype's runs were visible), stalls and long tasks recorded,
  the bench lock and the machine load recorded; three is served at `/three/`, so that the worker can
  import the scene module.

## Results

`results/electron-44.7.0/2026-10-22-offscreen/`: the suite as committed, on the development
machine (Intel Core i9-14900K, NVIDIA GeForce RTX 5070 through ANGLE and Direct3D 11, Windows 11),
which Windows reported with one 1440 × 900 display at 60 Hz (Evidence 1's files record two 4K
displays at 175 % scaling), Electron 44.7.0 (Chromium 152.0.7977.130), offscreen window at 60 Hz and
pixel ratio 1, `--gpu high`, 3 runs per condition, 2026-10-22 (bench lock held 300 s; CPU 1.4 to
6.5 % busy before each run, at most 9.6 % during one). Every run is labelled fallback clock (the
offscreen timer; median 59.88 Hz, that is 16.7 ms at Chromium's 0.1 ms clock resolution). Every
run drew 7 draw calls with 2 shader programs per frame, as Evidence 1's main-thread runs did. Median
of the 3 runs, [range]:

| Stall, condition | Late intervals | Missed, rAF (low) | Missed, entry (high) | Longest interval, rAF / entry |
|---|---|---|---|---|
| 50 ms, main thread | 21 | 23 [21-23] (1.88 % [1.72-1.88]) | 47 [43-48] (3.77 % [3.46-3.85]) | 50.0 [33.4-50.0] / 67.1 [61.1-68.0] ms |
| 50 ms, worker | 0 | 0 | 0 | 16.8 / 18.7 [18.6-18.8] ms |
| 100 ms, main thread | 22 | 89 [89-89] (6.91 %) | 120 [117-123] (9.09 % [8.88-9.30]) | 100.1 [100.0-100.1] / 116.3 [115.8-116.8] ms |
| 100 ms, worker | 0 | 0 | 0 | 16.8 / 18.6 ms |

Each main-thread run had one late interval per stall that fell among its counted frames (21 or
22); the worker drew every frame in every run. The rAF count equals the net frame deficit taken
with the timer's true period, 1000/60 ms (21.0, 22.9 and 23.0 for 50 ms, 88.9 for 100 ms, about 0
for the worker); with P = 16.7 ms, the clock's resolution makes the deficit 2.4 frames lower per
1,200 intervals. The entry count is higher, as in Evidence 1, because the short intervals after a
stall are not credited, and rAF timestamps under-read the stall (100.1 against 116.3 ms).

These files were written by the suite before `condenseLoad` left out the computer's name and the
programs' names; their machine-load snapshots were condensed again by the present rule on the same
day, and nothing else in them changed.

`results/electron-33.4.11/`: Evidence 1's own result files (`worker-high.json`, 50 ms, and
`worker-high-100.json`, 100 ms), byte for byte from three-maze-notes `proto/rendering/results/` at
caba01f: Electron 33.4.11, a visible unfocused window on one of two 4K displays at 175 % scaling
(pixel ratio 1.75), on the fallback clock (about 56.5 Hz), one run per condition, counted by the
prototype (ADR-0003, Evidence 1).

| Stall | Main thread: missed (rAF); longest interval | Worker: missed; longest interval |
|---|---|---|
| 50 ms (33.4.11) | 20 (1.639 %); 36 ms | 0; 18.9 ms |
| 100 ms (33.4.11) | 84 (6.542 %) rAF, 121 (9.16 %) entry; 89.2 ms rAF, 118.1 ms entry | 0; 18.8 ms |
| 50 ms (44.7.0, median) | 23 (1.88 %) rAF, 47 (3.77 %) entry; 50.0 ms rAF, 67.1 ms entry | 0; 16.8 ms rAF, 18.7 ms entry |
| 100 ms (44.7.0, median) | 89 (6.91 %) rAF, 120 (9.09 %) entry; 100.1 ms rAF, 116.3 ms entry | 0; 16.8 ms rAF, 18.6 ms entry |

Not yet run: a visible window with the displays awake (`--window visible`), which would show whether
the runs are vsync-locked; on the rig, optionally at the gate visit. The suite runs for about 6
minutes; plan item REN-16 allows a quarter of an hour of rig time for it.
