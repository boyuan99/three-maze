// Differences between Rapier builds that the motion code depends on, kept in one module so that it
// runs on the pinned 0.14.0 and on the build the Rapier upgrade (MOT-16) moves to. The mover
// (MOT-03) adds its version-specific settings here.
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
