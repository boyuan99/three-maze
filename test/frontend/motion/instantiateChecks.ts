// Queries on a world built by instantiate() from the fixture (fixtures/colliders.manifest.json).
// instantiate.test.ts runs them in Node and, bundled by Vite, in a worker; the two results must be
// equal, and the Node result must match the analytic geometry. Plain data only, so that a result
// can cross postMessage.
import type { ColliderManifest } from '../../../src/motion/manifest.ts'
import { describeColliders, GROUPS, instantiate } from '../../../src/motion/instantiate.ts'
import type { ColliderRecord, QueryWorld, Rapier } from '../../../src/motion/instantiate.ts'
import { refreshQueries } from '../../../src/motion/rapierCompat.ts'

type Point = [number, number, number]

/** First hit of a ray: the manifest id of the collider (or 'agent', 'probe') and the distance. */
export interface Hit {
  id: string
  toi: number
}

export interface CheckResults {
  rapierVersion: string
  colliders: ColliderRecord[]
  /** Rays with the agent's groups and EXCLUDE_SENSORS, as the mover casts them. */
  rays: Record<string, Hit | null>
  /** Zone ids (the `zone` field) the zone probe finds at named points. */
  probes: Record<string, string[]>
  /** The ray through the gate: disabled (as loaded), enabled, disabled again. */
  gate: Array<Hit | null>
  /** The zone probe below the floor: the void zone disabled (as loaded), then enabled. */
  voidZone: string[][]
  /** With the agent's own collider and a probe collider added inside the reward zone. */
  groups: {
    /** A ray down through the zone, the agent and the probe, with the agent's groups only. */
    agentRay: Hit | null
    /** The same ray without groups or flags. */
    unfilteredRay: Hit | null
    /** Colliders containing the probe point, by query. */
    pointWithZoneProbe: string[]
    pointWithAgentGroups: string[]
    pointUnfiltered: string[]
  }
}

/** Rays and probe points of runChecks; the test computes the analytic answers. */
export const RAYS: Record<string, { origin: Point, dir: Point }> = {
  floor: { origin: [5, 10, -5], dir: [0, -1, 0] },
  wall30: { origin: [0, 1, 0], dir: [1, 0, 0] },
  wall30Oblique: { origin: [0, 1, 0], dir: [Math.cos(0.2), 0, Math.sin(0.2)] },
  sideWall: { origin: [0, 1, 20], dir: [-1, 0, 0] },
  ramp: { origin: [0, 10, 25], dir: [0, -1, 0] },
  rampCorner: { origin: [-7, 10, 22], dir: [0, -1, 0] },
  post: { origin: [0, 1, 0], dir: [-1, 0, 0] },
}
export const GATE_RAY = { origin: [0, 1, 0] as Point, dir: [0, 0, -1] as Point }
export const PROBES: Record<string, Point> = {
  reward: [0, 1.15, 40],
  endA: [45, 1.15, -41],
  endB: [45, 1.15, -35],
  open: [0, 1.15, 0],
}
const BELOW_FLOOR: Point = [0, -15, 0]
/** The agent's cylinder (radius 0.5, feet + 0.3 to feet + 4.15, ADR-0001 R3), feet on the floor. */
const AGENT_HALF_HEIGHT = (4.15 - 0.3) / 2
const AGENT = { radius: 0.5, halfHeight: AGENT_HALF_HEIGHT, center: [0, 0.3 + AGENT_HALF_HEIGHT, 40] as Point }

const vector = ([x, y, z]: Point) => ({ x, y, z })

export function runChecks(R: Rapier, manifest: ColliderManifest): CheckResults {
  const q: QueryWorld = instantiate(R, manifest)
  const { world } = q
  const colliders = describeColliders(R, q)
  const names = new Map<number, string>()
  for (const [id, collider] of q.colliders) names.set(collider.handle, id)
  const name = (handle: number) => names.get(handle) ?? '?'

  const cast = (origin: Point, dir: Point, groups?: number, flags?: number): Hit | null => {
    const hit = world.castRay(new R.Ray(vector(origin), vector(dir)), 1000, true, flags, groups)
    return hit ? { id: name(hit.collider.handle), toi: hit.timeOfImpact } : null
  }
  const asAgent = (origin: Point, dir: Point) =>
    cast(origin, dir, GROUPS.agent, R.QueryFilterFlags.EXCLUDE_SENSORS)
  const containing = (point: Point, groups?: number, flags?: number) => {
    const found: string[] = []
    const collect = (c: { handle: number }) => { found.push(name(c.handle)); return true }
    world.intersectionsWithPoint(vector(point), collect, flags, groups)
    return found.sort()
  }
  // The zone probe of ADR-0001 R1: sensors only, zone groups; reported as zone ids
  const zonesAt = (point: Point) => {
    const zones = containing(point, GROUPS.zoneProbe, R.QueryFilterFlags.EXCLUDE_SOLIDS)
      .map((id) => (q.entries.get(q.colliders.get(id)!.handle) as { zone: string }).zone)
    return [...new Set(zones)].sort()
  }

  const rays: Record<string, Hit | null> = {}
  for (const [key, { origin, dir }] of Object.entries(RAYS)) rays[key] = asAgent(origin, dir)
  const probes: Record<string, string[]> = {}
  for (const [key, point] of Object.entries(PROBES)) probes[key] = zonesAt(point)

  const gate = [asAgent(GATE_RAY.origin, GATE_RAY.dir)]
  q.setEnabled('gate', true)
  gate.push(asAgent(GATE_RAY.origin, GATE_RAY.dir))
  q.setEnabled('gate', false)
  gate.push(asAgent(GATE_RAY.origin, GATE_RAY.dir))

  const voidZone = [zonesAt(BELOW_FLOOR)]
  q.setEnabled('zoneVoid', true)
  voidZone.push(zonesAt(BELOW_FLOOR))

  // The motion core adds the agent's collider itself (ADR-0001 R5); a probe collider stands for
  // any collider in the zone-probe layer
  const agent = world.createCollider(R.ColliderDesc.cylinder(AGENT.halfHeight, AGENT.radius)
    .setTranslation(...AGENT.center).setCollisionGroups(GROUPS.agent))
  const probe = world.createCollider(R.ColliderDesc.ball(0.01)
    .setTranslation(...PROBES.reward).setSensor(true).setCollisionGroups(GROUPS.zoneProbe))
  names.set(agent.handle, 'agent')
  names.set(probe.handle, 'probe')
  refreshQueries(world)
  const down: [Point, Point] = [[0, 10, 40], [0, -1, 0]]
  const groups = {
    agentRay: cast(...down, GROUPS.agent),
    unfilteredRay: cast(...down),
    pointWithZoneProbe: containing(PROBES.reward, GROUPS.zoneProbe),
    pointWithAgentGroups: containing(PROBES.reward, GROUPS.agent),
    pointUnfiltered: containing(PROBES.reward),
  }

  world.free()
  return { rapierVersion: q.rapierVersion, colliders, rays, probes, gate, voidZone, groups }
}
