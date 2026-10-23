# v0 reference loader

A port of v0.3's experiment-scene loader (`src/scenes/serial/PythonCustomScene.vue`) to TypeScript
that runs without the DOM: in Node, in a worker or in the renderer. It builds what v0.3 builds from
a v0 maze JSON (`public/mazes/*`), quirks included:

- the three.js scene: skybox, lights, meshes with their materials and textures, and the camera inside
  v0.3's camera rig;
- the renderer settings v0.3 applies to its canvas;
- the physics world as plain data: one world-space solid per collider v0.3 creates, the gravity and
  the player body.

Plan item TS-28. Its users: the DOM-free render host's first content (REN-9); the gate's fallback
scene input if `compileScene` (TS-04, TS-07, TS-10) is not merged in time; the solids for the
collider partitioner (MOT-08); and the reference for the migrator's visual and physics equivalence
tests (TS-10). Once those items land it is a reference only, not a path for paper data.

Line numbers below refer to `src/scenes/serial/PythonCustomScene.vue` at b96ad72 unless a file is
named.

## API

```ts
import { buildV0Scene, createV0Renderer, v0Physics } from './index.ts'

const build = await buildV0Scene(config, { aspect: width / height, loaders })
const renderer = createV0Renderer({ canvas, width, height, updateStyle: false })  // false for an OffscreenCanvas
const physics = v0Physics(config)
```

| Function | Reproduces | Returns |
|---|---|---|
| `buildV0Scene(config, options)` | skybox, camera and lights of `onMounted` (:544-617), `createSceneFromConfig` (:349-450), camera rig and its first placement (:642-667) | `scene`, `camera`, `rig`, `meshes` (with the JSON index and name of each), `lights`, `assets` (each texture or skybox URL and whether it loaded), `diagnostics` |
| `placeV0Camera(rig, body, theta)` | the per-frame camera update (:231-240) | nothing; moves the rig |
| `createV0Renderer(options)` | the renderer settings (:576-585) | the renderer |
| `v0Physics(config)` | `createPhysicsFromConfig` (:453-501), gravity (:623) and the player body (:628-640) | `solids`, `bodiesWithoutCollider`, `gravity`, `player`, `diagnostics` |
| `describeScene(scene, camera)` | (test support) a plain-data description of a scene graph | see `describe.ts` |

`config` is the parsed JSON plus `_basePath`, the folder asset paths are relative to (for example
`mazes/Hallway04/`), as v0.3's scene store sets it (`src/stores/scenes.js:274`): the maze's folder
relative to the served root (`electron/main.js:676-682`), else the JSON's own `basePath` key, else
an empty string. Asset URLs are resolved with v0.3's own `src/utils/resolveAssetPath.js`.

The caller supplies the asset loaders (`options.loaders.texture` and `.skybox`, each returning a
promise of a new `Texture`), because three's `TextureLoader` creates an `<img>` element
(`node_modules/three/src/loaders/ImageLoader.js:39`); v0.3 used `TextureLoader` and `EXRLoader`.

Each solid has `position` (the body's translation), `colliderRotation` (always none, as v0.3 builds
it) and `meshRotation` (the Euler rotation of the object's mesh, which v0.3's collider ignores;
MOT-08 uses it to build correctly rotated colliders: `src/compiler/physics/fromV0.ts` turns the
solids into the collider partitioner's boxes).

## Quirks reproduced

1. **Colliders drop the rotation.** The body gets only the translation (:464-468); the mesh is
   rotated (:435-439). No shipped maze rotates an object.
2. **`||` defaults turn 0 into the default.** Geometry sizes 0 become 1 (:364-366, :371-372,
   :377-379, :477-479, :483, :487-488), roughness 0 becomes 1 (:391), friction 0 becomes 0.5 (:497),
   fov 0 becomes 75 (:568).
3. **Colour 0 (black) is rendered white** (:389).
4. **Point lights ignore the JSON's `distance` and `decay`**: always 50 and 2 (:609).
   HallwaySerialMigrated asks for 60 (`public/mazes/HallwaySerialMigrated/HallwaySerialMigrated.json:25`).
5. **Fog is ignored.** The experiment scene has no fog code; Hallway_fog's `fog` block
   (`public/mazes/Hallway_fog/Hallway_fog.json:15`) only works in the gallery path
   (`src/worlds/BaseWorld.js:233-242`).
6. **The JSON's camera `position`, `near` and `far` are ignored**: near 0.1 and far 1000 are fixed,
   the aspect comes from the window (:567-572).
7. **Eye height is counted twice.** The camera sits 1.6 above the rig (:574) and the rig 1.6 above
   the player body's centre (:235, :663), so the eye is 3.2 above the centre: 3.7 for the starting
   body at y = 0.5 (:630).
8. **Renderer settings that do nothing in three 0.169.0.** `toneMapping` and `toneMappingExposure`
   are passed to the constructor (:580-581), which does not read them
   (`node_modules/three/src/renderers/WebGLRenderer.js:64-75`), so tone mapping stays
   `NoToneMapping` (`WebGLRenderer.js:150`); `physicallyCorrectLights` (:585) is not a property of
   the r169 renderer.
   `setSize` is called without `setPixelRatio`, so the pixel ratio stays 1 (:583), and shadows are
   always enabled (:584), whatever the JSON's `renderer` block says.
9. **Every point light with `castShadow` casts cube shadows** (:613): three each in Hallway01,
   Hallway04 and HallwaySerialMigrated. A directional light's target stays at the origin and is not in
   the scene graph.
10. **Light types other than ambient, directional and point are skipped silently** (:593-617).
    A missing `lights` key gives an ambient and a directional light (:588-591); `lights: []` gives
    none.
11. **An unsupported geometry type** (anything but box, sphere, cylinder) gets no mesh (:382-384),
    but with physics enabled it gets a rigid body without a collider (:470 runs before :491-492).
12. **The cylinder collider uses `radiusTop` only** (:486-489); the mesh uses both radii.
13. **Any physics type but `'dynamic'` gives a fixed body** (:460-462): `'static'`, `'kinematic'`
    and typos alike. Example01's sphere is dynamic (`public/mazes/Example01.json:63`) and falls under
    gravity −500 (:623); `v0Physics` reports it in `diagnostics`.
14. **Textures:** a texture that fails to load leaves the flat colour (:422-425); textures keep
    three's default colour space (`NoColorSpace`: JPEG colours are used as if linear, not converted
    from sRGB) and anisotropy 1; wrapping is set to repeat only when the JSON gives `repeat`
    (:410-417).
15. **Textures load one after another**, each awaited before the next object (:401-408).

## Deviation from v0.3

1. **A skybox that fails to load does not hang.** v0.3's promise has no error callback (:553-555),
   so a missing EXR stops the scene setup forever. The port continues without a background or
   environment map, as v0.3's `catch` intends (:560-563), and reports the failure in `assets` and
   `diagnostics`.

The port also lists unsupported light and geometry types and failed textures in `diagnostics`; v0.3
logs some of them to the console. Neither changes the scene.

A caller that must show exactly what v0.3 shows (the gate's fallback scene) should check `assets`:
an entry with `loaded: false` means the scene differs from what v0.3 shows when all its assets are
present (no sky, or a flat colour instead of a texture), even though the build succeeded.

## Keys v0.3's experiment scene ignores

`camera.position`, `camera.near`, `camera.far`, the whole `renderer` block, `fog`, `player`,
`controls`, a light's `distance` and `decay`, and `physics.shape`, `physics.mass` and the other
physics keys besides `enabled`, `type`, `friction` and `restitution`. `name` and `description` only
label the scene in the UI.

## Tests

`test/frontend/v0Reference.test.ts`, with its helpers in `test/frontend/v0Reference/`:

- **Golden snapshots of v0.3's own loader.** `extractV03.ts` takes `createSceneFromConfig`,
  `createPhysicsFromConfig`, `PLAYER_RADIUS` and the setup steps of `onMounted` (from
  `await RAPIER.init()` to the resize listener) out of the real `.vue` file through its syntax tree
  and runs them unchanged in Node. Their record for each of the six shipped mazes is
  `test/frontend/v0Reference/golden/<maze>.json`: the scene graph (every node's type, transform and
  world matrix; geometry parameters and world-space box; material parameters; textures; lights with
  their shadow settings; the camera and its world pose), the renderer settings, and the Rapier world
  read back after setup (bodies, collider shapes, poses, friction, restitution, density). The test
  fails if v0.3's loader no longer builds the golden record, and if the port's record differs from
  v0.3's.
- **Quirk fixtures** run through both loaders and must give equal records; the test also checks
  quirks 1 to 14 directly, since the shipped mazes exercise only some of them (no shipped maze
  rotates an object, gives a size 0 or a texture without `repeat`). It also checks that each solid
  carries its mesh's position and rotation, on the mazes and on a fixture with a rotated box.
- **DOM-free:** a scan for DOM globals and DOM-bound loaders in this folder, and a type check of this
  folder with only the ES2022 library (no DOM, no Node types).
- **Plain Node:** a child `node --experimental-strip-types` process builds the six mazes from these
  files and must give the same scene descriptions and solids as the build under Vitest. The test is
  skipped on a Node without type stripping (before 22.6).

Node lacks three things the loaders use, so the test stands in for them (`harness.ts`):

| Stand-in | Compared | Not compared |
|---|---|---|
| `TextureLoader`: an empty `Texture` for files that exist under `public/`, an error otherwise | URL, wrapping, repeat, colour space, filters and every other texture parameter | JPEG pixels and image size |
| `WebGLRenderer`: records constructor parameters, method calls and property writes | what v0.3 asks of the renderer | what three does with it on a GPU (quirk 8 is from the three.js source, not executed), shader programs, pixels |
| `fetch` for `EXRLoader`: serves `public/` | the decoded EXR: size, type, colour space and a fingerprint of the pixels | nothing further |

Also not compared: anything after setup (frames, resizes, the physics simulation), ids, uuids and
version counters, and v0.3's console output. Rapier stores 32-bit floats, so the port's solids are
rounded with `Math.fround` before they are compared with the Rapier read-back.

The golden files were generated at b96ad72 (three 0.169.0, Rapier 0.14.0, Node 22.16.0). They are
only ever written from v0.3's output: after a deliberate change to v0.3's loader, regenerate them
with `npx vitest run test/frontend/v0Reference.test.ts -u` and review the diff. When v0.3's scene
component is rewritten or retired (REN-5, DPR-19), the extraction will stop finding its functions;
keep the golden files as the record of v0.3 and replace the extraction test by a check against them.

## Running in Node

The files import only `three` and `src/utils/resolveAssetPath.js`, with relative `.ts` imports and
erasable TypeScript only, so Node runs them by stripping types (on Node 22.16, the version used here,
with `node --experimental-strip-types`; the "Plain Node" test above checks it). How the project's
Node scripts run TypeScript is owner decision D4; nothing here depends on its outcome.

`src/types/three-shim.d.ts` declares `three` loosely (every name is `any`) because three 0.169.0 ships
no types. TODO(D3): remove the shim when @types/three is added, and fix any type errors that appear.
