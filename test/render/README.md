# Render host in Electron (`test/render`)

The render host (`src/render`, plan item REN-9) drawing the shipped v0 mazes, built by the v0
reference loader (`src/compat/v0`), in Electron 44.7.0 with a real WebGL context. Two uses:

## Development page

`host.html` with `hostPage.ts` stands in for the scene window around the host: it owns the canvas,
its size and the window's `requestAnimationFrame`, loads one maze, and sends the host a pose about
every 20 ms, as the motion worker will. The host itself never touches the page.

```sh
npm run dev
# then open http://localhost:5173/test/render/host.html?maze=Hallway04
```

| Parameter | Values |
|---|---|
| `maze` | `Example01`, `Hallway01`, `Hallway02`, `Hallway04` (default), `HallwaySerialMigrated`, `Hallway_fog` |
| `mode` | `walk` (default): along the corridor and back, from the start to 50 units ahead, through the start to 50 units behind and back to it every 20 s, looking up to 0.6 rad left and right every 8 s; `still`: stand at the start; `smoke`: used by the smoke test |
| `dpr` | the pixel ratio given to the host (default: the display's) |

The page is not part of the app's build (`vite build` builds `index.html` only).

## Smoke test

```sh
npm run test:render                                  # the six shipped mazes
node test/render/smoke.mjs --only Hallway04 --software-gl --out <empty folder>
```

`smoke.mjs` builds the page into a fresh folder (`build-page.mjs`, with the repository's
`vite.config.js`), serves it on a free port, and runs `smoke-main.cjs` in Electron, which opens each
maze in a hidden offscreen window (1280 × 720, pixel ratio 1; frames painted at a fixed 60 Hz, as in
the e2e bench). There the page draws five canonical poses with `renderFrame()`, reads each frame back,
then runs the host's frame loop on the window's `requestAnimationFrame` for 1 s. No window is shown.
It takes the bench lock shared (`test/e2e/lib/benchLock.mjs`), so it waits while a timing measurement
holds the lock; it needs no fixed port.

Checks per maze: no page error, console error or crashed renderer; every asset loaded; the effective
renderer settings of owner decision D7 a (no tone mapping, sRGB output, black clear colour, no shadow
maps, the pixel ratio given, the high-performance GPU asked for); colour textures sRGB and no point
light casting shadows; every canonical pose drew the scene, at least one with draw calls and more
than a tenth of the frame other than black (from its start, Example01's small room shows only a
strip of floor); at least 10 frames from the loop in its second.

Output, in the folder printed at the start (a new temporary folder unless `--out` is given):
`results.json` (per maze: what was loaded, the policy applied, the effective settings, renderer
counters, per pose the outcome, draw calls and pixel statistics, the loop's frames, console messages)
and `<maze>.png`, the frame of the first canonical pose.

A window that is only hidden (not offscreen) does not do here: in Electron 44.7.0 a hidden window
that draws WebGL on its main thread gets only one or two `requestAnimationFrame` callbacks a second,
while an `OffscreenCanvas` worker in the same window keeps drawing, at about 55 frames a second on
Chromium's timer rather than the display's 60 Hz (probes of 2026-10-22 on the development machine).

Not checked here: whether the pixels equal v0.3's `TextureLoader` path at equal settings, and the
host in a worker on an `OffscreenCanvas` (ADR-0003 test 3, plan item REN-19); warm-up and the
post-ready monitor (REN-8).
