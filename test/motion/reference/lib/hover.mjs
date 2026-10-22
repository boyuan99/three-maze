// -------------------------------------------------------------------------------------------------
// VENDORED REFERENCE: test code, not shipped in the application. Do not edit it to make a test
//   pass; see test/motion/README.md.
// Source: proto/verify/inclined/mover_fix/lib/hover.mjs in the separate three-maze-notes
//   repository (design-review workspace). SHA-256
//   49244bfe8c2bb0afdb02e57715f5b7d256233ec10d36294b8c1fabbb55a233e7, last modified 2026-10-07
//   20:44.
// Copied: 2026-10-09 (roadmap phase 1, MOT-01).
// What it is: The body-less hover mover of the inclined-face study, one move() call per device
//   sample. `fix: true` (variant U+RS: wall rule, recovery, steep-floor slide) with `top: 4.15`
//   (eyeHeight 3.7 + 0.45) is the mover ADR-0001 adopts (R3, R4, R6); `fix: false` is the
//   configuration the ADR first adopted. The TypeScript mover (MOT-03) must reproduce it bit for
//   bit on Rapier 0.14.0.
// Changes from the source: none (only this header was added).
// -------------------------------------------------------------------------------------------------
// Body-less hover mover, per device sample (ADR-0001 R1, R3, R4, R6), with the fix for inclined faces.
//
// fix: false  -> the adopted configuration, a line-for-line port of out/2026-10-07-rev/composite.mjs makeComposite
//                (t4 Part 1 reproduces composite_out.txt exactly: KCC calls, reverts, worst depth, path efficiency).
// fix: true   -> the "horizontal-wall rule" (this study; defaults = the recommended variant U+RS = U with recover and
//                slideSteep; recover: false, slideSteep: false = the first attempt's U):
//   H. Horizontal sub-step, at most maxCalls (6) KCC calls. After each call, scan its collisions in order. A WALL
//      contact has an obstacle normal n1 with n_y < cos 30 deg (not walkable) and a horizontal part |n_h| > epsH
//      (1e-3): vertical walls, faces steeper than 30 deg, sides of spheres and cones, faces leaning over the agent.
//      (Variant T, allWalls false, also requires |n_y| > epsV and leaves near-vertical contacts to the KCC.)
//      No wall contact: keep the call's horizontal movement; done. Otherwise: move by the horizontal part of the
//      first wall contact's translationDeltaApplied (the KCC stopped there at the skin), take its
//      translationDeltaRemaining (horizontal part), remove its component into h = n_h/|n_h| and into the h of every
//      earlier wall contact of this sub-step (still pointing into one of them -> zero), then (sep 'separate', the
//      default) one KCC call of sepDist (0.01) * h steps off the face (cut at its own first wall contact if any) and
//      the next call moves the projected remainder; (sep 'mixed') hNudge * h is added to the remainder instead.
//      A remainder left after the last call is dropped (counted as itCap).
//      Why 'separate': a re-run that starts exactly at the skin distance and moves parallel to the face gets toi-0
//      contacts whose normals Rapier tilts by up to ~9 degrees, which threw the agent 0.03-0.05 off the face
//      (cmp_variants: wobble 0.107 mixed 0.01, 0.031 separate 0.01).
//   A. Airborne vertical sweep (once per sample): if the sweep's collisions include a wall contact, the KCC's 3-D
//      result is kept (it slides off the face instead of having its horizontal part discarded), cut at the first
//      walkable contact that follows (translationDeltaApplied) so the slide does not run on along the floor; a
//      landing needs a walkable floor (ray normal n_y >= cos 30 deg).
//   R. recover (default = fix; added by the second attempt): a sub-step the guard rejects is redone once, treating
//      the colliders the guard found as wall contacts at the start of the sub-step (see missedWalls below); only a
//      second guard hit undoes it.
//   S. slideSteep (default = fix; second attempt): a sub-step that the ground ray rejects because the floor under the
//      candidate axis is steeper than 30 deg is redone once with that floor's horizontal normal as a wall facing the
//      agent (h, or -h when the input runs along h; rule H with a preset plane), instead of being a dead stop.
//   retry (default false, not recommended): a guard-rejected sub-step is retried once as two half moves; probe_retry
//      showed it can accept a pose 0.02 inside a ball after a second cast miss.
// Everything else (ground ray, step limit, slope rejection, guard, gravity) is the adopted code. top (default 2.0)
// sets the cylinder's top above the feet; its bottom stays at stepH = 0.3.
export function makeHover(R, w, x, z, o = {}) {
  const fix = !!o.fix
  const r = 0.5, stepH = 0.3, skin = 0.02, g = o.g ?? -981
  const top = o.top ?? 2.0
  const hh = top === 2.0 ? 0.85 : (top - stepH) / 2, f2c = top === 2.0 ? 1.15 : stepH + hh
  const grp = (m, f) => ((m << 16) | f) >>> 0
  const groups = grp(4, 1 | 2), flags = R.QueryFilterFlags.EXCLUDE_SENSORS, cos30 = Math.cos(Math.PI / 6) - 1e-6
  const col = w.createCollider(R.ColliderDesc.cylinder(hh, r).setTranslation(x, f2c, z).setCollisionGroups(groups))
  const k = w.createCharacterController(skin); k.setSlideEnabled(true); k.setNormalNudgeFactor(0.01); k.setUp({ x: 0, y: 1, z: 0 })
  k.disableAutostep(); k.disableSnapToGround(); k.setMaxSlopeClimbAngle(Math.PI / 6); k.setMinSlopeSlideAngle(Math.PI / 6)
  const guard = new R.Cylinder(hh, r - skin), ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }), rot = { x: 0, y: 0, z: 0, w: 1 }
  const probe = (px, fy, pz, below = stepH) => { ray.origin = { x: px, y: fy + stepH + 1e-3, z: pz }
    const h = w.castRayAndGetNormal(ray, stepH + below + 1e-3, true, flags, groups, col); return h ? { y: fy + stepH + 1e-3 - h.timeOfImpact, ny: h.normal.y, nx: h.normal.x, nz: h.normal.z } : null }
  const hit = (px, fy, pz) => !!w.intersectionWithShape({ x: px, y: fy + f2c, z: pz }, rot, guard, flags, groups, col)
  const epsV = o.epsV ?? 1e-4, epsH = o.epsH ?? 1e-3, hNudge = o.hNudge ?? 0.01
  // sep: 'mixed'    -> the horizontal nudge is added to the projected remainder (one re-run KCC call);
  //      'separate' -> first a KCC call of sepDist * h alone (moves off the face), then the projected remainder.
  const sep = o.sep ?? 'separate', sepDist = o.sepDist ?? 0.01
  const maxCalls = o.maxCalls ?? (sep === 'separate' ? 6 : 4) // KCC calls per horizontal sub-step
  const landWalkable = o.landWalkable ?? fix, airSlide = o.airSlide ?? fix
  const retry = o.retry ?? false // see move(): retry a guard-rejected sub-step once as two halves
  // slideSteep (default = fix; second attempt): when the ground ray rejects a sub-step because the floor under the
  // candidate axis is steeper than 30 deg, that floor is a wall: the sub-step is redone once from the committed pose with
  // the ray hit's horizontal normal as a wall plane (input projected, 0.01 step-off, rule H). Why: the KCC can miss a
  // face of 31-33 deg (probe_band31_state: no collision reported, 2 ms per call, rim 0.0057 inside, too shallow for the
  // guard) and faces of 30-31 deg are first met by the ray, not the rim; a plain rejection is a dead stop that repeats
  // while the input is unchanged (t1 Part B: retention 11.3% on a 31-deg face at top 4.15, probe_band31).
  const slideSteep = o.slideSteep ?? fix
  // recover (default = fix; second attempt): a guard hit after a horizontal sub-step is redone once before it is undone.
  // Why: such hits come from Rapier cast misses (the KCC reports no contact although the move runs into a solid: starts
  // within ~2e-5 of the 0.02 offset, probe_exact_skin and t7_census; near-exact head-on alignment with a ball,
  // probe_cast_miss_fine). A plain undo leaves the state unchanged, so the same input misses again on every following
  // sample (t2: 138 reverts in a row). Recovery: the colliders the guard found at the candidate pose are queried for
  // their closest-point contact with the r 0.5 cylinder at the COMMITTED pose (collider.contactShape, prediction
  // recoverDist 0.5, a distance query, not a cast); each non-walkable normal with a horizontal part is a wall plane h.
  // The sub-step is then redone from the committed pose as after a wall contact: the input loses its components into
  // every h, one KCC call steps sepDist along the normalised sum of the h, and the usual loop moves the rest. The guard
  // checks the result; a second hit undoes the sub-step as R6 does (counted in reverts).
  // Normal of each collider the guard found, in order of preference: (1) collider.contactShape of the r 0.5 cylinder at
  // the committed pose; (2) if Rapier returns no contact there (probe_recover_cone: the 256-gon hull cone at a gap of
  // 0.0200), collider.projectPoint of three points on the agent's axis (feet + 0.3, the middle, feet + top), the
  // nearest projection giving the normal; (3) if neither works, the reverse of the sub-step direction (dirX, dirZ).
  // recoverVia (tests only): 'contact' | 'projection' | 'direction' forces one source of the wall normals (t7 FALLBACK runs)
  const recover = o.recover ?? fix, recoverDist = o.recoverDist ?? 0.5, via = o.recoverVia ?? null
  const agentShape = new R.Cylinder(hh, r)
  function missedWalls(cx, cf, cz, dirX, dirZ) {
    const cand = { x: cx, y: cf + f2c, z: cz }, at = { x: p.x, y: feet + f2c, z: p.z }, planes = []
    const add = (nx, ny, nz) => { const hl = Math.hypot(nx, nz); if (ny < cos30 && hl > epsH) planes.push(nx / hl, nz / hl) }
    w.intersectionsWithShape(cand, rot, guard, (c) => {
      const ct = via && via !== 'contact' ? null : c.contactShape(agentShape, at, rot, recoverDist)
      if (ct) { add(ct.normal1.x, ct.normal1.y, ct.normal1.z); st.recoverByContact++; return true }
      let best = null
      if (!via || via === 'projection') for (const y of [feet + stepH, feet + f2c, feet + top]) { const q = { x: p.x, y, z: p.z }, pr = c.projectPoint(q, false)
        if (pr && !pr.isInside) { const d = Math.hypot(q.x - pr.point.x, q.y - pr.point.y, q.z - pr.point.z); if (d > 1e-9 && (!best || d < best.d)) best = { d, n: [(q.x - pr.point.x) / d, (q.y - pr.point.y) / d, (q.z - pr.point.z) / d] } } }
      if (best) { add(best.n[0], best.n[1], best.n[2]); st.recoverByProjection++; return true }
      const dl = Math.hypot(dirX, dirZ); if ((!via || via === 'direction') && dl > 1e-12) { planes.push(-dirX / dl, -dirZ / dl); st.recoverByDirection++ }
      return true
    }, flags, groups, col)
    return planes
  }
  const cc = new R.CharacterCollision()
  const st = { reverts: 0, retries: 0, retryOk: 0, raySteep: 0, rayHigh: 0, raySlides: 0, raySlideStops: 0, recoveries: 0, recoverOk: 0, recoverNoWall: 0, recoverByContact: 0, recoverByProjection: 0, recoverByDirection: 0, airReverts: 0, calls: 0, sub: 0, incl: 0, inclSub: 0, itCap: 0, airIncl: 0, airClip: 0, fallStarts: 0, lands: 0, maxNyVert: 0, kccCallsHist: [0, 0, 0, 0, 0, 0, 0, 0, 0] }
  let p = { x, z }, feet = 0, vy = 0, air = false
  const g0 = probe(x, 0, z); if (g0) feet = g0.y; col.setTranslation({ x, y: feet + f2c, z })
  // allWalls (variant U, the default with fix): every non-walkable contact, vertical ones included, takes the
  // horizontal-wall rule; allWalls false (variant T) lets contacts with |n_y| <= epsV keep the KCC's own slide.
  // t3_walls: Rapier reports |n_y| up to 3e-4 (toi-0 artifacts up to 0.0125) on exactly vertical faces, so T is
  // never bit-identical to the adopted mover anyway, and T gave guard reverts in the 30-deg wedge; U did not.
  const allWalls = o.allWalls ?? fix
  // first wall contact of the last KCC call (fills cc), or false
  function firstInclined() {
    const nc = k.numComputedCollisions()
    for (let i = 0; i < nc; i++) {
      k.computedCollision(i, cc); const n = cc.normal1, ay = Math.abs(n.y)
      if (!allWalls && ay <= epsV) { if (ay > st.maxNyVert) st.maxNyVert = ay; continue }
      if (n.y >= cos30) continue
      if (Math.hypot(n.x, n.z) <= epsH) continue
      return true
    }
    return false
  }
  // one horizontal move from (sx, sz) (the committed pose p unless retrying) at the current feet; returns [x, z].
  // preset (recovery only): wall planes [hx, hz, ...] known before the first call (see missedWalls)
  function horizontal(dx, dz, sx = p.x, sz = p.z, preset = null) {
    if (!fix) { k.computeColliderMovement(col, { x: dx, y: 0, z: dz }, flags, groups); st.calls++; const m = k.computedMovement(); return [p.x + m.x, p.z + m.z] }
    let cx = sx, cz = sz, rx = dx, rz = dz, calls = 0, moved = sx !== p.x || sz !== p.z, incl = false
    const planes = []
    const call = (mx, mz) => { if (calls > 0 || moved) { col.setTranslation({ x: cx, y: feet + f2c, z: cz }); moved = true }
      k.computeColliderMovement(col, { x: mx, y: 0, z: mz }, flags, groups); st.calls++; calls++ }
    if (preset && preset.length) { // as after a wall contact at the start: project the input, step off, then the loop
      let ex = 0, ez = 0
      for (let q = 0; q < preset.length; q += 2) { planes.push(preset[q], preset[q + 1]); ex += preset[q]; ez += preset[q + 1] }
      for (let q = 0; q < planes.length; q += 2) { const d = rx * planes[q] + rz * planes[q + 1]; if (d < 0) { rx -= d * planes[q]; rz -= d * planes[q + 1] } }
      for (let q = 0; q < planes.length; q += 2) if (rx * planes[q] + rz * planes[q + 1] < -1e-9) { rx = 0; rz = 0; break }
      const el = Math.hypot(ex, ez)
      if (el > 1e-6) { call((sepDist * ex) / el, (sepDist * ez) / el)
        if (firstInclined()) { const a2 = cc.translationDeltaApplied; cx += a2.x; cz += a2.z } else { const ms = k.computedMovement(); cx += ms.x; cz += ms.z } }
      if (Math.hypot(rx, rz) < 1e-9 && calls === 0) return [cx, cz] // nothing to do (the loop below breaks if calls > 0)
    }
    for (;;) {
      if (calls > 0 && Math.hypot(rx, rz) < 1e-9) break
      if (calls >= maxCalls) { st.itCap++; break }
      call(rx, rz)
      if (!firstInclined()) { const m = k.computedMovement(); cx += m.x; cz += m.z; rx = 0; rz = 0; break }
      st.incl++; incl = true
      const a = cc.translationDeltaApplied, rem = cc.translationDeltaRemaining, n = cc.normal1
      cx += a.x; cz += a.z
      const hl = Math.hypot(n.x, n.z), hx = n.x / hl, hz = n.z / hl
      rx = rem.x; rz = rem.z
      planes.push(hx, hz)
      for (let q = 0; q < planes.length; q += 2) { const d = rx * planes[q] + rz * planes[q + 1]; if (d < 0) { rx -= d * planes[q]; rz -= d * planes[q + 1] } }
      for (let q = 0; q < planes.length; q += 2) if (rx * planes[q] + rz * planes[q + 1] < -1e-9) { rx = 0; rz = 0; break }
      if (sep === 'separate') { // step off the face first, so the slide does not start at the skin distance
        if (calls >= maxCalls) { st.itCap++; break }
        call(sepDist * hx, sepDist * hz)
        if (firstInclined()) { const a2 = cc.translationDeltaApplied; cx += a2.x; cz += a2.z } else { const ms = k.computedMovement(); cx += ms.x; cz += ms.z }
      } else { rx += hNudge * hx; rz += hNudge * hz }
    }
    st.kccCallsHist[Math.min(calls, 8)]++
    if (incl) st.inclSub++
    if (moved) col.setTranslation({ x: p.x, y: feet + f2c, z: p.z }) // the caller commits or reverts
    return [cx, cz]
  }
  return {
    st, col, f2c, top, pos: () => ({ x: p.x, y: feet, z: p.z }), feet: () => feet, get airborne() { return air },
    // teleport (between samples): snap to the floor under (x, z), clear the airborne state
    place(nx, nz, fy = 0) { p = { x: nx, z: nz }; const gd = probe(nx, fy, nz); feet = gd ? gd.y : fy; vy = 0; air = false; col.setTranslation({ x: nx, y: feet + f2c, z: nz }) },
    move(dx, dz, dt) {
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.25))
      let steepN = null // horizontal normal of the steep floor that made the last groundAt reject its candidate
      const groundAt = (nx, nz) => { let nf = feet, nair = air, nvy = vy; steepN = null
        if (!air) { const gd = probe(nx, feet, nz)
          if (gd && (gd.y - feet > stepH + 1e-6 || gd.ny < cos30)) { nx = p.x; nz = p.z; if (gd.ny < cos30) { st.raySteep++; const hl = Math.hypot(gd.nx, gd.nz); if (hl > epsH) steepN = [gd.nx / hl, gd.nz / hl] } else st.rayHigh++ } else if (gd) nf = gd.y; else { nair = true; nvy = 0 } }
        return [nx, nz, nf, nair, nvy] }
      for (let i = 0; i < n; i++) {
        st.sub++
        let [nx, nz, nf, nair, nvy] = groundAt(...horizontal(dx / n, dz / n))
        if (slideSteep && steepN) { // the steep floor is a wall facing the agent: h, or -h when the input runs along h
          // (a steep slope going down away from the agent, probe_stepdown_steep)
          st.raySlides++; const hw = (dx * steepN[0] + dz * steepN[1] > 0) ? [-steepN[0], -steepN[1]] : steepN
          ;[nx, nz, nf, nair, nvy] = groundAt(...horizontal(dx / n, dz / n, p.x, p.z, hw)); if (steepN) st.raySlideStops++ }
        if (hit(nx, nf, nz)) {
          let ok = false
          if (recover) { // redo once with the walls the guard found (see missedWalls)
            const planes = missedWalls(nx, nf, nz, dx / n, dz / n)
            if (planes.length) { st.recoveries++; if (o.onRecover) o.onRecover({ x: nx, y: nf, z: nz, from: { x: p.x, y: feet, z: p.z }, planes })
              ;[nx, nz, nf, nair, nvy] = groundAt(...horizontal(dx / n, dz / n, p.x, p.z, planes)); ok = !hit(nx, nf, nz); if (ok) st.recoverOk++ }
            else st.recoverNoWall++
          }
          if (!ok && retry) { // a guard hit is retried once as two half-length moves (different cast configurations)
            st.retries++; if (o.onRetry) o.onRetry({ x: nx, y: nf, z: nz, from: { x: p.x, y: feet, z: p.z } })
            const [hx1, hz1] = horizontal(dx / n / 2, dz / n / 2), [hx2, hz2] = horizontal(dx / n / 2, dz / n / 2, hx1, hz1)
            ;[nx, nz, nf, nair, nvy] = groundAt(hx2, hz2); ok = !hit(nx, nf, nz); if (ok) st.retryOk++ }
          if (!ok) { st.reverts++; if (o.onRevert) o.onRevert({ x: nx, y: nf, z: nz, from: { x: p.x, y: feet, z: p.z }, kind: 'sub' }); continue }
        }
        if (nair && !air) st.fallStarts++
        p = { x: nx, z: nz }; feet = nf; air = nair; vy = nvy; col.setTranslation({ x: p.x, y: feet + f2c, z: p.z })
      }
      if (air) { vy += g * dt; k.computeColliderMovement(col, { x: 0, y: vy * dt, z: 0 }, flags, groups); st.calls++
        const m = k.computedMovement()
        let nx = p.x, nz = p.z, nf = feet + m.y
        if (airSlide && firstInclined()) { // keep the 3-D slide off the wall face, but stop it at the first walkable contact after it
          st.airIncl++; let mv = m, seenWall = false
          for (let i = 0; i < k.numComputedCollisions(); i++) { k.computedCollision(i, cc); const n = cc.normal1
            if (n.y >= cos30) { if (seenWall) { mv = cc.translationDeltaApplied; st.airClip++; break } } else if (Math.hypot(n.x, n.z) > epsH) seenWall = true }
          nx += mv.x; nz += mv.z; nf = feet + mv.y }
        const land = probe(nx, nf, nz, 0); let nair = true, nvy = vy
        if (land && vy <= 0 && (!landWalkable || land.ny >= cos30)) { nair = false; nvy = 0; nf = land.y }
        if (hit(nx, nf, nz)) { st.reverts++; st.airReverts++; if (o.onRevert) o.onRevert({ x: nx, y: nf, z: nz, from: { x: p.x, y: feet, z: p.z }, kind: 'air' }) } else { if (!nair) st.lands++; p = { x: nx, z: nz }; feet = nf; air = nair; vy = nvy; col.setTranslation({ x: p.x, y: feet + f2c, z: p.z }) } }
    },
  }
}
