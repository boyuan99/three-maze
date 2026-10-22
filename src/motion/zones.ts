// Zones and run-time gates (ADR-0001 R1, Validation 6; plan item MOT-04). A zone sensor for the
// motion core (./core.ts): after each sample and each teleport the core asks it which zones the
// agent's zone point is in, a point on the agent's axis 1.15 above its feet, found by a point
// query that sees zones only (EXCLUDE_SOLIDS and the zone-probe groups of ./instantiate.ts). It
// reports the zones entered and left since the last query, by set difference, in ADR-0002's
// dispatch order: exits, then entries, each by zone id compared by character code (ADR-0005 F4).
// A compound zone, several colliders with one zone id, is one zone: moving between its colliders
// enters and leaves nothing.
//
// Zones never block: they are sensors in their own layer, and every query of the mover passes
// EXCLUDE_SENSORS and the agent's groups (ADR-0001 R3). A zone thinner than one sample's
// displacement can be crossed without a sample inside it; the scene check warns about such zones
// (plan item MOT-10).
//
// Zones and gates (solid colliders such as invisible barriers) are switched at run time here, with
// a query refresh and no world.step() (ADR-0001 R1). The switch takes effect for the mover's next
// query; zone membership follows at the next sample or teleport, so a zone switched off around
// the agent is left, and one switched on around it entered, there (cause 'move'). Switching a
// gate on where it overlaps the agent was never validated (ADR-0001 Caveats): the overlap guard
// (R6) would then undo the agent's moves.
import type { Collider } from '@dimforge/rapier3d-compat'
import type { ZoneChange, ZoneSensor } from './core.ts'
import { GROUPS } from './instantiate.ts'
import type { ManifestEntry, QueryWorld, Rapier } from './instantiate.ts'
import { refreshQueries } from './rapierCompat.ts'

/** Height of the zone point above the feet, on the agent's axis (ADR-0001 R1, R3). */
export const ZONE_POINT_HEIGHT = 1.15

export interface Zones extends ZoneSensor {
  /** Zones the zone point was in at the last update, sorted by id; empty before the first. */
  readonly inside: readonly string[]
  /** Every zone id of the manifest, sorted. */
  readonly ids: readonly string[]
  /**
   * The zones entered and left since the last update, at the agent's pose (x, feetY, z): exits,
   * then entries, each sorted by zone id.
   */
  update(x: number, feetY: number, z: number): ZoneChange[]
  /** Switches every collider of a zone on or off and refreshes the scene queries. */
  setZoneEnabled(zone: string, enabled: boolean): void
  /**
   * Switches the solid colliders compiled from one scene object (a gate, all its pieces) on or
   * off and refreshes the scene queries. Throws if no collider comes from that object, or if one
   * of them was merged from several objects, since it cannot be switched for one of them alone.
   */
  setGateEnabled(object: string, enabled: boolean): void
}

/** Creates the zone sensor of a query world built by instantiate(). */
export function createZones(R: Rapier, queryWorld: QueryWorld): Zones {
  const { world } = queryWorld
  const zoneColliders = new Map<string, Collider[]>()
  const fromObject = new Map<string, Array<{ collider: Collider, entry: ManifestEntry }>>()
  for (const collider of queryWorld.colliders.values()) {
    const entry = queryWorld.entries.get(collider.handle) as ManifestEntry
    if ('zone' in entry) {
      const list = zoneColliders.get(entry.zone) ?? []
      list.push(collider)
      zoneColliders.set(entry.zone, list)
    } else {
      for (const source of entry.sources) {
        const list = fromObject.get(source) ?? []
        list.push({ collider, entry })
        fromObject.set(source, list)
      }
    }
  }
  const ids = [...zoneColliders.keys()].sort()
  const point = { x: 0, y: 0, z: 0 }
  const flags = R.QueryFilterFlags.EXCLUDE_SOLIDS
  let inside: string[] = []

  function update(x: number, feetY: number, z: number): ZoneChange[] {
    const now = new Set<string>()
    point.x = x
    point.y = feetY + ZONE_POINT_HEIGHT
    point.z = z
    world.intersectionsWithPoint(point, (collider) => {
      const entry = queryWorld.entries.get(collider.handle)
      if (entry && 'zone' in entry) now.add(entry.zone)
      return true
    }, flags, GROUPS.zoneProbe)
    const before = new Set(inside)
    // inside is sorted, so the exits are too
    const exits = inside.filter((zone) => !now.has(zone))
    const entries = [...now].filter((zone) => !before.has(zone)).sort()
    inside = [...now].sort()
    return [
      ...exits.map((zone): ZoneChange => ({ zone, edge: 'exit' })),
      ...entries.map((zone): ZoneChange => ({ zone, edge: 'enter' })),
    ]
  }

  function setZoneEnabled(zone: string, enabled: boolean): void {
    const colliders = zoneColliders.get(zone)
    if (!colliders) throw new Error(`no zone '${zone}' in the manifest`)
    for (const collider of colliders) collider.setEnabled(enabled)
    refreshQueries(world)
  }

  function setGateEnabled(object: string, enabled: boolean): void {
    const found = fromObject.get(object)
    if (!found) throw new Error(`no collider in the manifest comes from '${object}'`)
    const merged = found.find(({ entry }) => entry.sources.length > 1)
    if (merged) {
      throw new Error(`'${object}' is part of collider '${merged.entry.id}' with `
        + `${merged.entry.sources.filter((s) => s !== object).join(', ')}; it cannot be switched `
        + 'alone')
    }
    for (const { collider } of found) collider.setEnabled(enabled)
    refreshQueries(world)
  }

  return {
    get inside() { return inside },
    ids,
    update,
    setZoneEnabled,
    setGateEnabled,
  }
}
