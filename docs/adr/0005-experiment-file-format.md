# ADR-0005: Write each experiment as one versioned JSON file that holds its world and its task, leaves rig facts to the rig file, and stays within ADR-0002's action budget

- Status: Accepted (2026-10-22)
- Date: 2026-10-09
- Deciders: project owner
- Related: [0001-player-mover.md](0001-player-mover.md) (units, axes, eye height, falls, colliders), [0002-task-engine-location.md](0002-task-engine-location.md) (declarative FSM, action and event budget), [0003-render-worker-priority.md](0003-render-worker-priority.md) (warm-up, no compiles after ready), [0004-dependency-versions.md](0004-dependency-versions.md) (freeze from v1.0-rc)
- Roadmap: phase 1 (experiment schema v1, `compileScene`, minimal declarative FSM, maze migrator), frozen at v1.0-rc; phase 2 (multi-world switching, the full task layer, code tasks, agent tooling) only adds to it.

Plan items (TS-03, MOT-10, ...), decisions (D5, ...) and design conflicts (C3, ...) named below are those of the phase-1 plan and its tasks breakdown in the separate three-maze-notes repository (`plan/phase1-plan.md`, `plan/breakdown_tasks.md`, at d9de45a). Design documents are cited from the same repository: `docs-site/docs/design/scene-switching.md` and `backend-modules.md` (the scene-switching and backend designs) and `design/scene_dsl_agent.json` (the scene-format design, its `design_sketch` sections §0-§2.9).

## Context

In v0.3 (HEAD b96ad72) an experiment is a scene file plus Python code, and neither has a defined format:

- A scene is a v0 JSON file (`public/mazes/*/*.json`). The app checks only that `name` and `objects` exist (`src/stores/scenes.js:138-145`). Vectors are `{x, y, z}` objects, rotations are radians passed straight to three.js (`src/scenes/serial/PythonCustomScene.vue:435-438`), colours are integers, and no unit is stated: lengths are centimetres only because the encoder calibration converts counts to cm (`experiments/hallway04_experiment.py:84`), while a comment calls the eye height "2.0m" (`:490`).
- The task is Python. hallway04's trial end (`|z| >= 70`, `:87`, `:448`), reward (70 ms, `:91`), serial port (`COM3`, `:156`) and reset to the origin with heading 0 (`:486-494`) are constants in the experiment file. Its `initialize(config)` could override them (`:145-150`), but the scene registers the experiment with `config: {}` (`PythonCustomScene.vue:714-717`).

The phase-1 designs disagree on the replacement (tasks breakdown, `design_conflicts`): one document with zones under `task` and a `rig` path in its header (`scene_dsl_agent.json` §2.1, §2.8), an experiment file referring to world files that carry their own zones (`scene-switching.md:79-107`), or a separate task file naming its scene (the experiment-data prototype). They list 14 actions (13 in `scene_dsl_agent.json` §2.8, plus `switchWorld` in `scene-switching.md:209-237`) where ADR-0002 keeps the format within 12 declarative actions and 6 task-event categories (Consequences, Risk); phase 2 extends the same format, so its names count against that budget too. They put the eye height in the experiment (`scene_dsl_agent.json` §2.7) where ADR-0001 R3 puts it in the rig file, write the blank inter-trial interval (ITI) in two ways, and allow lengths in mm, cm or m while every limit of ADR-0001 is in cm.

The schema (plan item TS-03), the compiler (TS-04), the FSM (TS-13) and the migrator (TS-10) need these questions settled first, and the format freezes at v1.0-rc together with the behaviour-critical dependencies (ADR-0004 Decision 5), so everything phase 2 adds must fit in without renaming what v1.0 ships.

## Decision drivers

1. **Provenance:** one source per experiment, validated, hashed and copied into every session, so a paper's methods can point to one file.
2. **Rig independence:** the same file runs on every rig and on the simulated one; what belongs to a rig is written once, in the rig file, and recorded with each session (`backend-modules.md:132-133`; ADR-0001 R3).
3. **Additive growth:** worlds, cues, zone tags, code tasks and agent tooling arrive after the freeze, so their names and places are fixed now.
4. **A small surface:** at most 12 declarative actions and 6 task-event categories, phase 2's included (ADR-0002, Risk); about 60 core schema keywords (`backend-modules.md:344`).
5. **One unit system with ADR-0001,** whose thresholds are all in units of 1 cm.
6. **Determinism:** one file gives the same compiled scene and the same trial table in Node and Electron, and the trial table's generator gives the same numbers in Python.

## Considered options

**A. One experiment file, its single world inline (chosen; D5 option a).** `worlds` holds one world written in the file; zones and spawns belong to the world; the task refers to them by id. *Pros:* one file to validate, hash, review and copy (the backend design's budget allows two file kinds, the second only for several or reused worlds, `backend-modules.md:343`); the keys phase 2 needs (`worlds` by id, `initialWorld`) exist in the first file, as the scene-switching design asks of phase 1 (`scene-switching.md:447`); zones sit next to the geometry they describe. *Cons:* a world used by several experiments is copied until phase 2's world files; the file's hash changes when only the task changes.

**B. Separate scene and task files** (the experiment-data prototype; the world files of `scene-switching.md:79-107`). *Pros:* one scene serves several tasks; a scene edit leaves the task file untouched. *Cons:* two files per session that must be chosen, recorded and versioned as a pair, as v0.3's scene file and Python experiment are today; zone ids referenced across files; the prototype's YAML task is excluded by ADR-0002 ("no indentation-based YAML twin").

**C. One document with zones, spawns and cues under `task`** (`scene_dsl_agent.json` §2.8). *Pros:* every task entity in one place. *Cons:* with a second world the zones must move into the worlds (each world has its own, `scene-switching.md:90`), a breaking change after the freeze.

Smaller choices, each settled in the Decision: the blank ITI as `display: blank` plus a timer, against a `transition` object on `teleport` (`backend-modules.md:260-263`); merged verbs, against raising ADR-0002's budget, which needs an ADR (ADR-0002, Risk); the rig chosen at run time, against a `rig` path in the file (`scene_dsl_agent.json` §2.1); SplitMix64, against Python's Mersenne Twister or another generator (F8).

## Decision

Adopt A. D5, which covers the layout, the merged actions and the blank ITI, has no owner answer yet; accepting this record decides it.

**F1. Layout.** One JSON file per experiment (proposed name `<name>.experiment.json`). Its top-level keys in format 1.0:

| Key | Required | Content |
|---|---|---|
| `$schema` | no | a path or URL for editors; the compiler ignores it |
| `format` | yes | `"three-maze-experiment"` |
| `version` | yes | `"1.0"` (F6) |
| `meta` | no | `title`, `description` |
| `units` | yes | `{"length": "cm" \| "mm" \| "m"}` (F3) |
| `renderer` | no | the stimulus renderer's settings, one set per session (F7) |
| `worlds` | yes | exactly one world, written inline, keyed by its id (F10 for more) |
| `initialWorld` | yes | the id of that world |
| `task` | no | the declarative task; without it the world runs with no task events |

A world holds `fall` (required: `"gravity"` or `"none"`, ADR-0001 R4), `gravity` (optional, negative, default −981 cm/s², ADR-0001 R3), `environment` (background, fog, skybox), `lights` (F7), `textures` and `materials` (named collections), `objects` (the node tree), `spawns` (required, named; it must contain `start`, where every session begins and the default spawn of phase 2's `switchWorld`, `scene-switching.md:216`) and `zones` (named sensor volumes; boxes in 1.0). A spawn has a feet position and a heading; zone membership is ADR-0001 R1's point query at feet + 1.15, so a zone has no probe setting. The task holds `variables`, `guards`, `trials` (seed, factors, blocks), `stateMachine` (initial state, states with `entry`, `exit`, `on`, `always`), `end` and `record`, with ADR-0002's clock and order; their semantics belong to the FSM (TS-13) and the trial table (TS-12). The task refers to zones and spawns of the current world by id.

Example: hallway04's logic (reward 70 ms at either end, `|z| >= 70`, back to the origin) with a 2 s blank ITI that v0.3 does not have. The layout (top-level keys, the world's and the task's keys, action forms, event names) is decided here; field names inside objects, materials, zones and spawns are the schema's (TS-03), which validates this example and amends it if they differ.

```json
{
  "format": "three-maze-experiment",
  "version": "1.0",
  "meta": { "title": "Linear track, reward at either end, 2 s blank ITI" },
  "units": { "length": "cm" },
  "worlds": {
    "hallway": {
      "fall": "none",
      "materials": {
        "track": { "color": "#808080" },
        "ends": { "color": "#0000ff" }
      },
      "objects": [
        { "type": "box", "id": "floor", "size": [40, 1, 200], "position": [0, -0.5, 0], "material": "track" },
        { "type": "box", "id": "leftWall", "size": [1, 10, 200], "position": [-20.5, 5, 0], "material": "track" },
        { "type": "box", "id": "rightWall", "size": [1, 10, 200], "position": [20.5, 5, 0], "material": "track" },
        { "type": "box", "id": "northWall", "size": [40, 10, 1], "position": [0, 5, 100.5], "material": "ends" },
        { "type": "box", "id": "southWall", "size": [40, 10, 1], "position": [0, 5, -100.5], "material": "ends" }
      ],
      "spawns": { "start": { "position": [0, 0, 0], "heading": 0 } },
      "zones": {
        "endNorth": { "position": [0, 5, 85], "size": [40, 10, 30] },
        "endSouth": { "position": [0, 5, -85], "size": [40, 10, 30] }
      }
    }
  },
  "initialWorld": "hallway",
  "task": {
    "stateMachine": {
      "initial": "run",
      "states": {
        "run": {
          "entry": [{ "trial": "start" }],
          "on": {
            "enter:endNorth": [{ "do": [{ "reward": { "durationMs": 70 } }, { "trial": { "end": "rewarded" } }], "goto": "interTrial" }],
            "enter:endSouth": [{ "do": [{ "reward": { "durationMs": 70 } }, { "trial": { "end": "rewarded" } }], "goto": "interTrial" }]
          }
        },
        "interTrial": {
          "entry": [{ "display": "blank" }, { "freeze": true }, { "teleport": "start" }, { "timer": { "start": "iti", "duration": 2 } }],
          "on": { "timer:iti": [{ "do": [{ "display": "on" }, { "freeze": false }], "goto": "run" }] }
        }
      }
    },
    "end": { "maxTrials": 100 }
  }
}
```

**F2. Rig facts stay out.** The file names no rig; the operator chooses one when the session starts (`--rig <name>`, `--rig sim` for the simulated rig; `backend-modules.md:132-133`, `scene-switching.md:156`). The rig file holds the eye height (default 3.7, ADR-0001 R3), the devices, their ports, channels and roles, the calibrations (cm per count, axis signs, valve), the reward safety envelope (ADR-0002, Rig runtime), the data folder, and the maximum speed and sample rate the zone-thickness lint uses (ADR-0001 R1). The agent's body and the mover's settings are ADR-0001 R3's and appear in neither file. The camera's projection belongs to the display: until the rig file has a display section (phase 2, `plan/phase1-plan.md:1003`), the render host uses v0.3's projection (vertical field of view 75°, near plane 0.1, far plane 1000, `PythonCustomScene.vue:567-571`; every shipped maze sets 75) and records it in each session. The task states reward amounts as `durationMs`, or as `volumeUl`, which arms a session only on a rig whose file holds a valve calibration; the paper states µL only with a calibration (D25 decides which the paper's tasks use).

**F3. Units and axes.** `units.length` is required. The compiler converts every length, and every quantity with a length in it (`gravity`), to cm once, as the decimal number the file writes: it takes the shortest decimal that reads back as the parsed value (JavaScript's number-to-string), moves its decimal point (mm: one place left; m: two places right) and reads the result as an IEEE-754 double. So `1.005` m compiles to the same double as `100.5` cm, which `1.005 × 100` in double precision would not (it gives 100.49999999999999). The compiled scene and everything after it, including ADR-0001's limits, is in cm; the source unit is recorded. Angles are degrees in the file (`heading`, `yaw`, rotations), converted only by the compiler. Times are seconds, except where a key names its unit (`durationMs`; `volumeUl` is µL). Axes as ADR-0001 R1: right-handed, +Y up, heading and yaw 0 look down −Z, positive yaw turns counter-clockwise seen from above (to the left, toward −X). Vectors are arrays `[x, y, z]` and colours sRGB strings `"#rrggbb"`; v0's `{x, y, z}` objects, integer colours and radians reach format 1.0 only through the migrator, which requires `--units` (TS-10).

**F4. Ids and names.** Every name an author chooses (worlds, objects, materials, textures, spawns, zones, states, variables, guards, timers, factors, blocks, trial outcomes) matches `^[A-Za-z][A-Za-z0-9_]*$` (`scene_dsl_agent.json` §2.2). Ids are case-sensitive, and two ids of one collection that differ only in letter case are rejected. Wherever order depends on ids (ADR-0002: zone entries by id), they are compared by character code, never by locale. Named collections (worlds, materials, textures, spawns, zones, states, variables, guards, factors) are JSON objects keyed by id, also where the designs list spawns and zones as arrays of objects with an `id` (`scene_dsl_agent.json` §2.8, `scene-switching.md:99-100`), so that a repeated id is a repeated key; a duplicate key anywhere makes the file invalid, because `JSON.parse` and Python's `json.loads` both keep the last of two duplicate keys silently (`scene_dsl_agent.json` §0; checked again on 2026-10-09 with Node 22.16.0 and Python 3.12.10). Keys the format defines are camelCase; Python code uses the snake_case form of the same names (`backend-modules.md:51`). Ids contain neither `@` nor `.`, so phase 2's zone tags (`enter:@reward`) and template exports (`maze.leftArm`) cannot collide with them.

**F5. Actions and events.** The names live in one machine-readable file, `schema/vocabulary.json`, from which the schema, TypeScript and Python constants are generated; a test fails continuous integration (CI) when the list exceeds ADR-0002's budget or a generated file is stale (plan item TS-02). The names follow the backend design (`backend-modules.md:74-77`: `freeze`, `enter:<zone>`, `timer:<id>`), except that its `startTimer` becomes `timer` with an operation, a merge the budget forces. An action is an object with one key. A merged action takes its operation as a string when the operation has no arguments, otherwise as an object keyed by the operation.

| Action | Form | In format 1.0 | Earlier names |
|---|---|---|---|
| `reward` | `{"reward": {"durationMs": 70}}`, or `volumeUl` (F2) | yes | water (roadmap) |
| `teleport` | `{"teleport": "start"}`: feet snapped to the floor, epoch + 1, zone exits with cause `teleport` (ADR-0001 R4; ADR-0002, Stamps) | yes | v0.3's `set` reply |
| `freeze` | `{"freeze": true}`, `{"freeze": false}`: locomotion discarded and logged | yes | `lock_motion` |
| `display` | `{"display": "blank"}`, `{"display": "on"}`: the screen shows black (the blanking colour of D14 a, applied by default on 2026-10-09) or the world; frames are still rendered and logged | yes | blackout (roadmap) |
| `timer` | `{"timer": {"start": "iti", "duration": 2}}`, `{"timer": {"cancel": "iti"}}` | yes | `startTimer`, `cancelTimer`, `set_timer` |
| `trial` | `{"trial": "start"}`, `{"trial": {"end": "rewarded"}}` | yes | `startTrial`, `endTrial` |
| `set` | `{"set": {"lastChoice": "left"}}`: task variables | yes | |
| `endSession` | `{"endSession": {}}` | yes | |
| `setGain` | per-axis gain from the next sample | only if B2 runs on v1.0-rc (D13, open) | |
| `setCue` | a cue object's state | phase 2 | |
| `emit` | a message to a plugin or an external controller | phase 2 | |
| `switchWorld` | another world, with a transition | phase 2 | |

These are 12 names, phase 2 included: the budget is full. Task events are `<category>:<name>`: `enter:<zone>`, `exit:<zone>` and `timer:<timer>` in format 1.0; `input:<name>`, `message:<topic>` and `world:switched` in phase 2 (`input:lick` earlier only if lick-contingent reward is needed, D29, open). These are 6 categories, the budget again. Motion records (`fall_start`, `land`; ADR-0001 R4) are logged, not task events: a fall that matters to a task is a zone below the floor. A blank ITI is `display: blank` plus a timer, as in the example; `teleport` takes a spawn id only (a later minor version may add an object form). There is no light action (F7).

**F6. Versions.** `format` and `version` (`"MAJOR.MINOR"`) are required; a file without them is v0 and reaches the compiler only through the migrator. Until the v1.0-rc freeze, 1.0 may still change: no paper data are collected before it (owner, 2026-10-09). After the freeze a format change is a new minor version that only adds: a reserved name becomes accepted (F10), a new optional key or enumeration value, a higher count limit, another form for a value. It never renames or removes a key or value, changes a default, makes an optional key required, or changes what an accepted file means: every file valid under 1.k is valid under 1.(k+1) and compiles to the same scene and task (the compiled form apart from its version fields). A compiler for 1.k accepts 1.0 to 1.k and rejects a later minor version or another major one with a diagnostic naming the version needed. Anything else is a new major version with a migrator.

**F7. Lights and renderer settings are fixed for a session.** Lights are declared per world and never change during a session: there is no light action, and phase 2's cue states may not target a light or change the number, kind or shadow casting of lights. three.js r169 (0.169.0) collects lights only from visible objects when it compiles (`node_modules/three/src/renderers/WebGLRenderer.js:947`), raises its light-state version when the number of lights of a kind changes (`webgl/WebGLLights.js:425-468`) and then recompiles every lit material (`WebGLRenderer.js:1839`): a light toggled after the renderer reports ready compiles shaders mid-session, which ADR-0003 1b forbids. The optional `renderer` block is one set per session; its fields and defaults come from the renderer-settings item (REN-3) under the owner's decision of 2026-10-09 (shadows off by default, every setting explicit).

**F8. Randomness.** The compiler expands the trial table (blocks and factors) from `task.trials.seed` before the session starts (ADR-0002, Decision) with one generator, SplitMix64 (Steele, Lea and Flood, OOPSLA 2014; the generator of Java's `java.util.SplittableRandom`), on unsigned 64-bit integers:

```text
state = (state + 0x9E3779B97F4A7C15) mod 2^64
z = state
z = ((z XOR (z >> 30)) * 0xBF58476D1CE4E5B9) mod 2^64
z = ((z XOR (z >> 27)) * 0x94D049BB133111EB) mod 2^64
output z XOR (z >> 31)
```

- The seed is an integer from 0 to 2^53 − 1 (the integers a JavaScript number holds exactly) and is the initial state. It is required when the table draws anything at random. A seed given at session start replaces the file's; the seed used and the table's hash are recorded.
- Derived draws, exact in TypeScript (`BigInt`) and Python (`int`): a fraction u = (x >> 11) · 2^−53 in [0, 1), and a uniform value a + (b − a) · u in IEEE-754 double precision; an integer below n (1 ≤ n ≤ 2^53) by rejection, drawing x until x < 2^64 − (2^64 mod n) and returning x mod n; a shuffle by Fisher-Yates from the last position down, swapping position i with position `below(i + 1)`.
- The trial-table item (TS-12) fixes the order of draws for each kind of factor and publishes test vectors shared by Vitest and pytest, checked against the reference code (`splitmix64.c` at prng.di.unimi.it) or Java's `SplittableRandom`. Phase 2's code tasks draw `ctx.rng` from the same generator; how further streams derive from the session seed is fixed then.

SplitMix64 takes a few lines in either language, needs only 64-bit integer arithmetic, gives 53-bit fractions that both languages represent exactly, and its reference code is described as "passing BigCrush" (prng.di.unimi.it/splitmix64.c). JavaScript's `Math.random` cannot be seeded; Python's `random` (Mersenne Twister) would need a TypeScript port of its seeding and its integer and shuffle routines, which are CPython's implementation details.

**F9. Compilation and provenance.** Only the compiler (`compileScene`, TS-04) reads experiment files; the motion worker, the render host and the rig runtime read what it produces (`scene_dsl_agent.json` §1), in which every default is written out, since only the compiler applies defaults (plan item TS-04). Asset paths (textures, skybox images) are relative to the experiment file's folder and use forward slashes; absolute paths and URLs are rejected. The compiled form names each asset by its path and its SHA-256, so its hash changes when an asset's content does. Each session keeps a copy of the file, the SHA-256 of its canonical form (RFC 8785 JSON Canonicalization Scheme) and of the compiled form, the format and compiler versions, the seed and the trial-table hash, next to the rig file and its hash.

**F10. Reserved for later versions, and what 1.0 rejects.** These names are recognised now and rejected in 1.0 with an "available in phase 2" diagnostic, so that phase 2 only lifts the rejection: more than one entry in `worlds`, and world files referenced as `{"$ref": "<path>.scene.json"}` (`scene-switching.md:79-107`); the world keys `cues`, `taskParams`, `onEnter` and `extraColliders` (extra invisible collision volumes, phase 2 by the owner's decision of 2026-10-09); zone `tags` and `@tag` event arguments; templates (`"type": "template"`) and their dotted exports; the actions `setCue`, `emit`, `switchWorld` and, until D13 is decided, `setGain`; the event categories `input`, `message` and `world`; `meta.generator`, the provenance of agent-written files, with the agent toolchain (phase 2, owner, 2026-10-09); and a code task in place of `task` (phase 2, owner, 2026-10-09), whose form is fixed then and which keeps one task source per session (ADR-0002). Colliders follow ADR-0001 R5 as the owner narrowed it on 2026-10-09 (D12 a): paper scenes use boxes, and walls, floors, steps and drops built from boxes stay valid whatever colliders R5 builds for them (R5.1 makes a non-rectangular floor region, such as a T-maze's, a triangle mesh), while walkable ramps, convex hulls and cones are rejected by the verifier until phase 2 (MOT-10); a node's `collider` is `auto` or `none`; dynamic and kinematic bodies are rejected (ADR-0001 Caveats: moving colliders are untested; D11).

**Resolved design conflicts** (tasks breakdown, `design_conflicts`):

| Conflict | The designs disagreed on | Resolution |
|---|---|---|
| C3 action budget | 13 actions (`scene_dsl_agent.json` §2.8), 14 with `switchWorld`; at most 12 (ADR-0002, Risk) | merged verbs `timer` and `trial`; 12 names with phase 2 (F5) |
| C4 naming | `lock_motion`, `set_timer`, `zone_enter` (experiment-data prototype); water and blackout (roadmap); `freeze`, `startTimer`, `enter:<zone>` (`backend-modules.md:74-77`) | the backend design's names, camelCase in JSON and snake_case in Python; water is `reward`, blackout is `display: blank`; `startTimer` becomes `timer` by the merge (F5) |
| C5 agent and eye height | an `agent` block with shape, radius, eye height and controller (`scene_dsl_agent.json` §2.7); eye height 2.1 in the prototypes and `backend-modules.md:146` | no agent in the experiment file; ADR-0001 R3 fixes the body; the eye height comes from the rig file, default 3.7, so the designs' 2.1 is superseded (F2) |
| C6 physics block | gravity 0 by default, a 1/120 s timestep and `world.step` (`scene_dsl_agent.json` §2.7, §4) | no timestep: motion per device sample (ADR-0001 R1); `fall` required per world, `gravity` default −981 (F1) |
| C7 zone detection | a 1 cm probe sensor and collision events, `zoneProbe` (`scene_dsl_agent.json` §0, §2.7) | ADR-0001 R1's point query at feet + 1.15; no probe setting (F1) |
| C8 layout | zones under `task`; world files with their own zones; a separate task file naming its scene | option A: one file, its world inline in `worlds`, zones and spawns in the world (F1) |
| C9 rig reference | a `rig` path in the header (`scene_dsl_agent.json` §2.1); `--rig` at run time (`backend-modules.md:132`, `scene-switching.md:156`) | `--rig`; the file names no rig (F2) |
| C10 blank ITI | `teleport` with a blank `transition` (`backend-modules.md:260-263`, `scene-switching.md:157`); `display: blank` plus a timer (`scene_dsl_agent.json` §3) | `display: blank` plus a timer; `teleport` takes a spawn id (F5) |
| C13 units | `units.length` mm, cm or m (`scene_dsl_agent.json` §2.1); ADR-0001's limits in cm; v0.3 comments in metres (`hallway04_experiment.py:490`) | `units.length` required, compiled to cm (F3); the migrator requires `--units` |

## Consequences

*Positive:* one file per experiment is validated, hashed and recorded, and runs unchanged on every rig and in simulation; the compiled scene and every limit downstream are in cm; phase 2's worlds, cues, tags, code tasks and agent provenance have reserved names and places, so they arrive as minor versions; the vocabulary is generated into the schema, TypeScript and Python from one list, and CI holds it within ADR-0002's budget.

*Negative:*
- The budget is full (12 of 12 actions, 6 of 6 event categories). A new action needs a merge or an ADR that raises the budget; the backend design's generic `output {role, ...}` (`backend-modules.md:345`), for example a trigger pulse to an imaging system, has no slot.
- Without zone tags, a handler shared by several zones is written once per zone (the example's two ends).
- The merged verbs are less obvious than separate ones; the vocabulary keeps the earlier names so that diagnostics can suggest the new form.
- A world reused by several experiments is copied until phase 2's world files, and a task-only change changes the experiment file's hash.
- Lengths in mm or m are converted through their decimal text (F3), a few lines more than a multiplication; a length written with more than 17 significant digits is converted from the double it parses to.
- The trial table is fixed at compile time; anything adaptive goes through FSM variables and guards.

*Risks:* a paradigm needs more than the budget (ADR-0002, When to revisit); D13 or D29 add `setGain` or `input:lick` before the freeze, which fits the budget; a mistake frozen into 1.0 stays until a major version.

*Follow-up:* phase 1: the vocabulary file and its budget check (TS-02, with this record); the schema accepting this example and rejecting what F10 reserves (TS-03); worlds reserved in the compiled form, the protocol and the records (TS-09); the compiler with units, angles, asset hashes and provenance (TS-04); the trial table with SplitMix64 and its vectors (TS-12); the migrator (TS-10). Phase 2: lift F10's reservations one minor version at a time.

## Validation

1. **Budget** (TS-02, CI): the vocabulary check passes on `schema/vocabulary.json` and fails on a copy with a 13th action or a 7th event category (ADR-0002 Validation 4); the generated constants match the list.
2. **Schema** (TS-03, CI): the example above validates with no diagnostic; a `rig` key, an `agent` or `eyeHeight` key, a second world, `switchWorld`, `setCue`, an `enter:@tag` event, an id outside F4's pattern, two ids differing only in case, a duplicate key, a missing `units.length` and `"version": "1.1"` each give one diagnostic with its JSON pointer.
3. **Units** (TS-04, CI): the example written in m and in cm compiles to the same scene, apart from the recorded source unit; its end walls at ±1.005 m included (F3).
4. **Randomness** (TS-12, CI): TypeScript and Python give identical sequences for the published vectors, which match the reference code.
5. **Additive versions** (from the freeze, CI): the hashes of the compiled examples and migrated mazes are kept; a schema change that alters one of them fails.
6. **Lights** (ADR-0003 test 2): constant `renderer.info` program counts from ready to the end of a session.

## When to revisit

- A planned paradigm needs a 13th action or a 7th event category.
- Phase 2 lifts a reservation of F10 (each is a minor version under F6).
- A rig needs a per-experiment value that F2 puts in the rig file, or the reverse.
- A test vector differs between TypeScript and Python, or SplitMix64 shows a defect that matters for trial tables.

## Evidence

- **Prototype of the scene-format design** (`scene_dsl_agent.json` §0): a v1 schema and a T-maze example validated with no diagnostic and compiled to 16 primitives and 11 colliders; the validator gave one diagnostic per root cause for 11 injected mistakes, after cascade suppression; Hallway01 took 1.7 KB of v1 scene plus task against 3.9 KB of v0 scene alone. These were throwaway prototypes outside the repository; the schema item brings the cases in.
- **Duplicate keys:** `JSON.parse('{"a":1,"a":2}')` gives `{ a: 2 }` and `json.loads` gives `{'a': 2}` (Node 22.16.0, Python 3.12.10, 2026-10-09).
- **Unit conversion:** `1.005 * 100` gives 100.49999999999999 in Node 22.16.0 and Python 3.12.10, while `Number('1.005e2')` and `float('1.005e2')` give 100.5 (2026-10-09); the example's end walls sit at z = ±100.5 cm.
- **three.js 0.169.0** lights at compile: `WebGLRenderer.js:947` (lights from `traverseVisible`), `:989` (materials from `traverse`), `:1839` (recompile on a changed light state); `webgl/WebGLLights.js:425-468` (the light-state version).
- **SplitMix64:** the reference `next()` and its note "passing BigCrush" (prng.di.unimi.it/splitmix64.c, read 2026-10-09); OpenJDK's `SplittableRandom` uses the same constants and shifts (`GOLDEN_GAMMA`, `mix64`), so `new SplittableRandom(seed).nextLong()` is the generator above seeded with `seed` (read 2026-10-09).
- **v0.3 facts** at b96ad72: the citations in Context; all six shipped mazes use boxes only except Example01's dynamic sphere (`public/mazes/Example01.json`), and all set a 75° field of view.
