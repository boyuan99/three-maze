// Web Worker entry for the Worker-bundle test of the motion core (core.test.ts). Vite bundles it as
// it will bundle the renderer's motion worker; the test runs the bundle in a worker thread and
// posts it the scripted session's samples.
import type { DeviceSample } from '../../../src/motion/core.ts'
import { runScript } from './coreScript.ts'

self.onmessage = (event: MessageEvent<DeviceSample[]>) => {
  try {
    self.postMessage({ ok: true, result: runScript(event.data) })
  } catch (error) {
    const text = error instanceof Error ? error.stack ?? error.message : String(error)
    self.postMessage({ ok: false, error: text })
  }
}
