// Web Worker entry for the Worker-bundle test of instantiate() (instantiate.test.ts). Vite bundles
// it with Rapier's ES build, as it will bundle the renderer's motion worker; the test runs the
// bundle in a worker thread and posts it the fixture manifest.
import RAPIER from '@dimforge/rapier3d-compat'
import type { ColliderManifest } from '../../../src/motion/manifest.ts'
import { runChecks } from './instantiateChecks.ts'

self.onmessage = async (event: MessageEvent<ColliderManifest>) => {
  try {
    await RAPIER.init()
    self.postMessage({ ok: true, result: runChecks(RAPIER, event.data) })
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error)
    self.postMessage({ ok: false, error: text })
  }
}
