# ADR-0004: Pin exactly only the dependencies that change experimental behaviour; update everything through monthly, tested pull requests

- Status: Accepted (2026-10-08); amended 2026-10-09
- Date: 2026-10-08
- Deciders: project owner
- Related: [0001-player-mover.md](0001-player-mover.md) (Rapier, R2 and R8), [0003-render-worker-priority.md](0003-render-worker-priority.md) (Electron, version split)
- Roadmap: phase 0 (repository tidying); phase 1 (Rapier upgrade); the freeze from v1.0-rc, the first build allowed to collect paper data, until collection ends.

## Context

A *pin* names one exact version (`44.7.0`). A *caret range* (`^5.4.9`) accepts any later release with the same major version (for 0.x versions, the same minor). The *lockfile*, `package-lock.json`, records what was installed, and `npm ci` reproduces it, but a regenerated lockfile can move a package anywhere in its range. In an instrument, that can change the stimulus or the movement while three-maze's code stays the same. Examples from this repository:

- **Rapier** (physics): 0.14.0 ignores its slope limit for horizontal pushes, so a standing capsule climbs 35–60° faces under a 30° limit. Versions 0.15.0–0.21.0 apply the limit to upward faces only (ADR-0001, Risks and Evidence). Until 4eb0e60, `package.json` accepted any 0.14.x.
- **Electron** (windows and rendering): from Electron 42, offscreen pages are painted at a scale factor of 1 instead of the display's, so the test bench now passes the factor to keep its canvas size (e569144). The bench does not exercise full-screen display (`test/e2e/README.md`, Known limits), which the scene window uses, so an Electron upgrade also needs a check on the rig.
- **Security:** Electron 33 had reached end of life with known advisories, among them a bypass of context isolation; phase 0 replaced it with 44.7.0 (cf87c04).

pip has no lockfile, so `requirements.txt` already pins every backend runtime package exactly, including the packages nidaqmx pulls in (b37ff0e).

## Decision drivers

- Every session's renderer, physics and backend versions are known, and stay the same while paper data are collected.
- The project does not fall behind: one maintainer cannot afford large, forced jumps such as Electron 33 → 44.
- Updates arrive tested, with little manual work.

## Considered options

a. **Pin everything, update by hand.** Reproducible, but nothing prompts an update, so versions fall behind until a security problem forces a large jump.

b. **Caret ranges for everything, plus the lockfile.** Current, but a regenerated lockfile or `npm update` can change the renderer or the physics without anyone noticing (Context).

c. **Chosen:** pins for the behaviour-critical dependencies, ranges plus the lockfile for the rest, monthly tested pull requests, and a freeze while paper data are collected.

## Decision

1. **Exact pins** for what changes experimental behaviour: `electron`, `@dimforge/rapier3d-compat`, `three` and `ajv` (Ajv 8) in `package.json`, and every package in `requirements.txt`, `jsonschema` among them (amended 2026-10-09). Session records are to include the renderer and physics versions (ADR-0001 R5 item 5; ADR-0003 Decision 3).
2. **Caret ranges plus the lockfile** for the rest of `package.json`: development tools (TypeScript, Vitest, Vite, @types/node, electron-builder and the like) and user-interface libraries such as Vue. `requirements-dev.txt` pins pytest exactly, because pip has no lockfile.
3. **Monthly updates.** Dependabot, GitHub's dependency-update service, opens pull requests once a month for npm, pip and GitHub Actions, for releases at least 7 days old (`.github/dependabot.yml`). Each behaviour-critical dependency arrives alone; the rest arrive grouped (for npm, minor and patch releases in one pull request, major releases in another). Continuous integration (CI) tests every pull request, and the owner merges only when it passes. Behaviour-critical updates also need checks that CI does not run: `npm run test:e2e` (Electron, three.js), ADR-0003's tests 1 and 5 and its gate once phase 1 builds them (Electron), and ADR-0001's Validation suite (Rapier, R2). Rapier pull requests wait until that suite exists (phase 1).
4. **Security fixes promptly**, outside the schedule, as with Electron 33 → 44.7.0. Dependabot security updates, a repository setting, open these pull requests when GitHub raises an alert.
5. **Freeze while paper data are collected.** From v1.0-rc until collection ends, the behaviour-critical dependencies stay as they are: the commented FREEZE entries in `dependabot.yml` are switched on. Afterwards they are upgraded together.
6. **Rapier in phase 1.** Rapier is upgraded to the then-latest version, validated by ADR-0001's Validation suite (with R3's slope settings for that version), and pinned again.

**Amendment 2026-10-09.** In item 1, "`electron`, `@dimforge/rapier3d-compat` and `three` in `package.json`, and every package in `requirements.txt`" is replaced by "`electron`, `@dimforge/rapier3d-compat`, `three` and `ajv` (Ajv 8) in `package.json`, and every package in `requirements.txt`, `jsonschema` among them". Phase 1 adds two JSON Schema validators: Ajv 8 for the motion worker and the Node tools, jsonschema for the Python rig runtime. Between them they decide which experiment files, rig files and link-protocol messages are accepted, so another release could accept a file that this one rejects, or the reverse, while three-maze's code stays the same. Both are therefore behaviour-critical, as the first item of When to revisit asks. Ajv is a direct dependency pinned exactly, kept out of both Dependabot groups so that its updates arrive alone (item 3), and given a FREEZE entry with the others (item 5). jsonschema is pinned exactly in `requirements.txt` with the packages it pulls in, and like every pin there it arrives alone and is frozen with the rest. The pins are made by 57a9752 (Ajv 8.20.0 and jsonschema 4.26.0, branch `p1/link-protocol-v1`) and 40ecc95 (the same `requirements.txt` lines, branch `p1/rig-runtime-skeleton`). This is option a of the phase-1 plan's decision D3, the plan's recommendation, applied by default on 2026-10-09 because the owner's answers of that day did not cover D3 (three-maze-notes `plan/phase1-plan.md`, D3; decision log `docs-site/docs/project/decisions.md`, defaults the owner may overturn, item 25). The project owner approves it by merging this amendment and may overturn it before. The third part of D3 a, @types/three 0.169.x, affects type checking only and stays a development tool under item 2. The decision itself (option c) is unchanged.

## Consequences

*Positive:* every session's renderer, physics and backend versions are known and reproducible; tools stay current with little effort; CI catches a broken update before it reaches the rig.

*Negative:* monthly pull requests to review; behaviour-critical updates need local tests, since CI runs the end-to-end bench only when started by hand; Rapier pull requests wait for phase 1. Dependabot labels per ecosystem, not per dependency: behaviour-critical pull requests are the ungrouped ones, named in the title.

*Risk:* a security advisory against a frozen dependency during collection. Upgrading then splits the data by version (ADR-0003, Risks), so the owner decides and records why.

## Validation

- `.github/dependabot.yml` parses and matches SchemaStore's public `dependabot-2.0` schema, with and without the FREEZE entries (2026-10-08). It takes effect once it is on the default branch on GitHub.
- CI (`.github/workflows/ci.yml`) runs on every Dependabot pull request.
- After the first monthly run, check that an npm major update (for example Vite 5 → 8) arrives in the `tools-major` pull request, not in `tools`.

## When to revisit

- Another dependency turns out to change behaviour: pin it and keep it out of the groups. For example Vue, if v0.3's scene, which updates Vue on every frame (ADR-0003, Context), still collects paper data at v1.0-rc; v1.0 takes Vue off the frame path (ADR-0003 Decision b).
- Electron 44 leaves Electron's support window (the latest three major versions) before collection ends.
- Too many pull requests each month, or Dependabot adds labels per dependency.

## Evidence

1. Rapier slope limit, 0.14.0 against 0.15.0–0.21.0: ADR-0001, Risks and Evidence.
2. Commits: 4eb0e60 (Rapier pinned to 0.14.0), cf87c04 (Electron 33 → 44.7.0 and the reasons), e569144 (bench adapted to Electron 42's offscreen scale factor), b37ff0e (backend pins).
3. Packaging: with electron-builder 26.17.0, `npm run electron:build -- --dir` builds `release/win-unpacked/three-maze.exe` on Electron 44.7.0 without compiling native modules (2026-10-08). With electron-builder 25 it failed: its @electron/rebuild 3.6.1 did not recognise the prebuilt binary of the unused `serialport` package and fell back to compiling it with node-gyp 9, which needs Python's `distutils`, removed in Python 3.12.
