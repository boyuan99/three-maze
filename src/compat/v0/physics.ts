// v0.3's physics world as plain data: the colliders createPhysicsFromConfig makes
// (src/scenes/serial/PythonCustomScene.vue:453-501), the gravity (:623) and the player body
// (:628-640). One solid per collider v0.3 creates, in world space (v0 objects have no parents), with
// v0.3's defaults and quirks (README.md). No Rapier here: MOT-08 turns the solids into colliders.
import type { V0SceneConfig } from './config.ts'

export type Vec3 = [number, number, number]
export type Quat = [number, number, number, number]

export type V0Shape =
  | { kind: 'cuboid', halfExtents: Vec3 }
  | { kind: 'ball', radius: number }
  | { kind: 'cylinder', halfHeight: number, radius: number }

export type V0BodyType = 'fixed' | 'dynamic'

export interface V0Solid {
  /** Index of the object in the JSON's `objects` */
  objectIndex: number
  name: string | null
  body: V0BodyType
  shape: V0Shape
  /** Translation of the body; the collider sits at the body's origin */
  position: Vec3
  /** Rotation of the collider v0.3 creates: always none, it sets only the translation (:464-468) */
  colliderRotation: Quat
  /** Euler XYZ rotation (radians) of the object's mesh (:435-439), which v0.3's collider ignores */
  meshRotation: Vec3
  friction: number
  restitution: number
}

/** An object with physics enabled whose geometry v0.3 cannot collide: the body exists, no collider */
export interface V0BodyWithoutCollider {
  objectIndex: number
  name: string | null
  body: V0BodyType
  position: Vec3
}

export interface V0PlayerBody {
  body: 'dynamic'
  position: Vec3
  shape: { kind: 'ball', radius: number }
  friction: number
  restitution: number
  linearDamping: number
  angularDamping: number
}

export interface V0PhysicsBuild {
  gravity: Vec3
  solids: V0Solid[]
  bodiesWithoutCollider: V0BodyWithoutCollider[]
  player: V0PlayerBody
  /** Dynamic bodies and bodies without a collider, one line each */
  diagnostics: string[]
}

/** World gravity of the experiment scene (:623) */
export const V0_GRAVITY: Vec3 = [0, -500, 0]

/** The player: a dynamic ball of radius PLAYER_RADIUS = 0.5 resting on y = 0 (:78, :628-640) */
export const V0_PLAYER: V0PlayerBody = {
  body: 'dynamic',
  position: [0, 0.5, 0],
  shape: { kind: 'ball', radius: 0.5 },
  friction: 0,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 0
}

const NO_ROTATION: Quat = [0, 0, 0, 1]

export function v0Physics(config: V0SceneConfig): V0PhysicsBuild {
  const solids: V0Solid[] = []
  const bodiesWithoutCollider: V0BodyWithoutCollider[] = []
  const diagnostics: string[] = []

  for (const [objectIndex, object] of (config.objects || []).entries()) {
    // Only objects with physics.enabled get a body (:458); any type but 'dynamic' is fixed (:460-462)
    if (!object.physics?.enabled) continue
    const body: V0BodyType = object.physics.type === 'dynamic' ? 'dynamic' : 'fixed'
    const name = object.name ?? null
    const position: Vec3 = [object.position?.x || 0, object.position?.y || 0, object.position?.z || 0]
    const label = `object ${objectIndex} (${name ?? 'unnamed'})`

    const geometry = object.geometry
    let shape: V0Shape
    switch (geometry.type) {
      case 'box':
        shape = {
          kind: 'cuboid',
          halfExtents: [(geometry.width || 1) / 2, (geometry.height || 1) / 2, (geometry.depth || 1) / 2]
        }
        break
      case 'sphere':
        shape = { kind: 'ball', radius: geometry.radius || 1 }
        break
      case 'cylinder':
        // The collider takes radiusTop only; the mesh also uses radiusBottom (:486-489)
        shape = { kind: 'cylinder', halfHeight: (geometry.height || 1) / 2, radius: geometry.radiusTop || 1 }
        break
      default:
        // v0.3 has already created the body (:470) when it skips the collider (:491-492)
        bodiesWithoutCollider.push({ objectIndex, name, body, position })
        diagnostics.push(`${label}: ${body} body without a collider (geometry type '${geometry.type}')`)
        continue
    }

    if (body === 'dynamic') {
      diagnostics.push(`${label}: dynamic body; in v0.3 it falls under gravity ${V0_GRAVITY[1]}`)
    }
    solids.push({
      objectIndex,
      name,
      body,
      shape,
      position,
      colliderRotation: [...NO_ROTATION],
      meshRotation: [object.rotation?.x || 0, object.rotation?.y || 0, object.rotation?.z || 0],
      friction: object.physics.friction || 0.5,
      restitution: object.physics.restitution || 0
    })
  }

  const player: V0PlayerBody = { ...V0_PLAYER, position: [...V0_PLAYER.position], shape: { ...V0_PLAYER.shape } }
  return { gravity: [...V0_GRAVITY], solids, bodiesWithoutCollider, player, diagnostics }
}
