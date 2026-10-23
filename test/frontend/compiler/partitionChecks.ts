// Collider manifests of v0 mazes built by the scene compiler's partitioner (src/compiler/physics),
// for partition.test.ts. The test runs buildManifests() in Node, and bundled by Vite in a worker
// thread and in Electron's own Node; the three results must be equal. Plain data only, so that a
// result can cross postMessage.
import type { V0SceneConfig } from '../../../src/compat/v0/config.ts'
import { v0Manifest } from '../../../src/compiler/physics/fromV0.ts'
import { manifestJson } from '../../../src/compiler/physics/manifest.ts'

export interface ManifestJob {
  rapierVersion: string
  configs: Record<string, V0SceneConfig>
}

export interface ManifestResult {
  hash: string
  /** The manifest's canonical JSON, which the hash is taken of. */
  json: string
  notes: string[]
}

export function buildManifests(job: ManifestJob): Record<string, ManifestResult> {
  const results: Record<string, ManifestResult> = {}
  for (const [name, config] of Object.entries(job.configs)) {
    const { manifest, hash, notes } = v0Manifest(config, { rapierVersion: job.rapierVersion })
    results[name] = { hash, json: manifestJson(manifest), notes }
  }
  return results
}

/** What a worker answers: the manifests, and the versions of the program it ran in. */
export interface WorkerAnswer {
  manifests: Record<string, ManifestResult>
  /** process.versions where there is one (Node, Electron as Node), else null */
  versions: Record<string, string | undefined> | null
}

export function answer(job: ManifestJob): WorkerAnswer {
  const versions = typeof process === 'undefined' ? null : { ...process.versions }
  return { manifests: buildManifests(job), versions }
}

/**
 * A v0 maze with rotated boxes, which no shipped maze has: a wall turned 30 degrees about +Y, a
 * beam lying on its side (turned 90 degrees about +X) and a slab tilted 45 degrees, all with an
 * extent over 40, on an 80-unit floor.
 */
export const ROTATED: V0SceneConfig = {
  name: 'Rotated boxes (test fixture)',
  objects: [
    {
      name: 'floor',
      geometry: { type: 'box', width: 80, height: 1, depth: 80 },
      position: { x: 0, y: -0.5, z: 0 },
      physics: { enabled: true, type: 'static' },
    },
    {
      name: 'wallTurned',
      geometry: { type: 'box', width: 1, height: 10, depth: 100 },
      position: { x: 10, y: 5, z: 0 },
      rotation: { x: 0, y: Math.PI / 6, z: 0 },
      physics: { enabled: true, type: 'static' },
    },
    {
      name: 'beamLying',
      geometry: { type: 'box', width: 2, height: 50, depth: 4 },
      position: { x: -20, y: 2, z: 0 },
      rotation: { x: Math.PI / 2, y: 0, z: 0 },
      physics: { enabled: true, type: 'static' },
    },
    {
      name: 'slabTilted',
      geometry: { type: 'box', width: 1, height: 10, depth: 60 },
      position: { x: 0, y: 5, z: -25 },
      rotation: { x: 0, y: 0.3, z: Math.PI / 4 },
      physics: { enabled: true, type: 'static' },
    },
  ],
}

/**
 * A v0 maze whose floor is three boxes turned 30 degrees about +Y, in a row along their own x
 * axis: they merge into one turned cuboid, whose centre and rotation the partitioner computes
 * with Math.hypot and square roots, so the cross-runtime checks cover that arithmetic too.
 */
export const TURNED: V0SceneConfig = {
  name: 'Turned floor (test fixture)',
  objects: [0, 20, 40].map((d, i) => ({
    name: `tile${i}`,
    geometry: { type: 'box', width: 20, height: 1, depth: 20 },
    position: { x: d * Math.cos(Math.PI / 6), y: -0.5, z: -d * Math.sin(Math.PI / 6) },
    rotation: { x: 0, y: Math.PI / 6, z: 0 },
    physics: { enabled: true, type: 'static' },
  })),
}
