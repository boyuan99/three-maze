// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: .claude/paper-review/proto/verify/inclined/mover_fix/lib/rooms.mjs in the design-review
//   workspace (on the development PC only, ignored by git). SHA-256
//   8c3466c76b9bc2cc9d58452fc1ab0d1dd645b6a1468e0ef6d58d538dd94f3c27, last modified 2026-10-07
//   16:10.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: The 13 inclined obstacles the study added to the soak room (t4 Part 2).
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// The inclined additions to the s4 soak room (t4 Part 2, t6): all pieces <= 40, placed in free parts of the room.
import { slab, sphere, cone } from './geom.mjs'
export function inclinedAdditions() {
  return [
    slab({ th: 35, fx: -70, fz: 5, hyaw: 0, W: 20, L: 10, T: 1 }),      // face towards +z; its underside is an overhang from behind
    slab({ th: 60, fx: -180, fz: -45, hyaw: 0, W: 12, L: 8, T: 1 }),    // face towards +z
    slab({ th: 75, fx: 50, fz: -35, hyaw: 90, W: 12, L: 10, T: 1 }),    // face towards +x
    slab({ th: 110, fx: 130, fz: -20, hyaw: -90, W: 15, L: 10, T: 1 }), // leaning over the -x side
    slab({ th: 135, fx: -160, fz: 15, hyaw: 0, W: 12, L: 8, T: 1 }),    // leaning over the +z side
    slab({ th: 45, fx: 60, fz: 5, hyaw: 0, W: 20, L: 7, T: 1 }), slab({ th: 45, fx: 60, fz: -5, hyaw: 180, W: 20, L: 7, T: 1 }), // ridge: two 45-deg faces crossing
    sphere(-60, 3, -15, 3), sphere(175, 10, -5, 10), sphere(-10, 0, 45, 10), sphere(-110, 25, 0, 25),
    cone(-130, -40, 10, 20, false, 256), cone(100, 45, 6, 12, true, 256),
  ]
}
