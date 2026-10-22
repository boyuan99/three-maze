# Motion suite

Tests of the player's motion: the motion module (`src/motion/`), the physics side of the scene
compiler (`src/compiler/`) and the Rapier build they run on. [ADR-0001](../../docs/adr/0001-player-mover.md)
(Validation) asks for a CI gate that runs this suite "on every change to the motion module,
compiler or Rapier" (`docs/adr/0001-player-mover.md:81`). Roadmap phase 1 builds it up in steps:

| Item | Adds |
|---|---|
| MOT-01 (this folder's start) | the vendored reference mover, the two tiers, the CI job `motion-suite` |
| MOT-03 | `equivalence.ts`, `fast/mover.equivalence.test.ts`, `full/mover.walls.test.ts`, `full/mover.rooms.test.ts`: the TypeScript mover against the reference, sample for sample |
| MOT-05a | `validation/`, `full/validation.*.test.ts`, `fast/validation.driver.test.ts`, `fast/validation.measures.test.ts`: ADR-0001 Validation 1-5 cases behind a mover interface, run on the reference on the archived streams and on rotating ones |
| MOT-05b (week 4) | the same cases on the TypeScript mover through the motion core, by switching the suite's driver |

The collider tests of `src/motion/instantiate.ts` (MOT-07), the tests of the motion core
`src/motion/core.ts` with movers that have no collisions (MOT-02), the hover mover's own tests
(`src/motion/mover.ts`, MOT-03: eye height, falls, events, worker bundle) and those of the pose
history (`src/motion/poseHistory.ts`, MOT-13: display modes, with the motion-core design's
display simulation) are ordinary unit tests in `test/frontend/motion/`.

## Layout

- `reference/`: the **vendored reference implementation**, test code that is never shipped. It is
  the inclined-face study's mover and test scripts, copied on 2026-10-09 from the design-review
  workspace, now kept in the separate three-maze-notes repository (`proto/verify/inclined/`). The
  workspace has since moved there unchanged: every source, and every archived output below, still
  has the SHA-256 recorded here. Each file starts with a provenance header: source path, SHA-256,
  what it is, and what was changed.
- `reference/archive/`: outputs the study archived, copied unchanged. The tests reproduce them.
- `equivalence.ts`: the harness that runs the reference and the TypeScript mover side by side
  (MOT-03), with case generators that rebuild the worlds and inputs of the study's scripts t1-t5,
  and one run that forces undos after airborne sweeps.
- `validation/`: ADR-0001 Validation 1-5 (MOT-05a): the mover interface and its two drivers
  (`driver.ts`), the device-sample streams (`streams.ts`), the cases (`walls.ts`, `inclined.ts`,
  `soaks.ts`), their measures (`measures.ts`, `camera.ts`) and what the test files share
  (`run.ts`, `suite.ts`, `soakSuite.ts`). See "ADR-0001 Validation 1-5" below.
- `fast/`: the fast tier. `npm test` runs it with the unit tests (CI job `javascript`).
- `full/`: the long runs of the full tier.
- `vitest.config.mjs`: the full tier's configuration. `npm run test:motion` runs `fast/` and
  `full/` (CI job `motion-suite`), one test file per logical CPU at a time.

### Vendored files

| File | Source (under `proto/verify/inclined/`) | SHA-256 of the source | Changed |
|---|---|---|---|
| `reference/lib/hover.mjs` | `mover_fix/lib/hover.mjs` | `49244bfe8c2b...` | header only |
| `reference/lib/geom.mjs` | `mover_fix/lib/geom.mjs` | `7d424383bbfc...` | header only |
| `reference/lib/walls.mjs` | `mover_fix/lib/walls.mjs` | `87edc588c941...` | header only |
| `reference/lib/rooms.mjs` | `mover_fix/lib/rooms.mjs` | `8c3466c76b9b...` | header only |
| `reference/lib/run.mjs` | `mover_fix/lib/run.mjs` | `5c53aa5f50c8...` | header only |
| `reference/lib/rapier.mjs` | `mover_fix/lib/rapier.mjs` | `6344cf515e71...` | default Rapier path |
| `reference/t3_walls.mjs` | `mover_fix/t3_walls.mjs` | `34be2c53a733...` | header only |
| `reference/xanalytic.mjs` | `verify/xanalytic.mjs` | `c1f2f8af3965...` | import paths |
| `reference/proxy/geom.mjs` | `proxy/lib/geom.mjs` | `fbc3efc617a2...` | header only |
| `reference/proxy/checks.mjs` | `proxy/lib/checks.mjs` | `a9647559d4ee...` | header only |
| `reference/proxy/scene.mjs` | `proxy/lib/scene.mjs` (copied 2026-10-22, MOT-05a) | `6ef5b9830e8f...` | Rapier from `../lib/rapier.mjs` |

The full hashes are in the headers. For every file except `xanalytic.mjs` they equal the hashes
the independent verification recorded for the files it re-ran (`verify/out/hashes_B_mover_fix.txt`,
`verify/out/hashes_A_proxy.txt`), so these are the versions behind the archived numbers.

`lib/hover.mjs` with `fix: true` and `top: 4.15` is the mover ADR-0001 adopts (variant U+RS:
R3, R4 and R6; cylinder top `eyeHeight` + 0.45). `fix: false` is the configuration the ADR first
adopted, kept for comparison. The study's `mover_fix/README.md` documents every option.
`proxy/` holds three files of approach A (compiler-side proxies, not adopted). `xanalytic.mjs`
uses two of them as an independently written second distance function; the Validation suite
builds the cross-tests' scenes and true shapes with them, in mode `'true'` (the objects' own
colliders, no proxies), as the verification's cross-tests did.

### Archived outputs

| File | Source | SHA-256 | Written by |
|---|---|---|---|
| `t3_walls_top415_out.txt` | `mover_fix/out/t3_walls_top415_out.txt` | `4a1c6883bce8...` | `TOP=4.15 MOVERS='[["adopted",{"fix":false}],["U+RS",{"fix":true}]]' node t3_walls.mjs` (`mover_fix/run_all.sh`, run of 2026-10-07 20:58) |
| `X11_analytic_out.txt` | `verify/out/X11_analytic_out.txt` | `ec62eaad065f...` | `node xanalytic.mjs` (listed in the study's `verify/README.md`, "How to re-run"; output of 2026-10-07 21:58) |

Copied 2026-10-22 for the Validation suite (MOT-05a), from the same run of `mover_fix/run_all.sh`
(2026-10-07) and the verification's re-runs (`verify/README.md`, "How to re-run"):

| File | Source | SHA-256 | Written by |
|---|---|---|---|
| `t1_slabs_A_out.txt` | `mover_fix/out/t1_slabs_A_out.txt` | `9fa7ee3250dc...` | `node t1_slabs.mjs A` (20:51) |
| `t1_slabs_B_out.txt` | `mover_fix/out/t1_slabs_B_out.txt` | `8d508f64e68f...` | `node t1_slabs.mjs B` (20:52) |
| `t2_curved_out.txt` | `mover_fix/out/t2_curved_out.txt` | `c405b5c3ef56...` | `node t2_curved.mjs` (20:52) |
| `t4_soak_part1_out.txt` | `mover_fix/out/t4_soak_part1_out.txt` | `49240057adcc...` | `node t4_soak.mjs 1 5` (21:08) |
| `t4_soak_part2_out.txt` | `mover_fix/out/t4_soak_part2_out.txt` | `00eced7ae658...` | `node t4_soak.mjs 2 5` (21:14) |
| `t5_floors_falls_out.txt` | `mover_fix/out/t5_floors_falls_out.txt` | `28e82ff5ff11...` | `node t5_floors_falls.mjs` (21:01) |
| `t7_census_out.txt` | `mover_fix/out/t7_census_out.txt` | `cb53d45206dd...` | `node t7_census.mjs 6000` (20:48) |
| `X1_directed_B415_out.txt` | `verify/out/X1_directed_B415_out.txt` | `5f02fa9c826d...` | `node xdirected.mjs B415` (21:48) |
| `X1_directed_B415_aspect32x9_out.txt` | `verify/out/X1_directed_B415_aspect32x9_out.txt` | `1e265ea2d956...` | `ASPECT=32/9 node xdirected.mjs B415` (21:48) |
| `X2_ramp_side_out.txt` | `verify/out/X2_ramp_side_out.txt` | `cb5f2720cc4f...` | `node xramp_side.mjs B415,adopted,B20` (21:47) |

## The two tiers

**Fast tier** (about 10 s). `fast/reference.test.mjs` (about 1.3 s) checks that the Rapier build
is 0.14.0, the build the archived numbers come from, and recomputes two rows of section S1 (long
walls) of the t3 study with the U+RS mover at top 4.15, using the code of `t3_walls.mjs` for
those rows. Both must equal the archived rows in every field except the time per sample:

```
  L200 split 40 U+RS     -0.020 / 0 / 0 / 100.0 / 0.015 / * / 0 / 0 / 15600
  L400 split  - U+RS     0.007 / 0 / 0 / 99.9 / 0.134 / * / 0 / 6 / 34489
```

(worst depth / samples deeper than the skin / crossings / minimum retention % / sideways range /
time / guard reverts / recoveries / KCC wall contacts, over 15 runs each: 3 speed and sample-rate
regimes x 5 angles). The first is a capped wall (ADR-0001 R5.2); the second, a 400-unit wall in
one piece, goes through the recovery of R6 six times.

`fast/mover.equivalence.test.ts` (about 10 s) compares the TypeScript mover with the reference
(next section) on those two S1 rows, on a thin wall of section S2 hit head-on from 20 start
phases (the runs that show a query refresh, below), on 10 s per rate in both soak rooms, on
directed runs at inclined faces, balls, cones, steps, a drop and falls, and on long walls, the
T-junction, the corner and the wedges in worlds built by `instantiate()`: 163 runs, 61,335
samples, all identical, no guard undo.

`fast/validation.driver.test.ts` (about 5 s) checks the Validation suite's mover interface: the
reference driver against the TypeScript mover through the core on rotating streams, 13,448
samples, every pose identical (section "ADR-0001 Validation 1-5").
`fast/validation.measures.test.ts` (milliseconds) checks the wall-crossing measure behind
Validation 3's "contained" on made-up sample ends.

**Full tier** (`full/`; the runtimes are under Runtimes). Runs two study scripts unchanged in a
fresh Node process, with the archived settings, and compares their whole output with the archive:

- `t3_walls.test.mjs`: the vertical-wall suite t3 (long walls, thin walls, seams, T-junction,
  corner, wedges, trimesh walls; 1,661 runs per mover) for the adopted mover and U+RS at top 4.15.
  Every line must match except the time-per-sample field of the S1 rows. Among the reproduced
  numbers: on capped long walls U+RS never comes closer than the 0.02 skin (worst depth -0.020)
  and keeps 100.0 % retention; its 7,187 guard reverts all come from the uncapped 1,200-unit thin
  wall (study README, t3).
- `xanalytic.test.mjs`: X11, which checks the analytic distance functions that judge overlap
  (`lib/geom.mjs`) against approach A's, against Rapier's `projectPoint` and against a brute-force
  minimum over the agent cylinder. Byte for byte.

It also compares the TypeScript mover with the reference on more inputs:

- `mover.walls.test.ts`: the inputs of all 1,661 t3 runs. Every pose identical; the mover's totals
  reproduce the archive's last line for U+RS: 7,187 guard undos and 3,352 recoveries, 383 of them
  clear. This is the tier that reaches the undo path (the uncapped 1,200-unit thin wall).
- `mover.rooms.test.ts`: both soak rooms, 4 seeds x 30 s at 20, 120, 250 and 1,000 samples/s,
  490 directed runs, and one run that forces undos after airborne sweeps (a lid enabled at run
  time around the falling agent; 4 airborne undos); it prints the cost table below.

And it runs ADR-0001 Validation 1-5 (section "ADR-0001 Validation 1-5"): `validation.walls`,
`validation.inclined`, `validation.floors` and the eight soak files
`validation.soak-<room>-<stream>`, one room and one stream per file so that the soaks spread over
the workers.

On 2026-10-09 both tiers reproduced the archive exactly on Rapier 0.14.0. The archive was written
with Node 22.16.0 (V8 12.4). Run with Electron 44.7.0's Node 24.21.0 (V8 15.2,
`ELECTRON_RUN_AS_NODE=1`), `t3_walls.mjs` and `xanalytic.mjs` gave the same output too (t3 with
its time field masked), so a newer V8 alone did not change any number.

## The TypeScript mover against the reference

ADR-0001's evidence was produced with the reference mover, so the shipped mover
(`src/motion/mover.ts`, a port restructured into per-sub-step calls) must reproduce it bit for bit
(plan item MOT-03). `equivalence.ts` builds every case twice with the vendored generators, runs
the reference (`makeHover`, `fix: true`, `top: 4.15`) in one world and the TypeScript mover (eye
height 3.7) through the motion core (`src/motion/core.ts`) in the other, sample by sample, and
compares x, feet, z and the airborne state of every sample with `Object.is`, and every counter at
the end.

- The reference takes a world-frame displacement per sample, the core a body-frame one. At yaw 0
  the sample d = [-dz, -dx, 0] is the same displacement exactly (sin 0 = 0, cos 0 = 1). Samples
  with rotation cannot be compared this way: the reference has no heading. The Validation suite's
  reference driver feeds it the core's sub-steps one call each instead, and on rotating streams the
  two movers then agree bit for bit as well (next section, `fast/validation.driver.test.ts`).
- Device time is whole microseconds (device protocol v1, section 7.2), so both movers get
  dt = dt_us / 1e6: at 120 samples/s 0.008333 s instead of the study's 1/120. dt only enters
  falls, so the comparison is unaffected, but runs with falls differ from the study's in the last
  digits; no archived number used here depends on them.
- A world built by `instantiate()` from a collider manifest gives the same poses as the study's
  builders (`viaManifest`: the reference world's cuboids read back into a manifest).
- Not reached by any compared run: a floor over 0.3 higher under the ground ray (at a step the
  controller meets the step's side first). An undo after an airborne sweep is reached only by the
  forced run in `full/mover.rooms.test.ts`: there both movers keep the undone samples' gravity in
  vy, although ADR-0001 R6 lists vy among the values an undo restores.
- Not compared: `fall: 'none'`, which the reference does not have. The TypeScript mover rejects
  a sub-step whose ground ray finds no floor, so the agent stops at the edge and, unlike along a
  wall, does not slide along it (`test/frontend/motion/mover.test.ts`).
- Found while porting: the mover must not refresh the scene queries after adding its own collider. A
  refresh puts it into Rapier's query tree, which changes which of two contacts at the same distance
  a cast reports first at the seam of two flush pieces; with it, 80 of the 1,661 t3 runs no longer
  matched, 10 of them among the 20 runs of the fast tier's thin-wall group. No query of the mover
  sees its own collider, so nothing needs it.

### Cost

`full/mover.rooms.test.ts` measures the time per sample of both movers, interleaved sample by
sample on the same inputs, as the study's t6 did. Development PC, 2026-10-09, the file run alone
(`npx vitest run --config test/motion/vitest.config.mjs test/motion/full/mover.rooms.test.ts`;
other work on the PC, CPU load 21-28 % before and after); median over 4 seeds x 30 s of the run
means, µs per sample, reference / TypeScript mover through the core:

| Room | 20/s | 120/s | 250/s | 1,000/s |
|---|---|---|---|---|
| walls only | 792.7 / 791.1 | 158.0 / 158.3 | 87.6 / 87.4 | 49.0 / 49.1 |
| inclined room | 889.6 / 888.1 | 170.9 / 170.8 | 99.6 / 99.6 | 56.3 / 56.2 |

The two agree within 1 % in every cell. The study's own figures for the reference, from runs of
60 s with three movers interleaved (t6, `mover_fix/out/t6_cost_ratios_out.txt`): 1,196 / 257 /
148 / 82 µs (walls only) and 1,502 / 290 / 168 / 94 µs (inclined room); 52 µs at 1,000 samples/s
in X13 (`verify/README.md`).

## ADR-0001 Validation 1-5

ADR-0001 (Validation) lists the cases the shipped configuration must pass in CI; its Evidence comes
from the study's scripts, which gave the reference mover one world-frame displacement per sample.
`validation/` ports those cases behind a mover interface, so that the same cases run on the
vendored reference now (plan item MOT-05a) and on the TypeScript mover through the motion core
later (MOT-05b), and gives every case a rotating variant, which the archived evidence never had.

### Mover interface and streams

A case drives an agent with device samples as the motion core receives them: a body-frame
displacement [forward, left, dyaw] and its length in whole µs (device protocol v1, section 7.2).
`validation/driver.ts` has two drivers:

- `referenceDriver`, the default: the vendored reference (U+RS at top 4.15), fed the way the core
  feeds its mover. A sample without rotation goes to it as one call with the sample's displacement
  turned to the current heading, exactly as the study drove it. A sample with rotation goes as one
  call per sub-step, each with the world displacement the core gives that sub-step (the sample's
  displacement turned to the heading at the sub-step's midpoint, ADR-0001 R1, over the number of
  sub-steps), dt on the last call only.
- `coreDriver`: the shipped configuration, `src/motion/mover.ts` through `src/motion/core.ts` at eye
  height 3.7. `MOTION_VALIDATION_DRIVER=core npm run test:motion` runs the suite on it; MOT-05b
  makes it the default (`validation/suite.ts`).

The reference driver counts where it could depart from the core: `resplit`, a sub-step that the
reference would split again because turning its displacement moved its length an ulp past 0.25
(the streams prevent it, below, and every test asserts 0), and `airborne`, a landing or an undo
in the airborne sweep of length 0 that each reference call makes while the agent is airborne,
between two sub-steps of one sample (the core sweeps once per sample). Where both stay 0, the
reference driver's poses are the TypeScript mover's bit for bit: `fast/validation.driver.test.ts`
runs both drivers on rotating streams (long walls at 30, 100 and 141 units/s, two slabs, a ball,
the soak room at 20, 120 and 250 samples/s, a drop: 13,448 samples) and finds every pose, heading
and counter identical, apart from the KCC calls of those airborne sweeps of length 0.

Every case runs on two streams (`validation/streams.ts`):

- **archived**: the study's own inputs, one world-frame displacement (dx, dz) per sample at
  heading 0, as the device sample d = [-dz, -dx, 0], which the core turns back into exactly (dx,
  dz). Device time is whole µs, 8,333 µs at 120 samples/s instead of 1/120 s; only falls notice.
- **rotating**: the same world path while the heading swings by ±0.6 rad around the first
  displacement's direction twice per second (peak 7.5 rad/s, 430 degrees/s; up to 0.38 rad per
  sample at 20 samples/s), from a phase that differs from run to run. Each sample's body-frame
  displacement is the archived world displacement turned back by the heading at the sample's
  midpoint, so the core's sub-steps fan out by ±dyaw/2 around the archived direction. A sample
  whose length is a whole number of 0.25 sub-steps to within 1e-9 (for example 30 and 300 units/s
  at 120 samples/s, 100 and 1,000 units/s at 20, the census's 0.25 and 5) is shortened by 1e-8 of
  its length, so that the core and the reference count the same sub-steps.

### Cases

| Test file (`full/`) | ADR-0001 Validation | Cases (study script) | Rows compared with the archive on the archived stream |
|---|---|---|---|
| `validation.walls.test.ts` | 1, 2, 3 | long walls of 200, 400, 600 in 40-unit pieces at 1-75 degrees (t3 S1: 45 runs); thin walls 0.1 thick, 40/400/1,200 long, one piece and 40-unit pieces, 141-1,000 units/s, up to 50 units per sample, 5/20/90 degrees, up to 20 start phases (S2: 1,420 runs); coplanar seams, the T-junction, the 90-degree corner, wedges of 30/60/90 degrees, retention near head-on, the seam trap (S3a-S3e: 115 runs); trimesh walls (S3g: 36 runs); the side of a 200-unit raised platform 2 high, in 40-unit pieces, run along from the floor below (new: 15 runs) | t3's U+RS rows of S1 (the split-40 rows, time per sample masked), S2, S3a-S3e and S3g |
| `validation.inclined.test.ts` | 5 | a 20 x 20 slab of 15-90 degrees head-on (t1 Part A: 33 runs); 400-unit slabs of 31-150 degrees at 5-90 degrees (t1 Part B: 588); balls of radius 3, 10, 25 on the floor and as domes, hull cones upright and inverted (t2: 336); the proxy study's shapes with their own colliders: balls of radius 3-60, hull cones, slabs and wedges of 35-75 degrees, a lying cylinder, a tumbled cube, the twisted 50-unit slab (X1: 1,302) | t1 Part A, t1 Part B, t2 (not Rapier's cone primitive, which R5.2 rules out), X1 at 16:9 and 32:9 |
| `validation.floors.test.ts` | 5 | floor T-junctions and the 20-unit drop (t5 a, b); steps of 0.1-0.5 (t5 c); falls onto a 45-degree slab, a ball and a hull cone (t5 d) and toward a ball (X7); the ledge scene with balls and an overhang (X3), plus steps of 0.2-0.31 under the overhang (new); railed ramps of 20 and 28 degrees, up and down head-on and 30 degrees off-axis (down off-axis new), at their sides (X15, X16, X2); the cast-miss census, 6,000 trials per obstacle (t7) | t5 (a)-(c), t7, X2's 20-degree railed row |
| `validation.soak-<room>-<stream>.test.ts` (8 files) | 4, 5 | 4 seeds x 5 min of the study's random running at 20, 120, 250 samples/s in four rooms: the closed 400 x 120 room with cuboid walls in 40-unit pieces (t4 Part 1) and with trimesh walls of segments up to 40 (s7); the same room with the 13 inclined obstacles (t4 Part 2); the proxy study's room with a platform, two railed 20-degree ramps and 18 objects (X9 with rails) | t4 Part 1 and Part 2 |

Not compared with an archive: falls (t5 d, X7, the proxy room), because whole-µs device time
changes them in the last digits; X3's and X15/X16's tables, whose columns the port does not print;
the trimesh room, which the study ran only with the adjudication's rigid-body hover; and the new
cases.

Thresholds, as the tests assert them (ADR-0001 Validation; R6: expected undo count zero; overlap
is a depth beyond the 0.02 skin, measured analytically against the true shapes):

- 1: no overlap, crossing or guard undo; retention at least 99 %; sideways range against a
  perfect slide below 0.1 (ADR-0001, When to revisit).
- 2: no crossing in any configuration; within R5.2 (40 units, or pieces of 40) also no overlap
  and no undo. The uncapped 400- and 1,200-unit walls are reported only.
- 3: contained: no crossing of any wall (`validation/measures.ts` Crossings: a sample that ends
  beside a wall on its other side) and no overlap; no undo; retention at least 99 %; no
  T-junction sample without progress.
- 4: no overlap, escape or guard undo.
- 5: no overlap and no undo; retention at least 99 % along flat faces (t1 Part B, X1) and
  sideways range at most 0.08 (t1 Part B); eye-point clearance at least 0.43 (t1, t2, X1, X3, the
  falls, the two inclined rooms); near plane above 0 at 16:9 and 32:9 (X1, X3, the falls, the two
  inclined rooms; in t1 and t2 an eye clearance of 0.43 keeps every point of the near plane and the
  frustum's tip, at most 0.30 from the eye at 32:9, outside); slabs up to 30 degrees climbed and
  31-90 blocked; feet range at most 1e-4 over floor T-junctions; the 20-unit drop lands within 2
  samples of free fall; steps of 0.28 climbed and 0.29 blocked, also under the overhang; every
  ramp run reaches the platform or the floor, side runs never get onto the ramp and runs on it
  never leave by its side; every fall ends on the floor below; in the proxy room every fall lands
  and none hangs. A hang on the ledge's rim is accepted only where ADR-0001 (Risks) expects it:
  X3's run toward the ball 1 unit beyond the ledge.

### Results

Rapier 0.14.0, Node 22.16.0, 2026-10-22. Every threshold passes on both streams with the reference
(MOT-05a). No rotating-stream failure to report before MOT-05b. The deviation `resplit` is 0
everywhere; `airborne` is 0 except in X3's rotating stream (2: the reference landed between two
sub-steps of a sample, where the core lands at the sample's end).

| Validation | Group | Archived stream | Rotating stream |
|---|---|---|---|
| 1 | long walls (46,375 samples) | worst depth -0.0200, lowest retention 100.00 %, sideways 0.0287 | -0.0200, 99.99 %, 0.0287 |
| 2 | thin walls within R5.2 | no crossing, worst depth -0.0200 (pieces of 40), -0.0233 (40 long), no undo | -0.0206, -0.0207, no undo |
| 2 | thin walls outside R5.2 (reported) | 400 in one piece: no crossing, worst depth 0.0036; 1,200 in one piece: no crossing, 0.0457, 7,187 undos (the archived numbers) | 400: -0.0059; 1,200: no crossing, 0.0630, 707 undos |
| 3 | seams, T-junction, corner, wedges | no crossing, worst depth -0.0040, lowest retention 99.77 %, sideways 0.0477 | no crossing, -0.0039, 99.77 %, 0.0477 |
| 3 | trimesh walls | no crossing, -0.0168, 99.99 % | no crossing, -0.0189, 99.93 % |
| 3 | raised platform | no crossing, -0.0202, 100.00 % | no crossing, -0.0202, 99.99 % |
| 4 | cuboid room (468,000 samples) | no overlap, escape or undo; worst depth -0.0177 | worst depth -0.0132 |
| 4 | trimesh room | worst depth -0.0196 | -0.0196 |
| 5 | t1 Part A | climbed up to 30 degrees, blocked from 31; gap ≥ 0.0098, eye ≥ 0.530 | eye ≥ 0.526 |
| 5 | t1 Part B | gap ≥ 0.0144, lowest retention 99.92 %, sideways 0.0542, eye ≥ 0.520 | 99.91 %, 0.0542, 0.520 |
| 5 | t2 | gap ≥ 0.0196, eye ≥ 0.589 | same |
| 5 | X1 | body ≥ 0.0196, eye ≥ 0.520, near plane 16:9 ≥ 0.361 (any yaw 0.351), 32:9 ≥ 0.237 (0.230), lowest retention 99.97 %, 1 recovery | 16:9 0.355 (0.351), 32:9 0.230 (0.230) |
| 5 | t5 floors, drop, steps | feet range 5.91e-8, drop within 1.48 samples of free fall, steps 0.28 climbed and 0.29 blocked | same |
| 5 | X3, steps under the overhang | gap ≥ 0.0202, eye ≥ 0.530, near plane 32:9 ≥ 0.244 (0.239); 6 runs hang on the rim toward the ball 1 unit away | 0.241 (0.239); 3 such runs |
| 5 | falls (t5 d, X7) | gap ≥ 0.0200, eye ≥ 0.537, near plane 32:9 ≥ 0.291 (0.244), all end on the floor | 0.531, 0.238 (0.236) |
| 5 | railed ramps | gap ≥ 0.0301, every run reached its goal | same |
| 5 | t7 census (60,000 trials) | no undo; 27 recoveries, all clear; deepest end 0.0117 inside a shape (within the skin) | 25 recoveries; 0.0131 |
| 5 | inclined room | worst depth -0.0177, eye ≥ 0.518, near plane 32:9 ≥ 0.230 (0.227) | -0.0199, 0.520, 0.230 (0.229) |
| 5 | proxy room | worst depth -0.0182, body ≥ 0.0195, eye ≥ 0.521, near plane 32:9 ≥ 0.240 (0.230); 46 falls, 46 landings, no hang | -0.0154, 0.0196, 0.520, 0.239 (0.230); 47 falls, 47 landings |

The near-plane cells give the rectangle at the camera's heading and, in brackets, the any-yaw
envelope (`validation/camera.ts`); the camera looks along the motion on the archived streams and
along the heading on the rotating ones.

The same suite on the TypeScript mover (`MOTION_VALIDATION_DRIVER=core`, 2026-10-22) passes every
threshold too, and every group prints the same numbers apart from the time per sample and the
deviation counts. That run only shows that the switch works; MOT-05b is the item that makes it
the suite's mover in CI.

## Rules

- **Do not edit `reference/` or `reference/archive/` to make a test pass.** The reference is the
  evidence ADR-0001 was decided on. A failing reproduction means the environment changed (the
  Rapier build, the Node version) or the code under `reference/` did.
- The archived numbers hold for Rapier 0.14.0 only. On another build the tests stop at the version
  check by design; the Rapier upgrade (MOT-16) decides how the suite is re-based (ADR-0004
  Decisions 3 and 6: Rapier updates wait for this suite).
- New cases go into `full/` (or `fast/` if they take seconds), not into `reference/`.

## Running

```
npm test                    # unit tests and the fast tier
npm run test:motion         # fast and full tier (about 2.5 min on the development PC)
MOTION_VALIDATION_DRIVER=core npm run test:motion   # Validation 1-5 on the TypeScript mover
npx vitest run --config test/motion/vitest.config.mjs test/motion/full/validation.walls.test.ts
cd test/motion/reference && TOP=4.15 MOVERS='[["U+RS",{"fix":true}]]' node t3_walls.mjs s1
```

The Validation tests print one line per group: runs, samples, wall time, the mover's time per
sample, and the group's measures (worst depth, retention, sideways range, eye and near-plane
clearance, deviations).

The reference scripts read the environment variables the study used: `TOP`, `MOVERS` (JSON
[name, options] pairs), `RAPIER` (path of another rapier3d-compat CommonJS entry), `KCCDEG` (test
hook in `lib/geom.mjs`), `EYE` and `ASPECT` (camera settings in `proxy/checks.mjs`);
`t3_walls.mjs` takes an optional section list (`s1,s2,s3,s3g`). `full/runReference.mjs` clears
them before setting the archived values.

Node runs the reference (`.mjs`) directly. TypeScript modules under `src/motion/` run under Vitest
until the owner decides how Node runs TypeScript (decision D4 of the phase-1 plan). They use
relative `.ts` imports and erasable syntax only, so Node 22.16.0 also runs them with
`--experimental-strip-types` (checked on 2026-10-09 with `src/motion/instantiate.ts`,
`src/motion/core.ts` and `src/motion/mover.ts`).

## Runtimes

Development PC (Intel Core i9-14900K, 32 logical CPUs, Windows 11 Pro, Node 22.16.0), 2026-10-09,
inside the end-to-end bench lock (no bench run in parallel; CPU load 3-9 % before and after):

| Run | Wall time |
|---|---|
| `npm test` (unit tests and fast tier) | 2.3 s (fast tier 1.3 s) |
| `npm run test:motion` (Vitest's default workers) | 95.5 s |
| the same with one worker (`--maxWorkers=1 --minWorkers=1`) | 175.1 s: t3 98.7 s, X11 73.6 s, fast tier 1.3 s |

With the TypeScript mover's comparisons (MOT-03), 2026-10-09, without the bench lock (other work
on the PC: CPU load 21-28 % around the cost run, 1 % right after the one-worker run):

| Run | Wall time |
|---|---|
| `npm test` (unit tests and fast tier) | 9.9 s (mover comparison 8.8 s) |
| `npm run test:motion` (Vitest's default workers) | 114.4 s |
| the same with one worker | 338.1 s: mover t3 112.5 s, t3 92.5 s, mover rooms 63.4 s, X11 57.5 s, fast tier 10.0 s |

With the fast tier's thin-wall group and the forced airborne undo added (same day, same
conditions): `npm test` 10.3 s (mover comparison 9.9 s), `npm run test:motion` 112.2 s.

With ADR-0001 Validation 1-5 (MOT-05a), 2026-10-22, same PC and Node. Every run below had a
window of its own, holding the worktrees' bench lock and the bench lock of
`test/e2e/lib/benchLock.mjs` (exclusive), with the machine load recorded before, during and after
(`tools/timing/machine-load.mjs`). Other work went on between the windows: CPU load before them
1.7-6.8 %, twice 12.6 % and 27.9 %; during them 5-15 % on average (the fast tier's driver test:
56 %, 5 s).

| Run | Wall time |
|---|---|
| `npm run test:motion`, one test file per logical CPU (32 here) | 146.8 s; 18 files, 87 tests; CPU load 38 % on average, 59 % at the 95th percentile |
| each file alone, one worker (sum) | 1,242.8 s (20.7 min): MOT-05a's files 901.4 s, the earlier ones 341.3 s |

Each file alone, one worker: fast tier `mover.equivalence` 10.8 s, `reference` 2.1 s,
`validation.driver` 5.3 s; full tier `mover.walls` 112.4 s, `t3_walls` 93.1 s, `mover.rooms`
64.4 s, `xanalytic` 58.5 s, `validation.inclined` 113.0 s, `validation.walls` 92.1 s,
`validation.floors` 51.0 s, and the soaks (archived / rotating): inclined room 126.3 / 121.7 s,
proxy room 80.5 / 77.6 s, cuboid room 66.9 / 65.0 s, trimesh room 50.9 / 51.1 s.

Per Validation group in those one-worker runs (archived / rotating stream): runs, samples, wall
time, and the reference mover's mean time per sample (the rest of the wall time is the measures):

| Group | Runs | Samples | Wall time, s | µs per sample |
|---|---|---|---|---|
| V1 long walls | 45 | 46,375 | 3.2 / 3.1 | 68.7 / 65.4 |
| V2 thin walls | 1,420 | 9,092 | 18.9 / 4.9 | 2,053.9 / 517.3 |
| V3 seams, T-junction, corner, wedges | 115 | 447,433 | 26.7 / 26.3 | 59.2 / 58.1 |
| V3 trimesh walls | 36 | 57,426 | 3.6 / 3.7 | 62.6 / 63.3 |
| V3 raised platform | 15 | 7,319 | 0.4 / 0.4 | 60.0 / 58.4 |
| V4 cuboid room, 20 / 120 / 250 samples/s | 4 each | 24,000 / 144,000 / 300,000 | 18.2, 20.8, 27.0 / 17.9, 21.0, 25.3 | 757.1, 143.3, 88.6 / 741.9, 144.4, 83.1 |
| V4 trimesh room | 4 each | as above | 14.0, 16.3, 19.7 / 14.0, 16.4, 19.9 | 582.3, 111.9, 64.5 / 580.6, 112.5, 65.0 |
| V5 inclined room | 4 each | as above | 24.9, 41.0, 59.5 / 23.1, 38.7, 59.1 | 913.7, 175.9, 97.2 / 849.0, 166.0, 96.2 |
| V5 proxy room | 4 each | as above | 19.9, 24.7, 35.0 / 19.4, 24.7, 32.7 | 806.1, 153.0, 95.8 / 783.1, 152.2, 89.9 |
| V5 t1 Part A | 33 | 21,450 | 2.7 / 2.6 | 25.3 / 24.2 |
| V5 t1 Part B | 588 | 231,868 | 12.1 / 12.0 | 50.8 / 50.4 |
| V5 t2 | 336 | 35,252 | 1.4 / 1.3 | 30.5 / 29.5 |
| V5 X1 | 1,302 | 176,555 | 40.2 / 39.8 | 49.4 / 48.5 |
| V5 t5 floors and drop | 96 | 26,134 | 0.3 / 0.3 | 9.7 / 8.5 |
| V5 t5 steps | 24 | 1,440 | 0.0 / 0.0 | 11.4 / 12.1 |
| V5 X3 ledge, steps under the overhang | 168 | 8,615 | 0.8 / 0.8 | 36.7 / 38.9 |
| V5 falls (t5 d, X7) | 153 | 15,222 | 1.6 / 1.8 | 28.1 / 37.8 |
| V5 railed ramps | 528 | 12,558 | 1.2 / 1.2 | 50.7 / 51.5 |
| V5 t7 census | 10 x 6,000 trials | 60,000 | 20.9 / 21.3 | 172.4 / 175.1 |

The thin walls' archived stream spends most of its time in the 7,187 undos of the uncapped
1,200-unit wall, outside R5.2. The time per sample is the reference's; the TypeScript mover's was
within 1 % of it in the cost table above.

GitHub-hosted runner: not measured yet. The owner relays the motion-suite job's time from the
first runs (plan item OA-17); it is informational. A runner runs as many files at a time as it has
logical CPUs (`vitest.config.mjs`), so with 4 CPUs it needs at least a quarter of the one-worker
sum at the development PC's speed per CPU (311 s), with 2 CPUs half (621 s); how much slower a
hosted runner's CPU is has not been measured.

## CI job `motion-suite`

Defined in `.github/workflows/ci.yml`, on `windows-latest` like the other jobs, with the same
pinned action versions. It runs on every push, pull request and manual run, and a step compares
the changed files with the base commit (the pull request's base, or the commit before the push).
It runs `npm run test:motion` only when one of these changed:

- `src/motion/**` (the motion module)
- `src/compiler/**` (all of the compiler: ADR-0001 names the compiler as a whole)
- `test/motion/**` (this suite)
- `package.json`, `package-lock.json` (Rapier and the other dependencies)
- `.github/workflows/ci.yml` (the job itself)

Without a base commit to compare with (manual run, first push of a branch, force push) it runs
the suite. When nothing relevant changed it passes without testing. The filter is a step and not
`on: paths` on purpose: a required check whose workflow is skipped by `on: paths` stays pending
and blocks the merge, so this way `motion-suite` can be made a required check of `main` (plan
item OA-04).

Timeout: 70 minutes, by the rule this job started with: three times the one-worker runtime above
(20.7 min with the Validation cases, so 62 min) plus about 5 minutes for checkout, Node setup and
`npm ci` (estimate), rounded up to 5 minutes. It was 15 minutes at first and 22 after the mover
comparisons (MOT-03). Revisit it when the hosted-runner times arrive. If the owner finds the job
too long for every motion change, the phase-1 plan's alternative is to run the soaks nightly,
which needs the owner's agreement and an amendment to ADR-0001 (Validation: the suite runs on
every change).
