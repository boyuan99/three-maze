// Differences between Rapier builds that the motion code depends on, kept in one module so that it
// runs on the pinned 0.14.0 and on the build the Rapier upgrade (MOT-16) moves to. instantiate()
// refreshes the scene queries with refreshQueries(); the hover mover (./mover.ts) takes its slope
// angles from slopeAngles().
import type { World } from '@dimforge/rapier3d-compat'

/**
 * Makes the scene queries see every change to the colliders. Rapier 0.14.0 has
 * world.updateSceneQueries(); later builds dropped it, and there a step without bodies refreshes
 * the query structures (ADR-0001 R1; Rapier upgrade MOT-16).
 */
export function refreshQueries(world: World): void {
  const w = world as { updateSceneQueries?: () => void, step: () => void }
  if (typeof w.updateSceneQueries === 'function') w.updateSceneQueries()
  else w.step()
}

/**
 * The hover mover's slope angles for the character controller, radians (ADR-0001 R3): its
 * maximum climb angle and minimum slide angle. On 0.14.0, the pinned build (R8), both are 30
 * degrees, the setting the archived evidence was produced with; that build ignores the climb
 * angle for horizontal pushes, so the wall rule of R4 decides every face. Builds from 0.15.0
 * apply the climb angle to upward faces, where exactly 30 degrees blocks 30-degree ramps, so R3
 * asks for both angles above 30 degrees after an upgrade. Which values is the upgrade's decision
 * (MOT-16), so any other build is refused here until it adds them.
 */
export function slopeAngles(version: string): { climb: number, slide: number } {
  if (version === '0.14.0') return { climb: Math.PI / 6, slide: Math.PI / 6 }
  throw new Error(`Rapier ${version}: the hover mover's slope angles are validated on 0.14.0 only `
    + '(ADR-0001 R3); the Rapier upgrade (MOT-16) sets them for another build')
}
