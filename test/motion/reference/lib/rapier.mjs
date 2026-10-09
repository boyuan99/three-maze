// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/mover_fix/lib/rapier.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   6344cf515e714fe133857bf2b536efdfcf7779a545938181158a416f3149477b, last modified 2026-10-07
//   20:11.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: The Rapier loader of every reference script (env RAPIER selects another build).
// Changes from the source: RAPIER_PATH defaults to require.resolve('@dimforge/rapier3d-compat'),
//   the CommonJS entry of the build installed in this repository, instead of an absolute path to
//   rapier.cjs.js in the development PC's checkout. Both are the pinned 0.14.0.
// -------------------------------------------------------------------------------------------------
// Rapier loader for every script in this folder: env RAPIER = path of a rapier3d-compat CommonJS entry (another build,
// e.g. 0.19.3 or 0.21.0 unpacked from the npm cache, see README); default = the repo's pinned 0.14.0, loaded the way
// adjudicator/common.mjs loads it (the same file, so both share one module instance under Node's require cache).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
export const RAPIER_PATH = process.env.RAPIER || require.resolve('@dimforge/rapier3d-compat')
export const R = require(RAPIER_PATH)
const warn = console.warn; console.warn = (...a) => { if (!String(a[0]).includes('deprecated parameters')) warn(...a) }
await R.init()
console.warn = warn
export const RAPIER_VERSION = R.version()
// 0.14.0 has world.updateSceneQueries(); 0.19+ dropped it (a step refreshes the broad phase used by queries)
export const refreshQueries = (w) => (typeof w.updateSceneQueries === 'function' ? w.updateSceneQueries() : w.step())
