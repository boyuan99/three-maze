// Hover mover (ADR-0001 R3, R4, R6): Rapier's kinematic character controller (KCC) slides an
// upright cylinder that floats one step height above the floor; a ground ray sets the height.
// It is the motion core's mover (./core.ts) on a world built by instantiate() (./instantiate.ts).
//
// A port of the adopted prototype, the vendored reference test/motion/reference/lib/hover.mjs with
// fix: true (variant U+RS: wall rule, recovery, steep-floor slide), restructured into one call per
// horizontal sub-step and one airborne sweep per sample so that the core can turn each sub-step by
// its own heading. Every floating-point operation is kept in the reference's order: for samples
// without rotation the poses equal the reference's bit for bit on Rapier 0.14.0
// (test/motion/fast/mover.equivalence.test.ts), which is what keeps the archived evidence behind
// ADR-0001 valid for this code. Change nothing here without re-running that test.
//
// Dropped from the reference: the configuration the ADR first adopted (fix: false) and the
// options it never adopted (sep 'mixed', retry, allWalls false, recoverVia). Added: events and
// the contact flag for the motion core, which only read the mover's state, and fall 'none'
// (ADR-0001 R4), which the reference does not have and which changes nothing unless chosen.
import type {
  CharacterCollision, Collider, KinematicCharacterController, World,
} from '@dimforge/rapier3d-compat'
import type { Mover, MoverEvent } from './core.ts'
import { GROUPS } from './instantiate.ts'
import type { Rapier } from './instantiate.ts'
import { slopeAngles } from './rapierCompat.ts'

/** Agent radius, step height (cylinder bottom above the feet), skin (KCC offset); ADR-0001 R3. */
export const RADIUS = 0.5
export const STEP_HEIGHT = 0.3
export const SKIN = 0.02
/** The cylinder's top is this far above the eye (ADR-0001 R3). */
export const TOP_ABOVE_EYE = 0.45

export interface HoverOptions {
  /** Feet at (x, z) on the floor near feetY at the start; defaults 0. */
  x?: number
  z?: number
  feetY?: number
  /** Eye above the feet, from the rig file (ADR-0001 R3); default 3.7. */
  eyeHeight?: number
  /** Gravity along +Y in units/s², the scene's (ADR-0001 R3); default -981. */
  gravity?: number
  /**
   * Where the ground ray finds no floor (ADR-0001 R4): 'gravity' (default) makes the agent
   * airborne and it falls; 'none' rejects the sub-step, as a floor too high does, so the agent
   * stops at the edge. R4 calls the edge "a wall" in this mode, but a ray that finds nothing
   * gives no face to slide along: pushed against the edge at any angle, the agent stops instead
   * of sliding along it as it does along a wall. Not part of the archived evidence (the reference
   * has no 'none').
   */
  fall?: 'gravity' | 'none'
}

/**
 * Counters, named as in the reference's `st` so that runs compare one to one with it and with the
 * study's outputs.
 */
export interface HoverStats {
  /** Horizontal sub-steps; KCC calls (horizontal and airborne). */
  sub: number
  calls: number
  /** KCC wall contacts that took the wall rule ("fix contacts"); sub-steps that had one. */
  incl: number
  inclSub: number
  /** Sub-steps whose remainder was dropped after the sixth KCC call. */
  itCap: number
  /** Sub-steps the ground ray rejected: floor steeper than 30 degrees, over 0.3 higher, none. */
  raySteep: number
  rayHigh: number
  rayNone: number
  /** Steep-floor slides (R4) and those the ray rejected again. */
  raySlides: number
  raySlideStops: number
  /** Guard hits redone as recoveries (R6), those that came out clear, and hits without a wall. */
  recoveries: number
  recoverOk: number
  recoverNoWall: number
  /** Source of each recovery wall normal: contact query, point projection, sub-step direction. */
  recoverByContact: number
  recoverByProjection: number
  recoverByDirection: number
  /** Guard undos (R6) of any kind, and those after an airborne sweep. Expected: zero. */
  reverts: number
  airReverts: number
  /** Airborne sweeps that met a wall face, and those cut at a walkable contact after it. */
  airIncl: number
  airClip: number
  fallStarts: number
  lands: number
  /** Sub-steps by their number of KCC calls (index 8: eight or more). */
  kccCallsHist: number[]
}

export interface HoverMover extends Mover {
  readonly stats: Readonly<HoverStats>
  /** Height of the cylinder's top above the feet: eyeHeight + 0.45. */
  readonly top: number
  readonly eyeHeight: number
  /** The agent's collider (groups GROUPS.agent). */
  readonly collider: Collider
  /** Removes the agent's collider and controller from the world. */
  free(): void
}

type Planes = number[] // wall planes h as [hx0, hz0, hx1, hz1, ...]
type Ground = [number, number, number, boolean, number] // x, z, feet, airborne, vy

/**
 * Adds the agent to `world` (a query world from instantiate(), or any world whose solid
 * colliders accept GROUPS.agent) and returns its mover. `R` must be initialised.
 */
export function createHoverMover(R: Rapier, world: World, options: HoverOptions = {}): HoverMover {
  const w = world
  const x = options.x ?? 0, z = options.z ?? 0
  const eyeHeight = options.eyeHeight ?? 3.7
  const g = options.gravity ?? -981
  const fallNone = (options.fall ?? 'gravity') === 'none'
  if (![x, z, options.feetY ?? 0, eyeHeight, g].every(Number.isFinite)) {
    throw new TypeError('hover mover: x, z, feetY, eyeHeight and gravity must be finite')
  }
  if (eyeHeight + TOP_ABOVE_EYE <= STEP_HEIGHT) {
    throw new TypeError('hover mover: eyeHeight too low')
  }
  const slope = slopeAngles(R.version())

  const r = RADIUS, stepH = STEP_HEIGHT, skin = SKIN
  const top = eyeHeight + TOP_ABOVE_EYE
  const hh = (top - stepH) / 2, f2c = stepH + hh // half height; feet to the cylinder's centre
  const groups = GROUPS.agent, flags = R.QueryFilterFlags.EXCLUDE_SENSORS
  const cos30 = Math.cos(Math.PI / 6) - 1e-6 // walkable: n_y >= cos30
  const epsH = 1e-3 // a wall needs a horizontal normal part above this
  const sepDist = 0.01 // step-off distance from a wall face (R4)
  const maxCalls = 6 // KCC calls per horizontal sub-step (R4)
  const recoverDist = 0.5 // prediction distance of the recovery's contact query (R6)

  const col = w.createCollider(R.ColliderDesc.cylinder(hh, r)
    .setTranslation(x, (options.feetY ?? 0) + f2c, z).setCollisionGroups(groups))
  const k: KinematicCharacterController = w.createCharacterController(skin)
  k.setSlideEnabled(true)
  k.setNormalNudgeFactor(0.01)
  k.setUp({ x: 0, y: 1, z: 0 })
  k.disableAutostep()
  k.disableSnapToGround()
  k.setMaxSlopeClimbAngle(slope.climb)
  k.setMinSlopeSlideAngle(slope.slide)
  // No refreshQueries() for the agent's own collider, unlike the scene colliders (ADR-0001 R1):
  // every query of the mover excludes it, and zone probes do not meet its groups, so no query
  // needs it. A refresh would add it to Rapier's query tree, and that changes which of two
  // contacts at the same distance a cast reports first, at the seam of two flush wall pieces:
  // with a refresh here, 80 of the 1,661 runs of the wall study t3 no longer matched the
  // reference bit for bit (measured 2026-10-09 on 0.14.0; the fast tier's group 'thin' fails).
  const guard = new R.Cylinder(hh, r - skin) // R6: the cylinder shrunk to radius 0.48
  const agentShape = new R.Cylinder(hh, r)
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const rot = { x: 0, y: 0, z: 0, w: 1 }
  const cc: CharacterCollision = new R.CharacterCollision()
  const st: HoverStats = {
    sub: 0, calls: 0, incl: 0, inclSub: 0, itCap: 0, raySteep: 0, rayHigh: 0, rayNone: 0,
    raySlides: 0, raySlideStops: 0, recoveries: 0, recoverOk: 0, recoverNoWall: 0,
    recoverByContact: 0, recoverByProjection: 0, recoverByDirection: 0, reverts: 0,
    airReverts: 0, airIncl: 0, airClip: 0, fallStarts: 0, lands: 0,
    kccCallsHist: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  }
  // Committed state
  let p = { x, z }, feet = 0, vy = 0, air = false
  // Contact flags: during the current sample, and of the last completed one
  let touched = false, contact = false

  // Ground ray from feet + stepH + 0.001 down to feet - below (R4)
  const probe = (px: number, fy: number, pz: number, below = stepH) => {
    ray.origin = { x: px, y: fy + stepH + 1e-3, z: pz }
    const h = w.castRayAndGetNormal(ray, stepH + below + 1e-3, true, flags, groups, col)
    return h
      ? { y: fy + stepH + 1e-3 - h.timeOfImpact, ny: h.normal.y, nx: h.normal.x, nz: h.normal.z }
      : null
  }
  // Overlap guard (R6): the shrunk cylinder at feet fy intersects a solid collider
  const hit = (px: number, fy: number, pz: number) => !!w.intersectionWithShape(
    { x: px, y: fy + f2c, z: pz }, rot, guard, flags, groups, col)

  // Recovery (R6): wall planes from the colliders the guard found at the candidate pose
  // (cx, cf, cz), with normals taken at the committed pose
  function missedWalls(cx: number, cf: number, cz: number, dirX: number, dirZ: number): Planes {
    const cand = { x: cx, y: cf + f2c, z: cz }, at = { x: p.x, y: feet + f2c, z: p.z }
    const planes: Planes = []
    const add = (nx: number, ny: number, nz: number) => {
      const hl = Math.hypot(nx, nz)
      if (ny < cos30 && hl > epsH) planes.push(nx / hl, nz / hl)
    }
    w.intersectionsWithShape(cand, rot, guard, (c) => {
      // (1) closest-point contact of the r 0.5 cylinder at the committed pose
      const ct = c.contactShape(agentShape, at, rot, recoverDist)
      if (ct) {
        add(ct.normal1.x, ct.normal1.y, ct.normal1.z)
        st.recoverByContact++
        return true
      }
      // (2) the nearest projection of three points on the agent's axis
      let best: { d: number, n: [number, number, number] } | null = null
      for (const y of [feet + stepH, feet + f2c, feet + top]) {
        const q = { x: p.x, y, z: p.z }, pr = c.projectPoint(q, false)
        if (pr && !pr.isInside) {
          const d = Math.hypot(q.x - pr.point.x, q.y - pr.point.y, q.z - pr.point.z)
          if (d > 1e-9 && (!best || d < best.d)) {
            const n: [number, number, number] =
              [(q.x - pr.point.x) / d, (q.y - pr.point.y) / d, (q.z - pr.point.z) / d]
            best = { d, n }
          }
        }
      }
      if (best) {
        add(best.n[0], best.n[1], best.n[2])
        st.recoverByProjection++
        return true
      }
      // (3) the reverse of the sub-step direction
      const dl = Math.hypot(dirX, dirZ)
      if (dl > 1e-12) {
        planes.push(-dirX / dl, -dirZ / dl)
        st.recoverByDirection++
      }
      return true
    }, flags, groups, col)
    return planes
  }

  // First wall contact of the last KCC call (R3: n_y < cos 30 and |n_h| > 1e-3), left in cc
  function firstWall(): boolean {
    const nc = k.numComputedCollisions()
    for (let i = 0; i < nc; i++) {
      k.computedCollision(i, cc)
      const n = cc.normal1
      if (n.y >= cos30) continue
      if (Math.hypot(n.x, n.z) <= epsH) continue
      return true
    }
    return false
  }

  // One horizontal move by (dx, dz) from (sx, sz) at the current feet, with the wall rule (R4);
  // preset: wall planes known before the first call (steep-floor slide, recovery). Returns the
  // end point; the collider is back at the committed pose afterwards.
  function horizontal(
    dx: number, dz: number, sx = p.x, sz = p.z, preset: Planes | null = null,
  ): [number, number] {
    let cx = sx, cz = sz, rx = dx, rz = dz, calls = 0, moved = sx !== p.x || sz !== p.z
    let incl = false
    const planes: Planes = []
    const call = (mx: number, mz: number) => {
      if (calls > 0 || moved) {
        col.setTranslation({ x: cx, y: feet + f2c, z: cz })
        moved = true
      }
      k.computeColliderMovement(col, { x: mx, y: 0, z: mz }, flags, groups)
      st.calls++
      calls++
    }
    // Removes the remainder's components into every wall plane; drops it if it still points
    // into one (a corner)
    const project = () => {
      for (let q = 0; q < planes.length; q += 2) {
        const d = rx * planes[q] + rz * planes[q + 1]
        if (d < 0) {
          rx -= d * planes[q]
          rz -= d * planes[q + 1]
        }
      }
      for (let q = 0; q < planes.length; q += 2) {
        if (rx * planes[q] + rz * planes[q + 1] < -1e-9) {
          rx = 0
          rz = 0
          break
        }
      }
    }
    // A step-off call (or the end of a cut call) keeps the movement up to its first wall
    const keepToFirstWall = () => {
      if (firstWall()) {
        const a2 = cc.translationDeltaApplied
        cx += a2.x
        cz += a2.z
      } else {
        const ms = k.computedMovement()
        cx += ms.x
        cz += ms.z
      }
    }
    if (preset && preset.length) { // as after a wall contact at the start
      let ex = 0, ez = 0
      for (let q = 0; q < preset.length; q += 2) {
        planes.push(preset[q], preset[q + 1])
        ex += preset[q]
        ez += preset[q + 1]
      }
      project()
      const el = Math.hypot(ex, ez)
      if (el > 1e-6) {
        call((sepDist * ex) / el, (sepDist * ez) / el)
        keepToFirstWall()
      }
      if (Math.hypot(rx, rz) < 1e-9 && calls === 0) return [cx, cz]
    }
    for (;;) {
      if (calls > 0 && Math.hypot(rx, rz) < 1e-9) break
      if (calls >= maxCalls) {
        st.itCap++
        break
      }
      call(rx, rz)
      if (!firstWall()) {
        const m = k.computedMovement()
        cx += m.x
        cz += m.z
        rx = 0
        rz = 0
        break
      }
      st.incl++
      incl = true
      touched = true
      // keep the movement up to the wall, slide the remainder along it
      const a = cc.translationDeltaApplied, rem = cc.translationDeltaRemaining, n = cc.normal1
      cx += a.x
      cz += a.z
      const hl = Math.hypot(n.x, n.z), hx = n.x / hl, hz = n.z / hl
      rx = rem.x
      rz = rem.z
      planes.push(hx, hz)
      project()
      // step off the face first, so that the slide does not start at the skin distance
      if (calls >= maxCalls) {
        st.itCap++
        break
      }
      call(sepDist * hx, sepDist * hz)
      keepToFirstWall()
    }
    st.kccCallsHist[Math.min(calls, 8)]++
    if (incl) st.inclSub++
    if (moved) col.setTranslation({ x: p.x, y: feet + f2c, z: p.z })
    return [cx, cz]
  }

  // Horizontal normal of the steep floor that made the last groundAt() reject its candidate
  let steepN: [number, number] | null = null
  // The ground under a candidate (nx, nz) of a grounded agent (R4): the candidate with its feet,
  // or the committed pose if the floor there is too high, too steep or (fall 'none') missing
  const groundAt = ([nx, nz]: [number, number]): Ground => {
    let nf = feet, nair = air, nvy = vy
    steepN = null
    if (!air) {
      const gd = probe(nx, feet, nz)
      if (gd && (gd.y - feet > stepH + 1e-6 || gd.ny < cos30)) {
        nx = p.x
        nz = p.z
        touched = true
        if (gd.ny < cos30) {
          st.raySteep++
          const hl = Math.hypot(gd.nx, gd.nz)
          if (hl > epsH) steepN = [gd.nx / hl, gd.nz / hl]
        } else st.rayHigh++
      } else if (gd) nf = gd.y
      else if (fallNone) {
        nx = p.x
        nz = p.z
        touched = true
        st.rayNone++
      } else {
        nair = true
        nvy = 0
      }
    }
    return [nx, nz, nf, nair, nvy]
  }

  function subStep(dx: number, dz: number, n: number, emit: (event: MoverEvent) => void): void {
    st.sub++
    let [nx, nz, nf, nair, nvy] = groundAt(horizontal(dx / n, dz / n))
    if (steepN) {
      // the steep floor is a wall facing the agent: h, or -h when the input runs along h (a
      // slope going down away from the agent)
      st.raySlides++
      const hw = (dx * steepN[0] + dz * steepN[1] > 0) ? [-steepN[0], -steepN[1]] : steepN
      ;[nx, nz, nf, nair, nvy] = groundAt(horizontal(dx / n, dz / n, p.x, p.z, hw))
      if (steepN) st.raySlideStops++
    }
    if (hit(nx, nf, nz)) {
      touched = true
      let ok = false
      // redo once with the walls the guard found
      const planes = missedWalls(nx, nf, nz, dx / n, dz / n)
      if (planes.length) {
        st.recoveries++
        ;[nx, nz, nf, nair, nvy] = groundAt(horizontal(dx / n, dz / n, p.x, p.z, planes))
        ok = !hit(nx, nf, nz)
        if (ok) st.recoverOk++
        emit({ type: 'guard_recovery', ok, x: nx, feetY: nf, z: nz })
      } else st.recoverNoWall++
      if (!ok) {
        st.reverts++
        emit({ type: 'guard_undo', kind: 'sub', x: nx, feetY: nf, z: nz })
        return
      }
    }
    if (nair && !air) {
      st.fallStarts++
      emit({ type: 'fall_start' })
    }
    p = { x: nx, z: nz }
    feet = nf
    air = nair
    vy = nvy
    col.setTranslation({ x: p.x, y: feet + f2c, z: p.z })
  }

  // Once per sample: gravity and the vertical sweep of an airborne agent (R4)
  function endSample(dt: number, emit: (event: MoverEvent) => void): void {
    if (air) {
      vy += g * dt
      k.computeColliderMovement(col, { x: 0, y: vy * dt, z: 0 }, flags, groups)
      st.calls++
      const m = k.computedMovement()
      let nx = p.x, nz = p.z, nf = feet + m.y
      if (firstWall()) {
        // keep the 3-D slide off the wall face, but stop it at the first walkable contact after
        st.airIncl++
        touched = true
        let mv = m, seenWall = false
        for (let i = 0; i < k.numComputedCollisions(); i++) {
          k.computedCollision(i, cc)
          const n = cc.normal1
          if (n.y >= cos30) {
            if (seenWall) {
              mv = cc.translationDeltaApplied
              st.airClip++
              break
            }
          } else if (Math.hypot(n.x, n.z) > epsH) seenWall = true
        }
        nx += mv.x
        nz += mv.z
        nf = feet + mv.y
      }
      const land = probe(nx, nf, nz, 0)
      let nair = true, nvy = vy
      if (land && vy <= 0 && land.ny >= cos30) {
        nair = false
        nvy = 0
        nf = land.y
      }
      if (hit(nx, nf, nz)) {
        // Undone. vy keeps this sample's gravity, as in the reference, although ADR-0001 R6 lists
        // vy among the values an undo restores (compared on forced undos only:
        // test/motion/full/mover.rooms.test.ts)
        st.reverts++
        st.airReverts++
        touched = true
        emit({ type: 'guard_undo', kind: 'air', x: nx, feetY: nf, z: nz })
      } else {
        if (!nair) {
          st.lands++
          emit({ type: 'land' })
        }
        p = { x: nx, z: nz }
        feet = nf
        air = nair
        vy = nvy
        col.setTranslation({ x: p.x, y: feet + f2c, z: p.z })
      }
    }
    contact = touched
    touched = false
  }

  // Teleport: feet on the floor within 0.3 of fy at (nx, nz), or at fy if there is none. A ray
  // that starts inside a solid hits at once and puts the feet 0.301 above fy, inside it
  function place(nx: number, nz: number, fy: number): void {
    p = { x: nx, z: nz }
    const gd = probe(nx, fy, nz)
    feet = gd ? gd.y : fy
    vy = 0
    air = false
    col.setTranslation({ x: nx, y: feet + f2c, z: nz })
  }

  place(x, z, options.feetY ?? 0)
  return {
    get x() { return p.x },
    get feetY() { return feet },
    get z() { return p.z },
    get airborne() { return air },
    get contact() { return contact },
    get stats() { return st },
    top,
    eyeHeight,
    collider: col,
    subStep,
    endSample,
    place,
    free() {
      w.removeCharacterController(k)
      w.removeCollider(col, false)
    },
  }
}
