# Motion suite

Tests of the player's motion: the motion module (`src/motion/`), the physics side of the scene
compiler (`src/compiler/`) and the Rapier build they run on. [ADR-0001](../../docs/adr/0001-player-mover.md)
(Validation) asks for a CI gate that runs this suite "on every change to the motion module,
compiler or Rapier" (`docs/adr/0001-player-mover.md:81`). Roadmap phase 1 builds it up in steps:

| Item | Adds |
|---|---|
| MOT-01 (this folder's start) | the vendored reference mover, the two tiers, the CI job `motion-suite` |
| MOT-03 | `equivalence.ts`, `fast/mover.equivalence.test.ts`, `full/mover.walls.test.ts`, `full/mover.rooms.test.ts`: the TypeScript mover against the reference, sample for sample |
| MOT-05a | `full/`: ADR-0001 Validation 1-5 cases behind a mover interface, run on the reference |

The collider tests of `src/motion/instantiate.ts` (MOT-07), the tests of the motion core
`src/motion/core.ts` with movers that have no collisions (MOT-02) and the hover mover's own tests
(`src/motion/mover.ts`, MOT-03: eye height, falls, events, worker bundle) are ordinary unit tests
in `test/frontend/motion/`.

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
- `fast/`: the fast tier. `npm test` runs it with the unit tests (CI job `javascript`).
- `full/`: the long runs of the full tier.
- `vitest.config.mjs`: the full tier's configuration. `npm run test:motion` runs `fast/` and
  `full/` (CI job `motion-suite`).

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

The full hashes are in the headers. For every file except `xanalytic.mjs` they equal the hashes
the independent verification recorded for the files it re-ran (`verify/out/hashes_B_mover_fix.txt`,
`verify/out/hashes_A_proxy.txt`), so these are the versions behind the archived numbers.

`lib/hover.mjs` with `fix: true` and `top: 4.15` is the mover ADR-0001 adopts (variant U+RS:
R3, R4 and R6; cylinder top `eyeHeight` + 0.45). `fix: false` is the configuration the ADR first
adopted, kept for comparison. The study's `mover_fix/README.md` documents every option.
`proxy/` holds two files of approach A (compiler-side proxies, not adopted); only `xanalytic.mjs`
uses them, as an independently written second distance function.

### Archived outputs

| File | Source | SHA-256 | Written by |
|---|---|---|---|
| `t3_walls_top415_out.txt` | `mover_fix/out/t3_walls_top415_out.txt` | `4a1c6883bce8...` | `TOP=4.15 MOVERS='[["adopted",{"fix":false}],["U+RS",{"fix":true}]]' node t3_walls.mjs` (`mover_fix/run_all.sh`, run of 2026-10-07 20:58) |
| `X11_analytic_out.txt` | `verify/out/X11_analytic_out.txt` | `ec62eaad065f...` | `node xanalytic.mjs` (listed in the study's `verify/README.md`, "How to re-run"; output of 2026-10-07 21:58) |

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

**Full tier** (`full/`, about 5.6 minutes with one worker). Runs two study scripts unchanged in a
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
  with rotation cannot be compared this way: the reference has no heading. ADR-0001 Validation 1-5
  with rotating streams cover them (MOT-05a on the reference, MOT-05b on the TypeScript mover).
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
- Found while porting: the mover must not refresh the scene queries after adding its own
  collider. A refresh puts it into Rapier's query tree, which changes which of two contacts at the
  same distance a cast reports first at the seam of two flush pieces; with it, 80 of the 1,661 t3
  runs no longer matched, six of them in the fast tier's thin-wall group. No query of the mover
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
npm run test:motion         # fast and full tier (about 2 min on the development PC)
cd test/motion/reference && TOP=4.15 MOVERS='[["U+RS",{"fix":true}]]' node t3_walls.mjs s1
```

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

GitHub-hosted runner: not measured yet. The owner relays the motion-suite job's time from the
first runs (plan item OA-17); it is informational.

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

Timeout: 22 minutes, three times the one-worker runtime above (5.6 min, so 17 min) plus about
5 minutes for checkout, Node setup and `npm ci` (estimate). It was 15 minutes until the mover
comparisons (MOT-03) doubled the runtime. Revisit it when MOT-05a adds the Validation cases
(estimated 15-30 min in total, not measured) or when the hosted-runner times arrive.
