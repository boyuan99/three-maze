// The collider manifest the scene compiler writes (ADR-0001 R5.5; plan item MOT-08): the
// partitioned colliders with their sources, the zones, the builder and Rapier versions and the
// scene's motion settings, plus its hash, which enters every session record (MOT-14). The
// manifest's types and validator are shared with instantiate() (src/motion/manifest.ts).
import { MANIFEST_FORMAT, MANIFEST_VERSION, validateManifest } from '../../motion/manifest.ts'
import type { ColliderManifest, ManifestMotion } from '../../motion/manifest.ts'
import { canonicalJson, sha256Hex } from '../hash.ts'
import type { Partition } from './partition.ts'

/**
 * The manifest's `builder`: this program and the version of its output. Raise the version
 * whenever the same input gives a different manifest, so that two hashes from one builder
 * version always mean two scenes.
 */
export const BUILDER = 'three-maze collider partitioner 1 (box subset, plan item MOT-08)'

/** Gravity of a scene that does not set one, units/s² (ADR-0001 R3). */
export const DEFAULT_GRAVITY = -981

export interface ManifestOptions {
  /**
   * RAPIER.version() of the build the manifest is for: the pinned one (ADR-0001 R8). The
   * compiler loads no Rapier, so the caller names it.
   */
  rapierVersion: string
  motion: ManifestMotion
}

/** The manifest of a partition (./partition.ts), validated. */
export function buildManifest(parts: Partition, options: ManifestOptions): ColliderManifest {
  const manifest: ColliderManifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    builder: BUILDER,
    rapierVersion: options.rapierVersion,
    motion: { ...options.motion },
    colliders: parts.colliders,
    zones: parts.zones,
  }
  return validateManifest(manifest)
}

/** The manifest in canonical JSON (RFC 8785), the form its hash is taken of. */
export function manifestJson(manifest: ColliderManifest): string {
  return canonicalJson(manifest)
}

/**
 * The manifest's hash for the session record: SHA-256 of its canonical JSON, 64 hexadecimal
 * digits. Equal manifests give equal hashes in Node, in a worker and in Electron; key order and
 * whitespace of a manifest read from a file do not matter.
 */
export function manifestHash(manifest: ColliderManifest): string {
  return sha256Hex(manifestJson(manifest))
}
