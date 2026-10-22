# Render host

The render host draws the experiment scene into a canvas it is given: an `HTMLCanvasElement` in the
scene window, or an `OffscreenCanvas` in a worker. It takes the canvas, its size, the pixel ratio,
poses and render-state changes as calls or messages, and owns the renderer, the scene graph and the
camera. It never touches the window, the document, DOM events or Vue, so the same code can move into
a render worker if the week-6 gate promotes one (ADR-0003 Decision 1c and Decision 3; plan item
REN-9).

Phase 1 covers the experiment scene only. Its first content is a v0 maze built by the v0 reference
loader (`src/compat/v0`, plan item TS-28); the experiment-file scene builder (TS-07) comes next. The
v0.3 scene component (`src/scenes/serial/PythonCustomScene.vue`) does not use the host yet: that
happens when it becomes a shell around the host (REN-5).

## API

```ts
import { createRenderHost, hostV0Loaders, loadV0Content } from './index.ts'

const host = createRenderHost({ canvas, width, height, pixelRatio })      // eyeHeight, settings optional
host.setContent(await loadV0Content(config, hostV0Loaders()))
host.start({ request: cb => requestAnimationFrame(cb), cancel: h => cancelAnimationFrame(h) })
host.handleMessage({ type: 'pose', pose })                                 // or host.setPose(pose)
host.handleMessage({ type: 'render_state', change: { seq, epoch, display: 'blank' } })
host.handleMessage({ type: 'resize', width, height, pixelRatio })
```

| Part | File | What it does |
|---|---|---|
| `createRenderHost(options)` | `RenderHost.ts` | the host: renderer, camera, content, inputs, frames, loop |
| `createStimulusRenderer`, `applyStimulusPolicy`, `describeRenderer` | `renderer.ts` | the renderer settings and the stimulus policy (below); the effective settings by name |
| `RenderContent`, `sceneTextures`, `disposeContent` | `content.ts` | what the host draws: a scene graph without a camera, its projection, start, assets |
| `createColorTextureLoader`, `createSkyLoader`, `hostV0Loaders` | `loaders.ts` | asset loaders without the DOM |
| `loadV0Content(config, loaders)` | `v0Content.ts` | content from a v0 maze JSON |

- **Size and pixel ratio** are explicit: the drawing buffer is `width × pixelRatio` by
  `height × pixelRatio`. The host never reads the window's ratio, and `setSize` never writes the
  canvas's style: sizing the element on the page is the scene window's job.
- **Camera.** The camera stands on the newest pose record: at the feet plus the eye height, turned
  by the yaw, with no other offset (ADR-0001 R1 and R3; the same rule as `eyePose` in
  `src/motion/core.ts`). The eye height comes from the rig file; without one it is 3.7, the only
  validated height. The projection (field of view, near and far planes) comes with the content; the
  aspect ratio is the drawing area's. For a v0 maze the host shows what v0.3 showed for the same
  player body: v0.3's eye was also 3.7 above the feet (v0 quirk 7).
- **Poses** are motion-core pose records (`PoseRecord`; `seq`, `epoch`, `t_dev_us`, `x`, `feetY`,
  `z`, `yaw` are read). A pose with a coordinate that is not finite, or a `seq`, `epoch` or
  `t_dev_us` that is not a whole number of at least 0, is refused. The host keeps a copy of the
  fields it read, so a caller may reuse its pose object.
- **Render-state changes** carry the stamp of their sample. `display: 'blank'` draws black,
  `display: 'on'` the world; `freeze` only marks the frames, because the motion core stops the agent
  (experiment-file actions `display` and `freeze`, ADR-0005 F5).
- **Frames.** `renderFrame()` draws one frame and returns its record: index, rAF timestamp, start and
  end times (`performance.now()`), what was drawn, the stamp of the pose drawn, and the blank and
  freeze flags. Until there is content and a pose, and while the display is blanked, the frame is
  cleared to black (the colour before ready and while blanked, D14 a) and still counted.
- **Frame loop.** `start(scheduler)` draws a frame on every callback of the scheduler it is given:
  the `requestAnimationFrame` of the realm the host runs in, passed in by whoever runs it. A frame
  that throws stops the loop. `stop()` cancels the next callback.
- **Messages.** `handleMessage` takes `{ type: 'pose' | 'render_state' | 'resize', ... }`, so a
  worker can pass its `MessagePort` messages straight through. Content is not a message (three.js
  objects do not cross a `postMessage`): a worker builds it from the description itself.

## Renderer settings and stimulus policy

Owner decision D7 a (2026-10-09; decision log DEC-042): shadows off by default, no point-light
shadows, no tone mapping, sRGB colour textures, an explicit pixel ratio, the high-performance GPU,
and colours as v0.3 showed them. Every setting is written out, not left to three's defaults:

| Setting | Value | v0.3 (`src/compat/v0/README.md`, quirks 8, 9, 14) |
|---|---|---|
| shadow maps | off; on only with `settings.shadows` (PCF) | always on |
| point-light shadows | never: the host switches them off in the content | cube shadows from every point light with `castShadow` (three each in Hallway01, Hallway04, HallwaySerialMigrated) |
| tone mapping | `NoToneMapping`, exposure 1, set as properties | ACES passed to the constructor, which r169 ignores: none in effect |
| output colour space | sRGB | sRGB (three's default) |
| colour textures (`map`, `emissiveMap`, ...) | sRGB, anisotropy `settings.anisotropy` (default 1, capped at the GPU's maximum) | `NoColorSpace`, anisotropy 1 |
| pixel ratio | given by the caller | 1 (no `setPixelRatio`) |
| context | antialias; `powerPreference: 'high-performance'`; alpha, depth, stencil, premultiplied alpha, preserve drawing buffer, fail-if-major-performance-caveat at three's defaults | antialias; `powerPreference: 'default'` |
| clear colour | black, alpha 1 | black (three's default) |

Material colours, lights and the sky are the content's: for a v0 maze, v0.3's own, quirks included
(colour 0 drawn white, point lights at range 50 and decay 2). The visible changes from v0.3 are the
missing shadows and the textures, whose colours are now decoded from sRGB instead of being used as
if linear.

`describeRenderer(renderer, settings)` (and `host.info().settings`) reads the effective settings back
from the renderer and its WebGL context, in the form of the render report's `settings`
(`protocol/v1/render.report.schema.json`), for the ready report and session provenance (REN-3,
REN-8). Which values the gate and v1.0-rc use, and the scene schema's renderer block, are plan item
REN-3; force_high_performance_gpu for a hybrid-GPU rig is decided there too.

## Loaders

`TextureLoader` decodes through an `<img>` element
(`node_modules/three/src/loaders/ImageLoader.js:39`), which a worker does not have. Colour textures
load through `ImageBitmapLoader` with `imageOrientation: 'flipY'` and `premultiplyAlpha: 'none'`,
both written out because `setOptions` replaces the loader's default
(`node_modules/three/src/loaders/ImageBitmapLoader.js:24`, `:28-30`); three adds
`colorSpaceConversion: 'none'` itself (`:93`). WebGL ignores `UNPACK_FLIP_Y_WEBGL` for an
`ImageBitmap`, so the flip happens at decode and the texture's `flipY` is false. A probe in Electron
44.7.0 (2026-10-22, a 4 × 4 image with one red corner) drew the decoded-flipped bitmap the same way
up as `TextureLoader`'s image, with the texture's `flipY` false or true; without the flip at decode it
drew upside down. Each call gives a new
`Texture` (as v0.3's loader did), and each URL is fetched and decoded once per loader. The sky (an
EXR) loads through three's `EXRLoader`, which fetches and decodes in JavaScript. Whether the
`ImageBitmap` path draws the same pixels as v0.3's `TextureLoader` path is ADR-0003 test 3 (REN-19).

## No DOM

- `tsconfig.json` in this folder type-checks the host with the ES2022 and WebWorker libraries only;
  `npm run typecheck` runs it after the project-wide check. A reference to `window`, `document` or an
  HTML element type is an error there. three's own declarations name DOM types; declaration files
  are not checked (`skipLibCheck`).
- `test/frontend/render/domScan.test.ts` scans every identifier of this folder and of the modules it
  imports for the window, the document, their elements and events, DOM-bound loaders and the frame
  timer (which a worker has too, but which the host must be given); checks that this folder imports
  only three, its EXR loader and DOM-free modules; and checks that the type check above fails on a
  fixture that names the document or the window.

## Tests

- `test/frontend/render/renderHost.test.ts`: settings, policy, camera, frames, inputs, loop and
  dispose, on a stand-in renderer (`fakeRenderer.ts`), since Node has no WebGL.
- `test/frontend/render/v0Content.test.ts`: the six shipped mazes as v0.3 builds them, without its
  camera rig; colours and lights kept; the policy applied; the host's view equal to v0.3's for the
  same player body.
- `test/frontend/render/loaders.test.ts`: the `ImageBitmapLoader` options and the EXR sky.
- `test/frontend/render/domScan.test.ts`: above.
- `test/render/` (`npm run test:render`): the six shipped mazes drawn through the host in Electron,
  and the development page that shows a maze through the host (`test/render/README.md`).

## Built on this host later

Warm-up before ready, load timeouts and the post-ready compile monitor (REN-8); the presentation of
stamped poses (newest or delay-interpolated) and of render-state changes at the frame of their
sample (REN-10: until then the newest pose is drawn and a change applies at the next frame); the
frame log (REN-11); the frame-clock check (REN-4); the scene window as a shell around the host
(REN-5); the same host in a worker on an `OffscreenCanvas` (REN-19).
